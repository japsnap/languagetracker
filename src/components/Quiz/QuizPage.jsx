import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { buildPool, pickNext } from '../../utils/quiz';
import { SCENES } from '../../utils/sorting';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';
import { supabase } from '../../utils/supabase';
import FlagButton from '../FlagButton/FlagButton';
import SpeakerButton from '../SpeakerButton/SpeakerButton';
import TagBar from '../TagBar/TagBar';
import { logEvent } from '../../utils/events';
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
const ANSWER_ICONS = { correct: '✅', wrong: '❌', 'not-sure': '🤷' };

const EMPTY_SESSION = { correct: 0, wrong: 0, notSure: 0, streak: 0, bestStreak: 0 };

// Strip diacritics so "espanol" normalizes same as "español".
function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Leading articles to strip before comparison, keyed by language code.
// To add a new language: add an entry with its code and article list.
// Languages with no articles (JA, KO, ZH, UR, HI) are omitted — no stripping needed.
// NOTE: Future fill-in-the-blanks / grammar mode is a SEPARATE quiz type and must NOT
// use this article-stripping logic — articles are part of the graded answer there.
const LEADING_ARTICLES = {
  ES: ['un', 'una', 'el', 'la', 'los', 'las'],
  FR: ["l'", 'un', 'une', 'le', 'la', 'les'],
  DE: ['ein', 'eine', 'der', 'die', 'das'],
  IT: ['un', 'una', 'il', 'la', 'i', 'le'],
  PT: ['um', 'uma', 'o', 'a', 'os', 'as'],
  EN: ['a', 'an', 'the'],
};

// Strip a leading article from a normalised (lowercased, trimmed) string.
// Articles are sorted longest-first so "l'" matches before "la" in French.
function stripLeadingArticle(str, langCode) {
  const articles = LEADING_ARTICLES[langCode];
  if (!articles) return str;
  const sorted = [...articles].sort((x, y) => y.length - x.length);
  for (const art of sorted) {
    // "l'" attaches directly; other articles are space-separated.
    if (art.endsWith("'")) {
      if (str.startsWith(art)) return str.slice(art.length).trim();
    } else {
      if (str.startsWith(art + ' ')) return str.slice(art.length).trim();
    }
  }
  return str;
}

// Levenshtein distance — O(m*n), fine for short vocabulary words.
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

// Accept if distance <= 1, except require exact match for words ≤ 3 chars.
// Leading articles (language-specific) are stripped from both sides before comparison.
// NOTE: Future fill-in-the-blanks / grammar mode is a SEPARATE quiz type and must NOT
// use this comparison function — articles will be part of the graded answer there.
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

/**
 * Normalize a string for accent-insensitive matching:
 * strip diacritics → lowercase → trim.
 * Same logic as stripDiacritics above + lowercase/trim.
 */
function normalizeForMatch(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Check whether typedInput matches any word in word_cache (result_word column)
 * or word_seeds (word column) for the given learningLang.
 * No AI call — pure Supabase queries + client-side accent normalization.
 *
 * Returns { correctedWord, meaning } if a match is found,
 * where meaning is null when only word_seeds matched (no cache row).
 * Returns null if no match.
 */
async function lookupCollision(typedInput, learningLang) {
  try {
    const normalizedInput = normalizeForMatch(typedInput);
    if (normalizedInput.length < 2) return null;

    // Use a prefix to limit DB scan; client-side filter handles accents
    const prefix = normalizedInput.slice(0, 3);

    // 1. Check word_cache (result_word column, mode='single')
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
      const meaning = cacheMatch.response?.meaning || null;
      return { correctedWord: cacheMatch.result_word, meaning };
    }

    // 2. Fallback: check word_seeds (word column)
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
      return { correctedWord: seedMatch.word, meaning: null };
    }

    return null;
  } catch {
    return null;
  }
}

