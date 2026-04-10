import { useState, useMemo, useCallback } from 'react';
import { buildPool, pickNext } from '../../utils/quiz';
import { SCENES } from '../../utils/sorting';
import FlagButton from '../FlagButton/FlagButton';
import { logEvent } from '../../utils/events';
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

export default function QuizPage({ words, onUpdateWord }) {
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

  const pool = useMemo(() => buildPool(words, settings), [words, settings]);

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
    setCurrent(next);
    setLastShownId(next.id);
    setLastAnswer(null);
    setHasChanged(false);
    setPhase('question');
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
      logEvent('quiz_answer', { word_id: current.id, word: current.word, answer: type });

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
    [current, onUpdateWord]
  );

  // Change answer: undo first response, apply new one.
  // `current` is the pre-answer snapshot (it is never mutated by onUpdateWord —
  // that updates the `words` array in the parent, not the `current` ref here).
  const handleChangeAnswer = useCallback(
    (newType) => {
      if (!current || hasChanged) return;

      // Recompute from original snapshot (current) as if they answered newType from the start
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
  }

  const reviewed = session.correct + session.wrong + session.notSure;

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      {/* Settings strip */}
      <div className={styles.settingsStrip}>
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

        <div className={styles.poolCount}>
          Pool: <strong>{pool.length}</strong> word{pool.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Session stats */}
      {phase !== 'idle' && (
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

      {/* Main area */}
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
            onAnswer={handleAnswer}
            onChangeAnswer={handleChangeAnswer}
            onNext={startOrNext}
          />
        )}

        {phase === 'done' && (
          <DoneScreen session={session} reviewed={reviewed} onRestart={restart} />
        )}
      </div>
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

function QuizCard({ word, phase, lastAnswer, hasChanged, onAnswer, onChangeAnswer, onNext }) {
  const cardClass = [
    styles.card,
    phase === 'revealed' && lastAnswer ? styles[`card_${lastAnswer.replace('-', '_')}`] : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={styles.cardWrap}>
      <div className={cardClass} translate="no">
        {/* Header */}
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderLeft}>
            <span className={styles.cardPos}>{word.part_of_speech}</span>
            {word.recommended_level && (
              <span
                className={styles.cardLevel}
                style={{ backgroundColor: LEVEL_COLORS[word.recommended_level] }}
              >
                {word.recommended_level}
              </span>
            )}
          </div>
          {phase === 'revealed' && lastAnswer && (
            <span className={styles.answerIcon}>{ANSWER_ICONS[lastAnswer]}</span>
          )}
        </div>

        <div className={styles.cardWordWrap}>
          <div className={styles.cardWord}>{word.word}</div>
          {phase === 'revealed' && (word.kana_reading || word.romanization) && (
            <div className={styles.cardRomanization}>
              {word.kana_reading   && <span className={styles.cardKana}>{word.kana_reading}</span>}
              {word.romanization   && <span className={styles.cardRoma}>{word.romanization}</span>}
            </div>
          )}
        </div>

        {/* Answer buttons — question phase */}
        {phase === 'question' && (
          <div className={styles.answerButtons}>
            <button className={`${styles.answerBtn} ${styles.correct}`} onClick={() => onAnswer('correct')}>
              ✅ I knew it
            </button>
            <button className={`${styles.answerBtn} ${styles.wrong}`} onClick={() => onAnswer('wrong')}>
              ❌ I didn't know it
            </button>
            <button className={`${styles.answerBtn} ${styles.notSure}`} onClick={() => onAnswer('not-sure')}>
              🤷 Lucky guess
            </button>
          </div>
        )}

        {/* Revealed info */}
        {phase === 'revealed' && (
          <>
            <div className={styles.revealDivider} />
            <div className={styles.revealGrid}>
              <RevealField label="Meaning" value={word.meaning} highlight />
              {word.example && <RevealField label="Example" value={word.example} italic />}
              {word.related_words && <RevealField label="Related words" value={word.related_words} />}
              {word.other_useful_notes && <RevealField label="Notes" value={word.other_useful_notes} />}
            </div>

            <div className={styles.revealActions}>
              <button className={styles.nextBtn} onClick={onNext}>
                Next word →
              </button>

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
