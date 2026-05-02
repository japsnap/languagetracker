import { useState, useRef, useCallback, useEffect } from 'react';
import { lookupWord, lookupWordSingle, lookupSecondary } from '../../utils/anthropic';
import { localToday, aiResultToWordFields } from '../../utils/vocabulary';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';
import SpeakerButton from '../SpeakerButton/SpeakerButton';
import TagBar from '../TagBar/TagBar';
import styles from './InputPage.module.css';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// Auto-save on lookup — set to false to disable (or wire to user preferences)
const AUTO_SAVE_ENABLED = true;

const EMPTY_FIELDS = {
  word: '',
  word_type: 'word',
  part_of_speech: '',
  base_form: null,
  meaning: '',
  example: '',
  recommended_level: '',
  related_words: '',
  other_useful_notes: '',
  romanization: '',
  kana_reading: '',
  meanings_array: null,
  word_alternatives: null,
};

export default function InputPage({ words, onAddWord, onRemoveWord, onUpdateWord, preferences, onUpdatePreferences, onNavigate }) {
  const [inputLang, setInputLang]               = useState(null); // null = derive from preferences
  const [inputWord, setInputWord]               = useState('');
  const [phase, setPhase]                       = useState('idle'); // idle | loading | preview | candidates | error
  const [fields, setFields]                     = useState(EMPTY_FIELDS);
  const [candidates, setCandidates]             = useState([]);
  const [savedIndices, setSavedIndices]         = useState(new Set());
  const [errorMsg, setErrorMsg]                 = useState('');
  const [duplicate, setDuplicate]               = useState(null);
  const [savedFlash, setSavedFlash]             = useState('');
  const [secondaryResults, setSecondaryResults]       = useState({}); // { [langCode]: { status, data } }
  const [secondarySaveStates, setSecondarySaveStates] = useState({}); // { [langCode]: { status: 'idle'|'saving'|'saved'|'error', id: uuid|null } }
  const [autoSaveState, setAutoSaveState]             = useState(null); // null | { id, word }
  const [previewTags,   setPreviewTags]               = useState([]);
  const [noMoreMeanings, setNoMoreMeanings]           = useState(false);
  const [primaryCardResult, setPrimaryCardResult]     = useState(null); // null | { status, data }
  const [primarySaveState, setPrimarySaveState]       = useState({ status: 'idle', id: null });
  const abortRef           = useRef(null);
  const autoSaveTimer      = useRef(null);
  const searchInputRef     = useRef(null);
  const lookupSessionIdRef = useRef(null); // stable uuid per lookup, shared by primary + secondary saves
  const lookupTermRef      = useRef('');   // original typed term; persists after inputWord is cleared

  const recentWords = [...words].sort((a, b) => b.id - a.id).slice(0, 5);

  // ── Language derivations ──────────────────────────────────────────────────────

  const learningLang   = preferences?.learning_language  || 'es';
  const primaryLang    = preferences?.primary_language   || 'en';
  const secondaryLangs = preferences?.secondary_languages || [];

  // Chip pool = learning + primary + secondaries, deduped
  const allLangCodes = [...new Set([learningLang, primaryLang, ...secondaryLangs])];

  // Active input language: explicit state if valid, else fall back to learning language
  const actualInputLang = (inputLang && allLangCodes.includes(inputLang)) ? inputLang : learningLang;

  const inputLangObj    = SUPPORTED_LANGUAGES.find(l => l.code === actualInputLang);
  const learningLangObj = SUPPORTED_LANGUAGES.find(l => l.code === learningLang);
  const primaryLangObj  = SUPPORTED_LANGUAGES.find(l => l.code === primaryLang);

  const primaryLangCardActive = actualInputLang !== primaryLang &&
                               (phase === 'preview' || phase === 'candidates') && !!fields.word;

  // When input === primary (e.g. typing English while primary=EN): skip the API lookup,
  // offer a direct save of the typed word instead.
  const primarySaveCardActive = actualInputLang === primaryLang &&
                                (phase === 'preview' || phase === 'candidates') && !!fields.word;

  const splitActive = (Object.keys(secondaryResults).length > 0 || primaryLangCardActive || primarySaveCardActive) &&
                      (phase === 'preview' || phase === 'candidates');

  const primaryAlreadySaved = !!(primaryCardResult?.data?.word && words.some(
    w => w.word?.toLowerCase() === primaryCardResult.data.word.toLowerCase() && w.word_language === primaryLang
  ));

  // Pre-check for direct save: typed term already in vocab for primary language
  const primaryDirectAlreadySaved = primarySaveCardActive && words.some(
    w => w.word?.toLowerCase() === (lookupTermRef.current || fields.word)?.toLowerCase() &&
         w.word_language === primaryLang
  );

  const availableToAdd = SUPPORTED_LANGUAGES.filter(l =>
    l.code !== actualInputLang &&
    l.code !== learningLang &&
    l.code !== primaryLang &&
    !secondaryLangs.includes(l.code)
  );

  // ── Reset lookup state ────────────────────────────────────────────────────────

  function resetLookupState() {
    setPhase('idle');
    setFields(EMPTY_FIELDS);
    setInputWord('');
    setDuplicate(null);
    setCandidates([]);
    setSavedIndices(new Set());
    setSecondaryResults({});
    setSecondarySaveStates({});
    clearTimeout(autoSaveTimer.current);
    setAutoSaveState(null);
    setPreviewTags([]);
    setNoMoreMeanings(false);
    setPrimaryCardResult(null);
    setPrimarySaveState({ status: 'idle', id: null });
    lookupSessionIdRef.current = null;
    lookupTermRef.current = '';
    if (abortRef.current) abortRef.current.abort();
  }

  // ── Auto-save helpers ─────────────────────────────────────────────────────────

  async function handleAutoSave(wordData) {
    const existing = words.find(
      w => w.word.toLowerCase().trim() === wordData.word.toLowerCase().trim()
    );
    if (existing) {
      setDuplicate(existing);
      return;
    }
    try {
      const saved = await onAddWord(wordData);
      setAutoSaveState({ id: saved.id, word: saved.word });
      // After 10s: remove Undo button, keep card open with a quiet 'Saved ✓' message
      autoSaveTimer.current = setTimeout(() => {
        setAutoSaveState(prev => prev ? { word: prev.word } : null);
      }, 10000);
    } catch (err) {
      // Auto-save silently failed — user sees the preview but no Undo bar appears
      console.warn('[auto-save] failed:', err?.message);
    }
  }

  function handleUndoAutoSave() {
    if (!autoSaveState?.id) return;
    onRemoveWord(autoSaveState.id);
    clearTimeout(autoSaveTimer.current);
    resetLookupState(); // close preview immediately, no flash
  }

  // Cleanup timer on unmount
  useEffect(() => () => clearTimeout(autoSaveTimer.current), []);

  // ── Secondary save handlers ───────────────────────────────────────────────────

  async function handleSaveSecondary(langCode, data) {
    setSecondarySaveStates(prev => ({ ...prev, [langCode]: { status: 'saving', id: null } }));
    try {
      const wordData = {
        ...aiResultToWordFields(data),
        word_language:      langCode,
        date_added:         localToday(),
        last_reviewed:      null,
        total_attempts:     0,
        error_counter:      0,
        correct_streak:     0,
        starred:            false,
        mastered:           false,
        scene:              null,
        tags:               ['polyglot'],
        lookup_session_id:  lookupSessionIdRef.current,
      };
      const saved = await onAddWord(wordData);
      setSecondarySaveStates(prev => ({ ...prev, [langCode]: { status: 'saved', id: saved.id } }));
    } catch (err) {
      console.error('[secondary-save]', err?.message);
      setSecondarySaveStates(prev => ({ ...prev, [langCode]: { status: 'error', id: null } }));
    }
  }

  function handleUndoSecondary(langCode) {
    const state = secondarySaveStates[langCode];
    if (!state?.id) return;
    onRemoveWord(state.id);
    setSecondarySaveStates(prev => ({ ...prev, [langCode]: { status: 'idle', id: null } }));
  }

  // ── Primary language card (on-demand, only when inputLang ≠ primaryLang) ──────

  async function handleShowPrimary() {
    if (primaryCardResult) return;
    setPrimaryCardResult({ status: 'loading', data: null });
    try {
      const data = await lookupWordSingle(fields.word, learningLang, primaryLang, primaryLang);
      setPrimaryCardResult({ status: 'done', data });
    } catch {
      setPrimaryCardResult({ status: 'error', data: null });
    }
  }

  async function handleSavePrimary(data) {
    setPrimarySaveState({ status: 'saving', id: null });
    try {
      const wordData = {
        ...aiResultToWordFields(data),
        word_language:     primaryLang,
        date_added:        localToday(),
        last_reviewed:     null,
        total_attempts:    0,
        error_counter:     0,
        correct_streak:    0,
        starred:           false,
        mastered:          false,
        scene:             null,
        tags:              ['polyglot'],
        lookup_session_id: lookupSessionIdRef.current,
      };
      const saved = await onAddWord(wordData);
      setPrimarySaveState({ status: 'saved', id: saved.id });
    } catch (err) {
      console.error('[primary-save]', err?.message);
      setPrimarySaveState({ status: 'error', id: null });
    }
  }

  function handleUndoPrimary() {
    if (!primarySaveState.id) return;
    onRemoveWord(primarySaveState.id);
    setPrimarySaveState({ status: 'idle', id: null });
  }

  // Direct save — only used when inputLang === primaryLang.
  // Saves the original typed word using data already in `fields` (no API call).
  // word_alternatives/example/related_words are omitted: they're in the learning language,
  // not the input language, so they'd be wrong for this row.
  async function handleSavePrimaryDirect() {
    setPrimarySaveState({ status: 'saving', id: null });
    try {
      const wordData = {
        word:               lookupTermRef.current || fields.word,
        word_type:          'word',
        part_of_speech:     '',
        base_form:          null,
        meaning:            fields.meaning || '',
        meanings_array:     null,
        word_alternatives:  null,
        example:            '',
        recommended_level:  fields.recommended_level || '',
        related_words:      '',
        other_useful_notes: '',
        romanization:       null,
        kana_reading:       null,
        word_language:      primaryLang,
        date_added:         localToday(),
        last_reviewed:      null,
        total_attempts:     0,
        error_counter:      0,
        correct_streak:     0,
        starred:            false,
        mastered:           false,
        scene:              null,
        tags:               ['polyglot'],
        lookup_session_id:  lookupSessionIdRef.current,
      };
      const saved = await onAddWord(wordData);
      setPrimarySaveState({ status: 'saved', id: saved.id });
    } catch (err) {
      console.error('[primary-direct-save]', err?.message);
      setPrimarySaveState({ status: 'error', id: null });
    }
  }

  // ── Secondary lookups ─────────────────────────────────────────────────────────
  // Always fire with the ORIGINAL input word (not the learning-language output),
  // using the original input language as source, for each secondary language.

  function fireSecondaryLookups(originalWord, sourceLang, langs) {
    if (!langs || langs.length === 0) return;
    // Skip learning and primary — they're already shown in the main result
    const filtered = langs.filter(c => c !== learningLang && c !== primaryLang);
    if (filtered.length === 0) return;
    const initial = {};
    filtered.forEach(c => { initial[c] = { status: 'loading', data: null }; });
    setSecondaryResults(initial);
    filtered.forEach(c => {
      lookupSecondary(originalWord, sourceLang, c, primaryLang, null)
        .then(data => setSecondaryResults(prev => ({ ...prev, [c]: { status: 'done', data } })))
        .catch(() => setSecondaryResults(prev => ({ ...prev, [c]: { status: 'error', data: null } })));
    });
  }

  // ── Input language selection ──────────────────────────────────────────────────

  function handleInputLangChange(code) {
    if (code === actualInputLang) return;
    setInputLang(code);
    resetLookupState();
  }

  // ── Lookup (single, default cheap call) ──────────────────────────────────────

  const handleLookup = useCallback(async (wordOverride) => {
    const term = (wordOverride ?? inputWord).trim();
    if (!term) return;
    lookupTermRef.current = term;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    // New session ID for this lookup — shared by primary auto-save and any secondary saves
    lookupSessionIdRef.current = crypto.randomUUID();

    setPhase('loading');
    setErrorMsg('');
    setDuplicate(null);
    setSavedIndices(new Set());
    setCandidates([]);
    setSecondaryResults({});
    setSecondarySaveStates({});

    try {
      const result = await lookupWordSingle(term, actualInputLang, learningLang, primaryLang, controller.signal);
      clearTimeout(timeoutId);
      const resultWord = result.word || term;
      const wordFields = {
        ...aiResultToWordFields(result),
        word: resultWord,
        // string fields shown in editable form inputs need '' not null
        romanization: result.romanization || '',
        kana_reading: result.kana_reading || '',
      };
      setFields(wordFields);
      setPhase('preview');
      setInputWord('');
      searchInputRef.current?.focus();
      fireSecondaryLookups(term.toLowerCase().trim(), actualInputLang, secondaryLangs);

      if (AUTO_SAVE_ENABLED) {
        const wordData = {
          ...wordFields,
          word_language:      learningLang,
          date_added:         localToday(),
          last_reviewed:      null,
          total_attempts:     0,
          error_counter:      0,
          correct_streak:     0,
          starred:            false,
          mastered:           false,
          scene:              null,
          lookup_session_id:  lookupSessionIdRef.current,
        };
        handleAutoSave(wordData);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        setErrorMsg('Request timed out.');
      } else {
        setErrorMsg(err.message || 'Something went wrong.');
      }
      setFields({ ...EMPTY_FIELDS, word: term });
      setPhase('error');
    }
  }, [inputWord, actualInputLang, learningLang, primaryLang, secondaryLangs]);

  // ── See more (array call) ─────────────────────────────────────────────────────

  const handleSeeMore = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    setPhase('loading');
    setErrorMsg('');
    setSavedIndices(new Set());
    setNoMoreMeanings(false);

    try {
      // Use the original typed term so the multi-mode prompt gets the right input word.
      // For EN→ES: term="bank", input_language="en" → AI returns 3 different Spanish words.
      // For ES→ES: term="banco", input_language="es" → AI returns 3 meanings of the same word.
      // (fields.word is the learning-language translation; using it with actualInputLang
      //  confuses the model into returning the same word with minor variations.)
      const word = lookupTermRef.current || fields.word;
      const results = await lookupWord(word, actualInputLang, learningLang, primaryLang, controller.signal);
      clearTimeout(timeoutId);
      if (results.length === 0) {
        setNoMoreMeanings(true);
        setPhase('preview');
      } else {
        setCandidates(results);
        setPhase('candidates');
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        setErrorMsg('Request timed out.');
      } else {
        setErrorMsg(err.message || 'Something went wrong.');
      }
      setPhase('error');
    }
  }, [fields.word, inputWord, actualInputLang, learningLang, primaryLang]);

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleLookup();
  }

  function handleDiscard() {
    resetLookupState();
  }

  // ── Save candidate ────────────────────────────────────────────────────────────

  async function handleSaveCandidate(index) {
    const c = candidates[index];
    if (!c) return;

    const wordData = {
      ...aiResultToWordFields(c),
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

    try {
      const saved = await onAddWord(wordData);
      setSavedIndices(prev => new Set([...prev, index]));
      setSavedFlash(`"${saved.word}" saved!`);
      setTimeout(() => setSavedFlash(''), 2500);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to save. Try again.');
    }
  }

  // ── Add secondary language ────────────────────────────────────────────────────

  function handleAddSecondaryLanguage(code) {
    if (!onUpdatePreferences) return;
    onUpdatePreferences({ secondary_languages: [...secondaryLangs, code] });
    if ((phase === 'preview' || phase === 'candidates') && fields.word) {
      setSecondaryResults(prev => ({ ...prev, [code]: { status: 'loading', data: null } }));
      lookupSecondary(fields.word.toLowerCase().trim(), learningLang, code, primaryLang)
        .then(data => setSecondaryResults(prev => ({ ...prev, [code]: { status: 'done', data } })))
        .catch(() => setSecondaryResults(prev => ({ ...prev, [code]: { status: 'error', data: null } })));
    }
  }

  function handleUndoAdd(id) {
    onRemoveWord(id);
  }

  // ── Derived UI strings ────────────────────────────────────────────────────────

  const placeholder    = `Enter a ${inputLangObj?.label || 'word'} word or phrase…`;
  const candidatesHint = `${candidates.length} result${candidates.length !== 1 ? 's' : ''} found — save the ones you want`;
  const seeMoreLabel   = 'See more meanings';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <div className={`${styles.content} ${splitActive ? styles.contentWide : ''}`}>
        <h1 className={styles.title}>Add New Word</h1>

        {/* Language selector */}
        <div className={styles.langSelector}>
          <div className={styles.langRow}>
            <span className={styles.langRowLabel}>Type in:</span>
            <div className={styles.chipGroup}>
              {allLangCodes.map(code => {
                const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
                if (!lang) return null;
                const isActive = code === actualInputLang;
                return (
                  <button
                    key={code}
                    className={`${styles.langChip} ${isActive ? styles.langChipActive : ''}`}
                    onClick={() => handleInputLangChange(code)}
                    title={lang.label}
                  >
                    {lang.flag} {code.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
          <div className={styles.langInfo}>
            <span className={styles.langInfoText}>
              <span className={styles.langInfoPart}>Learning: {learningLangObj?.flag} {learningLangObj?.label}</span>
              <span className={styles.langInfoSep}> · </span>
              <span className={styles.langInfoPart}>Meaning in: {primaryLangObj?.flag} {primaryLangObj?.label}</span>
            </span>
            {onNavigate && (
              <button className={styles.langInfoLink} onClick={() => onNavigate('settings')}>
                Change in Settings
              </button>
            )}
          </div>
        </div>

        {/* Search bar */}
        <div className={styles.searchRow}>
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            type="text"
            placeholder={placeholder}
            value={inputWord}
            onChange={e => setInputWord(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={phase === 'loading'}
            autoFocus
            translate="no"
          />
          <button
            className={styles.lookupBtn}
            onClick={() => handleLookup()}
            disabled={phase === 'loading' || !inputWord.trim()}
          >
            {phase === 'loading' ? <span className={styles.spinner} /> : 'Look up →'}
          </button>
        </div>

        {/* Saved confirmation flash */}
        {savedFlash && <div className={styles.savedFlash}>{savedFlash}</div>}

        {/* Error state */}
        {phase === 'error' && (
          <div className={styles.errorBox}>
            <span className={styles.errorIcon}>⚠</span>
            <span className={styles.errorText}>{errorMsg}</span>
            <div className={styles.errorActions}>
              <button className={styles.retryBtn} onClick={() => handleLookup()}>Retry</button>
            </div>
          </div>
        )}

        {/* Results area — split layout on desktop when secondary langs present */}
        {(phase === 'preview' || phase === 'candidates') && (
          <div className={splitActive ? styles.lookupResults : undefined}>
            {/* Primary column */}
            <div>
              {phase === 'preview' && (
                <PreviewCard
                  fields={fields}
                  duplicate={duplicate}
                  onSeeMore={noMoreMeanings ? null : handleSeeMore}
                  seeMoreLabel={noMoreMeanings ? 'No additional meanings found' : seeMoreLabel}
                  learningLang={learningLang}
                  autoSaved={autoSaveState}
                  onUndoAutoSave={handleUndoAutoSave}
                  previewTags={previewTags}
                  onTagChange={autoSaveState?.id ? (newTags) => {
                    setPreviewTags(newTags);
                    onUpdateWord(autoSaveState.id, { tags: newTags });
                  } : null}
                  wordAlternatives={fields.word_alternatives}
                />
              )}

              {phase === 'candidates' && candidates.length > 0 && (
                <div className={styles.candidatesSection}>
                  <div className={styles.candidatesHeader}>
                    <span className={styles.candidatesHint}>{candidatesHint}</span>
                    <button className={styles.discardAllBtn} onClick={handleDiscard}>
                      Discard all
                    </button>
                  </div>
                  <div className={styles.candidatesList}>
                    {candidates.map((c, i) => {
                      const alreadyInVocab = words.some(
                        w => w.word.toLowerCase().trim() === (c.word || '').toLowerCase().trim()
                      );
                      const isSaved = savedIndices.has(i);
                      return (
                        <CandidateCard
                          key={i}
                          word={c}
                          alreadyInVocab={alreadyInVocab}
                          isSaved={isSaved}
                          onSave={() => handleSaveCandidate(i)}
                          learningLang={learningLang}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Secondary column */}
            {splitActive && (
              <SecondaryColumn
                secondaryLangs={Object.keys(secondaryResults)}
                results={secondaryResults}
                availableToAdd={availableToAdd}
                onAddLanguage={handleAddSecondaryLanguage}
                words={words}
                saveStates={secondarySaveStates}
                onSave={handleSaveSecondary}
                onUndo={handleUndoSecondary}
                primaryLang={primaryLang}
                inputLang={actualInputLang}
                primaryLangCardActive={primaryLangCardActive}
                primarySaveCardActive={primarySaveCardActive}
                primaryLangObj={primaryLangObj}
                primaryCardResult={primaryCardResult}
                primaryAlreadySaved={primaryAlreadySaved}
                primaryDirectAlreadySaved={primaryDirectAlreadySaved}
                primarySaveState={primarySaveState}
                onShowPrimary={handleShowPrimary}
                onSavePrimary={() => handleSavePrimary(primaryCardResult?.data)}
                onSavePrimaryDirect={handleSavePrimaryDirect}
                onUndoPrimary={handleUndoPrimary}
              />
            )}
          </div>
        )}

        {/* Recent additions */}
        {recentWords.length > 0 && (
          <div className={styles.recentSection}>
            <h3 className={styles.recentTitle}>Last added words</h3>
            <div className={styles.recentList}>
              {recentWords.map(w => (
                <div key={w.id} className={styles.recentItem}>
                  <span className={styles.recentWord}>{w.word}</span>
                  <span className={styles.recentPos}>{w.part_of_speech}</span>
                  <span className={styles.recentMeaning}>{w.meaning}</span>
                  <button
                    className={styles.undoBtn}
                    onClick={() => handleUndoAdd(w.id)}
                    title="Remove this word"
                  >
                    Undo
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Secondary column ──────────────────────────────────────────────────────────

function SecondaryColumn({
  secondaryLangs, results, availableToAdd, onAddLanguage, words, saveStates, onSave, onUndo,
  primaryLang, inputLang,
  primaryLangCardActive, primarySaveCardActive, primaryLangObj,
  primaryCardResult, primaryAlreadySaved, primaryDirectAlreadySaved,
  primarySaveState, onShowPrimary, onSavePrimary, onSavePrimaryDirect, onUndoPrimary,
}) {
  const canAdd = secondaryLangs.length < 4 && availableToAdd.length > 0;

  return (
    <div className={styles.secondaryColumn}>
      {secondaryLangs.map(code => {
        const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
        if (!lang) return null;
        if (code === inputLang) return null;
        const entry = results[code];
        const data  = entry?.data;
        const alreadySaved = !!(data?.word && words.some(
          w => w.word?.toLowerCase() === data.word.toLowerCase() && w.word_language === code
        ));
        const saveState = saveStates[code] || { status: 'idle', id: null };
        const canSave = entry?.status === 'done' && !!data?.word && code !== primaryLang && !alreadySaved;
        return (
          <SecondaryMiniCard
            key={code}
            lang={lang}
            entry={entry}
            alreadySaved={alreadySaved}
            saveState={saveState}
            canSave={canSave}
            onSave={() => onSave(code, data)}
            onUndo={() => onUndo(code)}
          />
        );
      })}
      {canAdd && (
        <select
          className={styles.addLangSelect}
          value=""
          onChange={e => { if (e.target.value) onAddLanguage(e.target.value); }}
        >
          <option value="">+ Add language</option>
          {availableToAdd.map(l => (
            <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
          ))}
        </select>
      )}
      {primaryLangCardActive && primaryLangObj && (
        <PrimaryLangCard
          primaryLangObj={primaryLangObj}
          entry={primaryCardResult}
          alreadySaved={primaryAlreadySaved}
          saveState={primarySaveState}
          canSave={primaryCardResult?.status === 'done' && !!primaryCardResult?.data?.word && !primaryAlreadySaved}
          onShow={onShowPrimary}
          onSave={onSavePrimary}
          onUndo={onUndoPrimary}
        />
      )}
      {primarySaveCardActive && primaryLangObj && (
        <PrimaryDirectSaveCard
          primaryLangObj={primaryLangObj}
          alreadySaved={primaryDirectAlreadySaved}
          saveState={primarySaveState}
          onSave={onSavePrimaryDirect}
          onUndo={onUndoPrimary}
        />
      )}
    </div>
  );
}

// ── PrimaryLangCard ───────────────────────────────────────────────────────────
// Shows a "Show in [lang]" trigger button that expands into a SecondaryMiniCard on tap.

function PrimaryLangCard({ primaryLangObj, entry, alreadySaved, saveState, canSave, onShow, onSave, onUndo }) {
  if (!entry) {
    return (
      <button className={styles.showPrimaryBtn} onClick={onShow}>
        Show in {primaryLangObj.flag} {primaryLangObj.label} →
      </button>
    );
  }
  return (
    <SecondaryMiniCard
      lang={primaryLangObj}
      entry={entry}
      alreadySaved={alreadySaved}
      saveState={saveState}
      canSave={canSave}
      onSave={onSave}
      onUndo={onUndo}
    />
  );
}

// ── PrimaryDirectSaveCard ─────────────────────────────────────────────────────
// Used when inputLang === primaryLang. No API call — saves the typed word directly.

function PrimaryDirectSaveCard({ primaryLangObj, alreadySaved, saveState, onSave, onUndo }) {
  const [showUndo, setShowUndo] = useState(false);
  const undoTimerRef = useRef(null);

  useEffect(() => {
    if (saveState?.status === 'saved') {
      setShowUndo(true);
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => setShowUndo(false), 5000);
    } else {
      setShowUndo(false);
    }
    return () => clearTimeout(undoTimerRef.current);
  }, [saveState?.status]);

  const isSaved = alreadySaved || saveState?.status === 'saved';

  if (isSaved) {
    return (
      <div className={styles.miniCard}>
        <div className={styles.miniCardHeader}>
          <span className={styles.miniCardFlag}>{primaryLangObj.flag}</span>
          <span className={styles.miniCardLang}>{primaryLangObj.label}</span>
        </div>
        <div className={styles.miniCardSavedBar}>
          <span className={styles.miniCardSavedText}>Saved ✓</span>
          {showUndo && !alreadySaved && (
            <button className={styles.miniCardUndoBtn} onClick={onUndo}>Undo</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <button
      className={styles.showPrimaryBtn}
      onClick={onSave}
      disabled={saveState?.status === 'saving'}
    >
      {saveState?.status === 'saving'
        ? <span className={styles.miniSpinner} />
        : `Save in ${primaryLangObj.flag} ${primaryLangObj.label}`}
    </button>
  );
}

// Fields shown in expanded view — add new entries here to extend without rewriting card logic
const SECONDARY_EXTRA_FIELDS = [
  { key: 'part_of_speech',      label: 'Part of speech' },
  { key: 'example',             label: 'Example' },
  { key: 'related_words',       label: 'Related words' },
  { key: 'other_useful_notes',  label: 'Notes' },
];

function SecondaryMiniCard({ lang, entry, alreadySaved, saveState, canSave, onSave, onUndo }) {
  const [expanded,  setExpanded]  = useState(false);
  const [showUndo,  setShowUndo]  = useState(false);
  const undoTimerRef = useRef(null);

  const data = entry?.data;
  const hasExtra = data && SECONDARY_EXTRA_FIELDS.some(f => data[f.key]);

  // 5-second undo window after a successful save
  useEffect(() => {
    if (saveState?.status === 'saved') {
      setShowUndo(true);
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => setShowUndo(false), 5000);
    } else {
      setShowUndo(false);
    }
    return () => clearTimeout(undoTimerRef.current);
  }, [saveState?.status]);

  const isSaved = alreadySaved || saveState?.status === 'saved';

  return (
    <div className={styles.miniCard} translate="no">
      <div className={styles.miniCardHeader}>
        <span className={styles.miniCardFlag}>{lang.flag}</span>
        <span className={styles.miniCardLang}>{lang.label}</span>
      </div>
      {!entry || entry.status === 'loading' ? (
        <div className={styles.miniCardLoading}>
          <span className={styles.miniSpinner} />
        </div>
      ) : entry.status === 'error' ? (
        <p className={styles.miniCardError}>Could not load</p>
      ) : data ? (
        <div className={styles.miniCardBody}>
          <div className={styles.miniCardWordRow}>
            <p className={styles.miniCardWord}>{data.word}</p>
            <SpeakerButton word={data.word} lang={lang.code} />
            {data.recommended_level && (
              <span className={styles.miniCardLevel}>{data.recommended_level}</span>
            )}
          </div>
          <RomanizationDisplay kana={data.kana_reading} romanization={data.romanization} />
          {data.word_alternatives?.length > 0 && (
            <div className={styles.miniCardAlts}>
              {data.word_alternatives.map((alt, i) => (
                <span key={i} className={styles.miniCardAlt}>{alt}</span>
              ))}
            </div>
          )}
          <p className={styles.miniCardMeaning}>{data.meaning}</p>
          {/* Native meaning — shown only when it differs from the primary-language meaning */}
          {data.meaning_native && data.meaning_native !== data.meaning && (
            <p className={styles.miniCardMeaningNative}>{data.meaning_native}</p>
          )}
          {!expanded && data.example && (
            <p className={styles.miniCardExample}>{data.example}</p>
          )}
          {expanded && (
            <div className={styles.miniCardExtra}>
              {SECONDARY_EXTRA_FIELDS.map(({ key, label }) =>
                data[key] ? (
                  <div key={key} className={styles.miniCardExtraField}>
                    <span className={styles.miniCardExtraLabel}>{label}</span>
                    <span className={styles.miniCardExtraValue}>{data[key]}</span>
                  </div>
                ) : null
              )}
            </div>
          )}
          {hasExtra && (
            <button
              className={styles.miniCardMoreBtn}
              onClick={() => setExpanded(e => !e)}
            >
              {expanded ? 'Show less ▲' : 'Show more ▼'}
            </button>
          )}
          {/* Save / Saved bar */}
          {isSaved ? (
            <div className={styles.miniCardSavedBar}>
              <span className={styles.miniCardSavedText}>Saved ✓</span>
              {showUndo && (
                <button className={styles.miniCardUndoBtn} onClick={onUndo}>Undo</button>
              )}
            </div>
          ) : saveState?.status === 'error' ? (
            <div className={styles.miniCardSavedBar}>
              <span className={styles.miniCardSaveError}>Save failed — retry?</span>
              <button className={styles.miniCardSaveBtn} onClick={onSave}>Retry</button>
            </div>
          ) : canSave ? (
            <button
              className={styles.miniCardSaveBtn}
              onClick={onSave}
              disabled={saveState?.status === 'saving'}
            >
              {saveState?.status === 'saving' ? <span className={styles.miniSpinner} /> : 'Save'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── PreviewCard ───────────────────────────────────────────────────────────────

function PreviewCard({ fields, duplicate, onSeeMore, seeMoreLabel, learningLang, autoSaved, onUndoAutoSave, previewTags, onTagChange, wordAlternatives }) {
  return (
    <div className={styles.previewCard} translate="no">
      <div className={styles.previewHeader}>
        <span className={styles.previewHint}>Word lookup result</span>
        <SpeakerButton word={fields.word} lang={learningLang} className={styles.previewSpeaker} />
      </div>

      {/* Word + romanization */}
      <div className={styles.previewWordRow}>
        <span className={styles.previewWord}>{fields.word}</span>
        {fields.part_of_speech && (
          <span className={styles.previewPos}>{fields.part_of_speech}</span>
        )}
        {fields.recommended_level && (
          <span className={styles.previewLevel}>{fields.recommended_level}</span>
        )}
      </div>
      <RomanizationDisplay kana={fields.kana_reading} romanization={fields.romanization} />

      {wordAlternatives?.length > 0 && (
        <div className={styles.previewAlts}>
          {wordAlternatives.map((alt, i) => (
            <span key={i} className={styles.previewAlt}>{alt}</span>
          ))}
        </div>
      )}

      {/* Core fields */}
      {fields.meaning && (
        <div className={styles.previewField}>
          <span className={styles.previewFieldLabel}>Meaning</span>
          <span className={styles.previewFieldValue}>{fields.meaning}</span>
        </div>
      )}
      {fields.example && (
        <div className={styles.previewField}>
          <span className={styles.previewFieldLabel}>Example</span>
          <span className={`${styles.previewFieldValue} ${styles.previewExample}`}>{fields.example}</span>
        </div>
      )}
      {fields.related_words && (
        <div className={styles.previewField}>
          <span className={styles.previewFieldLabel}>Related</span>
          <span className={styles.previewFieldValue}>{fields.related_words}</span>
        </div>
      )}
      {fields.other_useful_notes && (
        <div className={styles.previewField}>
          <span className={styles.previewFieldLabel}>Notes</span>
          <span className={styles.previewFieldValue}>{fields.other_useful_notes}</span>
        </div>
      )}

      {/* Status bar */}
      {duplicate ? (
        <div className={styles.dupSimple}>
          <span className={styles.dupSimpleIcon}>⚠</span>
          <span className={styles.dupSimpleText}>Already in your vocabulary</span>
        </div>
      ) : autoSaved?.id ? (
        <div className={styles.autoSavedBar}>
          <span className={styles.autoSavedText}>Saved automatically ✓</span>
          <button className={styles.autoUndoBtn} onClick={onUndoAutoSave}>Undo</button>
        </div>
      ) : autoSaved ? (
        <div className={styles.savedConfirm}>Saved ✓</div>
      ) : null}

      {/* Tag bar — only shown when word is saved (we have an id to write to) */}
      {onTagChange && (
        <div className={styles.previewTagRow}>
          <TagBar tags={previewTags} onChange={onTagChange} size="sm" />
        </div>
      )}

      {(onSeeMore || seeMoreLabel) && (
        <div className={styles.seeMoreRow}>
          {onSeeMore ? (
            <button className={styles.seeMoreBtn} onClick={onSeeMore}>
              {seeMoreLabel} →
            </button>
          ) : (
            <span className={styles.noMoreNote}>{seeMoreLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── CandidateCard ─────────────────────────────────────────────────────────────

function CandidateCard({ word, alreadyInVocab, isSaved, onSave, learningLang }) {
  return (
    <div className={`${styles.candidateCard} ${isSaved ? styles.candidateSaved : ''}`} translate="no">
      <div className={styles.candidateTop}>
        <div className={styles.candidateWordRow}>
          <span className={styles.candidateWord}>{word.word}</span>
          <SpeakerButton word={word.word} lang={learningLang} />
          {word.part_of_speech && <span className={styles.candidatePos}>{word.part_of_speech}</span>}
          {word.recommended_level && (
            <span className={styles.candidateLevel}>{word.recommended_level}</span>
          )}
        </div>
        <RomanizationDisplay kana={word.kana_reading} romanization={word.romanization} />
        <div className={styles.candidateActions}>
          {isSaved ? (
            <span className={styles.savedBadge}>Saved ✓</span>
          ) : alreadyInVocab ? (
            <span className={styles.alreadyBadge}>Already in vocabulary</span>
          ) : (
            <button className={styles.saveCandidateBtn} onClick={onSave}>Save</button>
          )}
        </div>
      </div>

      <div className={styles.candidateDetails}>
        {word.meaning && (
          <div className={styles.candidateRow}>
            <span className={styles.candidateLabel}>Meaning</span>
            <span className={styles.candidateMeaning}>{word.meaning}</span>
          </div>
        )}
        {word.example && (
          <div className={styles.candidateRow}>
            <span className={styles.candidateLabel}>Example</span>
            <span className={styles.candidateExample}>{word.example}</span>
          </div>
        )}
        {word.related_words && (
          <div className={styles.candidateRow}>
            <span className={styles.candidateLabel}>Related</span>
            <span className={styles.candidateValue}>{word.related_words}</span>
          </div>
        )}
        {word.other_useful_notes && (
          <div className={styles.candidateRow}>
            <span className={styles.candidateLabel}>Notes</span>
            <span className={styles.candidateValue}>{word.other_useful_notes}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared romanization display ───────────────────────────────────────────────

function RomanizationDisplay({ kana, romanization }) {
  if (!kana && !romanization) return null;
  return (
    <div className={styles.wordRomanizationWrap}>
      {kana       && <span className={styles.wordKana}>{kana}</span>}
      {romanization && <span className={styles.wordRomanization}>{romanization}</span>}
    </div>
  );
}

