import { useState } from 'react';
import styles from './PasswordGate.module.css';

const CORRECT = import.meta.env.VITE_APP_PASSWORD;

export default function PasswordGate({ onSuccess }) {
  const [value, setValue]   = useState('');
  const [shake, setShake]   = useState(false);
  const [error, setError]   = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    if (value === CORRECT) {
      onSuccess();
    } else {
      setError(true);
      setShake(true);
      setValue('');
      setTimeout(() => setShake(false), 500);
    }
  }

  return (
    <div className={styles.backdrop}>
      <form
        className={`${styles.card} ${shake ? styles.shake : ''}`}
        onSubmit={handleSubmit}
        noValidate
      >
        <div className={styles.icon}>¡</div>
        <h1 className={styles.title}>LanguageTracker Beta</h1>
        <p className={styles.subtitle}>Enter the password to continue</p>

        <input
          className={`${styles.input} ${error ? styles.inputError : ''}`}
          type="password"
          placeholder="Password"
          value={value}
          autoFocus
          autoComplete="current-password"
          onChange={e => { setValue(e.target.value); setError(false); }}
        />

        {error && <p className={styles.errorMsg}>Incorrect password</p>}

        <button className={styles.btn} type="submit" disabled={!value}>
          Enter
        </button>
      </form>
    </div>
  );
}