export default function QuizPage({ words, onUpdateWord, onAddWord, preferences }) {
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
  const [prevEntry, setPrevEntry] = useState(null); // { word, answer, hasChanged, session, typedAnswer }
  const [canGoBack, setCanGoBack] = useState(false);
  const [quizMode, setQuizMode] = useState('easy'); // 'easy' | 'hard'
  const [exploreMode, setExploreMode] = useState(() => words.length === 0);
  const [typedAnswer, setTypedAnswer] = useState('');
  const [langFilter, setLangFilter] = useState('');
  const [collisionInfo, setCollisionInfo] = useState(null); // { correctedWord, meaning } | null

  // Enter key advances to next word during revealed phase.
  // Deferred via setTimeout(0) so the keydown that triggered the reveal
  // (typed check via Enter) doesn't also immediately advance to the next word.
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

  // Set lang filter once when preferences load (preserves manual changes after that)
  const langFilterAutoSet = useRef(false);
  useEffect(() => {
    if (!langFilterAutoSet.current && preferences?.learning_language) {
      setLangFilter(preferences.learning_language);
      langFilterAutoSet.current = true;
    }
  }, [preferences?.learning_language]);

  // Unique languages that exist in this user's vocabulary
  const vocabLangs = useMemo(
    () => [...new Set(words.map(w => w.word_language).filter(Boolean))].sort(),
    [words]
  );

  // Pre-filter by selected language, then apply quiz settings
  const langFilteredWords = useMemo(
    () => (langFilter ? words.filter(w => w.word_language === langFilter) : words),
    [words, langFilter]
  );

  const pool = useMemo(() => buildPool(langFilteredWords, settings), [langFilteredWords, settings]);

  // ── settings ─────────────────────────────────────────────────────────────────

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

  // ── quiz flow ────────────────────────────────────────────────────────────────

  function startOrNext() {
    const next = pickNext(pool, lastShownId);
    if (!next) {
      setPhase('done');
      return;
    }
    // Save current card as "previous" before advancing
    if (current !== null) {
      setPrevEntry({ word: current, answer: lastAnswer, hasChanged, session, typedAnswer });
      setCanGoBack(true);
    }
    setCurrent(next);
    setLastShownId(next.id);
    setLastAnswer(null);
    setHasChanged(false);
    setTypedAnswer('');
    setCollisionInfo(null);
    setPhase('question');
  }

  function handleGoBack() {
    if (!prevEntry || !canGoBack) return;

    // If current word was already answered, undo its DB changes
    if (phase === 'revealed' && current && lastAnswer) {
      onUpdateWord(current.id, {
        total_attempts:  current.total_attempts,
        correct_streak:  current.correct_streak,
        mastered:        current.mastered,
        error_counter:   current.error_counter,
        last_reviewed:   current.last_reviewed,
      });
    }

    // Restore session to state before current word (covers both phases)
    setSession(prevEntry.session);
    setCurrent(prevEntry.word);
    setLastAnswer(prevEntry.answer);
    setHasChanged(prevEntry.hasChanged);
    setTypedAnswer(prevEntry.typedAnswer ?? '');
    setPhase('revealed');
    setCanGoBack(false);
  }

  // Apply answer changes to a word starting from its `base` snapshot.
  function computeChanges(base, type) {
    const now = new Date().toISOString();
    const changes = {
      total_attempts: base.total_attempts + 1,
      last_reviewed: now,
      error_counter: base.error_counter,
      correct_streak: base.correct_streak,
      mastered: base.mastered,
    };
    if (type === 'correct') {
      const newStreak = base.correct_streak + 1;
      changes.correct_streak = newStreak;
      if (newStreak >= 5) changes.mastered = true;
    } else if (type === 'wrong') {
      changes.error_counter = base.error_counter + 1;
      changes.correct_streak = 0;
    } else {
      // not-sure
      changes.correct_streak = 0;
    }
    return changes;
  }

  const handleAnswer = useCallback(
    (type) => {
      if (!current) return;
      onUpdateWord(current.id, computeChanges(current, type));
      logEvent('quiz_answer', { word_id: current.id, word: current.word, answer: type, quiz_mode: quizMode });

      setSession(prev => {
        const newStreak = type === 'correct' ? prev.streak + 1 : 0;
        return {
          correct:    prev.correct   + (type === 'correct'   ? 1 : 0),
          wrong:      prev.wrong     + (type === 'wrong'     ? 1 : 0),
          notSure:    prev.notSure   + (type === 'not-sure'  ? 1 : 0),
          streak:     newStreak,
          bestStreak: Math.max(prev.bestStreak, newStreak),
        };
      });
      setLastAnswer(type);
      setPhase('revealed');
    },
    [current, onUpdateWord, quizMode]
  );

  // Hard mode: compare typed input against the word and any stored alternatives.
  // On wrong answer: fire an async collision check against word_cache + word_seeds.
  function handleCheckAnswer(typed) {
    if (!typed.trim() || !current) return;
    const lang = current.word_language || preferences?.learning_language || null;
    const isCorrect = answersMatch(typed, current.word, lang) ||
      (Array.isArray(current.word_alternatives) &&
        current.word_alternatives.some(alt => answersMatch(typed, alt, lang)));
    if (!isCorrect) {
      const lookupLang = current.word_language || preferences?.learning_language || 'es';
      setCollisionInfo(null);
      lookupCollision(typed, lookupLang).then(setCollisionInfo);
    }
    handleAnswer(isCorrect ? 'correct' : 'wrong');
  }

  // Change answer: undo first response, apply new one.
  const handleChangeAnswer = useCallback(
    (newType) => {
      if (!current || hasChanged) return;

      onUpdateWord(current.id, computeChanges(current, newType));

      setSession(prev => {
        const old = lastAnswer;
        let newStreak = prev.streak;
        if (old === 'correct' && newType !== 'correct') newStreak = 0;
        else if (old !== 'correct' && newType === 'correct') newStreak = 1;

        return {
          ...prev,
          correct:  prev.correct  - (old === 'correct'   ? 1 : 0) + (newType === 'correct'   ? 1 : 0),
          wrong:    prev.wrong    - (old === 'wrong'      ? 1 : 0) + (newType === 'wrong'      ? 1 : 0),
          notSure:  prev.notSure  - (old === 'not-sure'  ? 1 : 0) + (newType === 'not-sure'   ? 1 : 0),
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
  }

  const reviewed = session.correct + session.wrong + session.notSure;

  // Flag for the current card's language
  const currentLangFlag = current?.word_language
    ? SUPPORTED_LANGUAGES.find(l => l.code === current.word_language)?.flag
    : null;

  // ── render ───────────────────────────────────────────────────────────────────

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

        {/* Quiz-specific settings — hidden in explore mode (ExploreMode has its own level row) */}
        {/* Language filter — only shown if vocabulary has words in multiple languages */}
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

      {/* Session stats — quiz only */}
      {!exploreMode && phase !== 'idle' && (
        <div className={styles.statsStrip}>
          <span className={styles.statItem}>
            Reviewed: <strong>{reviewed}</strong>
          </span>
          <span className={`${styles.statItem} ${styles.statCorrect}`}>
            ✅ <strong>{session.correct}</strong>
          </span>
          <span className={`${styles.statItem} ${styles.statWrong}`}>
            ❌ <strong>{session.wrong}</strong>
          </span>
          <span className={`${styles.statItem} ${styles.statNotSure}`}>
            🤷 <strong>{session.notSure}</strong>
          </span>
          <span className={styles.statItem}>
            Streak: <strong>{session.streak}</strong>
          </span>
        </div>
      )}

      {/* Explore mode fills remaining space (has its own layout) */}
      {exploreMode && (
        <ExploreMode
          preferences={preferences}
          words={words}
          onAddWord={onAddWord}
        />
      )}

      {/* Quiz mode main area */}
      {!exploreMode && (
      <div className={styles.main}>
        {phase === 'idle' && (
          <IdleScreen pool={pool} onStart={startOrNext} />
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
            onUpdateWord={onUpdateWord}
            collisionInfo={collisionInfo}
            learningLang={preferences?.learning_language || 'es'}
            primaryLang={preferences?.primary_language || 'en'}
          />
        )}

        {phase === 'done' && (
          <DoneScreen session={session} reviewed={reviewed} onRestart={restart} />
        )}
      </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
          <button className={styles.startBtn} onClick={onStart}>
            Start Quiz
          </button>
        </>
      )}
    </div>
  );
}

const ALL_ANSWER_TYPES = ['correct', 'wrong', 'not-sure'];

function QuizCard({ word, phase, lastAnswer, hasChanged, langFlag, canGoBack, quizMode, typedAnswer, onTypedAnswerChange, onCheckAnswer, onAnswer, onChangeAnswer, onGoBack, onNext, onUpdateWord, collisionInfo, learningLang, primaryLang }) {
  const inputRef = useRef(null);

  // Local tag + mastered state — reset when word changes so stale snapshot doesn't persist
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

  // Auto-focus the text input whenever a reverse-mode question appears
  useEffect(() => {
    if (quizMode === 'hard' && phase === 'question' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [word.id, quizMode, phase]);

  const cardClass = [
    styles.card,
    phase === 'revealed' && lastAnswer ? styles[`card_${lastAnswer.replace('-', '_')}`] : '',
  ].filter(Boolean).join(' ');

  const isHard = quizMode === 'hard'; // hard = typed production; easy = self-assessed recognition
  const learningLangObj = SUPPORTED_LANGUAGES.find(l => l.code === word.word_language);

  return (
    <div className={styles.cardWrap}>
      {canGoBack && (
        <button className={styles.prevBtn} onClick={onGoBack}>← Previous</button>
      )}
      <div className={cardClass}>

        {/* ── Header: pos / level / lang badge / answer icon ── */}
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

        {/* ── Normal mode: word is the question ── */}
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

        {/* ── Reverse mode question: meaning is the prompt ── */}
        {isHard && phase === 'question' && (
          <div className={styles.reverseMeaningWrap}>
            <div className={styles.reverseMeaning}>{word.meaning}</div>
            <SpeakerButton word={word.meaning} lang={primaryLang} />
          </div>
        )}

        {/* ── Reverse mode revealed: show the correct word ── */}
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

        {/* ── Normal mode answer buttons ── */}
        {!isHard && phase === 'question' && (
          <div className={styles.answerButtons}>
            <button className={`${styles.answerBtn} ${styles.correct}`} onClick={() => onAnswer('correct')}>✅ I knew it</button>
            <button className={`${styles.answerBtn} ${styles.wrong}`} onClick={() => onAnswer('wrong')}>❌ I didn't know it</button>
            <button className={`${styles.answerBtn} ${styles.notSure}`} onClick={() => onAnswer('not-sure')}>🤷 Lucky guess</button>
          </div>
        )}

        {/* ── Reverse mode input + self-assess ── */}
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
                <button className={`${styles.answerBtn} ${styles.correct}`} onClick={() => onAnswer('correct')}>✅ I knew it</button>
                <button className={`${styles.answerBtn} ${styles.wrong}`} onClick={() => onAnswer('wrong')}>❌ I didn't know it</button>
                <button className={`${styles.answerBtn} ${styles.notSure}`} onClick={() => onAnswer('not-sure')}>🤷 Lucky guess</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Revealed section (both modes) ── */}
        {phase === 'revealed' && (
          <>
            {/* Answer comparison — reverse mode, when user typed rather than self-assessed */}
            {isHard && typedAnswer && (
              <div className={styles.answerComparison}>
                <div className={`${styles.compCell} ${lastAnswer === 'correct' ? styles.compCellCorrect : styles.compCellWrong}`}>
                  <span className={styles.compCellLabel}>Your answer</span>
                  <span className={styles.compCellValue} translate="no">{typedAnswer}</span>
                </div>
                {lastAnswer !== 'correct' && (
                  <div className={`${styles.compCell} ${styles.compCellCorrect}`}>
                    <span className={styles.compCellLabel}>Correct</span>
                    <span className={styles.compCellValue} translate="no">{word.word}</span>
                  </div>
                )}
              </div>
            )}

            {/* Collision hint — shown when wrong typed answer matches a different valid word */}
            {isHard && typedAnswer && lastAnswer === 'wrong' && collisionInfo && (
              <div className={styles.collisionCard} translate="no">
                <span className={styles.collisionIcon}>💡</span>
                <span className={styles.collisionText}>
                  <strong>{collisionInfo.correctedWord}</strong>
                  {collisionInfo.meaning
                    ? ` means "${collisionInfo.meaning}" — but that's not what we're looking for here!`
                    : ` is a valid word — but that's not what we're looking for here!`
                  }
                </span>
              </div>
            )}

            <div className={styles.revealDivider} />
            <div className={styles.revealGrid}>
              <RevealField label="Meaning" value={word.meaning} highlight />
              {word.example && <RevealField label="Example" value={word.example} italic />}
              {word.related_words && <RevealField label="Related words" value={word.related_words} />}
              {word.other_useful_notes && <RevealField label="Notes" value={word.other_useful_notes} />}
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
                      title={type === 'correct' ? 'I knew it' : type === 'wrong' ? "I didn't know it" : 'Lucky guess'}
                    >
                      {ANSWER_ICONS[type]}
                    </button>
                  ))}
                </div>
              )}

              {/* Mastered button */}
              <div className={styles.flagRow}>
                {localMastered ? (
                  <span className={styles.masteredConfirm}>Mastered ✓</span>
                ) : (
                  <button className={styles.masteredBtn} onClick={handleMarkMastered}>
                    Mark as mastered
                  </button>
                )}
              </div>

              {/* Word tags */}
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
        italic   ? styles.revealItalic   : '',
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
