import { speak } from '../../utils/speak';
import styles from './SpeakerButton.module.css';

/**
 * Small speaker icon button. Calls speak() from utils/speak.js.
 * Stops click propagation so embedding in clickable rows is safe.
 */
export default function SpeakerButton({ word, lang, className }) {
  if (!word) return null;

  function handleClick(e) {
    e.stopPropagation();
    speak(word, lang);
  }

  return (
    <button
      className={`${styles.btn}${className ? ` ${className}` : ''}`}
      onClick={handleClick}
      title={`Speak "${word}"`}
      aria-label="Speak word"
      type="button"
    >
      🔊
    </button>
  );
}
