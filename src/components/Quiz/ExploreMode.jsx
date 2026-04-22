import { useState, useEffect, useRef } from 'react';
import { fetchExploreWord, resetSeedProgress } from '../../utils/explore';
import { aiResultToWordFields, localToday } from '../../utils/vocabulary';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';
import styles from './ExploreMode.module.css';
import quizStyles from './QuizPage.module.css';

const ALL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const LEVEL_COLORS = {
  A1: 'var(--level-a1)', A2: 'var(--level-a2)',
  B1: 'var(--level-b1)', B2: 'var(--level-b2)',
  C1: 'var(--level-c1)', C2: 'var(--level-c2)',
};

const LANG_NAMES = {
  es: 'Spanish', pt: 'Portuguese', it: 'Italian', fr: 'French', de: 'German',
  en: 'English',  ja: 'Japanese',  ko: 'Korean',  zh: 'Chinese', hi: 'Hindi', ur: 'Urdu',
};

/**
 * Explore mode — serves vocabulary cards by level from the word_seeds table.
 *
 * Seeded languages (es, etc.): tracks per-user progress via user_seed_progress.
 *   Exhausted level → shows reset + next-level options.
 * Unseeded languages: falls back to random cache / AI (existing behaviour).
 *
 * Saved words go into the user's vocabulary via onAddWord.
 */
