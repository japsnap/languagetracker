import { useState } from 'react';
import { useVocabulary } from './hooks/useVocabulary';
import Navigation from './components/Navigation/Navigation';
import ReviewPage from './components/Review/ReviewPage';
import StatsPage from './components/Stats/StatsPage';
import InputPage from './components/Input/InputPage';
import QuizPage from './components/Quiz/QuizPage';
import styles from './App.module.css';

export default function App() {
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
      </main>
    </div>
  );
}
