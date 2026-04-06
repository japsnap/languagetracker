import styles from './Navigation.module.css';

const TABS = [
  { id: 'input',    label: 'Input' },
  { id: 'review',   label: 'Review' },
  { id: 'stats',    label: 'Stats' },
  { id: 'quiz',     label: 'Quiz' },
  { id: 'settings', label: '⚙ Settings' },
];

export default function Navigation({ activeTab, onTabChange, user, onSignOut }) {
  return (
    <nav className={styles.nav}>
      <div className={styles.brand}>
        <span className={styles.brandIcon}>¡</span>
        <span className={styles.brandFull}>LanguageTracker Beta</span>
        <span className={styles.brandShort}>LT</span>
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
      {user && (
        <div className={styles.userArea}>
          <span className={styles.userEmail}>{user.email}</span>
          <button className={styles.signOutBtn} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
