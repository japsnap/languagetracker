import { useState, useRef, useCallback } from 'react';
import { lookupWord, lookupWordSingle, lookupSecondary } from '../../utils/anthropic';
import { localToday } from '../../utils/vocabulary';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';
import styles from './InputPage.module.css';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const EMPTY_FIELDS = {
  word: '',
  part_of_speech: '',
  meaning: '',
  example: '',
  recommended_level: '',
  related_words: '',
  other_useful_notes: '',
  romanization: '',
  kana_reading: '',
};

export default function InputPage({ words, onAddWord, onRemoveWord, preferences, onUpdatePreferences, onNavigate }) {
  const [inputLang, setInputLang]               = useState(null); // null = derive from preferences
  const [inputWord, setInputWord]               = useState('');
  const [phase, setPhase]                       = useState('idle'); // idle | loading | preview | candidates | error
  const [fields, setFields]                     = useState(EMPTY_FIELDS);
  const [candidates, setCandidates]             = useState([]);
  const [savedIndices, setSavedIndices]         = useState(new Set());
  const [errorMsg, setErrorMsg]                 = useState('');
  const [duplicate, setDuplicate]               = useState(null);
  const [showExisting, setShowExisting]         = useState(false);
  const [sessionAdded, setSessionAdded]         = useState([]);
  const [savedFlash, setSavedFlash]             = useState('');
  const [secondaryResults, setSecondaryResults] = useState({}); // { [langCode]: { status, data } }
  const abortRef = useRef(null);

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

  const splitActive = Object.keys(secondaryResults).length > 0 &&
                      (phase === 'preview' || phase === 'candidates');

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
    setShowExisting(false);
    setCandidates([]);
    setSavedIndices(new Set());
    setSecondaryResults({});
    if (abortRef.current) abortRef.current.abort();
  }

  // ── Secondary lookups ─────────────────────────────────────────────────────────
  // Always fire with the result word (in learning language) as input,
  // using learningLang as source, for each secondary language.

  function fireSecondaryLookups(wordInLearningLang, langs) {
    if (!langs || langs.length === 0) return;
    // Skip learning and primary — they're already shown in the main result
    const filtered = langs.filter(c => c !== learningLang && c !== primaryLang);
    if (filtered.length === 0) return;
    const initial = {};
    filtered.forEach(c => { initial[c] = { status: 'loading', data: null }; });
    setSecondaryResults(initial);
    filtered.forEach(c => {
      lookupSecondary(wordInLearningLang, learningLang, c, null)
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

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    setPhase('loading');
    setErrorMsg('');
    setDuplicate(null);
    setShowExisting(false);
    setSavedIndices(new Set());
    setCandidates([]);
    setSecondaryResults({});

    try {
      const result = await lookupWordSingle(term, actualInputLang, learningLang, primaryLang, controller.signal);
      clearTimeout(timeoutId);
      const resultWord = result.word || term;
      setFields({
        word:               resultWord,
        part_of_speech:     result.part_of_speech     || '',
        meaning:            result.meaning            || '',
        example:            result.example            || '',
        recommended_level:  result.recommended_level  || '',
        related_words:      result.related_words      || '',
        other_useful_notes: result.other_useful_notes || '',
        romanization:       result.romanization       || '',
        kana_reading:       result.kana_reading       || '',
      });
      setPhase('preview');
      fireSecondaryLookups(resultWord.toLowerCase().trim(), secondaryLangs);
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

    try {
      const results = await lookupWord(fields.word || inputWord, actualInputLang, learningLang, primaryLang, controller.signal);
      clearTimeout(timeoutId);
      setCandidates(results);
      setPhase('candidates');
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

  function handleFillManually() {
    setPhase('preview');
    setErrorMsg('');
  }

  function handleDiscard() {
    resetLookupState();
  }

  // ── Save preview word ─────────────────────────────────────────────────────────

  async function handleSave(force = false) {
    if (!fields.word.trim()) return;

    if (!force) {
      const existing = words.find(
        w => w.word.toLowerCase().trim() === fields.word.toLowerCase().trim()
      );
      if (existing) { setDuplicate(existing); return; }
    }

    const wordData = {
      word:               fields.word.trim(),
      part_of_speech:     fields.part_of_speech,
      meaning:            fields.meaning,
      example:            fields.example,
      recommended_level:  fields.recommended_level,
      related_words:      fields.related_words,
      other_useful_notes: fields.other_useful_notes,
      romanization:       fields.romanization       || null,
      kana_reading:       fields.kana_reading       || null,
      date_added:         localToday(),
      last_reviewed:      null,
      total_attempts:     0,
      error_counter:      0,
      correct_streak:     0,
      starred:            false,
      mastered:           false,
      scene:              null,
    };

    try {
      const saved = await onAddWord(wordData);
      setSessionAdded(prev => [saved, ...prev].slice(0, 5));
      setSavedFlash(`"${saved.word}" saved!`);
      setTimeout(() => setSavedFlash(''), 2500);
      resetLookupState();
    } catch (err) {
      setErrorMsg(err.message || 'Failed to save word. Try again.');
      setPhase('error');
    }
  }

  // ── Save candidate ────────────────────────────────────────────────────────────

  async function handleSaveCandidate(index) {
    const c = candidates[index];
    if (!c) return;

    const wordData = {
      word:               (c.word || '').trim(),
      part_of_speech:     c.part_of_speech     || '',
      meaning:            c.meaning            || '',
      example:            c.example            || '',
      recommended_level:  c.recommended_level  || '',
      related_words:      c.related_words      || '',
      other_useful_notes: c.other_useful_notes || '',
      romanization:       c.romanization       || null,
      kana_reading:       c.kana_reading       || null,
      date_added:         localToday(),
      last_reviewed:      null,
      total_attempts:     0,
      error_counter:      0,
      correct_streak:     0,
      starred:            false,
      mastered:           false,
      scene:              null,
    };

    try {
      const saved = await onAddWord(wordData);
      setSessionAdded(prev => [saved, ...prev].slice(0, 5));
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
      lookupSecondary(fields.word.toLowerCase().trim(), learningLang, code, null)
        .then(data => setSecondaryResults(prev => ({ ...prev, [code]: { status: 'done', data } })))
        .catch(() => setSecondaryResults(prev => ({ ...prev, [code]: { status: 'error', data: null } })));
    }
  }

  function handleUndoAdd(id) {
    onRemoveWord(id);
    setSessionAdded(prev => prev.filter(w => w.id !== id));
  }

  function setField(key, value) {
    setFields(f => ({ ...f, [key]: value }));
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
            className={styles.searchInput}
            type="text"
            placeholder={placeholder}
            value={inputWord}
            onChange={e => setInputWord(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={phase === 'loading'}
            autoFocus
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
              <button className={styles.manualBtn} onClick={handleFillManually}>Fill manually</button>
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
                  setField={setField}
                  duplicate={duplicate}
                  showExisting={showExisting}
                  onToggleExisting={() => setShowExisting(s => !s)}
                  onSave={() => handleSave(false)}
                  onSaveAnyway={() => handleSave(true)}
                  onDiscard={handleDiscard}
                  onSeeMore={handleSeeMore}
                  seeMoreLabel={seeMoreLabel}
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
              />
            )}
          </div>
        )}

        {/* Recent additions */}
        {sessionAdded.length > 0 && (
          <div className={styles.recentSection}>
            <h3 className={styles.recentTitle}>Added this session</h3>
            <div className={styles.recentList}>
              {sessionAdded.map(w => (
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

function SecondaryColumn({ secondaryLangs, results, availableToAdd, onAddLanguage }) {
  const canAdd = secondaryLangs.length < 4 && availableToAdd.length > 0;

  return (
    <div className={styles.secondaryColumn}>
      {secondaryLangs.map(code => {
        const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
        if (!lang) return null;
        return (
          <SecondaryMiniCard key={code} lang={lang} entry={results[code]} />
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
    </div>
  );
}

function SecondaryMiniCard({ lang, entry }) {
  return (
    <div className={styles.miniCard}>
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
      ) : entry.data ? (
        <div className={styles.miniCardBody}>
          <p className={styles.miniCardWord}>{entry.data.word_in_target}</p>
          <RomanizationDisplay kana={entry.data.kana_reading} romanization={entry.data.romanization} />
          <p className={styles.miniCardMeaning}>{entry.data.meaning_brief}</p>
          {entry.data.example_brief && (
            <p className={styles.miniCardExample}>{entry.data.example_brief}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── PreviewCard ───────────────────────────────────────────────────────────────

function PreviewCard({ fields, setField, duplicate, showExisting, onToggleExisting, onSave, onSaveAnyway, onDiscard, onSeeMore, seeMoreLabel }) {
  return (
    <div className={styles.previewCard}>
      <div className={styles.previewHeader}>
        <span className={styles.previewHint}>Review and edit before saving</span>
      </div>

      <div className={styles.formGrid}>
        <FormField label="Word *" required>
          <input className={styles.formInput} value={fields.word} onChange={e => setField('word', e.target.value)} />
          <RomanizationDisplay kana={fields.kana_reading} romanization={fields.romanization} />
        </FormField>

        <FormField label="Part of speech">
          <input className={styles.formInput} value={fields.part_of_speech} onChange={e => setField('part_of_speech', e.target.value)} placeholder="e.g. noun, verb, phrase…" />
        </FormField>

        <FormField label="Meaning *" wide required>
          <input className={styles.formInput} value={fields.meaning} onChange={e => setField('meaning', e.target.value)} placeholder="Meaning in your primary language" />
        </FormField>

        <FormField label="Level">
          <select className={styles.formSelect} value={fields.recommended_level} onChange={e => setField('recommended_level', e.target.value)}>
            <option value="">— select —</option>
            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </FormField>

        <FormField label="Example sentence" wide>
          <textarea className={styles.formTextarea} rows={2} value={fields.example} onChange={e => setField('example', e.target.value)} placeholder="A natural sentence using this word" />
        </FormField>

        <FormField label="Related words" wide>
          <input className={styles.formInput} value={fields.related_words} onChange={e => setField('related_words', e.target.value)} placeholder="Comma-separated related words" />
        </FormField>

        <FormField label="Notes" wide>
          <textarea className={styles.formTextarea} rows={2} value={fields.other_useful_notes} onChange={e => setField('other_useful_notes', e.target.value)} placeholder="Grammar notes, usage tips…" />
        </FormField>
      </div>

      {duplicate && (
        <div className={styles.duplicateBox}>
          <span className={styles.dupIcon}>⚠</span>
          <span className={styles.dupText}><strong>"{duplicate.word}"</strong> already exists in your vocabulary.</span>
          <div className={styles.dupActions}>
            <button className={styles.dupViewBtn} onClick={onToggleExisting}>{showExisting ? 'Hide existing' : 'View existing'}</button>
            <button className={styles.dupSaveBtn} onClick={onSaveAnyway}>Save anyway</button>
          </div>
          {showExisting && (
            <div className={styles.existingPreview}>
              <ExistingRow label="Word"    value={duplicate.word} />
              <ExistingRow label="Meaning" value={duplicate.meaning} />
              <ExistingRow label="Example" value={duplicate.example} />
              <ExistingRow label="Level"   value={duplicate.recommended_level} />
              <ExistingRow label="Notes"   value={duplicate.other_useful_notes} />
            </div>
          )}
        </div>
      )}

      <div className={styles.previewActions}>
        <button className={styles.saveBtn} onClick={onSave} disabled={!fields.word.trim() || !fields.meaning.trim()}>
          Save to vocabulary
        </button>
        <button className={styles.discardBtn} onClick={onDiscard}>Discard</button>
      </div>

      {onSeeMore && (
        <div className={styles.seeMoreRow}>
          <button className={styles.seeMoreBtn} onClick={onSeeMore}>
            {seeMoreLabel} →
          </button>
        </div>
      )}
    </div>
  );
}

// ── CandidateCard ─────────────────────────────────────────────────────────────

function CandidateCard({ word, alreadyInVocab, isSaved, onSave }) {
  return (
    <div className={`${styles.candidateCard} ${isSaved ? styles.candidateSaved : ''}`}>
      <div className={styles.candidateTop}>
        <div className={styles.candidateWordRow}>
          <span className={styles.candidateWord}>{word.word}</span>
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function FormField({ label, children, wide, required }) {
  return (
    <div className={`${styles.formField} ${wide ? styles.formFieldWide : ''}`}>
      <label className={styles.formLabel}>
        {label}{required && <span className={styles.required}> *</span>}
      </label>
      {children}
    </div>
  );
}

function ExistingRow({ label, value }) {
  if (!value) return null;
  return (
    <div className={styles.existingRow}>
      <span className={styles.existingLabel}>{label}:</span>
      <span className={styles.existingValue}>{value}</span>
    </div>
  );
}
