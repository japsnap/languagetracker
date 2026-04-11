/**
 * On-demand word insights — etymology, register, collocations, cultural note.
 *
 * Fetch order (cache-first, two-write):
 *   1. Return word.ai_insights immediately if already populated (optimistic update from
 *      useVocabulary ensures this is non-null after the first successful fetch).
 *   2. Check word_cache for ai_insights on the word's existing mode='single' row.
 *      Cache key: (word, learningLang, learningLang, primaryLang, 'single') — matches
 *      how explore mode and direct same-language lookups store words.
 *      If populated (by any prior user), return immediately — no API call.
 *   3. Call AI, parse response.
 *   4. Write to both stores:
 *      - word_cache.ai_insights via setCachedExtra UPDATE on the existing single row
 *        (no-op if the row doesn't exist for this key — vocabulary write still occurs).
 *      - vocabulary.ai_insights for the current user's fast path.
 *
 * Extensibility: adding new enrichment fields to word_cache only requires adding to
 * CACHE_EXTRA_JSONB_FIELDS in cache.js + a SQL migration. No changes needed here.
 * New enrichment types (e.g. false_friends) use their own getCachedWord/setCachedExtra
 * calls with a separate field name.
 *
 * SQL migration required (run once in Supabase SQL Editor):
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS ai_insights jsonb;
 */

import { supabase } from './supabase';
import { updateWordDB } from './vocabulary';
import { getCachedWord, setCachedExtra } from './cache';

async function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const devKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (devKey) headers['x-api-key'] = devKey;
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
  return headers;
}

/**
 * Fetch ai_insights for a vocabulary word.
 *
 * @param {object} word         — full vocabulary row (must have .id, .word, .word_language)
 * @param {string} primaryLang  — user's primary language code (for response language)
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}   — the ai_insights object (from cache or fresh AI call)
 */
export async function fetchInsights(word, primaryLang, signal) {
  // 1. Already in memory — optimistic update from useVocabulary means word.ai_insights
  //    is populated after the first successful fetch in any session.
  if (word.ai_insights) return word.ai_insights;

  const learningLang = word.word_language || 'es';
  const wordLower    = word.word.toLowerCase().trim();

  // Cache key for insights: same key pattern as explore-mode single rows.
  // input_language = learning_language = learningLang (word is already in learning lang).
  const cacheKey = { word: wordLower, inputLang: learningLang, learningLang, primaryLang, mode: 'single' };

  // 2. Check shared cache — any prior user who fetched insights for this word will have
  //    set ai_insights on the existing single-mode cache row, making it free for all.
  const cacheRow = await getCachedWord(wordLower, learningLang, learningLang, primaryLang, 'single');
  if (cacheRow?.ai_insights) {
    console.log('[insights] cache hit:', cacheKey);
    return cacheRow.ai_insights;
  }

  // 3. Call AI
  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: await buildHeaders(),
    body: JSON.stringify({
      word:              word.word,
      part_of_speech:    word.part_of_speech || '',
      learning_language: learningLang,
      primary_language:  primaryLang,
      mode:              'insights',
    }),
  });

  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try {
      const err = await response.json();
      if (err.error?.message) msg = err.error.message;
    } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  const text = (data.content?.[0]?.text || '').trim();

  let insights;
  try {
    insights = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) insights = JSON.parse(match[0]);
    else throw new Error('Could not parse insights response. Try again.');
  }

  // 4. Write to both stores in parallel:
  //    - word_cache: UPDATE the existing single-mode row's ai_insights column (shared,
  //      cross-user). If the row doesn't exist for this key, setCachedExtra is a no-op.
  //    - vocabulary: per-user fast path so step 1 is hit on all subsequent opens.
  console.log('[insights] writing to cache:', cacheKey);
  await Promise.all([
    setCachedExtra(wordLower, learningLang, learningLang, primaryLang, 'single', { ai_insights: insights }),
    updateWordDB(word.id, { ai_insights: insights }),
  ]);

  return insights;
}
