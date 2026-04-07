import { supabase } from './supabase';

export async function submitFlag(wordId, wordText, reason) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('Not authenticated');
  const { error } = await supabase
    .from('word_flags')
    .insert({ user_id: user.id, word_id: wordId, word_text: wordText, reason });
  if (error) throw error;
}
