/**
 * Word tag configuration — single source of truth.
 *
 * Each tag has:
 *   key   — stored in vocabulary.tags jsonb array
 *   label — shown in title tooltip
 *   icon  — emoji rendered in TagBar
 *   color — CSS background color when active
 *
 * To add a new tag: add one entry here. No other file needs to change.
 */
export const WORD_TAGS = [
  { key: 'difficult',  label: 'Difficult',  icon: '🔥', color: '#e53935' },
  { key: 'priority',   label: 'Priority',   icon: '⭐', color: '#f9a825' },
  { key: 'review',     label: 'Review',     icon: '🔄', color: '#1e88e5' },
  { key: 'confusing',  label: 'Confusing',  icon: '❓', color: '#8e24aa' },
  { key: 'fun',        label: 'Fun',        icon: '😄', color: '#43a047' },
  { key: 'practical',  label: 'Practical',  icon: '💼', color: '#00897b' },
];

/** Return the tags array after toggling `key` in or out. */
export function toggleTag(tags, key) {
  const arr = Array.isArray(tags) ? tags : [];
  return arr.includes(key) ? arr.filter(t => t !== key) : [...arr, key];
}

/** True if the word has at least one tag present in filterKeys. Empty filterKeys = always true. */
export function wordHasAnyTag(word, filterKeys) {
  if (!filterKeys || filterKeys.length === 0) return true;
  const wordTags = Array.isArray(word.tags) ? word.tags : [];
  return filterKeys.some(k => wordTags.includes(k));
}
