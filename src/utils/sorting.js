import { memorizationLevel } from './vocabulary';

const LEVEL_ORDER = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };

export const SCENES = ['social', 'business', 'travel', 'daily', 'food', 'academic', 'slang', 'other'];

export const SORT_OPTIONS = [
  { value: 'alpha-asc',     label: 'A → Z' },
  { value: 'alpha-desc',    label: 'Z → A' },
  { value: 'level-asc',     label: 'Level: A1 → B2' },
  { value: 'level-desc',    label: 'Level: B2 → A1' },
  { value: 'date-newest',   label: 'Date Added: Newest' },
  { value: 'date-oldest',   label: 'Date Added: Oldest' },
  { value: 'weakest',       label: 'Weakest First' },
  { value: 'last-reviewed', label: 'Least Recently Reviewed' },
];

export const ALL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export function filterAndSort(words, { search, sortBy, starredOnly, scene, levels }) {
  let result = words;

  if (starredOnly) result = result.filter(w => w.starred);
  if (scene) result = result.filter(w => w.scene === scene);
  if (levels && levels.length > 0) result = result.filter(w => levels.includes(w.recommended_level));

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    result = result.filter(
      w =>
        w.word.toLowerCase().includes(q) ||
        w.meaning.toLowerCase().includes(q) ||
        w.example.toLowerCase().includes(q)
    );
  }

  result = [...result].sort(sorter(sortBy));
  return result;
}

function sorter(sortBy) {
  switch (sortBy) {
    case 'alpha-asc':    return (a, b) => a.word.localeCompare(b.word);
    case 'alpha-desc':   return (a, b) => b.word.localeCompare(a.word);
    case 'level-asc':    return (a, b) => (LEVEL_ORDER[a.recommended_level] ?? 99) - (LEVEL_ORDER[b.recommended_level] ?? 99);
    case 'level-desc':   return (a, b) => (LEVEL_ORDER[b.recommended_level] ?? 99) - (LEVEL_ORDER[a.recommended_level] ?? 99);
    case 'date-newest':  return (a, b) => new Date(b.date_added) - new Date(a.date_added);
    case 'date-oldest':  return (a, b) => new Date(a.date_added) - new Date(b.date_added);
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
    default: return () => 0;
  }
}
