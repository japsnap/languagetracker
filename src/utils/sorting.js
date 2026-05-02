import { memorizationLevel } from './vocabulary';

const LEVEL_ORDER = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };

export const SCENES = ['social', 'business', 'travel', 'daily', 'food', 'academic', 'slang', 'other'];

export const SORT_OPTIONS = [
  { value: 'alpha-asc',       label: 'A → Z' },
  { value: 'alpha-desc',      label: 'Z → A' },
  { value: 'level-asc',       label: 'Level: A1 → B2' },
  { value: 'level-desc',      label: 'Level: B2 → A1' },
  { value: 'date-newest',     label: 'Date Added: Newest' },
  { value: 'date-oldest',     label: 'Date Added: Oldest' },
  { value: 'weakest',         label: 'Weakest First' },
  { value: 'last-reviewed',   label: 'Reviewed Longest Ago' },
  { value: 'always-wrong',    label: 'Always Wrong' },
  { value: 'recent-mistakes', label: 'Recent Mistakes' },
];

export const ALL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/**
 * @param {object} opts
 * @param {string}  opts.search
 * @param {string}  opts.sortBy
 * @param {boolean} opts.starredOnly
 * @param {string}  opts.scene
 * @param {string[]} opts.levels
 * @param {string}  opts.language
 * @param {string}  opts.wordType        — '' | 'word' | 'phrase' | 'idiom'
 * @param {object|null} opts.mistakeTimestamps — { [wordId]: isoTimestamp } for recent-mistakes sort
 */
export function filterAndSort(words, { search, sortBy, starredOnly, scene, levels, language, wordType, mistakeTimestamps } = {}) {
  let result = words;

  if (starredOnly) result = result.filter(w => w.starred);
  if (scene) result = result.filter(w => w.scene === scene);
  if (levels && levels.length > 0) result = result.filter(w => levels.includes(w.recommended_level));
  if (language) result = result.filter(w => w.word_language === language);

  // word_type filter — null/missing entries are treated as 'word'
  if (wordType) {
    if (wordType === 'word') {
      result = result.filter(w => !w.word_type || w.word_type === 'word');
    } else {
      result = result.filter(w => w.word_type === wordType);
    }
  }

  // Mistake sorts also act as filters
  if (sortBy === 'always-wrong') {
    result = result.filter(w => (w.error_counter || 0) > 0);
  }
  if (sortBy === 'recent-mistakes' && mistakeTimestamps) {
    result = result.filter(w => w.id in mistakeTimestamps);
  }

  if ((search || '').trim()) {
    const q = search.trim().toLowerCase();
    result = result.filter(
      w =>
        w.word.toLowerCase().includes(q) ||
        w.meaning.toLowerCase().includes(q) ||
        w.example.toLowerCase().includes(q)
    );
  }

  result = [...result].sort(sorter(sortBy, mistakeTimestamps));
  return result;
}

function sorter(sortBy, mistakeTimestamps) {
  switch (sortBy) {
    case 'alpha-asc':    return (a, b) => a.word.localeCompare(b.word);
    case 'alpha-desc':   return (a, b) => b.word.localeCompare(a.word);
    case 'level-asc':    return (a, b) => (LEVEL_ORDER[a.recommended_level] ?? 99) - (LEVEL_ORDER[b.recommended_level] ?? 99);
    case 'level-desc':   return (a, b) => (LEVEL_ORDER[b.recommended_level] ?? 99) - (LEVEL_ORDER[a.recommended_level] ?? 99);
    case 'date-newest':  return (a, b) => b.id - a.id;
    case 'date-oldest':  return (a, b) => a.id - b.id;
    case 'weakest':
      return (a, b) => {
        const ma = memorizationLevel(a), mb = memorizationLevel(b);
        if (ma === null && mb === null) return 0;
        if (ma === null) return -1;
        if (mb === null) return 1;
        return ma - mb;
      };
    case 'last-reviewed':
      return (a, b) => {
        if (!a.last_reviewed && !b.last_reviewed) return 0;
        if (!a.last_reviewed) return -1;
        if (!b.last_reviewed) return 1;
        return new Date(a.last_reviewed) - new Date(b.last_reviewed);
      };
    case 'always-wrong':
      return (a, b) => (b.error_counter || 0) - (a.error_counter || 0);
    case 'recent-mistakes':
      return (a, b) => {
        const ta = mistakeTimestamps?.[a.id];
        const tb = mistakeTimestamps?.[b.id];
        if (!ta && !tb) return 0;
        if (!ta) return 1;
        if (!tb) return -1;
        return new Date(tb) - new Date(ta);
      };
    default: return () => 0;
  }
}
