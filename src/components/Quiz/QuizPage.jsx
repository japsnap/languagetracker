import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { buildPool } from '../../utils/quiz';
import { SCENES } from '../../utils/sorting';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../Auth/AuthProvider';
import FlagButton from '../FlagButton/FlagButton';
import SpeakerButton from '../SpeakerButton/SpeakerButton';
import TagBar from '../TagBar/TagBar';
import { logEvent } from '../../utils/events';
import { scheduleReview, buildReviewLogRow, inferGradeHardMode, inferGradeEasyMode } from '../../utils/fsrs';
import { logInterferenceEvent } from '../../utils/interference';
import { lookupSecondary } from '../../utils/anthropic';
import ExploreMode from './ExploreMode';
import styles from './QuizPage.module.css';

const ALL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const LEVEL_COLORS = {
  A1: 'var(--level-a1)',
  A2: 'var(--level-a2)',
  B1: 'var(--level-b1)',
  B2: 'var(--level-b2)',
  C1: 'var(--level-c1)',
  C2: 'var(--level-c2)',
};

// 'easy' added for FSRS 🎯 Easy button (Easy mode only)
const ANSWER_ICONS = { easy: '🎯', correct: '✅', wrong: '❌', 'not-sure': '🤔' };

const EMPTY_SESSION = { correct: 0, wrong: 0, notSure: 0, streak: 0, bestStreak: 0 };

const NON_LATIN = new Set(['ja', 'ko', 'zh', 'ur', 'hi']);

// Session limit constants — module-level so a future config can override without rewriting the flow.
const SESSION_LIMITS         = { easy: 30, hard: 20 };
const SESSION_EXTENSION      = 10;
const SESSION_HARD_CAP       = 100;
const COFFEE_FEATURES_ENABLED = false;

// ---------------------------------------------------------------------------
// Answer matching helpers (unchanged — see .claude/rules/quiz-answer-matching.md)
// ---------------------------------------------------------------------------

function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const LEADING_ARTICLES = {
  ES: ['un', 'una', 'el', 'la', 'los', 'las'],
  FR: ["l'", 'un', 'une', 'le', 'la', 'les'],
  DE: ['ein', 'eine', 'der', 'die', 'das'],
  IT: ['un', 'una', 'il', 'la', 'i', 'le'],
  PT: ['um', 'uma', 'o', 'a', 'os', 'as'],
  EN: ['a', 'an', 'the'],
};

