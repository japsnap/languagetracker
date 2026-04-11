import { useState, useEffect, useRef } from 'react';
import { fetchExploreWord } from '../../utils/explore';
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

/**
 * Explore mode — serves random vocabulary cards by level.
 *
 * Serving: checks word_cache first (free), falls back to AI.
 * Saved words go directly into the user's vocabulary via onAddWord.
 *
 * Extensibility: phrase/idiom filtering → pass `wordType` to fetchExploreWord.
 * Community pools → add a `pool` param to fetchExploreWord (no changes needed here).
 */
export default function ExploreMode({ preferences, words, onAddWord }) {
  const [level,       setLevel]       = useState('A1');
  const [card,        setCard]        = useState(null);
  const [flipped,     setFlipped]     = useState(false);
  const [phase,       setPhase]       = useState('idle'); // idle | loading | ready | error
  const [errorMsg,    setErrorMsg]    = useState('');
  const [seenWords,   setSeenWords]   = useState(new Set()); // reset on level/lang change
  const [savedWords,  setSavedWords]  = useState(new Set()); // saved this session
  const [saving,      setSaving]      = useState(false);
  const abortRef = useRef(null);

  const learningLang    = preferences?.learning_language || 'es';
  const primaryLang     = preferences?.primary_language  || 'en';
  const learningLangObj = SUPPORTED_LANGUAGES.find(l => l.code === learningLang);

  async function loadNext(currentLevel = level, currentSeen = seenWords) {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('loading');
    setFlipped(false);
    setCard(null);
    setErrorMsg('');

    try {
      const result = await fetchExploreWord({
        learningLang,
        primaryLang,
        level: currentLevel,
        wordType: 'word',
        seenWords: currentSeen,
        signal: controller.signal,
      });
      setCard(result);
      setSeenWords(prev => new Set([...prev, (result.word || '').toLowerCase().trim()]));
      setPhase('ready');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setErrorMsg(err.message || 'Something went wrong.');
      setPhase('error');
    }
  }

  // Reset seen words and load on level/language change
  useEffect(() => {
    const freshSeen = new Set();
    setSeenWords(freshSeen);
    loadNext(level, freshSeen);
    return () => abortRef.current?.abort();
  }, [level, learningLang, primaryLang]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLevelChange(lvl) {
    if (lvl === level) return;
    setLevel(lvl);
    // useEffect above fires when level changes
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

                  {/* Romanization — same rules as rest of app: shown always on explore front */}
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
