import { useState, useMemo } from 'react';
import { filterAndSort, SORT_OPTIONS, SCENES, ALL_LEVELS } from '../../utils/sorting';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';
import WordRow from './WordRow';
import styles from './ReviewPage.module.css';

const LEVEL_COLORS = {
  A1: 'var(--level-a1)',
  A2: 'var(--level-a2)',
  B1: 'var(--level-b1)',
  B2: 'var(--level-b2)',
  C1: 'var(--level-c1)',
  C2: 'var(--level-c2)',
};

export default function ReviewPage({ words, onToggleStar, onUpdateWord, preferences }) {
  const [search, setSearch]       = useState('');
  const [sortBy, setSortBy]       = useState('date-newest');
  const [starredOnly, setStarredOnly] = useState(false);
  const [scene, setScene]         = useState('');
  const [levels, setLevels]       = useState([]);
  const [langFilter, setLangFilter] = useState('');
  const [expandedId, setExpandedId]   = useState(null);

  // Bulk select
  const [selectMode, setSelectMode]   = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkScene, setBulkScene]     = useState('');

  // Languages that exist in this user's vocabulary
  const vocabLangs = useMemo(
    () => [...new Set(words.map(w => w.word_language).filter(Boolean))].sort(),
    [words]
  );
  const hasMultipleLangs = vocabLangs.length > 1;

  function toggleLevel(lvl) {
    setLevels(prev =>
      prev.includes(lvl) ? prev.filter(l => l !== lvl) : [...prev, lvl]
    );
  }

  const filtered = useMemo(
    () => filterAndSort(words, { search, sortBy, starredOnly, scene, levels, language: langFilter }),
    [words, search, sortBy, starredOnly, scene, levels, langFilter]
  );

  function handleToggleExpand(id) {
    if (selectMode) return;
    setExpandedId(prev => (prev === id ? null : id));
  }

  function handleToggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleSelectAll() {
    setSelectedIds(new Set(filtered.map(w => w.id)));
  }

  function handleDeselectAll() {
    setSelectedIds(new Set());
  }

  function handleCancelSelect() {
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkScene('');
  }

  function handleApplyBulkScene() {
    if (!bulkScene || selectedIds.size === 0) return;
    selectedIds.forEach(id => onUpdateWord(id, { scene: bulkScene }));
    handleCancelSelect();
  }

  const colCount = selectMode ? 8 : 7;

  return (
    <div className={styles.page}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        {!selectMode ? (
          <>
            <input
              className={styles.search}
              type="text"
              placeholder="Search word, meaning, or example…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />

            <select className={styles.filterSelect} value={sortBy} onChange={e => setSortBy(e.target.value)}>
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <select className={styles.filterSelect} value={scene} onChange={e => setScene(e.target.value)}>
              <option value="">All scenes</option>
              {SCENES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>

            {/* Language filter — only shown when vocabulary spans multiple languages */}
            {hasMultipleLangs && (
              <div className={styles.langFilter}>
                <button
                  className={`${styles.levelBtn} ${langFilter === '' ? styles.levelActive : ''}`}
                  onClick={() => setLangFilter('')}
                >
                  All
                </button>
                {vocabLangs.map(code => {
                  const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
                  return (
                    <button
                      key={code}
                      className={`${styles.levelBtn} ${langFilter === code ? styles.levelActive : ''}`}
                      onClick={() => setLangFilter(code === langFilter ? '' : code)}
                      title={lang?.label}
                    >
                      {lang?.flag} {code.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            )}

            <div className={styles.levelFilter}>
              {ALL_LEVELS.map(lvl => {
                const active = levels.includes(lvl);
                return (
                  <button
                    key={lvl}
                    className={`${styles.levelBtn} ${active ? styles.levelActive : ''}`}
                    style={active ? { backgroundColor: LEVEL_COLORS[lvl], borderColor: LEVEL_COLORS[lvl], color: '#fff' } : {}}
                    onClick={() => toggleLevel(lvl)}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>

            <label className={styles.checkLabel}>
              <input type="checkbox" checked={starredOnly} onChange={e => setStarredOnly(e.target.checked)} />
              Starred only
            </label>

            <button className={styles.selectBtn} onClick={() => setSelectMode(true)}>
              Select
            </button>

            <span className={styles.count}>
              {filtered.length !== words.length
                ? `${filtered.length} / ${words.length}`
                : `${words.length} words`}
            </span>
          </>
        ) : (
          /* Bulk select toolbar */
          <>
            <span className={styles.selectInfo}>
              <strong>{selectedIds.size}</strong> selected
            </span>
            <button className={styles.selectAllBtn} onClick={handleSelectAll}>All ({filtered.length})</button>
            <button className={styles.selectAllBtn} onClick={handleDeselectAll}>None</button>

            <select
              className={styles.filterSelect}
              value={bulkScene}
              onChange={e => setBulkScene(e.target.value)}
            >
              <option value="">Tag scene…</option>
              {SCENES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              <option value="__clear__">— Clear tag</option>
            </select>

            <button
              className={styles.applyBtn}
              onClick={handleApplyBulkScene}
              disabled={selectedIds.size === 0 || !bulkScene}
            >
              Apply to {selectedIds.size > 0 ? selectedIds.size : '…'} words
            </button>

            <button className={styles.cancelBtn} onClick={handleCancelSelect}>Cancel</button>
          </>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No words match your filters.</div>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                {selectMode && <th className={styles.thCheck} />}
                <th>Word</th>
                <th>Part of Speech</th>
                <th>Meaning</th>
                <th>Example</th>
                <th>Level</th>
                <th>Memory</th>
                <th>★</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(word => (
                <WordRow
                  key={word.id}
                  word={word}
                  isExpanded={!selectMode && expandedId === word.id}
                  onToggleExpand={handleToggleExpand}
                  onToggleStar={onToggleStar}
                  onUpdateWord={onUpdateWord}
                  selectMode={selectMode}
                  isSelected={selectedIds.has(word.id)}
                  onToggleSelect={handleToggleSelect}
                  colCount={colCount}
                  showLangBadge={hasMultipleLangs}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
