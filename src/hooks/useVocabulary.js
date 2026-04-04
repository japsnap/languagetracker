import { useState, useCallback } from 'react';
import { loadWords, saveWords, toggleStar as toggleStarUtil, updateWord, removeWord as removeWordUtil } from '../utils/vocabulary';

export function useVocabulary() {
  const [words, setWords] = useState(() => loadWords());

  const toggleStar = useCallback((id) => {
    setWords(prev => toggleStarUtil(prev, id));
  }, []);

  const updateWordById = useCallback((id, changes) => {
    setWords(prev => updateWord(prev, id, changes));
  }, []);

  // Accepts a fully-constructed word object (caller builds it with the right id).
  const addWord = useCallback((word) => {
    setWords(prev => {
      const updated = [...prev, word];
      saveWords(updated);
      return updated;
    });
  }, []);

  const removeWord = useCallback((id) => {
    setWords(prev => removeWordUtil(prev, id));
  }, []);

  return { words, toggleStar, updateWord: updateWordById, addWord, removeWord };
}
