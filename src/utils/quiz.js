import { memorizationLevel } from './vocabulary';

/**
 * Build the quiz pool from all words based on current settings.
 */
export function buildPool(words, { levels, starredOnly, includeMastered, scene }) {
  return words.filter(word => {
    if (!includeMastered && word.mastered) return false;
    if (starredOnly && !word.starred) return false;
    if (levels.length > 0 && !levels.includes(word.recommended_level)) return false;
    if (scene && word.scene !== scene) return false;
    return true;
  });
}

/**
 * Pick the next word using weighted randomization.
 * - Never reviewed: highest priority
 * - Lower memorization %: higher priority
 * - Not reviewed recently: higher priority
 * Excludes lastShownId when pool has > 1 word.
 */
export function pickNext(pool, lastShownId) {
  if (pool.length === 0) return null;

  const candidates =
    pool.length > 1 ? pool.filter(w => w.id !== lastShownId) : pool;

  const weights = candidates.map(wordWeight);
  const total = weights.reduce((a, b) => a + b, 0);

  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

function wordWeight(word) {
  if (!word.last_reviewed) return 500;

  const daysSince =
    (Date.now() - new Date(word.last_reviewed).getTime()) / 86_400_000;

  const mem = memorizationLevel(word);
  const accuracyWeight = mem !== null ? Math.max(0, 100 - mem) : 40;
  const recencyWeight = Math.min(daysSince * 10, 50);

  return accuracyWeight + recencyWeight + 1;
}
