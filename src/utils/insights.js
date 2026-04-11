/**
 * On-demand word insights — etymology, register, collocations, cultural note.
 *
 * Priority order:
 *   1. word_cache.ai_insights (shared, cross-user) — checked first on every call.
 *      If populated, return immediately — no AI call, no vocabulary read needed.
 *   2. word.ai_insights (vocabulary, per-user in-memory) — used only if cache misses.
 *      If populated, backfill word_cache so future users (including this user on
 *      the next session) hit step 1. Return without an AI call.
 *   3. Call AI — write to both word_cache (shared) and vocabulary (per-user). Return.
 *
 * Cache key: (word, learningLang, learningLang, primaryLang, 'single') — matches the
 * key used by explore mode and direct same-language lookups. For words added from a
 * different input language (e.g. English typed → Spanish word), the key won't match
 * and step 1 will miss; the vocabulary write at step 3 still succeeds as the fallback.
 *
 * Extensibility: adding new enrichment fields to word_cache only requires adding to
 * CACHE_EXTRA_JSONB_FIELDS in cache.js + a SQL migration. No changes needed here.
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
 * @returns {Promise<object>}   — the ai_insights object
 */
export async function fetchInsights(word, primaryLang, signal) {
  const learningLang = word.word_language || 'es';
  const wordLower    = word.word.toLowerCase().trim();
  const cacheKey     = { word: wordLower, inputLang: learningLang, learningLang, primaryLang, mode: 'single' };

  // 1. Check shared cache first — any prior user populates this for everyone.
  const cacheRow = await getCachedWord(wordLower, learningLang, learningLang, primaryLang, 'single');
  if (cacheRow?.ai_insights) {
    console.log('[insights] step 1 hit — word_cache:', cacheKey);
    return cacheRow.ai_insights;
  }

  // 2. Fall back to per-user vocabulary row (already in memory from initial load).
  //    Backfill word_cache so future lookups (any user) hit step 1.
  if (word.ai_insights) {
    console.log('[insights] step 2 hit — vocabulary, backfilling word_cache:', cacheKey);
    // Fire-and-forget backfill — don't block the UI on the cache write.
    setCachedExtra(wordLower, learningLang, learningLang, primaryLang, 'single', { ai_insights: word.ai_insights });
    return word.ai_insights;
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

  // 4. Write to both stores in parallel.
  //    setCachedExtra logs whether the cache row exists; if not, the vocabulary write
  //    still succeeds as the per-user fallback.
  console.log('[insights] step 3 — AI call done, writing to cache + vocabulary:', cacheKey);
  await Promise.all([
    setCachedExtra(wordLower, learningLang, learningLang, primaryLang, 'single', { ai_insights: insights }),
    updateWordDB(word.id, { ai_insights: insights }),
  ]);

  return insights;
}
