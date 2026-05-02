import { useState } from 'react';
import { supabase } from '../../utils/supabase';
import styles from './LoginPage.module.css';

const IN_APP_UA_PATTERNS = [
  /FBAN/i, /FBAV/i, /Instagram/i, /\bLine\//i,
  /Twitter/i, /HelloTalk/i, /\bwv\b/,
];

function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return IN_APP_UA_PATTERNS.some(p => p.test(ua));
}

export default function LoginPage() {
  const webView = isInAppBrowser();
  const [copied, setCopied]       = useState(false);
  const [email, setEmail]         = useState('');
  const [otpSent, setOtpSent]     = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError]   = useState('');

  function handleGoogleSignIn() {
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleMagicLink(e) {
    e.preventDefault();
    if (!email.trim() || otpLoading) return;
    setOtpLoading(true);
    setOtpError('');
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setOtpLoading(false);
    if (error) {
      setOtpError(error.message);
    } else {
      setOtpSent(true);
    }
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.card}>
        <div className={styles.icon}>¡</div>
        <h1 className={styles.title}>LanguageTracker</h1>
        <p className={styles.subtitle}>Sign in to access your vocabulary</p>

        {webView ? (
          <div className={styles.webviewBanner}>
            <p className={styles.webviewMsg}>
              For Google sign-in and app install, please open this page in Chrome or Safari
            </p>
            <button className={styles.copyBtn} onClick={handleCopyLink}>
              {copied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
        ) : (
          <button className={styles.googleBtn} onClick={handleGoogleSignIn}>
            <svg className={styles.googleIcon} viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>
        )}

        <div className={styles.divider}><span>or</span></div>

        {otpSent ? (
          <p className={styles.otpSuccess}>Check your email for a login link</p>
        ) : (
          <form className={styles.otpForm} onSubmit={handleMagicLink}>
            <input
              className={styles.emailInput}
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <button
              className={styles.otpBtn}
              type="submit"
              disabled={!email.trim() || otpLoading}
            >
              {otpLoading ? 'Sending…' : 'Send magic link'}
            </button>
            {otpError && <p className={styles.otpError}>{otpError}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
