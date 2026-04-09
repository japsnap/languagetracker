import { supabase } from './supabase';

export async function getCachedWord(word, direction, mode, target_language = 'en') {
  const normalized = word.toLowerCase().trim();
  const { data, error } = await supabase
    .from('word_cache')
    .select('response')
    .eq('input_word', normalized)
    .eq('direction', direction)
    .eq('mode', mode)
    .eq('target_language', target_language)
    .maybeSingle();

  if (error || !data) return null;
  return data.response;
}

export async function setCachedWord(word, direction, mode, response, target_language = 'en') {
  const normalized = word.toLowerCase().trim();
  await supabase
    .from('word_cache')
    .upsert(
      { input_word: normalized, direction, mode, target_language, response },
      { onConflict: 'input_word,direction,mode,target_language' }
    );
}
