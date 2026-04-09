/**
 * Data layer — all reads/writes go through Supabase.
 * Pure helpers (localToday, memorizationLevel) are unchanged.
 */

import { supabase } from './supabase';
import { logEvent } from './events';

const TABLE = 'vocabulary';

export async function loadWords() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('id', { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function updateWordDB(id, changes) {
  const { error } = await supabase
    .from(TABLE)
    .update(changes)
    .eq('id', id);

  if (error) throw new Error(error.message);
}

export async function toggleStarDB(id, starred) {
  return updateWordDB(id, { starred });
}

export async function addWordDB(wordData) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ ...wordData, user_id: user?.id })
    .select()
    .single();

  if (error) throw new Error(error.message);
  logEvent('word_added', { word: wordData.word, recommended_level: wordData.recommended_level });
  return data;
}

export async function removeWordDB(id) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', id);

  if (error) throw new Error(error.message);
}

/** Returns today's date as YYYY-MM-DD in the user's local timezone. */
export function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function memorizationLevel(word) {
  if (word.total_attempts < 3) return null;
  return Math.round(((word.total_attempts - word.error_counter) / word.total_attempts) * 100);
}
