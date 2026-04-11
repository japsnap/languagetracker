import { useState, useRef } from 'react';
import { memorizationLevel } from '../../utils/vocabulary';
import { fetchInsights } from '../../utils/insights';
import { SCENES } from '../../utils/sorting';
import FlagButton from '../FlagButton/FlagButton';
import InsightsPanel from './InsightsPanel';
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
  selectMode, isSelected, onToggleSelect, colCount, showLangBadge,
  anchorLetter, primaryLang,
}) {
  const memLevel = memorizationLevel(word);

  // ── More Info / insights state ────────────────────────────────────────────
  const [insightsOpen,  setInsightsOpen]  = useState(false);
  const [insightsPhase, setInsightsPhase] = useState('idle'); // idle | loading | ready | error
  const [insightsError, setInsightsError] = useState('');
  const [insights,      setInsights]      = useState(null);  // local copy for this session
  const abortRef = useRef(null);

  async function handleMoreInfo(e) {
    e.stopPropagation();
    if (insightsOpen) { setInsightsOpen(false); return; }

    setInsightsOpen(true);

    // Already have insights (either from DB on the word prop or local session cache)
    const existing = insights || word.ai_insights;
    if (existing) {
      setInsights(existing);
      setInsightsPhase('ready');
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setInsightsPhase('loading');
    setInsightsError('');

    try {
      const result = await fetchInsights(word, primaryLang || 'en', controller.signal);
      setInsights(result);
      setInsightsPhase('ready');
      // Propagate to parent so word.ai_insights is populated for future row expansions
      onUpdateWord(word.id, { ai_insights: result });
    } catch (err) {
      if (err.name === 'AbortError') return;
      setInsightsError(err.message || 'Something went wrong.');
      setInsightsPhase('error');
    }
  }

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
        data-alpha-anchor={anchorLetter || undefined}
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
        <td className={styles.wordCell} translate="no">
          <span className={styles.wordText}>{word.word}</span>
          {word.mastered && <span className={styles.masteredBadge} title="Mastered">✓</span>}
          {word.scene && <span className={styles.sceneBadge}>{word.scene}</span>}
          {showLangBadge && word.word_language && (
            <span className={styles.langBadge}>{word.word_language.toUpperCase()}</span>
          )}
          {word.kana_reading   && <span className={styles.wordKana}>{word.kana_reading}</span>}
          {word.romanization   && <span className={styles.wordRomanization}>{word.romanization}</span>}
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
        <tr className={styles.detailRow} translate="no">
          <td colSpan={colCount ?? 7}>
            <div className={styles.detailGrid}>
              {word.kana_reading      && <DetailField label="Reading"      value={word.kana_reading} />}
              {word.romanization     && <DetailField label="Pronunciation" value={word.romanization} />}
              {word.related_words    && <DetailField label="Related words" value={word.related_words} />}
              {word.other_useful_notes && <DetailField label="Notes"       value={word.other_useful_notes} />}

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

              {/* More Info trigger — spans full width */}
              <div className={styles.moreInfoRow}>
                <button
                  className={`${styles.moreInfoBtn} ${insightsOpen ? styles.moreInfoBtnOpen : ''}`}
                  onClick={handleMoreInfo}
                >
                  {insightsOpen ? 'Less info ▲' : 'More info ▼'}
                </button>
              </div>
            </div>

            {/* Insights panel — shown below the detail grid when open */}
            {insightsOpen && (
              <div className={styles.insightsWrap}>
                {insightsPhase === 'loading' && (
                  <div className={styles.insightsLoading}>
                    <span className={styles.insightsSpinner} />
                    <span>Loading insights…</span>
                  </div>
                )}
                {insightsPhase === 'error' && (
                  <p className={styles.insightsError}>{insightsError}</p>
                )}
                {insightsPhase === 'ready' && (
                  <InsightsPanel insights={insights || word.ai_insights} />
                )}
              </div>
            )}
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
