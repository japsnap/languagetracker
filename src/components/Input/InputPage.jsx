import { useState, useRef, useCallback } from 'react';
import { lookupWord, lookupEnglishWord } from '../../utils/anthropic';
import { localToday } from '../../utils/vocabulary';
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
};

export default function InputPage({ words, onAddWord, onRemoveWord }) {
  const [direction, setDirection]       = useState('es-en'); // 'es-en' | 'en-es'
  const [inputWord, setInputWord]       = useState('');
  const [phase, setPhase]               = useState('idle'); // idle | loading | preview | candidates | error
  const [fields, setFields]             = useState(EMPTY_FIELDS);
  const [candidates, setCandidates]     = useState([]);    // EN→ES results
  const [savedIndices, setSavedIndices] = useState(new Set());
  const [errorMsg, setErrorMsg]         = useState('');
  const [duplicate, setDuplicate]       = useState(null);
  const [showExisting, setShowExisting] = useState(false);
  const [sessionAdded, setSessionAdded] = useState([]);
  const [savedFlash, setSavedFlash]     = useState('');
  const abortRef = useRef(null);

  // ── direction toggle ──────────────────────────────────────────────────────────

  function handleDirectionChange(dir) {
    if (dir === direction) return;
    setDirection(dir);
    handleDiscard();
  }

  // ── lookup ────────────────────────────────────────────────────────────────────

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

    try {
      if (direction === 'es-en') {
        const result = await lookupWord(term, controller.signal);
        clearTimeout(timeoutId);
        setFields({
          word:               term,
          part_of_speech:     result.part_of_speech    || '',
          meaning:            result.meaning           || '',
          example:            result.example           || '',
          recommended_level:  result.recommended_level || '',
          related_words:      result.related_words     || '',
          other_useful_notes: result.other_useful_notes || '',
        });
        setPhase('preview');
      } else {
        const results = await lookupEnglishWord(term, controller.signal);
        clearTimeout(timeoutId);
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
      setFields({ ...EMPTY_FIELDS, word: term });
      setPhase('error');
    }
  }, [inputWord, direction]);

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleLookup();
  }

  function handleFillManually() {
    setPhase('preview');
    setErrorMsg('');
  }

  function handleDiscard() {
    setPhase('idle');
    setFields(EMPTY_FIELDS);
    setInputWord('');
    setDuplicate(null);
    setShowExisting(false);
    setCandidates([]);
    setSavedIndices(new Set());
    if (abortRef.current) abortRef.current.abort();
  }

  // ── save (ES→EN single word) ──────────────────────────────────────────────────

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
      setPhase('idle');
      setFields(EMPTY_FIELDS);
      setInputWord('');
      setDuplicate(null);
      setShowExisting(false);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to save word. Try again.');
      setPhase('error');
    }
  }

  // ── save candidate (EN→ES) ────────────────────────────────────────────────────

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

  function handleUndoAdd(id) {
    onRemoveWord(id);
    setSessionAdded(prev => prev.filter(w => w.id !== id));
  }

  function setField(key, value) {
    setFields(f => ({ ...f, [key]: value }));
  }

  const placeholder = direction === 'es-en'
    ? 'Enter a Spanish word or phrase…'
    : 'Enter an English word or expression…';

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h1 className={styles.title}>Add New Word</h1>

        {/* Direction toggle */}
        <div className={styles.directionToggle}>
          <button
            className={`${styles.dirBtn} ${direction === 'es-en' ? styles.dirActive : ''}`}
            onClick={() => handleDirectionChange('es-en')}
          >
            Spanish → English
          </button>
          <button
            className={`${styles.dirBtn} ${direction === 'en-es' ? styles.dirActive : ''}`}
            onClick={() => handleDirectionChange('en-es')}
          >
            English → Spanish
          </button>
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
              {direction === 'es-en' && (
                <button className={styles.manualBtn} onClick={handleFillManually}>Fill manually</button>
              )}
            </div>
          </div>
        )}

        {/* ES→EN: single preview card */}
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
          />
        )}

        {/* EN→ES: multi-candidate cards */}
        {phase === 'candidates' && candidates.length > 0 && (
          <div className={styles.candidatesSection}>
            <div className={styles.candidatesHeader}>
              <span className={styles.candidatesHint}>
                {candidates.length} Spanish match{candidates.length !== 1 ? 'es' : ''} found — save the ones you want
              </span>
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

// ── PreviewCard (ES→EN) ───────────────────────────────────────────────────────

function PreviewCard({ fields, setField, duplicate, showExisting, onToggleExisting, onSave, onSaveAnyway, onDiscard }) {
  return (
    <div className={styles.previewCard}>
      <div className={styles.previewHeader}>
        <span className={styles.previewHint}>Review and edit before saving</span>
      </div>

      <div className={styles.formGrid}>
        <FormField label="Word *" required>
          <input className={styles.formInput} value={fields.word} onChange={e => setField('word', e.target.value)} />
        </FormField>

        <FormField label="Part of speech">
          <input className={styles.formInput} value={fields.part_of_speech} onChange={e => setField('part_of_speech', e.target.value)} placeholder="e.g. noun, verb, phrase…" />
        </FormField>

        <FormField label="Meaning *" wide required>
          <input className={styles.formInput} value={fields.meaning} onChange={e => setField('meaning', e.target.value)} placeholder="English meaning" />
        </FormField>

        <FormField label="Level">
          <select className={styles.formSelect} value={fields.recommended_level} onChange={e => setField('recommended_level', e.target.value)}>
            <option value="">— select —</option>
            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </FormField>

        <FormField label="Example sentence" wide>
          <textarea className={styles.formTextarea} rows={2} value={fields.example} onChange={e => setField('example', e.target.value)} placeholder="A natural Spanish sentence using this word" />
        </FormField>

        <FormField label="Related words" wide>
          <input className={styles.formInput} value={fields.related_words} onChange={e => setField('related_words', e.target.value)} placeholder="Comma-separated related words" />
        </FormField>

        <FormField label="Notes" wide>
          <textarea className={styles.formTextarea} rows={2} value={fields.other_useful_notes} onChange={e => setField('other_useful_notes', e.target.value)} placeholder="Grammar notes, usage tips, conjugation info…" />
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
    </div>
  );
}

// ── CandidateCard (EN→ES) ─────────────────────────────────────────────────────

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

// ── helpers ───────────────────────────────────────────────────────────────────

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