export default function ExploreMode({ preferences, words, onAddWord }) {
  const [level,         setLevel]         = useState('A1');
  const [card,          setCard]          = useState(null);
  const [flipped,       setFlipped]       = useState(false);
  const [phase,         setPhase]         = useState('idle'); // idle|loading|ready|error|exhausted
  const [errorMsg,      setErrorMsg]      = useState('');
  const [exhaustedInfo, setExhaustedInfo] = useState(null); // { level, language, totalSeeds }
  const [savedWords,    setSavedWords]    = useState(new Set());
  const [saving,        setSaving]        = useState(false);
  const [resetting,     setResetting]     = useState(false);
  const abortRef = useRef(null);

  const learningLang    = preferences?.learning_language || 'es';
  const primaryLang     = preferences?.primary_language  || 'en';
  const learningLangObj = SUPPORTED_LANGUAGES.find(l => l.code === learningLang);
  const langLabel       = LANG_NAMES[learningLang] || learningLang.toUpperCase();

  const nextLevel = ALL_LEVELS[ALL_LEVELS.indexOf(level) + 1] ?? null;

  async function loadNext(currentLevel = level) {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('loading');
    setFlipped(false);
    setCard(null);
    setErrorMsg('');
    setExhaustedInfo(null);

    try {
      const result = await fetchExploreWord({
        learningLang,
        primaryLang,
        level: currentLevel,
        wordType: 'word',
        signal: controller.signal,
      });

      if (result?.exhausted) {
        setExhaustedInfo({ level: result.level, language: result.language, totalSeeds: result.totalSeeds });
        setPhase('exhausted');
        return;
      }

      setCard(result);
      setPhase('ready');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setErrorMsg(err.message || 'Something went wrong.');
      setPhase('error');
    }
  }

  useEffect(() => {
    loadNext(level);
    return () => abortRef.current?.abort();
  }, [level, learningLang, primaryLang]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLevelChange(lvl) {
    if (lvl === level) return;
    setLevel(lvl);
  }

  async function handleSave() {
    if (!card || !onAddWord || saving) return;
    setSaving(true);
    try {
      const wordData = {
        ...aiResultToWordFields(card),
        word_language:  learningLang,
        date_added:     localToday(),
        last_reviewed:  null,
        total_attempts: 0,
        error_counter:  0,
        correct_streak: 0,
        starred:        false,
        mastered:       false,
        scene:          null,
      };
      await onAddWord(wordData);
      setSavedWords(prev => new Set([...prev, (card.word || '').toLowerCase().trim()]));
    } catch (err) {
      console.error('[explore] save failed:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (resetting) return;
    setResetting(true);
    try {
      await resetSeedProgress({ learningLang, level });
      await loadNext(level);
    } catch (err) {
      console.error('[explore] reset failed:', err);
      setErrorMsg('Reset failed. Please try again.');
      setPhase('error');
    } finally {
      setResetting(false);
    }
  }

  function handleNextLevel() {
    if (!nextLevel) return;
    setLevel(nextLevel);
  }

  const cardWordLower = (card?.word || '').toLowerCase().trim();
  const isInVocab     = cardWordLower && words.some(w => w.word.toLowerCase().trim() === cardWordLower);
  const isSavedNow    = savedWords.has(cardWordLower);
  const alreadySaved  = isInVocab || isSavedNow;

  return (
    <div className={styles.wrap}>

      {/* Level selector */}
      <div className={styles.levelRow}>
        <span className={quizStyles.settingsLabel}>Level:</span>
        {ALL_LEVELS.map(lvl => (
          <button
            key={lvl}
            className={`${quizStyles.levelBtn} ${level === lvl ? quizStyles.levelActive : ''}`}
            style={level === lvl
              ? { backgroundColor: LEVEL_COLORS[lvl], borderColor: LEVEL_COLORS[lvl], color: '#fff' }
              : {}}
            onClick={() => handleLevelChange(lvl)}
          >
            {lvl}
          </button>
        ))}
      </div>

      {/* Main scroll area */}
      <div className={styles.main}>

        {phase === 'loading' && (
          <div className={styles.loadingWrap}>
            <div className={styles.spinner} />
            <p className={styles.loadingText}>Finding a word…</p>
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.errorWrap}>
            <p className={styles.errorMsg}>{errorMsg}</p>
            <button className={quizStyles.startBtn} onClick={() => loadNext()}>
              Try again
            </button>
          </div>
        )}

        {phase === 'exhausted' && exhaustedInfo && (
          <div className={styles.exhaustedWrap}>
            <p className={styles.exhaustedTitle}>Level {exhaustedInfo.level} complete</p>
            <p className={styles.exhaustedMsg}>
              You've explored all {exhaustedInfo.totalSeeds} {langLabel} {exhaustedInfo.level} words
              in our current list. More words coming soon.
            </p>
            <div className={styles.exhaustedActions}>
              <button
                className={styles.resetBtn}
                onClick={handleReset}
                disabled={resetting}
              >
                {resetting ? 'Resetting…' : `Reset ${exhaustedInfo.level} progress`}
              </button>
              {nextLevel && (
                <button className={styles.nextLevelBtn} onClick={handleNextLevel}>
                  Try {nextLevel} →
                </button>
              )}
            </div>
          </div>
        )}

        {phase === 'ready' && card && (
          <div className={styles.cardArea}>

            {/* 3D flip scene */}
            <div className={styles.scene}>
              <div
                className={`${styles.card} ${flipped ? styles.cardFlipped : ''}`}
                onClick={() => !flipped && setFlipped(true)}
              >

                {/* ── Front face: word + romanization ── */}
                <div className={styles.front}>
                  <div className={styles.faceHeader}>
                    {card.recommended_level && (
                      <span
                        className={quizStyles.cardLevel}
                        style={{ backgroundColor: LEVEL_COLORS[card.recommended_level] }}
                      >
                        {card.recommended_level}
                      </span>
                    )}
                    {card.word_type && card.word_type !== 'word' && (
                      <span className={styles.typeBadge}>{card.word_type}</span>
                    )}
                    {learningLangObj && (
                      <span className={quizStyles.cardLangBadge}>
                        {learningLangObj.flag} {learningLang.toUpperCase()}
                      </span>
                    )}
                  </div>

                  <div className={styles.wordBig} translate="no">{card.word}</div>

                  {(card.kana_reading || card.romanization) && (
                    <div className={quizStyles.cardRomanization}>
                      {card.kana_reading && (
                        <span className={quizStyles.cardKana}>{card.kana_reading}</span>
                      )}
                      {card.romanization && (
                        <span className={quizStyles.cardRoma}>{card.romanization}</span>
                      )}
                    </div>
                  )}

                  <p className={styles.tapHint}>Tap to reveal</p>
                </div>

                {/* ── Back face: meaning + example ── */}
                <div className={styles.back}>
                  <div className={styles.faceHeader}>
                    {card.part_of_speech && (
                      <span className={quizStyles.cardPos}>{card.part_of_speech}</span>
                    )}
                    {card.recommended_level && (
                      <span
                        className={quizStyles.cardLevel}
                        style={{ backgroundColor: LEVEL_COLORS[card.recommended_level] }}
                      >
                        {card.recommended_level}
                      </span>
                    )}
                  </div>

                  <div className={styles.wordSmall} translate="no">{card.word}</div>

                  {(card.kana_reading || card.romanization) && (
                    <div className={quizStyles.cardRomanization}>
                      {card.kana_reading && (
                        <span className={quizStyles.cardKana}>{card.kana_reading}</span>
                      )}
                      {card.romanization && (
                        <span className={quizStyles.cardRoma}>{card.romanization}</span>
                      )}
                    </div>
                  )}

                  <div className={styles.divider} />

                  <div className={styles.revealArea} translate="no">
                    <p className={styles.meaning}>{card.meaning}</p>
                    {card.example && (
                      <p className={styles.example}><em>{card.example}</em></p>
                    )}
                    {card.related_words && (
                      <p className={styles.related}>{card.related_words}</p>
                    )}
                  </div>
                </div>

              </div>
            </div>

            {/* Action buttons */}
            <div className={styles.actions}>
              <button
                className={quizStyles.nextBtn}
                onClick={() => loadNext()}
              >
                Next word →
              </button>

              {flipped && (
                <button
                  className={`${styles.saveBtn} ${alreadySaved ? styles.saveBtnDone : ''}`}
                  onClick={handleSave}
                  disabled={alreadySaved || saving}
                >
                  {alreadySaved
                    ? 'Saved to vocabulary'
                    : saving
                      ? 'Saving…'
                      : '+ Save to my vocabulary'}
                </button>
              )}
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
