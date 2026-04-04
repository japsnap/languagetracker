import { useState, useRef, useCallback } from 'react';
import { lookupWord } from '../../utils/anthropic';
import { localToday } from '../../utils/vocabulary';
import styles from './InputPage.module.css';

const LEVELS = ['A1', 'A2', 'B1', 'B2'];

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
  const [inputWord, setInputWord] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | loading | preview | error
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [errorMsg, setErrorMsg] = useState('');
  const [duplicate, setDuplicate] = useState(null);    // existing word object if duplicate
  const [showExisting, setShowExisting] = useState(false);
  const [sessionAdded, setSessionAdded] = useState([]); // last 5 words added this session
  const [savedFlash, setSavedFlash] = useState('');     // brief confirmation message
  const abortRef = useRef(null);

  // ── lookup ────────────────────────────────────────────────────────────────────

  const handleLookup = useCallback(async (wordOverride) => {
    const term = (wordOverride ?? inputWord).trim();
    if (!term) return;

    // Cancel any in-flight request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // 10-second timeout
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    setPhase('loading');
    setErrorMsg('');
    setDuplicate(null);
    setShowExisting(false);

    try {
      const result = await lookupWord(term, controller.signal);
      clearTimeout(timeoutId);
      setFields({
        word: term,
        part_of_speech:    result.part_of_speech    || '',
        meaning:           result.meaning           || '',
        example:           result.example           || '',
        recommended_level: result.recommended_level || '',
        related_words:     result.related_words     || '',
        other_useful_notes: result.other_useful_notes || '',
      });
      setPhase('preview');
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        setErrorMsg('Request timed out after 10 seconds.');
      } else {
        setErrorMsg(err.message || 'Something went wrong.');
      }
      setFields({ ...EMPTY_FIELDS, word: term });
      setPhase('error');
    }
  }, [inputWord]);

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
    if (abortRef.current) abortRef.current.abort();
  }

  // ── save ──────────────────────────────────────────────────────────────────────

  async function handleSave(force = false) {
    if (!fields.word.trim()) return;

    // Duplicate check
    if (!force) {
      const existing = words.find(
        w => w.word.toLowerCase().trim() === fields.word.toLowerCase().trim()
      );
      if (existing) {
        setDuplicate(existing);
        return;
      }
    }

    const today = localToday();
    const wordData = {
      word:               fields.word.trim(),
      part_of_speech:     fields.part_of_speech,
      meaning:            fields.meaning,
      example:            fields.example,
      recommended_level:  fields.recommended_level,
      related_words:      fields.related_words,
      other_useful_notes: fields.other_useful_notes,
      date_added:         today,
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

  function handleUndoAdd(id) {
    onRemoveWord(id);
    setSessionAdded(prev => prev.filter(w => w.id !== id));
  }

  function setField(key, value) {
    setFields(f => ({ ...f, [key]: value }));
  }

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h1 className={styles.title}>Add New Word</h1>

        {/* Search bar */}
        <div className={styles.searchRow}>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Enter a Spanish word or phrase…"
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
        {savedFlash && (
          <div className={styles.savedFlash}>{savedFlash}</div>
        )}

        {/* Error state */}
        {phase === 'error' && (
          <div className={styles.errorBox}>
            <span className={styles.errorIcon}>⚠</span>
            <span className={styles.errorText}>{errorMsg}</span>
            <div className={styles.errorActions}>
              <button className={styles.retryBtn} onClick={() => handleLookup()}>
                Retry
              </button>
              <button className={styles.manualBtn} onClick={handleFillManually}>
                Fill manually
              </button>
            </div>
          </div>
        )}

        {/* Preview / edit card */}
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

// ── PreviewCard ───────────────────────────────────────────────────────────────

function PreviewCard({ fields, setField, duplicate, showExisting, onToggleExisting, onSave, onSaveAnyway, onDiscard }) {
  return (
    <div className={styles.previewCard}>
      <div className={styles.previewHeader}>
        <span className={styles.previewHint}>Review and edit before saving</span>
      </div>

      <div className={styles.formGrid}>
        <FormField label="Word *" required>
          <input
            className={styles.formInput}
            value={fields.word}
            onChange={e => setField('word', e.target.value)}
          />
        </FormField>

        <FormField label="Part of speech">
          <input
            className={styles.formInput}
            value={fields.part_of_speech}
            onChange={e => setField('part_of_speech', e.target.value)}
            placeholder="e.g. noun, verb, phrase…"
          />
        </FormField>

        <FormField label="Meaning *" wide required>
          <input
            className={styles.formInput}
            value={fields.meaning}
            onChange={e => setField('meaning', e.target.value)}
            placeholder="English meaning"
          />
        </FormField>

        <FormField label="Level">
          <select
            className={styles.formSelect}
            value={fields.recommended_level}
            onChange={e => setField('recommended_level', e.target.value)}
          >
            <option value="">— select —</option>
            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </FormField>

        <FormField label="Example sentence" wide>
          <textarea
            className={styles.formTextarea}
            rows={2}
            value={fields.example}
            onChange={e => setField('example', e.target.value)}
            placeholder="A natural Spanish sentence using this word"
          />
        </FormField>

        <FormField label="Related words" wide>
          <input
            className={styles.formInput}
            value={fields.related_words}
            onChange={e => setField('related_words', e.target.value)}
            placeholder="Comma-separated related words"
          />
        </FormField>

        <FormField label="Notes" wide>
          <textarea
            className={styles.formTextarea}
            rows={2}
            value={fields.other_useful_notes}
            onChange={e => setField('other_useful_notes', e.target.value)}
            placeholder="Grammar notes, usage tips, conjugation info…"
          />
        </FormField>
      </div>

      {/* Duplicate warning */}
      {duplicate && (
        <div className={styles.duplicateBox}>
          <span className={styles.dupIcon}>⚠</span>
          <span className={styles.dupText}>
            <strong>"{duplicate.word}"</strong> already exists in your vocabulary.
          </span>
          <div className={styles.dupActions}>
            <button className={styles.dupViewBtn} onClick={onToggleExisting}>
              {showExisting ? 'Hide existing' : 'View existing'}
            </button>
            <button className={styles.dupSaveBtn} onClick={onSaveAnyway}>
              Save anyway
            </button>
          </div>
          {showExisting && (
            <div className={styles.existingPreview}>
              <ExistingRow label="Word"        value={duplicate.word} />
              <ExistingRow label="Meaning"     value={duplicate.meaning} />
              <ExistingRow label="Example"     value={duplicate.example} />
              <ExistingRow label="Level"       value={duplicate.recommended_level} />
              <ExistingRow label="Notes"       value={duplicate.other_useful_notes} />
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className={styles.previewActions}>
        <button
          className={styles.saveBtn}
          onClick={onSave}
          disabled={!fields.word.trim() || !fields.meaning.trim()}
        >
          Save to vocabulary
        </button>
        <button className={styles.discardBtn} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

function FormField({ label, children, wide, required }) {
  return (
    <div className={`${styles.formField} ${wide ? styles.formFieldWide : ''}`}>
      <label className={styles.formLabel}>
        {label}
        {required && <span className={styles.required}> *</span>}
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
