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
 * Dedicated TEXT columns stored alongside `response` for indexing/querying.
 * Values are extracted from the AI response object (or first item of a multi-mode array).
 * On cache hit, column values backfill any fields missing from older `response` blobs.
 *
 * To add a new indexed text field:
 *   1. Run: ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS <field> text;
 *   2. Add the field name here — extractIndexedFields, getCachedWord, setCachedWord handle it.
 *
 * SQL migrations required for current fields:
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS recommended_level text;
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS base_form text;
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS result_word text;
 *
 * To add a field where the column name differs from the AI response field name, also add
 * an entry to CACHE_INDEXED_ALIASES: { columnName: 'responseFieldName' }.
 */
const CACHE_INDEXED_FIELDS = ['part_of_speech', 'word_type', 'recommended_level', 'base_form', 'result_word'];

/**
 * Maps column names → AI response field names when they differ.
 * result_word stores response.word (the AI-corrected learning-language word).
 * This lets findCachedWordRow search by result_word to match vocabulary words
 * (corrected/translated) back to their cache rows regardless of what the user typed.
 */
const CACHE_INDEXED_ALIASES = {
  result_word: 'word',
};

/**
 * Dedicated JSONB columns stored alongside `response` for on-demand enrichment data.
 * These are NOT extracted from the main word AI response — they are populated separately
 * via setCachedExtra after their own fetch.
 *
 * getCachedWord selects and returns these automatically alongside `response`.
 * setCachedExtra writes them to an existing cache row without touching `response`.
 *
 * To add a new extra JSONB field:
 *   1. Run: ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS <field> jsonb;
 *   2. Add the field name here — getCachedWord returns it, setCachedExtra writes it.
 *
 * SQL migration required for current fields:
 *   ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS ai_insights jsonb;
 */
const CACHE_EXTRA_JSONB_FIELDS = ['ai_insights', 'audio_urls'];

/** Extract CACHE_INDEXED_FIELDS from a response (object or multi-mode array). */
function extractIndexedFields(response) {
  const src = Array.isArray(response) ? response[0] : response;
  if (!src || typeof src !== 'object') return {};
  const result = {};
  for (const field of CACHE_INDEXED_FIELDS) {
    const srcField = CACHE_INDEXED_ALIASES[field] ?? field;
    if (src[srcField] != null) result[field] = src[srcField];
  }
  return result;
}

/**
 * Look up a cached response. Returns the merged object (response + indexed cols +
 * extra JSONB cols), or null on miss. Callers can check any extra field (e.g.
 * result?.ai_insights) without a separate query.
 *
 * @param {string} word            - normalized input word
 * @param {string} inputLang       - language the user typed in
 * @param {string} learningLang    - target word language
 * @param {string} primaryLang     - meaning/notes language
 * @param {string} mode            - 'single' | 'multi' | 'secondary'
 * @returns {*} Cached response (object or array), or null on miss.
 */
export async function getCachedWord(word, inputLang, learningLang, primaryLang, mode) {
  const normalized = word.toLowerCase().trim();
  const selectCols = ['response', ...CACHE_INDEXED_FIELDS, ...CACHE_EXTRA_JSONB_FIELDS].join(', ');
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

  const { response, ...rest } = data; // rest = indexed text cols + extra JSONB cols

  // Multi-mode returns an array — extra column values belong to the first item only;
  // callers receive the raw array and do not use extra cols for multi-mode.
  if (Array.isArray(response)) return response;

  // Single/secondary: merge so that (a) response fields take precedence over indexed
  // fallbacks, and (b) extra JSONB fields (e.g. ai_insights) are available on the result.
  return { ...rest, ...response };
}

/**
 * Find a cache row for a vocabulary word without assuming input_language or input_word.
 *
 * Searches by result_word (the AI-corrected learning-language word stored as a dedicated
 * column) OR input_word as fallback for rows predating the result_word column. This
 * resolves the mismatch where input_word is the raw typed text ("grinder", "buenisima")
 * but vocabulary stores the corrected result ("molinillo", "buenísima").
 *
 * Returns { inputLang, cacheData } — inputLang is the value to pass to setCachedExtra.
 * Returns null if no row found (e.g. cross-language words cached before result_word was
 * added, or words never cached).
 */
