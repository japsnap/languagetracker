import styles from './InsightsPanel.module.css';

/**
 * Configurable renderer for ai_insights fields.
 *
 * To add a new field (e.g. false_friends, mnemonic):
 *   1. Add an entry to INSIGHTS_SECTIONS below.
 *   2. If the field's data shape is already covered by an existing `type`, done.
 *   3. If the data shape is new, add a renderer to RENDERERS below.
 *   The fetch/save logic in insights.js requires no changes.
 */
const INSIGHTS_SECTIONS = [
  { key: 'etymology',     label: 'Etymology',           type: 'text' },
  { key: 'register',      label: 'Register',            type: 'badge' },
  { key: 'collocations',  label: 'Common collocations', type: 'collocations' },
  { key: 'cultural_note', label: 'Cultural note',       type: 'text' },
  // Future examples (uncomment + update prompt):
  // { key: 'false_friends', label: 'False friends',   type: 'list' },
  // { key: 'mnemonic',      label: 'Memory tip',      type: 'text' },
];

const REGISTER_STYLES = {
  formal:       { bg: '#E3F2FD', color: '#1565C0' },
  informal:     { bg: '#FFF8E1', color: '#E65100' },
  colloquial:   { bg: '#E0F2F1', color: '#00695C' },
  slang:        { bg: '#FCE4EC', color: '#AD1457' },
  'written-only': { bg: '#F3E5F5', color: '#6A1B9A' },
  neutral:      { bg: 'var(--bg-elevated)', color: 'var(--text-secondary)' },
};

function renderText(value) {
  return <p className={styles.text}>{value}</p>;
}

function renderBadge(value) {
  const s = REGISTER_STYLES[value] || REGISTER_STYLES.neutral;
  return (
    <span
      className={styles.badge}
      style={{ background: s.bg, color: s.color }}
    >
      {value}
    </span>
  );
}

function renderCollocations(value) {
  if (!Array.isArray(value)) return null;
  return (
    <ul className={styles.collocationList}>
      {value.map((item, i) => (
        <li key={i} className={styles.collocationItem}>
          <span className={styles.collocationPhrase} translate="no">{item.phrase}</span>
          {item.example && (
            <span className={styles.collocationExample} translate="no">
              — <em>{item.example}</em>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function renderList(value) {
  if (!Array.isArray(value)) return renderText(String(value));
  return (
    <ul className={styles.simpleList}>
      {value.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

const RENDERERS = {
  text:         renderText,
  badge:        renderBadge,
  collocations: renderCollocations,
  list:         renderList,
};

export default function InsightsPanel({ insights }) {
  if (!insights || typeof insights !== 'object') return null;

  return (
    <div className={styles.panel}>
      {INSIGHTS_SECTIONS.map(({ key, label, type }) => {
        const value = insights[key];
        if (value == null || value === '') return null;
        const renderer = RENDERERS[type] || renderText;
        return (
          <section key={key} className={styles.section}>
            <h4 className={styles.sectionLabel}>{label}</h4>
            {renderer(value)}
          </section>
        );
      })}
    </div>
  );
}
