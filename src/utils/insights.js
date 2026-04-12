/**
 * On-demand word insights — etymology, register, collocations, cultural note.
 *
 * Cache key problem (and fix):
 *   setCachedExtra must UPDATE a row using the EXACT key it was inserted with.
 *   The full key is (input_word, input_language, learning_language, primary_language, mode).
 *   fetchInsights only knows word.word and word.word_language — it does NOT know the
 *   original input_language (which may differ: e.g. user typed "beautiful" in English
 *   to get "hermoso"; cache stored input_word="beautiful", input_language="en").
 *
 *   Fix: findCachedWordRow() queries by (input_word=word.word, learning_language,
 *   primary_language, mode) WITHOUT input_language, and returns the stored input_language.
 *   setCachedExtra then uses that actual value. If the word isn't in cache at all
 *   (e.g. cross-language words where input_word != result word), the UPDATE is skipped
 *   gracefully and vocabulary.ai_insights still receives the write.
 *
 * Priority order:
 *   1. word_cache.ai_insights — checked first via findCachedWordRow (shared, cross-user).
 *   2. word.ai_insights (vocabulary, in-memory) — backfills word_cache, then returns.
 *   3. AI call — writes to both word_cache and vocabulary.
 *
 * Extensibility: adding new enrichment fields to word_cache only requires adding to
 * CACHE_EXTRA_JSONB_FIELDS in cache.js + a SQL migration. No changes needed here.
 *
 * SQL migration required (run once in Supabase SQL Editor):
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS ai_insights jsonb;
 */

import { supabase } from './supabase';
import { updateWordDB } from './vocabulary';
import { findCachedWordRow, setCachedExtra } from './cache';

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

  // Find the cache row — this resolves the actual input_language stored in the row,
  // which may differ from learningLang for cross-language lookups.
  const cacheMatch = await findCachedWordRow(wordLower, learningLang, primaryLang, 'single');

  // 1. Cache hit with ai_insights already populated — return immediately.
  if (cacheMatch?.cacheData?.ai_insights) {
    console.log('[insights] step 1 hit — word_cache:', { word: wordLower, storedInputWord: cacheMatch.inputWord, storedInputLang: cacheMatch.inputLang, learningLang, primaryLang });
    return cacheMatch.cacheData.ai_insights;
  }

  // 2. Vocabulary row has ai_insights (from a prior session's AI call) — backfill
  //    word_cache so any future user gets a step 1 hit, then return.
  if (word.ai_insights) {
    console.log('[insights] step 2 hit — vocabulary, backfilling word_cache:', { word: wordLower, learningLang, primaryLang, cacheRowFound: !!cacheMatch });
    if (cacheMatch) {
      // Use the stored input_word and input_language — both may differ from the vocabulary word.
      setCachedExtra(wordLower, cacheMatch.inputLang, learningLang, primaryLang, 'single', { ai_insights: word.ai_insights });
    }
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

  // 4. Write to both stores. Use the actual stored input_language for the cache UPDATE.
  console.log('[insights] step 3 — AI done, writing:', { word: wordLower, learningLang, primaryLang, cacheRowFound: !!cacheMatch, storedInputLang: cacheMatch?.inputLang });
  const writes = [updateWordDB(word.id, { ai_insights: insights })];
  if (cacheMatch) {
    writes.push(setCachedExtra(wordLower, cacheMatch.inputLang, learningLang, primaryLang, 'single', { ai_insights: insights }));
  } else {
    console.log('[insights] no cache row found for word — vocabulary-only write:', { word: wordLower, learningLang, primaryLang });
  }
  await Promise.all(writes);

  return insights;
}
