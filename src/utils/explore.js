/**
 * Explore mode word serving.
 *
 * Serving order:
 *   1. Random entry from word_cache matching (learningLang, primaryLang, level, wordType)
 *      excluding words already seen this session — zero AI cost.
 *   2. Fresh AI call (explore mode prompt) if no unseen cache hit.
 *      Response is immediately saved to word_cache so future sessions reuse it.
 *
 * Extensibility: to support phrase/idiom filtering or community word pools, add params
 * to `fetchExploreWord` and forward them to `getRandomCachedExploreWord`. The
 * ExploreMode component only calls `fetchExploreWord` and never touches cache directly.
 */

import { supabase } from './supabase';
import { getRandomCachedExploreWord, setCachedWord } from './cache';
import { logEvent } from './events';

async function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  // Dev: direct Anthropic key (never deployed; Vite proxy handles locally)
  const devKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (devKey) headers['x-api-key'] = devKey;
  // Prod: serverless function validates this token
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
  return headers;
}

/**
 * Fetch one word for explore mode.
 *
 * @param {object}      opts
 * @param {string}      opts.learningLang
 * @param {string}      opts.primaryLang
 * @param {string}      opts.level       — 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'
 * @param {string}      [opts.wordType]  — 'word' | 'phrase' | 'idiom'; default 'word'
 * @param {Set<string>} [opts.seenWords] — lowercase word strings shown this session
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} AI result object (same shape as primary lookup)
 */
export async function fetchExploreWord({
  learningLang,
  primaryLang,
  level,
  wordType = 'word',
  seenWords = new Set(),
  signal,
}) {
  // 1. Try cache first (free)
  const cached = await getRandomCachedExploreWord(
    learningLang, primaryLang, level, wordType, seenWords
  );
  if (cached) {
    logEvent('word_lookup', {
      mode: 'explore', learning: learningLang, primary: primaryLang,
      level, word_type: wordType, cache_hit: true,
    });
    return cached;
  }

  // 2. Call AI
  logEvent('word_lookup', {
    mode: 'explore', learning: learningLang, primary: primaryLang,
    level, word_type: wordType, cache_hit: false,
  });

  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: await buildHeaders(),
    body: JSON.stringify({
      learning_language: learningLang,
      primary_language:  primaryLang,
      level,
      word_type: wordType,
      mode: 'explore',
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

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) result = JSON.parse(match[0]);
    else throw new Error('Could not parse explore word response. Try again.');
  }

  // 3. Save to cache immediately.
  // Key: input_language = learning_language (word is already in the learning language).
  // CACHE_INDEXED_FIELDS (word_type, recommended_level, part_of_speech) are extracted
  // automatically by setCachedWord, enabling future explore cache hits.
  const normalized = (result.word || '').toLowerCase().trim();
  if (normalized) {
    await setCachedWord(normalized, learningLang, learningLang, primaryLang, 'single', result);
  }

  return result;
}
