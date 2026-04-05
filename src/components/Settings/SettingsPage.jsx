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

export default function SettingsPage({ words }) {
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
