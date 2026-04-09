import { supabase } from './supabase';

export async function getCachedWord(word, direction, mode) {
  const normalized = word.toLowerCase().trim();
  const { data, error } = await supabase
    .from('word_cache')
    .select('response')
    .eq('input_word', normalized)
    .eq('direction', direction)
    .eq('mode', mode)
    .maybeSingle();

  if (error || !data) return null;
  return data.response;
}

export async function setCachedWord(word, direction, mode, response) {
  const normalized = word.toLowerCase().trim();
  await supabase
    .from('word_cache')
    .upsert(
      { input_word: normalized, direction, mode, response },
      { onConflict: 'input_word,direction,mode' }
    );
}
