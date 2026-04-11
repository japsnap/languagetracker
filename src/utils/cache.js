/**
 * Word cache — Supabase-backed lookup cache.
 *
 * Cache key: (input_word, input_language, learning_language, primary_language, mode)
 *
 * Supabase migration (run once):
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS input_language text NOT NULL DEFAULT '';
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT '';
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS primary_language text NOT NULL DEFAULT '';
 *   ALTER TABLE word_cache ADD CONSTRAINT word_cache_three_role_key
 *     UNIQUE (input_word, input_language, learning_language, primary_language, mode);
 *
 * Old entries (keyed on direction/target_language) will be cache misses — no errors.
 */

import { supabase } from './supabase';

/**
 * Dedicated columns stored alongside `response` for indexing/querying.
 *
 * To add a new indexed field:
 *   1. Run: ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS <field> text;
 *   2. Add the field name to this array — everything else is automatic.
 *
 * Values are extracted from the AI response object (or first item of a multi-mode array).
 * On cache hit, column values backfill any fields missing from older `response` blobs.
 */
// SQL migration required for new entries here:
//   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS recommended_level text;
const CACHE_INDEXED_FIELDS = ['part_of_speech', 'word_type', 'recommended_level'];

/** Extract CACHE_INDEXED_FIELDS from a response (object or multi-mode array). */
function extractIndexedFields(response) {
  const src = Array.isArray(response) ? response[0] : response;
  if (!src || typeof src !== 'object') return {};
  return Object.fromEntries(
    CACHE_INDEXED_FIELDS
      .filter(f => src[f] != null)
      .map(f => [f, src[f]])
  );
}

/**
 * Look up a cached response.
 * @param {string} word            - normalized input word
 * @param {string} inputLang       - language the user typed in
 * @param {string} learningLang    - target word language
 * @param {string} primaryLang     - meaning/notes language
 * @param {string} mode            - 'single' | 'multi' | 'secondary'
 * @returns {*} Cached response (object or array), or null on miss.
 */
export async function getCachedWord(word, inputLang, learningLang, primaryLang, mode) {
  const normalized = word.toLowerCase().trim();
  const selectCols = ['response', ...CACHE_INDEXED_FIELDS].join(', ');
  const { data, error } = await supabase
    .from('word_cache')
    .select(selectCols)
    .eq('input_word', normalized)
    .eq('input_language', inputLang)
    .eq('learning_language', learningLang)
    .eq('primary_language', primaryLang)
    .eq('mode', mode)
    .maybeSingle();

  if (error) {
    console.error('[cache] getCachedWord failed:', error.message, { word: normalized, inputLang, learningLang, primaryLang, mode });
    return null;
  }
  if (!data) return null;

  const { response, ...indexedCols } = data;

  // Multi-mode returns an array — indexed column values belong to the first item.
  // Array items contain their own fields from when they were cached; return as-is.
  if (Array.isArray(response)) return response;

  // Single/secondary: merge column values as fallback for entries cached before a field
  // was added to the prompt. Response fields take precedence over column values.
  return { ...indexedCols, ...response };
}

/**
 * Return one random cached word matching explore filters, excluding already-seen words.
 * Fetches up to `limit` candidates client-side and picks randomly (Supabase has no
 * native ORDER BY RANDOM()).
 *
 * Extensibility: add filter params (e.g. communityPool, topic) here and in the query
 * without touching the caller (fetchExploreWord).
 *
 * @param {string}      learningLang
 * @param {string}      primaryLang
 * @param {string}      level        — 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'
 * @param {string}      [wordType]   — 'word' | 'phrase' | 'idiom'; default 'word'
 * @param {Set<string>} [seenWords]  — lowercase word strings already shown this session
 * @param {number}      [limit]      — max rows to fetch before random selection
 */
export async function getRandomCachedExploreWord(
  learningLang, primaryLang, level,
  wordType = 'word', seenWords = new Set(), limit = 30
) {
  const { data, error } = await supabase
    .from('word_cache')
    .select('response, word_type, recommended_level')
    .eq('learning_language', learningLang)
    .eq('primary_language', primaryLang)
    .eq('word_type', wordType)
    .eq('recommended_level', level)
    .eq('mode', 'single')
    .limit(limit);

  if (error) {
    console.error('[cache] getRandomCachedExploreWord failed:', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;

  const candidates = data.filter(row => {
    const w = (row.response?.word || '').toLowerCase().trim();
    return w && !seenWords.has(w);
  });
  if (candidates.length === 0) return null;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const { response, ...indexedCols } = pick;
  // Merge column values as fallback (response fields take precedence)
  return { ...indexedCols, ...response };
}

/**
 * Store a response in the cache.
 * CACHE_INDEXED_FIELDS are extracted from the response and stored as dedicated columns.
 */
export async function setCachedWord(word, inputLang, learningLang, primaryLang, mode, response) {
  const normalized = word.toLowerCase().trim();
  const indexed = extractIndexedFields(response);
  const { error } = await supabase
    .from('word_cache')
    .upsert(
      {
        input_word: normalized,
        input_language: inputLang,
        learning_language: learningLang,
        primary_language: primaryLang,
        mode,
        response,
        ...indexed,
      },
      { onConflict: 'input_word,input_language,learning_language,primary_language,mode' }
    );
  if (error) {
    console.error('[cache] setCachedWord failed:', error.message, { word: normalized, inputLang, learningLang, primaryLang, mode });
  }
}
