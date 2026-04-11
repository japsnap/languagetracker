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
 * Look up a cached response.
 * @param {string} word            - normalized input word
 * @param {string} inputLang       - language the user typed in
 * @param {string} learningLang    - target word language
 * @param {string} primaryLang     - meaning/notes language
 * @param {string} mode            - 'single' | 'multi' | 'secondary'
 */
export async function getCachedWord(word, inputLang, learningLang, primaryLang, mode) {
  const normalized = word.toLowerCase().trim();
  const { data, error } = await supabase
    .from('word_cache')
    .select('response')
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
  return data.response;
}

/**
 * Store a response in the cache.
 */
export async function setCachedWord(word, inputLang, learningLang, primaryLang, mode, response) {
  const normalized = word.toLowerCase().trim();
  const { error } = await supabase
    .from('word_cache')
    .upsert(
      { input_word: normalized, input_language: inputLang, learning_language: learningLang, primary_language: primaryLang, mode, response },
      { onConflict: 'input_word,input_language,learning_language,primary_language,mode' }
    );
  if (error) {
    console.error('[cache] setCachedWord failed:', error.message, { word: normalized, inputLang, learningLang, primaryLang, mode });
  }
}
