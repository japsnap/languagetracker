import { useState, lazy, Suspense } from 'react';
import PasswordGate from './components/Auth/PasswordGate';
import { useVocabulary } from './hooks/useVocabulary';
import Navigation from './components/Navigation/Navigation';
import styles from './App.module.css';

const ReviewPage   = lazy(() => import('./components/Review/ReviewPage'));
const StatsPage    = lazy(() => import('./components/Stats/StatsPage'));
const InputPage    = lazy(() => import('./components/Input/InputPage'));
const QuizPage     = lazy(() => import('./components/Quiz/QuizPage'));
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage'));

export default function App() {
  const [isAuthed, setIsAuthed] = useState(
    () => sessionStorage.getItem('lt_authed') === '1'
  );

  if (!isAuthed) {
    return (
      <PasswordGate
        onSuccess={() => {
          sessionStorage.setItem('lt_authed', '1');
          setIsAuthed(true);
        }}
      />
    );
  }

  return <AppShell />;
}

function AppShell() {
  const [activeTab, setActiveTab] = useState('review');
  const { words, loading, error, toggleStar, updateWord, addWord, removeWord } = useVocabulary();

  if (loading) {
    return (
      <div className={styles.app}>
        <div className={styles.loadingScreen}>
          <div className={styles.loadingSpinner} />
          <p className={styles.loadingText}>Loading vocabulary…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.app}>
        <div className={styles.errorScreen}>
          <p className={styles.errorTitle}>Failed to load vocabulary</p>
          <p className={styles.errorMsg}>{error}</p>
          <button className={styles.errorRetry} onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <Navigation activeTab={activeTab} onTabChange={setActiveTab} />
      <main className={styles.main}>
        <Suspense fallback={<div className={styles.tabSpinner}><div className={styles.loadingSpinner} /></div>}>
          {activeTab === 'review' && (
            <ReviewPage words={words} onToggleStar={toggleStar} onUpdateWord={updateWord} />
          )}
          {activeTab === 'stats' && <StatsPage words={words} />}
          {activeTab === 'input' && (
            <InputPage words={words} onAddWord={addWord} onRemoveWord={removeWord} />
          )}
          {activeTab === 'quiz' && (
            <QuizPage words={words} onUpdateWord={updateWord} />
          )}
          {activeTab === 'settings' && <SettingsPage words={words} />}
        </Suspense>
      </main>
    </div>
  );
}
