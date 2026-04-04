/**
 * Data layer — all reads/writes go through here.
 * To migrate to Supabase: replace localStorage calls with API calls.
 */

import seedData from '../data/vocabulary.json';

const STORAGE_KEY = 'spanish_vocab_v1';

export function loadWords() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // corrupted storage — fall through to seed
  }
  saveWords(seedData);
  return seedData;
}

export function saveWords(words) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
}

export function updateWord(words, id, changes) {
  const updated = words.map(w => (w.id === id ? { ...w, ...changes } : w));
  saveWords(updated);
  return updated;
}

export function toggleStar(words, id) {
  const word = words.find(w => w.id === id);
  if (!word) return words;
  return updateWord(words, id, { starred: !word.starred });
}

export function removeWord(words, id) {
  const updated = words.filter(w => w.id !== id);
  saveWords(updated);
  return updated;
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
