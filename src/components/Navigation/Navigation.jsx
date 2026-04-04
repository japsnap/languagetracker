import styles from './Navigation.module.css';

const TABS = [
  { id: 'input',  label: 'Input' },
  { id: 'review', label: 'Review' },
  { id: 'stats',  label: 'Stats' },
  { id: 'quiz',   label: 'Quiz' },
];

export default function Navigation({ activeTab, onTabChange }) {
  return (
    <nav className={styles.nav}>
      <div className={styles.brand}>
        <span className={styles.brandIcon}>¡</span>SpanishTool
      </div>
      <div className={styles.tabs}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeTab === tab.id ? styles.active : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
