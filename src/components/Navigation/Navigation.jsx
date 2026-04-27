import styles from './Navigation.module.css';
import { ADMIN_EMAIL } from '../../utils/admin';

const TABS = [
  { id: 'input',    label: 'Input' },
  { id: 'review',   label: 'Review' },
  { id: 'stats',    label: 'Stats' },
  { id: 'quiz',     label: 'Quiz' },
  { id: 'settings', label: '⚙ Settings' },
];

export default function Navigation({ activeTab, onTabChange, user, onSignOut, quizDueCount }) {
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
            {tab.id === 'quiz' && quizDueCount > 0 ? (
              <span className={styles.tabWithBadge}>
                {tab.label}
                <span className={styles.tabBadge}>
                  {quizDueCount > 99 ? '99+' : quizDueCount}
                </span>
              </span>
            ) : tab.label}
          </button>
        ))}
      </div>
      {user && (
        <div className={styles.userArea}>
          <span className={styles.userEmail}>{user.email}</span>
          {user.email === ADMIN_EMAIL && (
            <button
              className={`${styles.adminBtn} ${activeTab === 'admin' ? styles.adminBtnActive : ''}`}
              onClick={() => onTabChange(activeTab === 'admin' ? 'input' : 'admin')}
            >
              Admin
            </button>
          )}
          <button className={styles.signOutBtn} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