function stripLeadingArticle(str, langCode) {
  const articles = LEADING_ARTICLES[langCode];
  if (!articles) return str;
  const sorted = [...articles].sort((x, y) => y.length - x.length);
  for (const art of sorted) {
    if (art.endsWith("'")) {
      if (str.startsWith(art)) return str.slice(art.length).trim();
    } else {
      if (str.startsWith(art + ' ')) return str.slice(art.length).trim();
    }
  }
  return str;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Diacritics-only match — same letters, accent differences only.
// Used for the related_words tier: no Levenshtein, no article stripping.
// "espanol" matches "español" but "espaol" does not match "español".
function matchesAccentsOnly(a, b) {
  return stripDiacritics(a.toLowerCase().trim()) === stripDiacritics(b.toLowerCase().trim());
}

// Parse the related_words string (comma-separated) into individual word tokens.
function parseRelatedWords(relatedWords) {
  if (!relatedWords || typeof relatedWords !== 'string') return [];
  return relatedWords.split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

// NOTE: Future fill-in-the-blanks / grammar mode must NOT use this function —
// articles are part of the graded answer there.
function answersMatch(input, correct, langCode = null) {
  const norm = s => stripDiacritics(s.toLowerCase().trim());
  let a = norm(input), b = norm(correct);
  if (langCode) {
    a = stripLeadingArticle(a, langCode);
    b = stripLeadingArticle(b, langCode);
  }
  if (b.length <= 3) return a === b;
  return levenshtein(a, b) <= 1;
}

function normalizeForMatch(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

async function lookupCollision(typedInput, learningLang) {
  try {
    const normalizedInput = normalizeForMatch(typedInput);
    if (normalizedInput.length < 2) return null;
    const prefix = normalizedInput.slice(0, 3);

    const { data: cacheRows } = await supabase
      .from('word_cache')
      .select('result_word, response')
      .eq('learning_language', learningLang)
      .eq('mode', 'single')
      .ilike('result_word', `${prefix}%`)
      .not('result_word', 'is', null)
      .limit(50);

    const cacheMatch = (cacheRows || []).find(
      row => row.result_word && normalizeForMatch(row.result_word) === normalizedInput
    );
    if (cacheMatch) {
      return { correctedWord: cacheMatch.result_word, meaning: cacheMatch.response?.meaning || null };
    }

    const { data: seedRows } = await supabase
      .from('word_seeds')
      .select('word')
      .eq('language', learningLang)
      .ilike('word', `${prefix}%`)
      .limit(50);

    const seedMatch = (seedRows || []).find(
      row => row.word && normalizeForMatch(row.word) === normalizedInput
    );
    if (seedMatch) {
      const { data: seedCacheRows } = await supabase
        .from('word_cache')
        .select('response')
        .eq('result_word', seedMatch.word)
        .eq('learning_language', learningLang)
        .eq('mode', 'single')
        .limit(1);
      return { correctedWord: seedMatch.word, meaning: seedCacheRows?.[0]?.response?.meaning || null };
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Daily new-card limit helpers (module-level, pure)
// ---------------------------------------------------------------------------

/**
 * Returns the UTC timestamp of today's local midnight for a given IANA timezone.
 * Used to scope the daily-new-card count to the user's calendar day.
 */
function getTodayMidnightUTC(timezone) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  // Today as "YYYY-MM-DD" in user's timezone
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  // Compute the UTC offset at this moment via formatToParts (more reliable than toLocaleString→parse)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = parseInt(p.value, 10);
    return acc;
  }, {});
  // offsetMs > 0 means TZ is ahead of UTC (e.g. UTC+9 → offsetMs = +9h)
  const tzAsUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMs = tzAsUTC - now.getTime();
  const [y, m, d] = todayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
}

/**
 * Fetch the number of distinct new-card introductions today for a user.
 * A "new introduction" is a review_log row where state_before IS NULL
 * (the word had no prior FSRS state) and reviewed_at >= today's local midnight.
 */
async function fetchDailyNewCount(userId, timezone) {
  if (!userId) return 0;
  const midnight = getTodayMidnightUTC(timezone);
  try {
    const { data } = await supabase
      .from('review_log')
      .select('word_id')
      .eq('user_id', userId)
      .is('state_before', null)
      .gte('reviewed_at', midnight.toISOString());
    const unique = new Set((data || []).map(r => r.word_id));
    return unique.size;
  } catch {
    return 0; // graceful — review_log table may not exist yet
  }
}

// ---------------------------------------------------------------------------
// FSRS helpers (module-level — no component state, pure or ref-based)
// ---------------------------------------------------------------------------

function detectDevice() {
  if (window.matchMedia('(display-mode: standalone)').matches) return 'pwa';
  if (/Mobi|Android/i.test(navigator.userAgent)) return 'mobile';
  return 'web';
}

/**
 * FSRS-aware card selection with queue mode support.
 *
 * fsrsMode:
 *   'due'  — only show cards that are actually due (review/relearning/learning due now).
 *            Returns null when nothing is due → "All caught up".
 *   'new'  — only show FSRS-untouched new words, respecting daily limit.
 *            Returns null when limit reached or no new words available.
 *   'all'  — existing priority order: due learning → due relearning → new → due review → earliest.
 *            Never returns null for a non-empty pool (falls back to earliest-due).
 *
 * Due learning/relearning MUST fire before new introductions — FSRS learning
 * steps are time-critical (minutes apart) and are lost if skipped.
 *
 * @param {object} newLimitConfig - { unlimited, limit, todayCount }
 * @param {string} fsrsMode - 'all' | 'due' | 'new'
 */
function pickNextFsrs(pool, stateMap, lastShownId, newLimitConfig = {}, fsrsMode = 'all') {
  if (pool.length === 0) return null;
  const candidates = pool.length > 1 ? pool.filter(w => w.id !== lastShownId) : pool;
  if (candidates.length === 0) return pool[0];

  const now = new Date();
  const tagged = candidates.map(w => {
    const s = stateMap.get(w.id);
    return {
      word: w,
      state: s?.state ?? 'new',
      due: s?.due_at ? new Date(s.due_at) : now,
      // review_count from FSRS state row; 0 when no row exists (never graded in FSRS)
      reviewCount: s?.review_count ?? 0,
    };
  });

  // ── 'due' mode: only cards that are actually due right now ────────────────
  if (fsrsMode === 'due') {
    // Strict definition: state IN ('review','relearning') AND due_at <= now().
    // Matches the badge count exactly. Learning cards are excluded — they are
    // mid-session in-flight steps and appear in 'all' mode (tier 1) instead.
    const dueRelearning = tagged.filter(t => t.state === 'relearning' && t.due <= now).sort((a, b) => a.due - b.due);
    if (dueRelearning.length > 0) return dueRelearning[0].word;
    const dueReview = tagged.filter(t => t.state === 'review' && t.due <= now).sort((a, b) => a.due - b.due);
    if (dueReview.length > 0) return dueReview[0].word;
    return null; // nothing due → caller sets doneReason='all_caught_up'
  }

  // ── 'new' mode: only FSRS-untouched new words ─────────────────────────────
  if (fsrsMode === 'new') {
    const { unlimited = false, limit = 20, todayCount = 0 } = newLimitConfig;
    if (!unlimited && todayCount >= limit) return null; // daily limit → 'daily_limit'
    const fsrsUntouched = tagged.filter(t => t.state === 'new' && t.reviewCount === 0);
    if (fsrsUntouched.length === 0) return null; // no new words → 'no_new_words'
    return fsrsUntouched[Math.floor(Math.random() * fsrsUntouched.length)].word;
  }

  // ── 'all' mode: full priority order (never dead-ends) ────────────────────

  // 1. Due 'learning' — most urgent (short FSRS step intervals, must not be skipped)
  const dueLearning = tagged
    .filter(t => t.state === 'learning' && t.due <= now)
    .sort((a, b) => a.due - b.due);
  if (dueLearning.length > 0) return dueLearning[0].word;

  // 2. Due 'relearning' — also time-critical
  const dueRelearning = tagged
    .filter(t => t.state === 'relearning' && t.due <= now)
    .sort((a, b) => a.due - b.due);
  if (dueRelearning.length > 0) return dueRelearning[0].word;

  // 3. FSRS-untouched 'new' words: state='new' AND review_count=0.
  // Uses FSRS-native data, not legacy vocabulary.total_attempts, so words with
  // pre-FSRS quiz history are correctly included as long as they have no FSRS answer yet.
  // Gated by daily_new_limit unless daily_new_unlimited is true.
  const { unlimited = false, limit = 20, todayCount = 0 } = newLimitConfig;
  if (unlimited || todayCount < limit) {
    const fsrsUntouched = tagged.filter(t => t.state === 'new' && t.reviewCount === 0);
    if (fsrsUntouched.length > 0) {
      return fsrsUntouched[Math.floor(Math.random() * fsrsUntouched.length)].word;
    }
  }

  // 4. Remaining 'new' words (FSRS row exists but still in 'new' state with review_count > 0)
  const newWords = tagged.filter(t => t.state === 'new');
  if (newWords.length > 0) {
    return newWords[Math.floor(Math.random() * newWords.length)].word;
  }

  // 5. Due 'review' cards — overdue-first
  const dueReview = tagged
    .filter(t => t.state === 'review' && t.due <= now)
    .sort((a, b) => a.due - b.due);
  if (dueReview.length > 0) return dueReview[0].word;

  // 6. No due cards — show earliest-due so quiz never dead-ends
  return tagged.sort((a, b) => a.due - b.due)[0].word;
}

// ---------------------------------------------------------------------------
// QuizPage component
// ---------------------------------------------------------------------------

export default function QuizPage({ words, onUpdateWord, onAddWord, preferences, onDueCountChange }) {
  const { user } = useAuth();

  // ── existing quiz state ───────────────────────────────────────────────────
  const [settings, setSettings] = useState({
    levels: [],
    starredOnly: false,
    includeMastered: false,
    scene: '',
  });
  const [phase, setPhase] = useState('idle'); // idle | question | revealed | done
  const [current, setCurrent] = useState(null);
  const [lastAnswer, setLastAnswer] = useState(null);
  const [lastShownId, setLastShownId] = useState(null);
  const [session, setSession] = useState(EMPTY_SESSION);
  const [hasChanged, setHasChanged] = useState(false);
  const [prevEntry, setPrevEntry] = useState(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [quizMode, setQuizMode] = useState('easy'); // 'easy' | 'hard'
  const [exploreMode, setExploreMode] = useState(() => words.length === 0);
  const [typedAnswer, setTypedAnswer] = useState('');
  const [langFilter, setLangFilter] = useState('');
  const [collisionInfo, setCollisionInfo] = useState(null);
  const [fsrsMode, setFsrsMode] = useState('all'); // 'all' | 'due' | 'new' — session-only, not persisted
  const [doneReason, setDoneReason] = useState(null);
  const [fsrsDueCount, setFsrsDueCount] = useState(null); // due cards for header badge
  const [secTranslations, setSecTranslations] = useState([]); // secondary lang chips for Easy mode revealed
  const [fillTranslationsLoading, setFillTranslationsLoading] = useState(false);
  const [savedChipLangs, setSavedChipLangs] = useState(() => new Set());
  const [chipHintDismissed, setChipHintDismissed] = useState(
    () => sessionStorage.getItem('quiz_chip_hint_dismissed') === '1'
  );
  const chipViewedIdsRef = useRef(new Set()); // tracks card IDs where chips were seen (for auto-dismiss)
  const [sessionElapsedMs, setSessionElapsedMs] = useState(null); // ms elapsed at session-complete
  const [filtersCollapsed, setFiltersCollapsed] = useState(false); // mobile-only collapse; auto-collapses after first card

  // ── FSRS / session refs (all reads in async fns go through refs) ──────────
  const sessionIdRef            = useRef(null);
  const sessionCreatedRef       = useRef(false);
  const sessionPositionRef      = useRef(0);
  const sessionReviewCountRef   = useRef(0);
  const sessionCorrectCountRef  = useRef(0);
  const sessionResponseTimesRef = useRef([]);
  const revealedAtRef           = useRef(null); // performance.now() when question shown
  const answerInFlightRef       = useRef(false); // prevents duplicate writes from rapid double-clicks
  const reviewsStateMapRef      = useRef(new Map()); // word_id → word_reviews_state row
  const lastFsrsUndoRef         = useRef(null); // undo info for go-back
  const dailyNewCountRef        = useRef(null); // null = unfetched; number = today's new-card count
  const fsrsDueCountRef         = useRef(null); // imperative copy of fsrsDueCount for handleAnswer live decrement
  const onDueCountChangeRef     = useRef(onDueCountChange); // kept current via effect below
  const inactivityTimerRef      = useRef(null);
  const userIdRef               = useRef(null); // stable copy for cleanup/async
  const quizModeRef             = useRef(quizMode); // stable copy for async fns
  const fsrsPrefsRef            = useRef({
    desiredRetention: preferences?.desired_retention ?? 0.80,
    weights: preferences?.fsrs_weights ?? null,
    timezone: preferences?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // ── Session limit refs ──────────────────────────────────────────────────────
  const sessionCardCountRef      = useRef(0);
  const sessionLimitRef          = useRef(null);  // null until first card; set to SESSION_LIMITS[mode]
  const sessionStartTimeRef      = useRef(null);  // Date.now() on first card shown
  const sessionGraduatedRef      = useRef([]);    // {id, word, meaning} — learning/relearning→review
  const sessionWeakRef           = useRef([]);    // {id, word, meaning} — grade='again'
  const sessionGradeBreakdownRef = useRef({});    // grade → count

  // ── keep refs current ────────────────────────────────────────────────────
  useEffect(() => { userIdRef.current = user?.id ?? null; }, [user?.id]);
  useEffect(() => { quizModeRef.current = quizMode; }, [quizMode]);
  useEffect(() => { onDueCountChangeRef.current = onDueCountChange; }, [onDueCountChange]);
  const secTranslationsRef = useRef([]); // stable copy for handleFillTranslations
  useEffect(() => { secTranslationsRef.current = secTranslations; }, [secTranslations]);
  useEffect(() => {
    fsrsPrefsRef.current = {
      desiredRetention: preferences?.desired_retention ?? 0.80,
      weights: preferences?.fsrs_weights ?? null,
      timezone: preferences?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }, [preferences]);

  // ── Auto-collapse filters on mobile when first card appears ──────────────
  const prevPhaseRef = useRef('idle');
  useEffect(() => {
    if (prevPhaseRef.current === 'idle' && phase === 'question') {
      setFiltersCollapsed(true);
    }
    prevPhaseRef.current = phase;
  }, [phase]);

  // ── Enter key advances on revealed phase ─────────────────────────────────
  const startOrNextRef = useRef(null);
  startOrNextRef.current = startOrNext;
  useEffect(() => {
    if (phase !== 'revealed') return;
    let handler = null;
    const tid = setTimeout(() => {
      handler = (e) => {
        if (e.key !== 'Enter') return;
        if (document.activeElement?.tagName === 'BUTTON') return;
        startOrNextRef.current();
      };
      document.addEventListener('keydown', handler);
    }, 0);
    return () => {
      clearTimeout(tid);
      if (handler) document.removeEventListener('keydown', handler);
    };
  }, [phase]);

  // ── Secondary language translation chips (Easy mode revealed) ───────────
  useEffect(() => {
    if (phase !== 'revealed' || quizMode !== 'easy' || !current) {
      setSecTranslations([]);
      return;
    }
    const learningLang = preferences?.learning_language || 'es';
    const wordLang    = current.word_language || learningLang;
    const wordNorm    = current.word.toLowerCase().trim();

    const candidateLangs    = chipCandidateLangs;
    const candidateLangSet  = new Set(candidateLangs);
    if (!candidateLangs.length) { setSecTranslations([]); return; }

    // ── Path 1: vocabulary siblings (same lookup_session_id, different word_language)
    // Instant — data already in the words prop. Works for polyglot saves (tags=['polyglot'])
    // added in the same Input lookup session since lookup_session_id was introduced.
    const vocabChips = [];
    const coveredLangs = new Set();
    if (current.lookup_session_id) {
      for (const w of words) {
        if (
          w.lookup_session_id === current.lookup_session_id &&
          w.id !== current.id &&
          w.word_language &&
          candidateLangSet.has(w.word_language) &&
          !coveredLangs.has(w.word_language)
        ) {
          const langObj = SUPPORTED_LANGUAGES.find(l => l.code === w.word_language);
          if (langObj) {
            vocabChips.push({ lang: w.word_language, flag: langObj.flag, word: w.word, romanization: w.romanization || null, kana_reading: w.kana_reading || null, meaning: w.meaning || '', word_type: w.word_type || 'word', recommended_level: w.recommended_level || null, part_of_speech: w.part_of_speech || null, example: w.example || '' });
            coveredLangs.add(w.word_language);
          }
        }
      }
    }
    if (vocabChips.length > 0) setSecTranslations(vocabChips);

    // ── Path 2: word_cache lookup for langs not covered by vocab siblings
    const remainingLangs = candidateLangs.filter(l => !coveredLangs.has(l));
    if (!remainingLangs.length) return;

    let cancelled = false;
    (async () => {
      try {
        // Step 1a: narrow query — result_word + learning_language + mode='single'
        const { data: primNarrow, error: primNarrowErr } = await supabase
          .from('word_cache')
          .select('input_word, input_language, primary_language, mode, learning_language')
          .ilike('result_word', wordNorm)
          .eq('learning_language', wordLang)
          .eq('mode', 'single')
          .limit(1);

        if (cancelled) return;

        // Step 1b: loose query — result_word ilike only, no mode/language filter.
        // Runs only when narrow finds nothing. Catches rows cached under 'multi',
        // old 'secondary', or with a different learning_language than expected.
        let primLoose = null;
        let primLooseErr = null;
        if (!primNarrow?.[0]) {
          const res = await supabase
            .from('word_cache')
            .select('input_word, input_language, primary_language, mode, learning_language')
            .ilike('result_word', wordNorm)
            .limit(5);
          if (cancelled) return;
          primLoose = res.data;
          primLooseErr = res.error;
        }

        const primRow = primNarrow?.[0] ?? primLoose?.[0] ?? null;
        const inputWord   = primRow?.input_word    ?? wordNorm;
        const inputLang   = primRow?.input_language ?? wordLang;
        const primaryLang = primRow?.primary_language ?? (preferences?.primary_language || 'en');

        // Step 2: fetch remaining secondary lang rows in parallel
        const results = await Promise.all(
          remainingLangs.map(secLang =>
            supabase
              .from('word_cache')
              .select('result_word, response')
              .eq('input_word', inputWord)
              .eq('input_language', inputLang)
              .eq('learning_language', secLang)
              .eq('primary_language', primaryLang)
              .eq('mode', 'single')
              .limit(1)
              .then(r => ({ ...r, secLang }))
          )
        );

        if (cancelled) return;

        const cacheChips = results
          .map(({ data, secLang }) => {
            const row = data?.[0];
            if (!row?.result_word) return null;
            const langObj = SUPPORTED_LANGUAGES.find(l => l.code === secLang);
            if (!langObj) return null;
            const resp = row.response || {};
            return { lang: secLang, flag: langObj.flag, word: row.result_word, romanization: resp.romanization || null, kana_reading: resp.kana_reading || null, meaning: resp.meaning || '', word_type: resp.word_type || 'word', recommended_level: resp.recommended_level || null, part_of_speech: resp.part_of_speech || null, example: resp.example || '' };
          })
          .filter(Boolean);

        if (cacheChips.length > 0) {
          setSecTranslations(prev => {
            const seen = new Set(prev.map(c => c.lang));
            return [...prev, ...cacheChips.filter(c => !seen.has(c.lang))];
          });
        }
      } catch (err) {
        console.error('[chips][path2-error]', err);
      }
    })();

    return () => { cancelled = true; };
  }, [phase, quizMode, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-set lang filter from preferences (once) ─────────────────────────
  const langFilterAutoSet = useRef(false);
  useEffect(() => {
    if (!langFilterAutoSet.current && preferences?.learning_language) {
      setLangFilter(preferences.learning_language);
      langFilterAutoSet.current = true;
    }
  }, [preferences?.learning_language]);

  // ── Chip candidate languages for current card (Easy mode) ────────────────
  // Shared between the chips useEffect and handleFillTranslations.
  const chipCandidateLangs = useMemo(() => {
    if (!current || quizMode !== 'easy') return [];
    const secLangs     = (preferences?.secondary_languages || []).slice(0, 4);
    const learningLang = preferences?.learning_language || 'es';
    const wordLang     = current.word_language || learningLang;
    return [...new Set([...secLangs, learningLang])].filter(l => l !== wordLang);
  }, [current?.id, quizMode, preferences?.secondary_languages, preferences?.learning_language]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset fill/save state when the card changes
  useEffect(() => { setFillTranslationsLoading(false); setSavedChipLangs(new Set()); }, [current?.id]);

  function dismissChipHint() {
    setChipHintDismissed(true);
    sessionStorage.setItem('quiz_chip_hint_dismissed', '1');
  }

  // Auto-dismiss chip hint after 3 unique card views that showed chips
  useEffect(() => {
    if (chipHintDismissed || phase !== 'revealed' || secTranslations.length === 0 || !current?.id) return;
    if (chipViewedIdsRef.current.has(current.id)) return;
    chipViewedIdsRef.current.add(current.id);
    if (chipViewedIdsRef.current.size >= 3) dismissChipHint();
  }, [phase, secTranslations.length, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fill translations — fires lookupSecondary for each missing chip lang ──
  const handleFillTranslations = useCallback(async () => {
    if (!current || fillTranslationsLoading) return;
    const missingLangs = chipCandidateLangs
      .filter(l => !secTranslationsRef.current.some(c => c.lang === l))
      .slice(0, 3);
    if (!missingLangs.length) return;

    setFillTranslationsLoading(true);

    const wordNorm    = current.word.toLowerCase().trim();
    const wordLang    = current.word_language || preferences?.learning_language || 'es';
    const primaryLang = preferences?.primary_language || 'en';

    // Resolve the primary cache row to get the canonical input_word / input_language
    let inputWord = wordNorm;
    let inputLang = wordLang;
    try {
      const { data: narrow } = await supabase
        .from('word_cache')
        .select('input_word, input_language')
        .ilike('result_word', wordNorm)
        .eq('learning_language', wordLang)
        .eq('mode', 'single')
        .limit(1);
      if (narrow?.[0]) {
        inputWord = narrow[0].input_word;
        inputLang = narrow[0].input_language;
      } else {
        const { data: loose } = await supabase
          .from('word_cache')
          .select('input_word, input_language')
          .ilike('result_word', wordNorm)
          .limit(1);
        if (loose?.[0]) { inputWord = loose[0].input_word; inputLang = loose[0].input_language; }
      }
    } catch { /* continue with defaults */ }

    // Fire all lookups in parallel — fire-and-forget; advancing card is fine
    Promise.all(
      missingLangs.map(async secLang => {
        try {
          const result = await lookupSecondary(inputWord, inputLang, secLang, primaryLang);
          if (!result?.word) return;
          const langObj = SUPPORTED_LANGUAGES.find(l => l.code === secLang);
          if (!langObj) return;
          setSecTranslations(prev => {
            if (prev.some(c => c.lang === secLang)) return prev;
            return [...prev, {
              lang: secLang, flag: langObj.flag, word: result.word,
              romanization: result.romanization || null, kana_reading: result.kana_reading || null,
              meaning: result.meaning || '', word_type: result.word_type || 'word',
              recommended_level: result.recommended_level || null, part_of_speech: result.part_of_speech || null, example: result.example || '',
            }];
          });
        } catch (err) {
          console.error('[fill-translations] failed for', secLang, err);
        }
      })
    ).finally(() => setFillTranslationsLoading(false));
  }, [current, chipCandidateLangs, fillTranslationsLoading, preferences]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chip save state: 'saved' if saved this session OR already in vocab for that word+lang
  const chipSaveStateMap = useMemo(() => {
    const map = {};
    for (const chip of secTranslations) {
      const inVocab = words.some(
        w => w.word?.toLowerCase() === chip.word?.toLowerCase() && w.word_language === chip.lang
      );
      map[chip.lang] = (inVocab || savedChipLangs.has(chip.lang)) ? 'saved' : 'none';
    }
    return map;
  }, [secTranslations, words, savedChipLangs]);

  const handleSaveChip = useCallback(async (chip) => {
    if (savedChipLangs.has(chip.lang)) return;
    const alreadyInVocab = words.some(
      w => w.word?.toLowerCase() === chip.word?.toLowerCase() && w.word_language === chip.lang
    );
    if (alreadyInVocab) { setSavedChipLangs(prev => new Set([...prev, chip.lang])); return; }

    // Optimistic update + dismiss first-time hint
    setSavedChipLangs(prev => new Set([...prev, chip.lang]));
    dismissChipHint();

    try {
      const today = new Date().toISOString().split('T')[0];
      const { data, error } = await supabase
        .from('vocabulary')
        .insert({
          user_id: user.id,
          word: chip.word,
          word_language: chip.lang,
          meaning: chip.meaning || '',
          word_type: chip.word_type || 'word',
          recommended_level: chip.recommended_level || null,
          part_of_speech: chip.part_of_speech || null,
          example: chip.example || '',
          romanization: chip.romanization || null,
          kana_reading: chip.kana_reading || null,
          tags: ['polyglot'],
          date_added: today,
          starred: false,
          mastered: false,
          total_attempts: 0,
          correct_streak: 0,
          error_counter: 0,
        })
        .select()
        .single();
      if (error) throw error;
      if (data && onAddWord) onAddWord(data);
    } catch (err) {
      console.error('[chip-save] failed', err);
      setSavedChipLangs(prev => { const s = new Set(prev); s.delete(chip.lang); return s; });
    }
  }, [savedChipLangs, words, user?.id, onAddWord]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Computed pools ────────────────────────────────────────────────────────
  const vocabLangs = useMemo(
    () => [...new Set(words.map(w => w.word_language).filter(Boolean))].sort(),
    [words]
  );
  const langFilteredWords = useMemo(
    () => (langFilter ? words.filter(w => w.word_language === langFilter) : words),
    [words, langFilter]
  );
  const pool = useMemo(() => buildPool(langFilteredWords, settings), [langFilteredWords, settings]);

  // ── Load FSRS state map whenever pool or quiz mode changes ────────────────
  useEffect(() => {
    if (!user?.id || pool.length === 0) {
      reviewsStateMapRef.current = new Map();
      setFsrsDueCount(0);
      fsrsDueCountRef.current = 0;
      onDueCountChangeRef.current?.(0);
      return;
    }
    supabase
      .from('word_reviews_state')
      .select('*')
      .eq('user_id', user.id)
      .eq('mode', quizMode)
      .in('word_id', pool.map(w => w.id))
      .then(({ data }) => {
        const map = new Map();
        (data || []).forEach(row => map.set(row.word_id, row));
        reviewsStateMapRef.current = map;
        // Compute how many cards are due for review right now
        const now = new Date();
        const count = (data || []).filter(row =>
          (row.state === 'review' || row.state === 'relearning') &&
          row.due_at && new Date(row.due_at) <= now
        ).length;
        setFsrsDueCount(count);
        fsrsDueCountRef.current = count;
        onDueCountChangeRef.current?.(count);
      })
      .catch(() => {}); // graceful — table may not exist yet
  }, [pool, quizMode, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Flush session on unmount ──────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearTimeout(inactivityTimerRef.current);
      _flushSession();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // FSRS helpers (read from refs — safe to call from stale closures)
  // ---------------------------------------------------------------------------

  function _flushSession() {
    const uid = userIdRef.current;
    const sid = sessionIdRef.current;
    if (!uid || !sid) return;
    const times = sessionResponseTimesRef.current;
    const avgMs = times.length > 0
      ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
      : null;
    supabase.from('sessions').update({
      ended_at: new Date().toISOString(),
      review_count: sessionReviewCountRef.current,
      correct_count: sessionCorrectCountRef.current,
      avg_response_ms: avgMs,
    }).eq('id', sid).then(null, () => {});
  }

  function _resetInactivityTimer() {
    clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(_flushSession, 10 * 60 * 1000);
  }

  async function _createSession() {
    if (sessionCreatedRef.current || !userIdRef.current) return;
    sessionCreatedRef.current = true;
    try {
      const { data } = await supabase
        .from('sessions')
        .insert({
          user_id: userIdRef.current,
          device: detectDevice(),
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (data?.id) sessionIdRef.current = data.id;
    } catch { /* graceful — sessions table may not exist yet */ }
  }

  // Maps answer button type → FSRS grade string.
  // Easy mode: tap maps to FSRS grade via inferGradeEasyMode.
  // Hard mode: isCorrect + responseTimeMs → inferGradeHardMode (tap is irrelevant).
  // New modes: add their own grade inference in a parallel elif branch here.
  function _answerTypeToGrade(type, isHardMode, responseTimeMs, wordLength) {
    if (isHardMode) {
      return inferGradeHardMode({ isCorrect: type === 'correct', responseTimeMs, wordLength });
    }
    const tapToEmoji = { easy: '🎯', correct: '✅', 'not-sure': '🤷', wrong: '❌' };
    return inferGradeEasyMode(tapToEmoji[type] ?? '✅');
  }

  // Core FSRS write: updates word_reviews_state, inserts review_log row.
  // All state read from refs — safe to call from useCallback closures.
  async function _writeFsrsResult(word, type, responseTimeMs) {
    const uid = userIdRef.current;
    if (!uid) return;

    const mode = quizModeRef.current;
    const isHardMode = mode === 'hard';
    const isCorrect = type === 'correct' || type === 'easy';
    const { desiredRetention, weights, timezone } = fsrsPrefsRef.current;
    const grade = _answerTypeToGrade(type, isHardMode, responseTimeMs, word.word.length);
    const currentState = reviewsStateMapRef.current.get(word.id) ?? null;

    let stateAfter;
    try {
      stateAfter = scheduleReview({ currentState, grade, desiredRetention, weights });
    } catch { return; }

    // Upsert word_reviews_state
    let updatedRow = null;
    try {
      const { data } = await supabase
        .from('word_reviews_state')
        .upsert({
          user_id: uid,
          word_id: word.id,
          mode,
          state: stateAfter.next_state,
          stability: stateAfter.stability,
          difficulty: stateAfter.difficulty,
          due_at: stateAfter.due_at,
          last_review_at: new Date().toISOString(),
          review_count: stateAfter.review_count,
          lapse_count: stateAfter.lapse_count,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,word_id,mode' })
        .select()
        .single();
      updatedRow = data;
    } catch { /* graceful — word_reviews_state table may not exist yet */ }

    if (updatedRow) reviewsStateMapRef.current.set(word.id, updatedRow);

    // Insert review_log row
    let reviewLogId = null;
    try {
      sessionPositionRef.current++;
      const logRow = buildReviewLogRow({
        userId: uid,
        wordId: word.id,
        mode,
        sessionId: sessionIdRef.current,
        sessionPosition: sessionPositionRef.current,
        grade,
        responseTimeMs,
        isCorrect,
        stateBefore: currentState,
        stateAfter,
        device: detectDevice(),
        inputMethod: isHardMode ? 'typed' : 'tap',
        userTimezone: timezone,
      });
      const { data } = await supabase
        .from('review_log')
        .insert(logRow)
        .select('id')
        .single();
      reviewLogId = data?.id ?? null;
    } catch { /* graceful — review_log table may not exist yet */ }

    // Store undo info so go-back can revert this write
    lastFsrsUndoRef.current = {
      wordId: word.id,
      mode,
      prevState: currentState,
      reviewLogId,
    };

    // Update session counters
    sessionReviewCountRef.current++;
    if (isCorrect) sessionCorrectCountRef.current++;
    if (responseTimeMs > 0) sessionResponseTimesRef.current.push(responseTimeMs);

    // Session stats tracking (grade breakdown, weak words, graduated words)
    sessionGradeBreakdownRef.current[grade] = (sessionGradeBreakdownRef.current[grade] || 0) + 1;
    if (grade === 'again') {
      if (!sessionWeakRef.current.some(w => w.id === word.id)) {
        sessionWeakRef.current.push({ id: word.id, word: word.word, meaning: word.meaning || '' });
      }
    }
    const stateBefore = currentState?.state ?? null;
    if ((stateBefore === 'learning' || stateBefore === 'relearning') && stateAfter.next_state === 'review') {
      if (!sessionGraduatedRef.current.some(w => w.id === word.id)) {
        sessionGraduatedRef.current.push({ id: word.id, word: word.word, meaning: word.meaning || '' });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  function toggleLevel(level) {
    setSettings(s => ({
      ...s,
      levels: s.levels.includes(level)
        ? s.levels.filter(l => l !== level)
        : [...s.levels, level],
    }));
  }

  function toggleSetting(key) {
    setSettings(s => ({ ...s, [key]: !s[key] }));
  }

  // ---------------------------------------------------------------------------
  // Quiz flow
  // ---------------------------------------------------------------------------

  function startOrNext() {
    // Initialize session limit and start time on the very first card of each session
    if (sessionLimitRef.current === null) {
      sessionLimitRef.current = SESSION_LIMITS[quizMode] ?? SESSION_LIMITS.easy;
      sessionStartTimeRef.current = Date.now();
    }

    // Check session limit before pulling next card
    const nextCardNum = sessionCardCountRef.current + 1;
    if (nextCardNum > sessionLimitRef.current) {
      setSessionElapsedMs(Date.now() - sessionStartTimeRef.current);
      setDoneReason('session_limit');
      setPhase('done');
      return;
    }

    // Lazy-fetch daily new count once per session (fire-and-forget; 0 used until resolved)
    if (dailyNewCountRef.current === null) {
      dailyNewCountRef.current = 0; // optimistic default so quiz doesn't block
      fetchDailyNewCount(userIdRef.current, fsrsPrefsRef.current.timezone)
        .then(count => { dailyNewCountRef.current = count; })
        .catch(() => {});
    }
    const newLimitConfig = {
      unlimited: preferences?.daily_new_unlimited ?? false,
      limit:     preferences?.daily_new_limit     ?? 20,
      todayCount: dailyNewCountRef.current ?? 0,
    };
    const next = pickNextFsrs(pool, reviewsStateMapRef.current, lastShownId, newLimitConfig, fsrsMode);
    if (!next) {
      // Determine why there are no more cards to show
      let reason = 'done';
      if (fsrsMode === 'due') {
        reason = 'all_caught_up';
      } else if (fsrsMode === 'new') {
        const { unlimited, limit, todayCount } = newLimitConfig;
        reason = (!unlimited && todayCount >= limit) ? 'daily_limit' : 'no_new_words';
      }
      setDoneReason(reason);
      setPhase('done');
      return;
    }

    // Commit card count only when a card was actually found
    sessionCardCountRef.current = nextCardNum;

    if (current !== null) {
      setPrevEntry({ word: current, answer: lastAnswer, hasChanged, session, typedAnswer });
      setCanGoBack(true);
    }
    // Create a session row on the first card of each quiz session
    if (!sessionCreatedRef.current) {
      _createSession();
    }
    setCurrent(next);
    setLastShownId(next.id);
    setLastAnswer(null);
    setHasChanged(false);
    setTypedAnswer('');
    setCollisionInfo(null);
    lastFsrsUndoRef.current = null;  // clear stale undo from previous card
    revealedAtRef.current = null;    // reset; timer starts on input focus (Hard mode)
    answerInFlightRef.current = false; // allow answer on the new card
    setPhase('question');
  }

  function handleEndSession() {
    setSessionElapsedMs(Date.now() - (sessionStartTimeRef.current ?? Date.now()));
    setDoneReason('session_limit');
    setPhase('done');
  }

  function handleExtendSession() {
    sessionLimitRef.current = Math.min(sessionCardCountRef.current + SESSION_EXTENSION, SESSION_HARD_CAP);
    startOrNext();
  }

  function handleGoBack() {
    if (!prevEntry || !canGoBack) return;

    if (phase === 'revealed' && current && lastAnswer) {
      // Undo legacy vocab changes (existing behaviour)
      onUpdateWord(current.id, {
        total_attempts:  current.total_attempts,
        correct_streak:  current.correct_streak,
        mastered:        current.mastered,
        error_counter:   current.error_counter,
        last_reviewed:   current.last_reviewed,
      });

      // Undo FSRS writes — delete review_log row and revert word_reviews_state
      if (lastFsrsUndoRef.current) {
        const { wordId, mode, prevState, reviewLogId } = lastFsrsUndoRef.current;
        const uid = userIdRef.current;
        if (uid) {
          if (reviewLogId) {
            supabase.from('review_log').delete().eq('id', reviewLogId).then(null, () => {});
          }
          if (prevState) {
            supabase.from('word_reviews_state')
              .upsert({ ...prevState, updated_at: new Date().toISOString() }, { onConflict: 'user_id,word_id,mode' })
              .then(null, () => {});
            reviewsStateMapRef.current.set(wordId, prevState);
          } else {
            // Word was new — remove the state row entirely
            supabase.from('word_reviews_state')
              .delete()
              .eq('user_id', uid).eq('word_id', wordId).eq('mode', mode)
              .then(null, () => {});
            reviewsStateMapRef.current.delete(wordId);
            // Undo the daily new count increment for this introduction
            dailyNewCountRef.current = Math.max(0, (dailyNewCountRef.current ?? 0) - 1);
          }
          // Revert session counters
          sessionReviewCountRef.current = Math.max(0, sessionReviewCountRef.current - 1);
          if (lastAnswer === 'correct' || lastAnswer === 'easy') {
            sessionCorrectCountRef.current = Math.max(0, sessionCorrectCountRef.current - 1);
          }
          sessionPositionRef.current = Math.max(0, sessionPositionRef.current - 1);
          if (sessionResponseTimesRef.current.length > 0) {
            sessionResponseTimesRef.current = sessionResponseTimesRef.current.slice(0, -1);
          }
        }
        lastFsrsUndoRef.current = null;
      }
    }

    setSession(prevEntry.session);
    setCurrent(prevEntry.word);
    setLastAnswer(prevEntry.answer);
    setHasChanged(prevEntry.hasChanged);
    setTypedAnswer(prevEntry.typedAnswer ?? '');
    setPhase('revealed');
    setCanGoBack(false);
  }

  // Compute legacy vocabulary field changes from a quiz answer.
  // 'easy' treated same as 'correct' for streak purposes.
  // FSRS note: auto-mastered on streak ≥ 5 removed — FSRS state='review' with
  // high stability will replace this concept (v1.5 deprecation path).
  function computeChanges(base, type) {
    const now = new Date().toISOString();
    const changes = {
      total_attempts: base.total_attempts + 1,
      last_reviewed: now,
      error_counter: base.error_counter,
      correct_streak: base.correct_streak,
      mastered: base.mastered,
    };
    if (type === 'correct' || type === 'easy') {
      changes.correct_streak = base.correct_streak + 1;
    } else if (type === 'wrong') {
      changes.error_counter = base.error_counter + 1;
      changes.correct_streak = 0;
    } else {
      // not-sure
      changes.correct_streak = 0;
    }
    return changes;
  }

  // handleAnswer is the single entry point for all answer submissions.
  // Response time is computed from revealedAtRef (set in startOrNext).
  const handleAnswer = useCallback(
    (type) => {
      if (answerInFlightRef.current || !current) return;
      answerInFlightRef.current = true;

      // Capture response time immediately — revealedAt was set when question was shown
      const responseTimeMs = revealedAtRef.current
        ? Math.round(performance.now() - revealedAtRef.current)
        : 0;
      revealedAtRef.current = null;

      // Legacy vocab fields (backward compat — Stats/Review still read these)
      onUpdateWord(current.id, computeChanges(current, type));

      // Preserve existing event logging (do not remove)
      logEvent('quiz_answer', {
        word_id: current.id,
        word: current.word,
        answer: type,
        quiz_mode: quizMode,
      });

      // FSRS write — fire-and-forget; graceful if tables don't exist yet
      _writeFsrsResult(current, type, responseTimeMs).catch(() => {});

      // Track daily new-card count: if this word had no prior FSRS state it's a new introduction
      const fsrsRow = reviewsStateMapRef.current.get(current.id);
      if (!fsrsRow || fsrsRow.review_count === 0) {
        dailyNewCountRef.current = (dailyNewCountRef.current ?? 0) + 1;
      }

      // Live-decrement the due badge when a review/relearning card that was due gets answered
      const wasDueCard = (fsrsRow?.state === 'review' || fsrsRow?.state === 'relearning') &&
        fsrsRow?.due_at && new Date(fsrsRow.due_at) <= new Date();
      if (wasDueCard && fsrsDueCountRef.current !== null) {
        const newCount = Math.max(0, fsrsDueCountRef.current - 1);
        fsrsDueCountRef.current = newCount;
        setFsrsDueCount(newCount);
        onDueCountChangeRef.current?.(newCount);
      }

      // Reset 10-min inactivity flush
      _resetInactivityTimer();

      const isCorrect = type === 'correct' || type === 'easy';
      setSession(prev => {
        const newStreak = isCorrect ? prev.streak + 1 : 0;
        return {
          correct:    prev.correct   + (isCorrect           ? 1 : 0),
          wrong:      prev.wrong     + (type === 'wrong'     ? 1 : 0),
          notSure:    prev.notSure   + (type === 'not-sure'  ? 1 : 0),
          streak:     newStreak,
          bestStreak: Math.max(prev.bestStreak, newStreak),
        };
      });
      setLastAnswer(type);
      setPhase('revealed');
    },
    [current, onUpdateWord, quizMode] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Hard mode typed-answer check. Fires interference log on wrong answer (v1 stub).
  // Cascade: exact/Levenshtein → word_alternatives → related_words (diacritics-only).
  function handleCheckAnswer(typed) {
    if (!typed.trim() || !current) return;
    const lang = current.word_language || preferences?.learning_language || null;
    const isCorrect =
      answersMatch(typed, current.word, lang) ||
      (Array.isArray(current.word_alternatives) &&
        current.word_alternatives.some(alt => answersMatch(typed, alt, lang))) ||
      parseRelatedWords(current.related_words)
        .some(rw => matchesAccentsOnly(typed, rw));

    if (!isCorrect) {
      const lookupLang = current.word_language || preferences?.learning_language || 'es';
      setCollisionInfo(null);
      lookupCollision(typed, lookupLang).then(setCollisionInfo);

      // Log interference event — fire-and-forget stub (v1.5 adds matching logic)
      if (userIdRef.current) {
        logInterferenceEvent({
          userId: userIdRef.current,
          targetWordId: current.id,
          typedText: typed,
          sessionId: sessionIdRef.current,
        }).catch(() => {});
      }
    }

    handleAnswer(isCorrect ? 'correct' : 'wrong');
  }

  // Change-answer undoes legacy fields only (FSRS write already committed with
  // original grade — acceptable for v1; FSRS re-grade on change is v1.5).
  const handleChangeAnswer = useCallback(
    (newType) => {
      if (!current || hasChanged) return;
      onUpdateWord(current.id, computeChanges(current, newType));
      setSession(prev => {
        const old = lastAnswer;
        const oldCorrect = old === 'correct' || old === 'easy';
        const newCorrect = newType === 'correct' || newType === 'easy';
        let newStreak = prev.streak;
        if (oldCorrect && !newCorrect) newStreak = 0;
        else if (!oldCorrect && newCorrect) newStreak = 1;
        return {
          ...prev,
          correct:  prev.correct  - (oldCorrect           ? 1 : 0) + (newCorrect            ? 1 : 0),
          wrong:    prev.wrong    - (old === 'wrong'       ? 1 : 0) + (newType === 'wrong'   ? 1 : 0),
          notSure:  prev.notSure  - (old === 'not-sure'    ? 1 : 0) + (newType === 'not-sure'? 1 : 0),
          streak:   newStreak,
        };
      });
      setLastAnswer(newType);
      setHasChanged(true);
    },
    [current, hasChanged, lastAnswer, onUpdateWord]
  );

  function restart() {
    setSession(EMPTY_SESSION);
    setLastShownId(null);
    setPhase('idle');
    setCurrent(null);
    setLastAnswer(null);
    setHasChanged(false);
    setPrevEntry(null);
    setCanGoBack(false);
    setTypedAnswer('');
    setCollisionInfo(null);
    setDoneReason(null);
    // Reset FSRS session state so next "Start Quiz" creates a fresh session
    sessionCreatedRef.current = false;
    sessionIdRef.current = null;
    sessionPositionRef.current = 0;
    sessionReviewCountRef.current = 0;
    sessionCorrectCountRef.current = 0;
    sessionResponseTimesRef.current = [];
    lastFsrsUndoRef.current = null;
    dailyNewCountRef.current = null; // re-fetch from DB on next session start
    clearTimeout(inactivityTimerRef.current);
    // Reset session limit state
    sessionCardCountRef.current = 0;
    sessionLimitRef.current = null;
    // Reset filter collapse so auto-fold fires again on next session start
    prevPhaseRef.current = 'idle';
    setFiltersCollapsed(false);
    sessionStartTimeRef.current = null;
    sessionGraduatedRef.current = [];
    sessionWeakRef.current = [];
    sessionGradeBreakdownRef.current = {};
    setSessionElapsedMs(null);
  }

  const reviewed = session.correct + session.wrong + session.notSure;
  const currentLangFlag = current?.word_language
    ? SUPPORTED_LANGUAGES.find(l => l.code === current.word_language)?.flag
    : null;

  // Filter summary line shown when collapsed on mobile
  const filterSummary = useMemo(() => {
    if (exploreMode) return 'Explore mode';
    const parts = [];
    if (langFilter) {
      const lObj = SUPPORTED_LANGUAGES.find(l => l.code === langFilter);
      parts.push(`${lObj?.flag ?? ''} ${langFilter.toUpperCase()}`);
    } else {
      parts.push('All languages');
    }
    if (settings.levels.length > 0) {
      parts.push(settings.levels.join('/'));
    } else {
      parts.push('All levels');
    }
    parts.push(`${pool.length} word${pool.length !== 1 ? 's' : ''}`);
    return parts.join(' · ');
  }, [exploreMode, langFilter, settings.levels, pool.length]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.page}>
      {/* Settings strip */}
      <div className={styles.settingsStrip}>

        {/* Mobile toggle bar — only visible on mobile */}
        <button
          className={styles.filtersToggleBar}
          onClick={() => setFiltersCollapsed(c => !c)}
          aria-expanded={!filtersCollapsed}
        >
          <span className={styles.filtersToggleLabel}>
            {filtersCollapsed ? `Filters ▼` : `Filters ▲`}
          </span>
          {filtersCollapsed && (
            <span className={styles.filtersSummary}>{filterSummary}</span>
          )}
        </button>

        {/* Filter groups — hidden on mobile when collapsed */}
        <div className={`${styles.filtersBody} ${filtersCollapsed ? styles.filtersBodyCollapsed : ''}`}>

          {/* FSRS Queue toggle — Due / All / New (session-only, not persisted) */}
          {!exploreMode && (
            <div className={styles.settingsGroup}>
              <span className={styles.settingsLabel}>Queue:</span>
              <button
                className={`${styles.levelBtn} ${fsrsMode === 'due' ? styles.levelActive : ''}`}
                onClick={() => { setFsrsMode('due'); if (phase !== 'idle') restart(); }}
              >
                Due
                {fsrsDueCount !== null && fsrsDueCount > 0 && (
                  <span className={styles.queueDueBadge}>{fsrsDueCount > 99 ? '99+' : fsrsDueCount}</span>
                )}
              </button>
              <button
                className={`${styles.levelBtn} ${fsrsMode === 'all' ? styles.levelActive : ''}`}
                onClick={() => { setFsrsMode('all'); if (phase !== 'idle') restart(); }}
              >
                All
              </button>
              <button
                className={`${styles.levelBtn} ${fsrsMode === 'new' ? styles.levelActive : ''}`}
                onClick={() => { setFsrsMode('new'); if (phase !== 'idle') restart(); }}
              >
                New
              </button>
            </div>
          )}

          {/* Mode toggle — Easy / Hard / Explore */}
          <div className={styles.settingsGroup}>
            <span className={styles.settingsLabel}>Mode:</span>
            <button
              className={`${styles.levelBtn} ${!exploreMode && quizMode === 'easy' ? styles.levelActive : ''}`}
              onClick={() => { setExploreMode(false); setQuizMode('easy'); }}
            >
              Easy
            </button>
            <button
              className={`${styles.levelBtn} ${!exploreMode && quizMode === 'hard' ? styles.levelActive : ''}`}
              onClick={() => { setExploreMode(false); setQuizMode('hard'); }}
            >
              Hard
            </button>
            <button
              className={`${styles.levelBtn} ${exploreMode ? styles.levelActive : ''}`}
              onClick={() => setExploreMode(true)}
            >
              Explore
            </button>
          </div>

          {/* Language filter — only when vocabulary spans multiple languages */}
          {!exploreMode && vocabLangs.length > 1 && (
            <div className={styles.settingsGroup}>
              <span className={styles.settingsLabel}>Language:</span>
              <button
                className={`${styles.levelBtn} ${langFilter === '' ? styles.levelActive : ''}`}
                onClick={() => setLangFilter('')}
              >
                All
              </button>
              {vocabLangs.map(code => {
                const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
                return (
                  <button
                    key={code}
                    className={`${styles.levelBtn} ${langFilter === code ? styles.levelActive : ''}`}
                    onClick={() => setLangFilter(code === langFilter ? '' : code)}
                    title={lang?.label}
                  >
                    {lang?.flag} {code.toUpperCase()}
                  </button>
                );
              })}
            </div>
          )}

          {!exploreMode && (
            <div className={styles.settingsGroup}>
              <span className={styles.settingsLabel}>Level:</span>
              <button
                className={`${styles.levelBtn} ${settings.levels.length === 0 ? styles.levelActive : ''}`}
                onClick={() => setSettings(s => ({ ...s, levels: [] }))}
              >
                All
              </button>
              {ALL_LEVELS.map(lvl => {
                const active = settings.levels.includes(lvl);
                return (
                  <button
                    key={lvl}
                    className={`${styles.levelBtn} ${active ? styles.levelActive : ''}`}
                    style={active ? { backgroundColor: LEVEL_COLORS[lvl], borderColor: LEVEL_COLORS[lvl], color: '#fff' } : {}}
                    onClick={() => toggleLevel(lvl)}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
          )}

          {!exploreMode && (
            <div className={styles.settingsGroup}>
              <span className={styles.settingsLabel}>Scene:</span>
              <select
                className={styles.sceneSelect}
                value={settings.scene}
                onChange={e => setSettings(s => ({ ...s, scene: e.target.value }))}
              >
                <option value="">All</option>
                {SCENES.map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>
          )}

          {!exploreMode && (
            <div className={styles.settingsGroup}>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={settings.starredOnly}
                  onChange={() => toggleSetting('starredOnly')}
                />
                Starred only
              </label>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={settings.includeMastered}
                  onChange={() => toggleSetting('includeMastered')}
                />
                Include mastered
              </label>
            </div>
          )}

          {!exploreMode && (
            <div className={styles.poolCount}>
              Pool: <strong>{pool.length}</strong> word{pool.length !== 1 ? 's' : ''}
            </div>
          )}

        </div>
      </div>

      {/* Session stats strip */}
      {!exploreMode && phase !== 'idle' && (
        <div className={styles.statsStrip}>
          <span className={styles.statItem}>Reviewed: <strong>{reviewed}</strong></span>
          <span className={`${styles.statItem} ${styles.statCorrect}`}>✅ <strong>{session.correct}</strong></span>
          <span className={`${styles.statItem} ${styles.statWrong}`}>❌ <strong>{session.wrong}</strong></span>
          <span className={`${styles.statItem} ${styles.statNotSure}`}>🤔 <strong>{session.notSure}</strong></span>
          <span className={styles.statItem}>Streak: <strong>{session.streak}</strong></span>
          {(phase === 'question' || phase === 'revealed') && (
            <button className={styles.endSessionBtn} onClick={handleEndSession}>End session</button>
          )}
        </div>
      )}

      {/* Explore mode */}
      {exploreMode && (
        <ExploreMode preferences={preferences} words={words} onAddWord={onAddWord} />
      )}

      {/* Quiz mode main area */}
      {!exploreMode && (
        <div className={styles.main}>
          {phase === 'idle' && (
            <IdleScreen pool={pool} onStart={startOrNext} dueCount={fsrsDueCount} fsrsMode={fsrsMode} />
          )}

          {(phase === 'question' || phase === 'revealed') && current && (
            <QuizCard
              word={current}
              phase={phase}
              lastAnswer={lastAnswer}
              hasChanged={hasChanged}
              langFlag={currentLangFlag}
              canGoBack={canGoBack}
              quizMode={quizMode}
              typedAnswer={typedAnswer}
              onTypedAnswerChange={setTypedAnswer}
              onCheckAnswer={handleCheckAnswer}
              onAnswer={handleAnswer}
              onChangeAnswer={handleChangeAnswer}
              onGoBack={handleGoBack}
              onNext={startOrNext}
              onInputFocus={() => { if (!revealedAtRef.current) revealedAtRef.current = performance.now(); }}
              onUpdateWord={onUpdateWord}
              collisionInfo={collisionInfo}
              learningLang={preferences?.learning_language || 'es'}
              primaryLang={preferences?.primary_language || 'en'}
              secTranslations={secTranslations}
              chipCandidateLangs={chipCandidateLangs}
              chipSaveStateMap={chipSaveStateMap}
              hasUnsavedChips={secTranslations.some(c => chipSaveStateMap[c.lang] !== 'saved')}
              showChipHint={!chipHintDismissed}
              fillTranslationsLoading={fillTranslationsLoading}
              onFillTranslations={handleFillTranslations}
              onSaveChip={handleSaveChip}
            />
          )}

          {phase === 'done' && doneReason === 'session_limit' && (
            <SessionCompleteScreen
              session={session}
              reviewed={reviewed}
              sessionElapsedMs={sessionElapsedMs}
              sessionGraduated={sessionGraduatedRef.current}
              sessionWeak={sessionWeakRef.current}
              sessionGradeBreakdown={sessionGradeBreakdownRef.current}
              canExtend={sessionLimitRef.current < SESSION_HARD_CAP}
              onExtend={handleExtendSession}
              onRestart={restart}
            />
          )}

          {phase === 'done' && doneReason !== 'session_limit' && (
            <DoneScreen
              session={session}
              reviewed={reviewed}
              onRestart={restart}
              doneReason={doneReason}
              onSwitchMode={(mode) => { setFsrsMode(mode); restart(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function IdleScreen({ pool, onStart, dueCount, fsrsMode }) {
  return (
    <div className={styles.idleScreen}>
      {pool.length === 0 ? (
        <>
          <p className={styles.idleEmpty}>No words match the current filters.</p>
          <p className={styles.idleSub}>Try adjusting the level or uncheck "Starred only".</p>
        </>
      ) : (
        <>
          {dueCount !== null && dueCount > 0 && fsrsMode !== 'due' && (
            <p className={styles.idleDueHint}>
              <strong>{dueCount}</strong> card{dueCount !== 1 ? 's' : ''} due for review
            </p>
          )}
          <p className={styles.idleReady}>
            <strong>{pool.length}</strong> word{pool.length !== 1 ? 's' : ''} ready
          </p>
          <button className={styles.startBtn} onClick={onStart}>Start Quiz</button>
        </>
      )}
    </div>
  );
}

// All answer types including 'easy' (🎯). Order matches button layout. Change-answer shows all but the current one.
const ALL_ANSWER_TYPES = ['easy', 'correct', 'not-sure', 'wrong'];

function QuizCard({
  word, phase, lastAnswer, hasChanged, langFlag, canGoBack, quizMode,
  typedAnswer, onTypedAnswerChange, onCheckAnswer, onAnswer, onChangeAnswer,
  onGoBack, onNext, onInputFocus, onUpdateWord, collisionInfo, learningLang, primaryLang,
  secTranslations, chipCandidateLangs, chipSaveStateMap, hasUnsavedChips, showChipHint,
  fillTranslationsLoading, onFillTranslations, onSaveChip,
}) {
  const inputRef = useRef(null);

  const [localTags,     setLocalTags]     = useState(word.tags ?? []);
  const [localMastered, setLocalMastered] = useState(word.mastered ?? false);
  useEffect(() => {
    setLocalTags(word.tags ?? []);
    setLocalMastered(word.mastered ?? false);
  }, [word.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleTagChange(newTags) {
    setLocalTags(newTags);
    onUpdateWord(word.id, { tags: newTags });
  }

  function handleMarkMastered() {
    setLocalMastered(true);
    onUpdateWord(word.id, { mastered: true });
  }

  useEffect(() => {
    if (quizMode === 'hard' && phase === 'question' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [word.id, quizMode, phase]);

  const cardClass = [
    styles.card,
    phase === 'revealed' && lastAnswer ? styles[`card_${lastAnswer.replace('-', '_')}`] : '',
  ].filter(Boolean).join(' ');

  const isHard = quizMode === 'hard';
  const learningLangObj = SUPPORTED_LANGUAGES.find(l => l.code === word.word_language);

  return (
    <div className={styles.cardWrap}>
      {canGoBack && (
        <button className={styles.prevBtn} onClick={onGoBack}>← Previous</button>
      )}
      <div className={cardClass}>

        {/* Header: pos / level / lang badge / answer icon */}
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderLeft}>
            <span className={styles.cardPos}>{word.part_of_speech}</span>
            {word.recommended_level && (
              <span className={styles.cardLevel} style={{ backgroundColor: LEVEL_COLORS[word.recommended_level] }}>
                {word.recommended_level}
              </span>
            )}
            {word.word_language && (
              <span className={styles.cardLangBadge}>
                {langFlag && `${langFlag} `}{word.word_language.toUpperCase()}
              </span>
            )}
          </div>
          {phase === 'revealed' && lastAnswer && (
            <span className={styles.answerIcon}>{ANSWER_ICONS[lastAnswer]}</span>
          )}
        </div>

        {/* Easy mode: word is the question */}
        {!isHard && (
          <div className={styles.cardWordWrap}>
            <div className={styles.cardWordRow}>
              <div className={styles.cardWord} translate="no">{word.word}</div>
              <SpeakerButton word={word.word} lang={word.word_language || learningLang} />
            </div>
            {phase === 'revealed' && (word.kana_reading || word.romanization) && (
              <div className={styles.cardRomanization}>
                {word.kana_reading && <span className={styles.cardKana}>{word.kana_reading}</span>}
                {word.romanization && <span className={styles.cardRoma}>{word.romanization}</span>}
              </div>
            )}
          </div>
        )}

        {/* Hard mode question: meaning is the prompt */}
        {isHard && phase === 'question' && (
          <div className={styles.reverseMeaningWrap}>
            <div className={styles.reverseMeaning}>{word.meaning}</div>
            <SpeakerButton word={word.meaning} lang={primaryLang} />
          </div>
        )}

        {/* Hard mode revealed: show the correct word */}
        {isHard && phase === 'revealed' && (
          <div className={styles.cardWordWrap}>
            <div className={styles.cardWordRow}>
              <div className={styles.cardWord} translate="no">{word.word}</div>
              <SpeakerButton word={word.word} lang={word.word_language || learningLang} />
            </div>
            {(word.kana_reading || word.romanization) && (
              <div className={styles.cardRomanization}>
                {word.kana_reading && <span className={styles.cardKana}>{word.kana_reading}</span>}
                {word.romanization && <span className={styles.cardRoma}>{word.romanization}</span>}
              </div>
            )}
          </div>
        )}

        {/* Easy mode answer buttons */}
        {!isHard && phase === 'question' && (
          <div className={styles.answerButtons}>
            <button className={`${styles.answerBtn} ${styles.easy}`}    onClick={() => onAnswer('easy')}>🎯 Easy</button>
            <button className={`${styles.answerBtn} ${styles.correct}`} onClick={() => onAnswer('correct')}>✅ I knew it</button>
            <button className={`${styles.answerBtn} ${styles.notSure}`} onClick={() => onAnswer('not-sure')}>🤔 Hesitated</button>
            <button className={`${styles.answerBtn} ${styles.wrong}`}   onClick={() => onAnswer('wrong')}>❌ Don't know</button>
          </div>
        )}

        {/* Hard mode: typed input + self-assess (🎯 Easy added to self-assess row) */}
        {isHard && phase === 'question' && (
          <div className={styles.reverseInputSection}>
            <div className={styles.reverseInputRow}>
              <input
                ref={inputRef}
                className={styles.reverseInput}
                type="text"
                placeholder={`Type the word${learningLangObj ? ` in ${learningLangObj.label}` : ''}...`}
                value={typedAnswer}
                onChange={e => onTypedAnswerChange(e.target.value)}
                onFocus={onInputFocus}
                onKeyDown={e => { if (e.key === 'Enter' && typedAnswer.trim()) onCheckAnswer(typedAnswer); }}
                translate="no"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck="false"
              />
              <button
                className={styles.checkBtn}
                onClick={() => onCheckAnswer(typedAnswer)}
                disabled={!typedAnswer.trim()}
              >
                Check
              </button>
            </div>
            <div className={styles.selfAssessSection}>
              <span className={styles.selfAssessLabel}>Or self-assess:</span>
              <div className={styles.answerButtons}>
                <button className={`${styles.answerBtn} ${styles.easy}`}    onClick={() => onAnswer('easy')}>🎯 Easy</button>
                <button className={`${styles.answerBtn} ${styles.correct}`} onClick={() => onAnswer('correct')}>✅ I knew it</button>
                <button className={`${styles.answerBtn} ${styles.notSure}`} onClick={() => onAnswer('not-sure')}>🤔 Hesitated</button>
                <button className={`${styles.answerBtn} ${styles.wrong}`}   onClick={() => onAnswer('wrong')}>❌ Don't know</button>
              </div>
            </div>
          </div>
        )}

        {/* Revealed section (both modes) */}
        {phase === 'revealed' && (
          <>
            {/* Answer comparison — Hard mode, typed answer */}
            {isHard && typedAnswer && (
              <div className={styles.answerComparison}>
                <div className={`${styles.compCell} ${lastAnswer === 'correct' || lastAnswer === 'easy' ? styles.compCellCorrect : styles.compCellWrong}`}>
                  <span className={styles.compCellLabel}>Your answer</span>
                  <span className={styles.compCellValue} translate="no">{typedAnswer}</span>
                </div>
                {lastAnswer !== 'correct' && lastAnswer !== 'easy' && (
                  <div className={`${styles.compCell} ${styles.compCellCorrect}`}>
                    <span className={styles.compCellLabel}>Correct</span>
                    <span className={styles.compCellValue} translate="no">{word.word}</span>
                  </div>
                )}
              </div>
            )}

            {/* Collision hint */}
            {isHard && typedAnswer && lastAnswer === 'wrong' && collisionInfo && (
              <div className={styles.collisionCard} translate="no">
                <span className={styles.collisionIcon}>💡</span>
                <span className={styles.collisionText}>
                  <strong>{collisionInfo.correctedWord}</strong>
                  {collisionInfo.meaning
                    ? ` is a valid word — which means "${collisionInfo.meaning}"`
                    : ` is a valid word in this language`
                  }
                </span>
              </div>
            )}

            <div className={styles.revealDivider} />
            <div className={styles.revealGrid}>
              <RevealField label="Meaning" value={word.meaning} highlight />
              {word.example          && <RevealField label="Example"       value={word.example}            italic />}
              {word.related_words    && <RevealField label="Related words" value={word.related_words} />}
              {word.other_useful_notes && <RevealField label="Notes"       value={word.other_useful_notes} />}
            </div>

            {/* Secondary language chips — Easy mode only */}
            {!isHard && (() => {
              const missingCount = (chipCandidateLangs || []).filter(l => !secTranslations?.some(c => c.lang === l)).length;
              const showChips = secTranslations?.length > 0;
              const showFillBtn = missingCount > 0;
              if (!showChips && !showFillBtn) return null;
              return (
                <div className={styles.secLangChips}>
                  {/* First-time hint banner — more prominent, shown until dismissed */}
                  {hasUnsavedChips && showChipHint && (
                    <div className={styles.chipHintBanner}>
                      🌐 Tap any translation to save it to your vocab
                    </div>
                  )}
                  {/* Persistent small label — shown after hint dismissed */}
                  {hasUnsavedChips && !showChipHint && (
                    <span className={styles.chipHintLabel}>🌐 Tap to save</span>
                  )}
                  {showChips && secTranslations.map(chip => {
                    const isSaved = chipSaveStateMap?.[chip.lang] === 'saved';
                    return (
                      <button
                        key={chip.lang}
                        className={`${styles.secLangChip} ${isSaved ? styles.secLangChipSaved : styles.secLangChipBtn}`}
                        onClick={() => !isSaved && onSaveChip(chip)}
                        disabled={isSaved}
                        title={isSaved ? 'Saved to vocabulary' : `Save ${chip.word} to vocabulary`}
                        translate="no"
                      >
                        {isSaved ? '✓ ' : ''}{chip.flag} {chip.word}
                        {NON_LATIN.has(chip.lang) && (chip.kana_reading || chip.romanization) && (
                          <span className={styles.secLangRoma}> {chip.kana_reading || chip.romanization}</span>
                        )}
                      </button>
                    );
                  })}
                  {showFillBtn && (
                    <button
                      className={styles.fillTransBtn}
                      onClick={onFillTranslations}
                      disabled={fillTranslationsLoading}
                      title="Look up missing translations"
                    >
                      {fillTranslationsLoading
                        ? <><span className={styles.fillTransSpinner} /><span className={styles.fillTransBtnText}> Loading…</span></>
                        : '🌐 Tap to load'}
                    </button>
                  )}
                </div>
              );
            })()}

            <div className={styles.revealActions}>
              <button className={styles.nextBtn} onClick={onNext}>Next word →</button>

              {!hasChanged && (
                <div className={styles.changeRow}>
                  <span className={styles.changeLabel}>Change answer:</span>
                  {ALL_ANSWER_TYPES.filter(t => t !== lastAnswer).map(type => (
                    <button
                      key={type}
                      className={`${styles.changeBtn} ${styles[`changeBtnType_${type.replace('-', '_')}`]}`}
                      onClick={() => onChangeAnswer(type)}
                      title={
                        type === 'easy'     ? 'Easy — I got it instantly'  :
                        type === 'correct'  ? 'I knew it'                   :
                        type === 'not-sure' ? 'Hesitated'                   :
                        "Don't know"
                      }
                    >
                      {ANSWER_ICONS[type]}
                    </button>
                  ))}
                </div>
              )}

              {/* Mastered button — manual only; FSRS state='review' will replace auto-mastering */}
              <div className={styles.flagRow}>
                {localMastered ? (
                  <span className={styles.masteredConfirm}>Mastered ✓</span>
                ) : (
                  <button className={styles.masteredBtn} onClick={handleMarkMastered}>
                    Mark as mastered
                  </button>
                )}
              </div>

              <div className={styles.flagRow}>
                <TagBar tags={localTags} onChange={handleTagChange} size="sm" />
              </div>

              <div className={styles.flagRow}>
                <FlagButton wordId={word.id} wordText={word.word} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RevealField({ label, value, highlight, italic }) {
  return (
    <div className={styles.revealField}>
      <span className={styles.revealLabel}>{label}</span>
      <span className={[
        styles.revealValue,
        highlight ? styles.revealHighlight : '',
        italic    ? styles.revealItalic   : '',
      ].filter(Boolean).join(' ')}>
        {value}
      </span>
    </div>
  );
}

const DONE_MESSAGES = {
  all_caught_up: { icon: '🌟', title: 'All caught up!',         sub: 'No cards are due for review right now.' },
  daily_limit:   { icon: '✅', title: 'Daily limit reached!',   sub: "You've introduced all new words for today." },
  no_new_words:  { icon: '📚', title: 'No new words left',      sub: 'All words have been introduced. Switch to Due to review them.' },
  done:          { icon: '🎉', title: 'No more words!',         sub: 'All words in your pool have been reviewed.' },
};

function DoneScreen({ session, reviewed, onRestart, doneReason, onSwitchMode }) {
  const { icon, title, sub } = DONE_MESSAGES[doneReason] ?? DONE_MESSAGES.done;
  return (
    <div className={styles.doneScreen}>
      <div className={styles.doneIcon}>{icon}</div>
      <h2 className={styles.doneTitle}>{title}</h2>
      <p className={styles.doneSub}>{sub}</p>

      {/* Quick-switch to a useful mode */}
      {doneReason === 'all_caught_up' && (
        <button className={styles.switchModeBtn} onClick={() => onSwitchMode('new')}>
          Switch to New words →
        </button>
      )}
      {(doneReason === 'daily_limit' || doneReason === 'no_new_words') && (
        <button className={styles.switchModeBtn} onClick={() => onSwitchMode('due')}>
          Switch to Due cards →
        </button>
      )}

      {reviewed > 0 && (
        <div className={styles.doneSummary}>
          <SummaryStat label="Reviewed"     value={reviewed} />
          <SummaryStat label="✅ Correct"   value={session.correct}    color="#4caf79" />
          <SummaryStat label="❌ Wrong"     value={session.wrong}      color="#e07070" />
          <SummaryStat label="🤔 Hesitated" value={session.notSure}    color="#e8a44a" />
          <SummaryStat label="Best streak"  value={session.bestStreak} />
        </div>
      )}
      <button className={styles.startBtn} onClick={onRestart}>Start over</button>
    </div>
  );
}

function SummaryStat({ label, value, color }) {
  return (
    <div className={styles.summaryStat}>
      <span className={styles.summaryValue} style={color ? { color } : {}}>{value}</span>
      <span className={styles.summaryLabel}>{label}</span>
    </div>
  );
}

function SessionCompleteScreen({ session, reviewed, sessionElapsedMs, sessionGraduated, sessionWeak, sessionGradeBreakdown, canExtend, onExtend, onRestart }) {
  const secs   = Math.floor((sessionElapsedMs || 0) / 1000);
  const mins   = Math.floor(secs / 60);
  const remSec = secs % 60;
  const timeStr = `${mins}:${String(remSec).padStart(2, '0')}`;
  const acc = reviewed > 0 ? Math.round(session.correct / reviewed * 100) : 0;

  return (
    <div className={styles.sessionComplete}>
      <div className={styles.sessionCompleteIcon}>🏁</div>
      <h2 className={styles.sessionCompleteTitle}>Session Complete</h2>

      <div className={styles.sessionStats}>
        <SessionStat label="Cards" value={reviewed} />
        <SessionStat label="Accuracy" value={`${acc}%`} color={acc >= 70 ? '#4caf79' : '#e07070'} />
        <SessionStat label="Time" value={timeStr} />
        <SessionStat label="Graduated" value={sessionGraduated.length} color={sessionGraduated.length > 0 ? '#4caf79' : undefined} />
        <SessionStat label="Weak words" value={sessionWeak.length} color={sessionWeak.length > 0 ? '#e07070' : undefined} />
      </div>

      {COFFEE_FEATURES_ENABLED && (
        <div className={styles.sessionAdvanced}>
          {Object.keys(sessionGradeBreakdown).length > 0 && (
            <div className={styles.sessionGradeBreakdown}>
              {['easy', 'good', 'hard', 'again'].filter(g => sessionGradeBreakdown[g]).map(g => (
                <span key={g} className={`${styles.sessionGradeChip} ${styles[`gradeChip_${g}`]}`}>
                  {g}: {sessionGradeBreakdown[g]}
                </span>
              ))}
            </div>
          )}
          {sessionGraduated.length > 0 && (
            <div className={styles.sessionWordSection}>
              <div className={styles.sessionWordListTitle}>Graduated</div>
              <div className={styles.sessionWordList}>
                {sessionGraduated.map(w => (
                  <span key={w.id} className={`${styles.sessionWordChip} ${styles.sessionWordChipGrad}`} title={w.meaning}>{w.word}</span>
                ))}
              </div>
            </div>
          )}
          {sessionWeak.length > 0 && (
            <div className={styles.sessionWordSection}>
              <div className={styles.sessionWordListTitle}>Weak words</div>
              <div className={styles.sessionWordList}>
                {sessionWeak.map(w => (
                  <span key={w.id} className={`${styles.sessionWordChip} ${styles.sessionWordChipWeak}`} title={w.meaning}>{w.word}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className={styles.sessionCompleteActions}>
        {canExtend ? (
          <button className={styles.extendBtn} onClick={onExtend}>
            Keep going? +{SESSION_EXTENSION} more
          </button>
        ) : (
          <p className={styles.sessionHardCapMsg}>Hard cap reached ({SESSION_HARD_CAP} cards)</p>
        )}
        <button className={styles.startBtn} onClick={onRestart}>Start new session</button>
      </div>
    </div>
  );
}

function SessionStat({ label, value, color }) {
  return (
    <div className={styles.summaryStat}>
      <span className={styles.summaryValue} style={color ? { color } : {}}>{value}</span>
      <span className={styles.summaryLabel}>{label}</span>
    </div>
  );
}
