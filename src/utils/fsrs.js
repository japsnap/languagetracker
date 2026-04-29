import { fsrs, generatorParameters, createEmptyCard, Rating, State } from 'ts-fsrs';

// Baseline response-time thresholds (ms) for Hard mode grade inference.
// These are intentionally simple baselines — will scale with word length per-call.
// v1.5 plan: tune these per language after collecting review_log data.
const HARD_MODE_THRESHOLDS = {
  easy_max_ms: 7000,
  good_max_ms: 12000,
};

const DEFAULT_DESIRED_RETENTION = 0.80;

// ---------------------------------------------------------------------------
// Scheduler factory
// ---------------------------------------------------------------------------

/**
 * Create a configured FSRS scheduler instance.
 *
 * @param {number} [desiredRetention=DEFAULT_DESIRED_RETENTION] - Target retention probability (0–1).
 * @param {number[]|null} [weights=null] - Custom FSRS weight vector; null uses library defaults.
 * @returns {import('ts-fsrs').FSRS} Configured FSRS instance.
 */
export function getFsrsInstance(desiredRetention = DEFAULT_DESIRED_RETENTION, weights = null) {
  return fsrs(generatorParameters({
    request_retention: desiredRetention,
    ...(weights ? { w: weights } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Grade inference
// ---------------------------------------------------------------------------

/**
 * Infer an FSRS grade from Hard mode (typed production) outcome and response time.
 * Thresholds scale linearly with word length so long words aren't unfairly penalised.
 *
 * @param {object} params
 * @param {boolean} params.isCorrect - Whether the typed answer was accepted.
 * @param {number} params.responseTimeMs - Milliseconds from card display to submission.
 * @param {number} params.wordLength - Character length of the target word.
 * @returns {'again'|'hard'|'good'|'easy'} Inferred grade string.
 */
export function inferGradeHardMode({ isCorrect, responseTimeMs, wordLength }) {
  if (!isCorrect) return 'again';

  // Scale factor: words shorter than 6 chars keep baseline; longer words get more time.
  const scale = Math.max(1, wordLength / 6);
  const scaledEasy = HARD_MODE_THRESHOLDS.easy_max_ms * scale;
  const scaledGood = HARD_MODE_THRESHOLDS.good_max_ms * scale;

  if (responseTimeMs < scaledEasy) return 'easy';
  if (responseTimeMs <= scaledGood) return 'good';
  return 'hard';
}

/**
 * Map an Easy mode tap icon to a grade string.
 *
 * @param {'❌'|'🤷'|'✅'|'🎯'} userTap - The icon the user tapped to self-assess.
 * @returns {'again'|'hard'|'good'|'easy'} Grade string.
 */
export function inferGradeEasyMode(userTap) {
  const map = {
    '❌': 'again',
    '🤷': 'hard',
    '✅': 'good',
    '🎯': 'easy',
  };
  return map[userTap] ?? 'good';
}

// ---------------------------------------------------------------------------
// Rating / State helpers
// ---------------------------------------------------------------------------

/**
 * Convert a grade string to the ts-fsrs Rating enum value.
 *
 * @param {'again'|'hard'|'good'|'easy'} grade
 * @returns {Rating} ts-fsrs Rating constant.
 */
export function gradeToRating(grade) {
  const map = {
    again: Rating.Again,
    hard: Rating.Hard,
    good: Rating.Good,
    easy: Rating.Easy,
  };
  return map[grade] ?? Rating.Good;
}

/**
 * Map a ts-fsrs State enum value to its lowercase string representation.
 *
 * @param {State} state - ts-fsrs State enum value.
 * @returns {'new'|'learning'|'review'|'relearning'} Human-readable state string.
 */
export function mapFsrsStateToString(state) {
  const map = {
    [State.New]: 'new',
    [State.Learning]: 'learning',
    [State.Review]: 'review',
    [State.Relearning]: 'relearning',
  };
  return map[state] ?? 'new';
}

/**
 * Map a state string back to the ts-fsrs State enum value.
 *
 * @param {'new'|'learning'|'review'|'relearning'} stateStr - String from the DB.
 * @returns {State} ts-fsrs State constant.
 */
export function mapStateToFsrsState(stateStr) {
  const map = {
    new: State.New,
    learning: State.Learning,
    review: State.Review,
    relearning: State.Relearning,
  };
  return map[stateStr] ?? State.New;
}

// ---------------------------------------------------------------------------
// Core scheduling
// ---------------------------------------------------------------------------

/**
 * Schedule the next review for a word using FSRS.
 *
 * Pass currentState=null for a word's first-ever review — an empty card will be created.
 * For subsequent reviews, pass the current row from the fsrs_word_state table.
 *
 * @param {object} params
 * @param {object|null} params.currentState - Current fsrs_word_state DB row; null if first review.
 *   Expected shape: { due_at, stability, difficulty, review_count, lapse_count,
 *                     state, last_review_at }
 * @param {'again'|'hard'|'good'|'easy'} params.grade - Grade for this review.
 * @param {number} [params.desiredRetention=DEFAULT_DESIRED_RETENTION] - Target retention (0–1).
 * @param {number[]|null} [params.weights=null] - Custom FSRS weights; null uses defaults.
 * @param {Date} [params.now=new Date()] - Review timestamp; injectable for testing.
 * @returns {{
 *   card: object,
 *   log: object,
 *   next_state: string,
 *   due_at: string,
 *   stability: number,
 *   difficulty: number,
 *   elapsed_days: number,
 *   review_count: number,
 *   lapse_count: number
 * }} Scheduling result — use next_state/due_at/etc. for DB writes, card/log for debugging.
 */
export function scheduleReview({
  currentState,
  grade,
  desiredRetention = DEFAULT_DESIRED_RETENTION,
  weights = null,
  now = new Date(),
}) {
  let card;

  // Treat as a fresh card if: no prior state, state='new', or stability is absent.
  // Backfilled word_reviews_state rows have state='new' with null stability/difficulty —
  // correct data shape for an untouched card, but ts-fsrs requires non-null DSR values
  // when reconstructing from a DB row. createEmptyCard is the correct path for these.
  const isUntouched = !currentState || currentState.state === 'new' || currentState.stability == null;

  if (isUntouched) {
    card = createEmptyCard(now);
  } else {
    const lastReview = currentState.last_review_at
      ? new Date(currentState.last_review_at)
      : undefined;

    const elapsedDays = lastReview
      ? Math.max(0, Math.floor((now - lastReview) / 86_400_000))
      : 0;

    card = {
      due: new Date(currentState.due_at),
      stability: currentState.stability,
      difficulty: currentState.difficulty,
      elapsed_days: elapsedDays,
      scheduled_days: 0,
      reps: currentState.review_count,
      lapses: currentState.lapse_count,
      state: mapStateToFsrsState(currentState.state),
      last_review: lastReview,
    };
  }

  const f = getFsrsInstance(desiredRetention, weights);
  const scheduling = f.repeat(card, now);
  const result = scheduling[gradeToRating(grade)];
  const { card: nextCard, log } = result;

  return {
    card: nextCard,
    log,
    next_state: mapFsrsStateToString(nextCard.state),
    due_at: nextCard.due.toISOString(),
    stability: nextCard.stability,
    difficulty: nextCard.difficulty,
    elapsed_days: nextCard.elapsed_days,
    review_count: nextCard.reps,
    lapse_count: nextCard.lapses,
  };
}

// ---------------------------------------------------------------------------
// Review log builder
// ---------------------------------------------------------------------------

/**
 * Build a row object suitable for inserting into the review_log table.
 * Computes local_hour and day_of_week from the current time in the user's timezone
 * using the Intl API — no external dependency required.
 *
 * @param {object} params
 * @param {string} params.userId - Supabase user UUID.
 * @param {string} params.wordId - Vocabulary row UUID.
 * @param {'easy'|'hard'} params.mode - Quiz mode at time of review.
 * @param {string} params.sessionId - Client-generated UUID stable for the quiz session.
 * @param {number} params.sessionPosition - 1-indexed position of this answer in the session.
 * @param {'again'|'hard'|'good'|'easy'} params.grade - FSRS grade applied.
 * @param {number} params.responseTimeMs - Milliseconds from card display to submission.
 * @param {boolean} params.isCorrect - Whether the answer was accepted.
 * @param {object|null} params.stateBefore - fsrs_word_state row before this review (null if new).
 * @param {object} params.stateAfter - Return value from scheduleReview().
 * @param {string} [params.device='web'] - Device/platform string (e.g. 'web', 'pwa').
 * @param {string} [params.inputMethod='typed'] - How the answer was entered ('typed'|'tap').
 * @param {string|null} [params.interferenceWordId=null] - UUID of word shown in collision hint.
 * @param {string} [params.userTimezone] - IANA timezone (e.g. 'America/New_York'); falls back to local.
 * @returns {object} Row ready for supabase.from('review_log').insert().
 */
export function buildReviewLogRow({
  userId,
  wordId,
  mode,
  sessionId,
  sessionPosition,
  grade,
  responseTimeMs,
  isCorrect,
  stateBefore,
  stateAfter,
  device = 'web',
  inputMethod = 'typed',
  interferenceWordId = null,
  userTimezone,
}) {
  const now = new Date();
  const tz = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Re-parse now into the user's timezone so .getHours()/.getDay() return local values.
  // day_of_week is SMALLINT in the schema: 0=Sunday … 6=Saturday.
  const localDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const localHour = localDate.getHours();  // 0-23
  const dayOfWeek = localDate.getDay();    // 0-6

  return {
    user_id: userId,
    word_id: wordId,
    mode,
    session_id: sessionId,
    session_position: sessionPosition,
    grade,
    response_time_ms: responseTimeMs,
    is_correct: isCorrect,
    state_before: stateBefore?.state ?? null,
    stability_before: stateBefore?.stability ?? null,
    difficulty_before: stateBefore?.difficulty ?? null,
    state_after: stateAfter.next_state,
    stability_after: stateAfter.stability,
    difficulty_after: stateAfter.difficulty,
    device,
    input_method: inputMethod,
    interference_word_id: interferenceWordId,
    local_hour: localHour,
    day_of_week: dayOfWeek,
    reviewed_at: now.toISOString(),
  };
}

// Structure: new modes (conjugation/cloze/audio) just need entries in mode checks — FSRS logic is mode-agnostic.
