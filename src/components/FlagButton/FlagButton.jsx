import { useState } from 'react';
import { submitFlag } from '../../utils/flags';
import styles from './FlagButton.module.css';

/**
 * Unobtrusive flag button for reporting issues with a word.
 * Saves to the word_flags table in Supabase.
 * Props: wordId (uuid), wordText (string)
 */
export default function FlagButton({ wordId, wordText }) {
  const [mode, setMode] = useState('idle'); // idle | input | done
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!reason.trim()) return;
    setSubmitting(true);
    try {
      await submitFlag(wordId, wordText, reason.trim());
      setReason('');
      setMode('done');
      setTimeout(() => setMode('idle'), 3000);
    } catch {
      // don't break the UX on failure
    } finally {
      setSubmitting(false);
    }
  }

  function cancel(e) {
    e.stopPropagation();
    setMode('idle');
    setReason('');
  }

  if (mode === 'done') {
    return <span className={styles.thanks}>Flagged — thanks!</span>;
  }

  if (mode === 'input') {
    return (
      <form className={styles.form} onSubmit={handleSubmit} onClick={e => e.stopPropagation()}>
        <input
          className={styles.input}
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="What's wrong? (e.g. wrong level, bad example)"
          autoFocus
          maxLength={200}
        />
        <button className={styles.submitBtn} type="submit" disabled={submitting || !reason.trim()}>
          Submit
        </button>
        <button className={styles.cancelBtn} type="button" onClick={cancel}>
          Cancel
        </button>
      </form>
    );
  }

  return (
    <button
      className={styles.flagBtn}
      onClick={e => { e.stopPropagation(); setMode('input'); }}
      title="Report an issue with this word"
    >
      🚩 Flag issue
    </button>
  );
}
