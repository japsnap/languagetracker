import styles from './SettingsPage.module.css';

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

export default function SettingsPage({ words, user }) {
  const mastered      = words.filter(w => w.mastered).length;
  const totalAttempts = words.reduce((s, w) => s + (w.total_attempts || 0), 0);
  const totalErrors   = words.reduce((s, w) => s + (w.error_counter   || 0), 0);
  const totalCorrect  = totalAttempts - totalErrors;
  const accuracy      = totalAttempts > 0
    ? Math.round((totalCorrect / totalAttempts) * 100)
    : null;

  function handleExportCSV() {
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
