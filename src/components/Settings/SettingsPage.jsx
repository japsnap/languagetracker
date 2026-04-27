import { useState } from 'react';
import styles from './SettingsPage.module.css';
import { logEvent } from '../../utils/events';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';

const CSV_COLUMNS = [
  'word', 'part_of_speech', 'meaning', 'example', 'recommended_level',
  'related_words', 'other_useful_notes', 'scene', 'date_added',
  'last_reviewed', 'total_attempts', 'error_counter', 'correct_streak',
  'starred', 'mastered',
];

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function buildCSV(words) {
  const header = CSV_COLUMNS.join(',');
  const rows = words.map(w =>
    CSV_COLUMNS.map(col => escapeCSV(w[col])).join(',')
  );
  return '\uFEFF' + [header, ...rows].join('\r\n');
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDate(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

export default function SettingsPage({ words, user, preferences, onUpdatePreferences }) {
  const [maxWarning, setMaxWarning] = useState(false);

  const mastered      = words.filter(w => w.mastered).length;
  const totalAttempts = words.reduce((s, w) => s + (w.total_attempts || 0), 0);
  const totalErrors   = words.reduce((s, w) => s + (w.error_counter   || 0), 0);
  const totalCorrect  = totalAttempts - totalErrors;
  const accuracy      = totalAttempts > 0
    ? Math.round((totalCorrect / totalAttempts) * 100)
    : null;

  function handlePrimaryChange(code) {
    const secondary = (preferences.secondary_languages || []).filter(c => c !== code);
    onUpdatePreferences({ primary_language: code, secondary_languages: secondary });
  }

  function handleLearningLangChange(code) {
    onUpdatePreferences({ learning_language: code });
  }

  function handleSecondaryToggle(code) {
    const current = preferences.secondary_languages || [];
    if (current.includes(code)) {
      onUpdatePreferences({ secondary_languages: current.filter(c => c !== code) });
    } else if (current.length >= 4) {
      setMaxWarning(true);
      setTimeout(() => setMaxWarning(false), 3000);
    } else {
      onUpdatePreferences({ secondary_languages: [...current, code] });
    }
  }

  function handleRetentionChange(pct) {
    onUpdatePreferences({ desired_retention: pct / 100 });
  }

  function handleExportCSV() {
    logEvent('csv_export', { word_count: words.length });
    const csv = buildCSV(words);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocabulary_${todayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h1 className={styles.title}>Settings</h1>

        {/* Profile */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Profile</h2>
          <div className={styles.card}>
            <div className={styles.row}>
              <div className={styles.rowInfo}>
                <span className={styles.rowLabel}>{user?.email ?? '—'}</span>
                <span className={styles.rowDesc}>Joined {formatDate(user?.created_at)}</span>
              </div>
            </div>
            <div className={styles.profileGrid}>
              <ProfileStat label="Total words"     value={words.length} />
              <ProfileStat label="Mastered"        value={mastered} />
              <ProfileStat label="Quiz attempts"   value={totalAttempts} />
              <ProfileStat label="Correct answers" value={totalCorrect} />
              <ProfileStat
                label="Accuracy"
                value={accuracy !== null ? `${accuracy}%` : '—'}
              />
            </div>
          </div>
        </section>

        {/* Languages */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Languages</h2>
          <div className={styles.card}>
            {preferences ? (
              <>
                <div className={styles.row}>
                  <div className={styles.rowInfo}>
                    <span className={styles.rowLabel}>Learning Language</span>
                    <span className={styles.rowDesc}>The language you are currently learning. Sets your default input on the Input page.</span>
                  </div>
                  <select
                    className={styles.langSelect}
                    value={preferences.learning_language || 'es'}
                    onChange={e => handleLearningLangChange(e.target.value)}
                  >
                    {SUPPORTED_LANGUAGES
                      .filter(l => l.code !== preferences.primary_language)
                      .map(lang => (
                        <option key={lang.code} value={lang.code}>
                          {lang.flag} {lang.label}
                        </option>
                      ))}
                  </select>
                </div>
                <div className={styles.row}>
                  <div className={styles.rowInfo}>
                    <span className={styles.rowLabel}>Primary Language</span>
                    <span className={styles.rowDesc}>Primary language is used for full word definitions. Secondary languages show brief translations.</span>
                  </div>
                  <select
                    className={styles.langSelect}
                    value={preferences.primary_language}
                    onChange={e => handlePrimaryChange(e.target.value)}
                  >
                    {SUPPORTED_LANGUAGES.map(lang => (
                      <option key={lang.code} value={lang.code}>
                        {lang.flag} {lang.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.langSecondaryRow}>
                  <div className={styles.rowInfo}>
                    <span className={styles.rowLabel}>Secondary Languages</span>
                    <span className={styles.rowDesc}>Up to 4.</span>
                  </div>
                  <div className={styles.langChips}>
                    {SUPPORTED_LANGUAGES
                      .filter(l => l.code !== preferences.primary_language)
                      .map(lang => {
                        const active = (preferences.secondary_languages || []).includes(lang.code);
                        return (
                          <button
                            key={lang.code}
                            className={`${styles.langChip} ${active ? styles.langChipActive : ''}`}
                            onClick={() => handleSecondaryToggle(lang.code)}
                          >
                            {lang.flag} {lang.label}
                          </button>
                        );
                      })}
                  </div>
                  {maxWarning && (
                    <p className={styles.langWarning}>Maximum 4 secondary languages.</p>
                  )}
                </div>
              </>
            ) : (
              <div className={styles.row}>
                <span className={styles.rowDesc}>Loading…</span>
              </div>
            )}
          </div>
        </section>

        {/* Quiz */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Quiz</h2>
          <div className={styles.card}>
            {preferences ? (
              <div className={styles.sliderRow}>
                <div className={styles.sliderHeader}>
                  <span className={styles.rowLabel}>Review Intensity</span>
                  <span className={styles.retentionValue}>
                    {Math.round((preferences.desired_retention ?? 0.80) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="70"
                  max="95"
                  step="5"
                  value={Math.round((preferences.desired_retention ?? 0.80) * 100)}
                  onChange={e => handleRetentionChange(Number(e.target.value))}
                  className={styles.retentionSlider}
                />
                <div className={styles.sliderLegends}>
                  <span>70% · Fewer reviews,<br />more forgetting allowed</span>
                  <span>95% · More reviews,<br />stronger long-term recall</span>
                </div>
              </div>
            ) : (
              <div className={styles.row}>
                <span className={styles.rowDesc}>Loading…</span>
              </div>
            )}
          </div>
        </section>

        {/* Data */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Data</h2>
          <div className={styles.card}>
            <div className={styles.row}>
              <div className={styles.rowInfo}>
                <span className={styles.rowLabel}>Export CSV</span>
                <span className={styles.rowDesc}>
                  Download all {words.length} word{words.length !== 1 ? 's' : ''} as a CSV file. Compatible with Excel and Google Sheets.
                </span>
              </div>
              <button className={styles.actionBtn} onClick={handleExportCSV} disabled={words.length === 0}>
                Export CSV
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProfileStat({ label, value }) {
  return (
    <div className={styles.profileStat}>
      <span className={styles.profileStatValue}>{value}</span>
      <span className={styles.profileStatLabel}>{label}</span>
    </div>
  );
}
