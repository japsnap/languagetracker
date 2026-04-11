/**
 * On-demand word insights — etymology, register, collocations, cultural note.
 *
 * Fetch order (cache-first, two-write):
 *   1. Return word.ai_insights immediately if already populated (optimistic update from
 *      useVocabulary ensures this is non-null after the first fetch in any session).
 *   2. Check word_cache for mode='insights' — populated by any prior user. Return if found.
 *   3. Call AI, parse response, write to BOTH word_cache (shared, cross-user) AND
 *      vocabulary.ai_insights (per-user fast path). Return result.
 *
 * Extensibility: ai_insights is stored as opaque JSONB in both stores. Adding new fields
 * (false_friends, mnemonic, etc.) only requires updating buildInsightsPrompt in
 * api/anthropic.js and INSIGHTS_SECTIONS in InsightsPanel.jsx — this file is unchanged.
 *
 * Future enrichment types (e.g. false_friends): follow the same pattern — use a new
 * mode string (e.g. 'false_friends') with getCachedWord/setCachedWord. No changes here.
 *
 * Cache key for insights: (word, learningLang, learningLang, primaryLang, 'insights').
 * No SQL migration required — 'insights' is a new mode value in the existing text column.
 */

import { supabase } from './supabase';
import { updateWordDB } from './vocabulary';
import { getCachedWord, setCachedWord } from './cache';

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
  // 1. Already in memory — the optimistic update from useVocabulary means word.ai_insights
  //    is populated after the first successful fetch in a session, so this path is always
  //    taken on subsequent row expansions without touching the network.
  if (word.ai_insights) return word.ai_insights;

  const learningLang = word.word_language || 'es';
  const wordLower    = word.word.toLowerCase().trim();

  // 2. Check shared cache — any user who previously fetched insights for this word
  //    will have populated this row, making it available to all subsequent users for free.
  const cached = await getCachedWord(wordLower, learningLang, learningLang, primaryLang, 'insights');
  if (cached !== null) return cached;

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
  //    - word_cache: shared across all users, keyed by (word, langs, 'insights').
  //      Any future user hitting this word skips the AI call entirely (step 2 above).
  //    - vocabulary: per-user fast path. Optimistic update by the caller ensures step 1
  //      is hit on all subsequent opens of this row in the same session.
  await Promise.all([
    setCachedWord(wordLower, learningLang, learningLang, primaryLang, 'insights', insights),
    updateWordDB(word.id, { ai_insights: insights }),
  ]);

  return insights;
}
