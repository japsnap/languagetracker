import { useState, lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './components/Auth/AuthProvider';
import LoginPage from './components/Auth/LoginPage';
import { useVocabulary } from './hooks/useVocabulary';
import Navigation from './components/Navigation/Navigation';
import { supabase } from './utils/supabase';
import styles from './App.module.css';

const ReviewPage   = lazy(() => import('./components/Review/ReviewPage'));
const StatsPage    = lazy(() => import('./components/Stats/StatsPage'));
const InputPage    = lazy(() => import('./components/Input/InputPage'));
const QuizPage     = lazy(() => import('./components/Quiz/QuizPage'));
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage'));

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

function AppShell() {
  const { session, user, loading } = useAuth();
  const [activeTab, setActiveTab] = useState('input');
  const { words, loading: vocabLoading, error, toggleStar, updateWord, addWord, removeWord } = useVocabulary();

  if (loading) {
    return (
      <div className={styles.app}>
        <div className={styles.loadingScreen}>
          <div className={styles.loadingSpinner} />
        </div>
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  if (vocabLoading) {
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
      <Navigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        user={user}
        onSignOut={() => supabase.auth.signOut()}
      />
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
          {activeTab === 'settings' && <SettingsPage words={words} user={user} />}
        </Suspense>
      </main>
    </div>
  );
}
