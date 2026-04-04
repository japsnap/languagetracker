import { useState, useEffect, useCallback } from 'react';
import {
  loadWords,
  updateWordDB,
  toggleStarDB,
  addWordDB,
  removeWordDB,
} from '../utils/vocabulary';

export function useVocabulary() {
  const [words, setWords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadWords()
      .then(data => { setWords(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  // Optimistic: update UI instantly, sync to Supabase in background.
  const toggleStar = useCallback((id) => {
    setWords(prev => {
      const word = prev.find(w => w.id === id);
      if (!word) return prev;
      const newStarred = !word.starred;
      toggleStarDB(id, newStarred).catch(err => console.error('toggleStar failed:', err));
      return prev.map(w => w.id === id ? { ...w, starred: newStarred } : w);
    });
  }, []);

  const updateWord = useCallback((id, changes) => {
    setWords(prev => prev.map(w => w.id === id ? { ...w, ...changes } : w));
    updateWordDB(id, changes).catch(err => console.error('updateWord failed:', err));
  }, []);

  // Async: insert to Supabase first to get the real ID, then update state.
  const addWord = useCallback(async (wordData) => {
    const saved = await addWordDB(wordData);
    setWords(prev => [...prev, saved]);
    return saved;
  }, []);

  // Optimistic: remove from UI instantly, sync to Supabase in background.
  const removeWord = useCallback((id) => {
    setWords(prev => prev.filter(w => w.id !== id));
    removeWordDB(id).catch(err => console.error('removeWord failed:', err));
  }, []);

  return { words, loading, error, toggleStar, updateWord, addWord, removeWord };
}