export async function findCachedWordRow(word, learningLang, primaryLang, mode) {
  const normalized = word.toLowerCase().trim();
  const selectCols = ['input_word', 'input_language', 'result_word', 'response', ...CACHE_INDEXED_FIELDS, ...CACHE_EXTRA_JSONB_FIELDS, 'audio_urls'].join(', ');

  // Search by result_word OR input_word — result_word matches corrected/translated words;
  // input_word fallback matches old rows and direct same-word lookups.
  const { data, error } = await supabase
    .from('word_cache')
    .select(selectCols)
    .or(`result_word.eq.${normalized},input_word.eq.${normalized}`)
    .eq('learning_language', learningLang)
    .eq('primary_language', primaryLang)
    .eq('mode', mode)
    .limit(1);

  if (error) {
    console.error('[cache] findCachedWordRow failed:', error.message, { word: normalized, learningLang, primaryLang, mode });
    return null;
  }
  if (!data || data.length === 0) {
    console.log('[cache] findCachedWordRow: no row found', { word: normalized, learningLang, primaryLang, mode });
    return null;
  }

  const { input_word, input_language, response, ...rest } = data[0];
  const cacheData = Array.isArray(response) ? response : { ...rest, ...response };
  console.log('[cache] findCachedWordRow hit:', { searchWord: normalized, storedInputWord: input_word, storedInputLang: input_language, learningLang, primaryLang, mode });
  return { inputLang: input_language, inputWord: input_word, cacheData };
}

/**
 * Return one random cached word matching explore filters.
 * Fetches up to `limit` candidates client-side and picks randomly (Supabase has no
 * native ORDER BY RANDOM()).
 *
 * Extensibility: add filter params (e.g. communityPool, topic) here and in the query
 * without touching the caller (fetchExploreWord).
 *
 * @param {string} learningLang
 * @param {string} primaryLang
 * @param {string} level        — 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'
 * @param {string} [wordType]   — 'word' | 'phrase' | 'idiom'; default 'word'
 * @param {number} [limit]      — max rows to fetch before random selection
 */
export async function getRandomCachedExploreWord(
  learningLang, primaryLang, level,
  wordType = 'word', limit = 30
) {
  const { data, error } = await supabase
    .from('word_cache')
    .select('response, word_type, recommended_level, audio_urls')
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

  const pick = data[Math.floor(Math.random() * data.length)];
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

/**
 * Write extra JSONB fields (CACHE_EXTRA_JSONB_FIELDS) to an existing cache row.
 * Uses UPDATE — will not create a new row. If no matching row exists the update is
 * a no-op; the caller should fall back to vocabulary-level storage.
 *
 * Extensibility: add new fields to CACHE_EXTRA_JSONB_FIELDS + run the SQL migration.
 * No changes needed here or in the callers.
 *
 * WHERE key: (result_word, learning_language, primary_language, mode) — matches findCachedWordRow.
 * inputLang is accepted for call-site compatibility but is NOT used in the WHERE clause.
 *
 * @param {string} word         — the AI-corrected result word (matched against result_word column)
 * @param {string} inputLang    — unused in WHERE; kept for call-site compatibility
 * @param {string} learningLang
 * @param {string} primaryLang
 * @param {string} mode
 * @param {object} extraFields  — e.g. { ai_insights: { ... } }
 */
export async function setCachedExtra(word, inputLang, learningLang, primaryLang, mode, extraFields) {
  const normalized = word.toLowerCase().trim();
  const ctx = { word: normalized, learningLang, primaryLang, mode, fields: Object.keys(extraFields) };
  console.log('[cache] setCachedExtra write:', ctx);

  // WHERE matches on result_word (the AI-corrected output word stored as a dedicated column),
  // same key fields as findCachedWordRow. inputLang is NOT in the WHERE — it varies per lookup
  // and is not known reliably at write time.
  // .select() makes Supabase return the updated rows — empty array means no row matched.
  const { data: updated, error } = await supabase
    .from('word_cache')
    .update(extraFields)
    .eq('result_word', normalized)
    .eq('learning_language', learningLang)
    .eq('primary_language', primaryLang)
    .eq('mode', mode)
    .select('result_word');

  if (error) {
    console.error('[cache] setCachedExtra failed:', error.message, ctx);
  } else if (!updated || updated.length === 0) {
    // No row matched result_word at this key — UPDATE is a no-op. Caller's vocabulary write
    // (e.g. vocabulary.ai_insights) still succeeds as the per-user fallback.
    console.log('[cache] setCachedExtra: no cache row at result_word key — skipping', ctx);
  } else {
    console.log('[cache] setCachedExtra OK:', { ...ctx, updatedRows: updated.length });
  }
}
