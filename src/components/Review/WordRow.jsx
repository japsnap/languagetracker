import { memorizationLevel } from '../../utils/vocabulary';
import { SCENES } from '../../utils/sorting';
import FlagButton from '../FlagButton/FlagButton';
import styles from './WordRow.module.css';

const LEVEL_COLORS = {
  A1: 'var(--level-a1)',
  A2: 'var(--level-a2)',
  B1: 'var(--level-b1)',
  B2: 'var(--level-b2)',
  C1: 'var(--level-c1)',
  C2: 'var(--level-c2)',
};

export default function WordRow({
  word, isExpanded, onToggleExpand, onToggleStar, onUpdateWord,
  selectMode, isSelected, onToggleSelect, colCount,
}) {
  const memLevel = memorizationLevel(word);

  function handleRowClick() {
    if (selectMode) onToggleSelect(word.id);
    else onToggleExpand(word.id);
  }

  function handleStarClick(e) {
    e.stopPropagation();
    onToggleStar(word.id);
  }

  function handleCheckboxChange(e) {
    e.stopPropagation();
    onToggleSelect(word.id);
  }

  return (
    <>
      <tr
        className={`${styles.row} ${isExpanded ? styles.expanded : ''} ${isSelected ? styles.selected : ''}`}
        onClick={handleRowClick}
      >
        {selectMode && (
          <td className={styles.checkCell} onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={isSelected}
              onChange={handleCheckboxChange}
              className={styles.checkbox}
            />
          </td>
        )}
        <td className={styles.wordCell}>
          <span className={styles.wordText}>{word.word}</span>
          {word.mastered && <span className={styles.masteredBadge} title="Mastered">✓</span>}
          {word.scene && <span className={styles.sceneBadge}>{word.scene}</span>}
        </td>
        <td className={styles.posCell}>{word.part_of_speech}</td>
        <td className={styles.meaningCell}>{word.meaning}</td>
        <td className={styles.exampleCell}>{word.example}</td>
        <td className={styles.levelCell}>
          <span className={styles.levelBadge} style={{ background: LEVEL_COLORS[word.recommended_level] || '#888' }}>
            {word.recommended_level}
          </span>
        </td>
        <td className={styles.memCell}>
          {memLevel !== null ? (
            <span className={styles.memBar}>
              <span className={styles.memFill} style={{ width: `${memLevel}%` }} />
              <span className={styles.memLabel}>{memLevel}%</span>
            </span>
          ) : (
            <span className={styles.memNone}>—</span>
          )}
        </td>
        <td className={styles.starCell}>
          <button
            className={`${styles.starBtn} ${word.starred ? styles.starred : ''}`}
            onClick={handleStarClick}
            title={word.starred ? 'Unstar' : 'Star'}
          >
            {word.starred ? '★' : '☆'}
          </button>
        </td>
      </tr>

      {isExpanded && (
        <tr className={styles.detailRow}>
          <td colSpan={colCount ?? 7}>
            <div className={styles.detailGrid}>
              {word.related_words && <DetailField label="Related words" value={word.related_words} />}
              {word.other_useful_notes && <DetailField label="Notes" value={word.other_useful_notes} />}

              {/* Scene tag selector */}
              <div className={styles.detailField}>
                <span className={styles.detailLabel}>Scene</span>
                <select
                  className={styles.sceneSelect}
                  value={word.scene || ''}
                  onChange={e => {
                    const val = e.target.value;
                    onUpdateWord(word.id, { scene: val || null });
                  }}
                  onClick={e => e.stopPropagation()}
                >
                  <option value="">— none —</option>
                  {SCENES.map(s => (
                    <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
              </div>

              <DetailField label="Date added" value={word.date_added} />
              <DetailField label="Last reviewed" value={word.last_reviewed ?? 'Never'} />
              <DetailField label="Total attempts" value={word.total_attempts} />
              <DetailField label="Errors" value={word.error_counter} />
              <DetailField label="Correct streak" value={word.correct_streak} />

              {/* Mastered toggle */}
              <div className={styles.detailField}>
                <span className={styles.detailLabel}>Mastered</span>
                <button
                  className={`${styles.masteredToggle} ${word.mastered ? styles.masteredOn : ''}`}
                  onClick={e => {
                    e.stopPropagation();
                    onUpdateWord(word.id, { mastered: !word.mastered, ...(word.mastered ? { correct_streak: 0 } : {}) });
                  }}
                >
                  {word.mastered ? '✓ Mastered' : 'Mark mastered'}
                </button>
              </div>

              {/* Flag */}
              <div className={styles.detailActions}>
                <FlagButton wordId={word.id} wordText={word.word} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DetailField({ label, value }) {
  return (
    <div className={styles.detailField}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>{value}</span>
    </div>
  );
}
