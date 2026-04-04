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
  const { words, toggleStar, updateWord, addWord, removeWord } = useVocabulary();

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
