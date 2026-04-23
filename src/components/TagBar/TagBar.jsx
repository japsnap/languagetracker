import { WORD_TAGS } from '../../utils/tags';
import styles from './TagBar.module.css';

/**
 * TagBar — horizontal row of emoji icon buttons for tagging a word.
 *
 * Props:
 *   tags     {string[]}             — current active tag keys
 *   onChange {(newTags: string[]) => void} — called after each toggle
 *   size     {'sm'|'md'}            — icon size; default 'md'
 */
export default function TagBar({ tags = [], onChange, size = 'md' }) {
  const arr = Array.isArray(tags) ? tags : [];

  function handleToggle(e, key) {
    e.stopPropagation();
    const next = arr.includes(key) ? arr.filter(t => t !== key) : [...arr, key];
    onChange(next);
  }

  return (
    <div className={`${styles.bar} ${size === 'sm' ? styles.sm : ''}`}>
      {WORD_TAGS.map(({ key, label, icon, color }) => {
        const active = arr.includes(key);
        return (
          <button
            key={key}
            type="button"
            className={`${styles.tag} ${active ? styles.tagActive : ''}`}
            style={active ? { backgroundColor: color } : undefined}
            title={label}
            onClick={(e) => handleToggle(e, key)}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}
