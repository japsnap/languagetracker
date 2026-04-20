import { useState, useEffect } from 'react';
import styles from './InstallPrompt.module.css';

const DISMISS_KEY = 'pwa-install-dismissed';

/**
 * Shows a bottom banner on mobile when the browser fires beforeinstallprompt.
 * Hidden on desktop via CSS (pointer: coarse media query).
 * Dismissal is stored in localStorage and never shown again after.
 */
export default function InstallPrompt() {
  const [prompt, setPrompt] = useState(null);

  useEffect(() => {
    // Don't show if already dismissed
    if (localStorage.getItem(DISMISS_KEY)) return;

    function handler(e) {
      e.preventDefault();
      setPrompt(e);
    }

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  async function handleInstall() {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') setPrompt(null);
  }

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setPrompt(null);
  }

  if (!prompt) return null;

  return (
    <div className={styles.banner} role="banner">
      <span className={styles.text}>Install LanguageTracker for quick access →</span>
      <div className={styles.actions}>
        <button className={styles.installBtn} onClick={handleInstall}>Install</button>
        <button className={styles.dismissBtn} onClick={handleDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
