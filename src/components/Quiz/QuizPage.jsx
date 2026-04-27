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
const ANSWER_ICONS = { easy: '🎯', correct: '✅', wrong: '❌', 'not-sure': '🤷' };

const EMPTY_SESSION = { correct: 0, wrong: 0, notSure: 0, streak: 0, bestStreak: 0 };

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
// FSRS helpers (module-level — no component state, pure or ref-based)
// ---------------------------------------------------------------------------

function detectDevice() {
  if (window.matchMedia('(display-mode: standalone)').matches) return 'pwa';
  if (/Mobi|Android/i.test(navigator.userAgent)) return 'mobile';
  return 'web';
}

/**
 * FSRS-aware card selection.
 * Priority: 0-attempt new → due learning → due relearning → remaining new →
 *           due review → earliest not-yet-due (never blocks the user).
 * New quiz modes (conjugation/cloze/audio) require no changes here — mode is
 * stored in word_reviews_state and filtered by the caller.
 */
function pickNextFsrs(pool, stateMap, lastShownId) {
  if (pool.length === 0) return null;
  const candidates = pool.length > 1 ? pool.filter(w => w.id !== lastShownId) : pool;
  if (candidates.length === 0) return pool[0];

  const now = new Date();
  const tagged = candidates.map(w => {
    const s = stateMap.get(w.id);
    return { word: w, state: s?.state ?? 'new', due: s?.due_at ? new Date(s.due_at) : now };
  });

  // 1. 0-attempt 'new' words (preserves existing tier-1 priority)
  const zeroAttempt = tagged.filter(t => t.state === 'new' && t.word.total_attempts === 0);
  if (zeroAttempt.length > 0) {
    return zeroAttempt[Math.floor(Math.random() * zeroAttempt.length)].word;
  }

  // 2. Due 'learning' — most urgent (short FSRS step intervals)
  const dueLearning = tagged
    .filter(t => t.state === 'learning' && t.due <= now)
    .sort((a, b) => a.due - b.due);
  if (dueLearning.length > 0) return dueLearning[0].word;

  // 3. Due 'relearning'
  const dueRelearning = tagged
    .filter(t => t.state === 'relearning' && t.due <= now)
    .sort((a, b) => a.due - b.due);
  if (dueRelearning.length > 0) return dueRelearning[0].word;

  // 4. Remaining 'new' words (have a state row but still 'new')
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

export default function QuizPage({ words, onUpdateWord, onAddWord, preferences }) {
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

  // ── FSRS / session refs (all reads in async fns go through refs) ──────────
  const sessionIdRef            = useRef(null);
  const sessionCreatedRef       = useRef(false);
  const sessionPositionRef      = useRef(0);
  const sessionReviewCountRef   = useRef(0);
  const sessionCorrectCountRef  = useRef(0);
  const sessionResponseTimesRef = useRef([]);
  const revealedAtRef           = useRef(null); // performance.now() when question shown
  const reviewsStateMapRef      = useRef(new Map()); // word_id → word_reviews_state row
  const lastFsrsUndoRef         = useRef(null); // undo info for go-back
  const inactivityTimerRef      = useRef(null);
  const userIdRef               = useRef(null); // stable copy for cleanup/async
  const quizModeRef             = useRef(quizMode); // stable copy for async fns
  const fsrsPrefsRef            = useRef({
    desiredRetention: preferences?.desired_retention ?? 0.80,
    weights: preferences?.fsrs_weights ?? null,
    timezone: preferences?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // ── keep refs current ────────────────────────────────────────────────────
  useEffect(() => { userIdRef.current = user?.id ?? null; }, [user?.id]);
  useEffect(() => { quizModeRef.current = quizMode; }, [quizMode]);
  useEffect(() => {
    fsrsPrefsRef.current = {
      desiredRetention: preferences?.desired_retention ?? 0.80,
      weights: preferences?.fsrs_weights ?? null,
      timezone: preferences?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }, [preferences]);

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

  // ── Auto-set lang filter from preferences (once) ─────────────────────────
  const langFilterAutoSet = useRef(false);
  useEffect(() => {
    if (!langFilterAutoSet.current && preferences?.learning_language) {
      setLangFilter(preferences.learning_language);
      langFilterAutoSet.current = true;
    }
  }, [preferences?.learning_language]);

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
    }).eq('id', sid).catch(() => {});
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
    const next = pickNextFsrs(pool, reviewsStateMapRef.current, lastShownId);
    if (!next) {
      setPhase('done');
      return;
    }
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
    lastFsrsUndoRef.current = null; // clear stale undo from previous card
    revealedAtRef.current = performance.now(); // start response-time window
    setPhase('question');
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
            supabase.from('review_log').delete().eq('id', reviewLogId).catch(() => {});
          }
          if (prevState) {
            supabase.from('word_reviews_state')
              .upsert({ ...prevState, updated_at: new Date().toISOString() }, { onConflict: 'user_id,word_id,mode' })
              .catch(() => {});
            reviewsStateMapRef.current.set(wordId, prevState);
          } else {
            // Word was new — remove the state row entirely
            supabase.from('word_reviews_state')
              .delete()
              .eq('user_id', uid).eq('word_id', wordId).eq('mode', mode)
              .catch(() => {});
            reviewsStateMapRef.current.delete(wordId);
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
      if (!current) return;

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
    // Reset FSRS session state so next "Start Quiz" creates a fresh session
    sessionCreatedRef.current = false;
    sessionIdRef.current = null;
    sessionPositionRef.current = 0;
    sessionReviewCountRef.current = 0;
    sessionCorrectCountRef.current = 0;
    sessionResponseTimesRef.current = [];
    lastFsrsUndoRef.current = null;
    clearTimeout(inactivityTimerRef.current);
  }

  const reviewed = session.correct + session.wrong + session.notSure;
  const currentLangFlag = current?.word_language
    ? SUPPORTED_LANGUAGES.find(l => l.code === current.word_language)?.flag
    : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.page}>
      {/* Settings strip */}
      <div className={styles.settingsStrip}>

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

      {/* Session stats strip */}
      {!exploreMode && phase !== 'idle' && (
        <div className={styles.statsStrip}>
          <span className={styles.statItem}>Reviewed: <strong>{reviewed}</strong></span>
          <span className={`${styles.statItem} ${styles.statCorrect}`}>✅ <strong>{session.correct}</strong></span>
          <span className={`${styles.statItem} ${styles.statWrong}`}>❌ <strong>{session.wrong}</strong></span>
          <span className={`${styles.statItem} ${styles.statNotSure}`}>🤷 <strong>{session.notSure}</strong></span>
          <span className={styles.statItem}>Streak: <strong>{session.streak}</strong></span>
        </div>
      )}

      {/* Explore mode */}
      {exploreMode && (
        <ExploreMode preferences={preferences} words={words} onAddWord={onAddWord} />
      )}

      {/* Quiz mode main area */}
      {!exploreMode && (
        <div className={styles.main}>
          {phase === 'idle' && <IdleScreen pool={pool} onStart={startOrNext} />}

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
              onUpdateWord={onUpdateWord}
              collisionInfo={collisionInfo}
              learningLang={preferences?.learning_language || 'es'}
              primaryLang={preferences?.primary_language || 'en'}
            />
          )}

          {phase === 'done' && <DoneScreen session={session} reviewed={reviewed} onRestart={restart} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function IdleScreen({ pool, onStart }) {
  return (
    <div className={styles.idleScreen}>
      {pool.length === 0 ? (
        <>
          <p className={styles.idleEmpty}>No words match the current filters.</p>
          <p className={styles.idleSub}>Try adjusting the level or uncheck "Starred only".</p>
        </>
      ) : (
        <>
          <p className={styles.idleReady}>
            <strong>{pool.length}</strong> word{pool.length !== 1 ? 's' : ''} ready
          </p>
          <button className={styles.startBtn} onClick={onStart}>Start Quiz</button>
        </>
      )}
    </div>
  );
}

// All answer types including 'easy' (🎯). Change-answer shows all but the current one.
const ALL_ANSWER_TYPES = ['easy', 'correct', 'wrong', 'not-sure'];

function QuizCard({
  word, phase, lastAnswer, hasChanged, langFlag, canGoBack, quizMode,
  typedAnswer, onTypedAnswerChange, onCheckAnswer, onAnswer, onChangeAnswer,
  onGoBack, onNext, onUpdateWord, collisionInfo, learningLang, primaryLang,
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

        {/* Easy mode answer buttons — 🎯 Easy added as the top grade option */}
        {!isHard && phase === 'question' && (
          <div className={styles.answerButtons}>
            <button className={`${styles.answerBtn} ${styles.easy}`}    onClick={() => onAnswer('easy')}>🎯 Easy</button>
            <button className={`${styles.answerBtn} ${styles.correct}`} onClick={() => onAnswer('correct')}>✅ I knew it</button>
            <button className={`${styles.answerBtn} ${styles.wrong}`}   onClick={() => onAnswer('wrong')}>❌ I didn't know it</button>
            <button className={`${styles.answerBtn} ${styles.notSure}`} onClick={() => onAnswer('not-sure')}>🤷 Lucky guess</button>
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
                <button className={`${styles.answerBtn} ${styles.wrong}`}   onClick={() => onAnswer('wrong')}>❌ I didn't know it</button>
                <button className={`${styles.answerBtn} ${styles.notSure}`} onClick={() => onAnswer('not-sure')}>🤷 Lucky guess</button>
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
                        type === 'wrong'    ? "I didn't know it"            :
                        'Lucky guess'
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

function DoneScreen({ session, reviewed, onRestart }) {
  return (
    <div className={styles.doneScreen}>
      <div className={styles.doneIcon}>🎉</div>
      <h2 className={styles.doneTitle}>No more words!</h2>
      <p className={styles.doneSub}>All words in your pool have been reviewed.</p>
      <div className={styles.doneSummary}>
        <SummaryStat label="Reviewed"    value={reviewed} />
        <SummaryStat label="✅ Correct"  value={session.correct}    color="#4caf79" />
        <SummaryStat label="❌ Wrong"    value={session.wrong}      color="#e07070" />
        <SummaryStat label="🤷 Not sure" value={session.notSure}    color="#e8a44a" />
        <SummaryStat label="Best streak" value={session.bestStreak} />
      </div>
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
