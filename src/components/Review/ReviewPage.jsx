import { useState, useMemo, useEffect, useRef } from 'react';
import { filterAndSort, SORT_OPTIONS, SCENES, ALL_LEVELS } from '../../utils/sorting';
import { SUPPORTED_LANGUAGES } from '../../utils/preferences';
import { WORD_TAGS, wordHasAnyTag } from '../../utils/tags';
import { supabase } from '../../utils/supabase';
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

// Fetch a map of { [wordId]: isoTimestamp } for words whose most recent
// quiz_answer event was a wrong answer. RLS scopes this to the current user.
async function fetchRecentMistakeMap() {
  const { data } = await supabase
    .from('user_events')
    .select('metadata, created_at')
    .eq('event_type', 'quiz_answer')
    .order('created_at', { ascending: false });

  if (!data) return {};

  // Walk events newest→oldest; first occurrence per word_id is the most recent answer.
  const latestPerWord = {};
  for (const event of data) {
    const { word_id, answer } = event.metadata || {};
    if (!word_id || latestPerWord[word_id]) continue;
    latestPerWord[word_id] = { answer, ts: event.created_at };
  }

  // Keep only words whose most recent answer was wrong.
  const map = {};
  for (const [id, { answer, ts }] of Object.entries(latestPerWord)) {
    if (answer === 'wrong') map[id] = ts;
  }
  return map;
}

const WORD_TYPE_CHIPS = [
  { value: '',       label: 'All' },
  { value: 'word',   label: 'Word' },
  { value: 'phrase', label: 'Phrase' },
  { value: 'idiom',  label: 'Idiom' },
];

export default function ReviewPage({ words, onToggleStar, onUpdateWord, preferences }) {
  const [search, setSearch]       = useState('');
  const [sortBy, setSortBy]       = useState('date-newest');
  const [starredOnly, setStarredOnly] = useState(false);
  const [scene, setScene]         = useState('');
  const [levels, setLevels]       = useState([]);
  const [langFilter, setLangFilter] = useState('');
  const [wordTypeFilter, setWordTypeFilter] = useState('');
  const [tagFilter, setTagFilter]     = useState([]); // array of tag keys (OR logic)
  const [expandedId, setExpandedId]   = useState(null);

  // Mistake data for 'recent-mistakes' sort — fetched lazily on first use
  const [mistakeMap, setMistakeMap]       = useState(null); // null = not yet fetched
  const [mistakeLoading, setMistakeLoading] = useState(false);

  // Bulk select
  const [selectMode, setSelectMode]   = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkScene, setBulkScene]     = useState('');

  // Alpha quick-scroll
  const tableWrapperRef = useRef(null);
  const [activeLetter, setActiveLetter] = useState('');

  // Languages that exist in this user's vocabulary
  const vocabLangs = useMemo(
    () => [...new Set(words.map(w => w.word_language).filter(Boolean))].sort(),
    [words]
  );
  const hasMultipleLangs = vocabLangs.length > 1;

  // Only show word_type chips when at least one phrase or idiom exists
  const hasPhraseOrIdiom = useMemo(
    () => words.some(w => w.word_type === 'phrase' || w.word_type === 'idiom'),
    [words]
  );

  // Only show tag filter when at least one word has a tag
  const hasTaggedWords = useMemo(
    () => words.some(w => Array.isArray(w.tags) && w.tags.length > 0),
    [words]
  );

  const learningLang = preferences?.learning_language || 'es';

  // Fetch recent-mistakes data the first time that sort is selected
  useEffect(() => {
    if (sortBy !== 'recent-mistakes' || mistakeMap !== null || mistakeLoading) return;
    setMistakeLoading(true);
    fetchRecentMistakeMap()
      .then(map => { setMistakeMap(map); setMistakeLoading(false); })
      .catch(() => { setMistakeMap({}); setMistakeLoading(false); });
  }, [sortBy, mistakeMap, mistakeLoading]);

  function toggleLevel(lvl) {
    setLevels(prev =>
      prev.includes(lvl) ? prev.filter(l => l !== lvl) : [...prev, lvl]
    );
  }

  const filtered = useMemo(
    () => filterAndSort(words, {
      search, sortBy, starredOnly, scene, levels,
      language: langFilter,
      wordType: wordTypeFilter,
      mistakeTimestamps: mistakeMap,
    }),
    [words, search, sortBy, starredOnly, scene, levels, langFilter, wordTypeFilter, mistakeMap]
  );

  // Second filter layer: tag filter (OR logic — word must have at least one selected tag)
  const tagFiltered = useMemo(
    () => tagFilter.length === 0 ? filtered : filtered.filter(w => wordHasAnyTag(w, tagFilter)),
    [filtered, tagFilter]
  );

  const isAlphaSort = sortBy === 'alpha-asc' || sortBy === 'alpha-desc';
  const showAlphaScroller = isAlphaSort && !selectMode && tagFiltered.length > 0;

  // wordId → letter for the first word of each letter group (A-Z only)
  const alphaAnchorMap = useMemo(() => {
    if (!isAlphaSort) return new Map();
    const map = new Map();
    const seen = new Set();
    for (const word of tagFiltered) {
      const letter = word.word?.[0]?.toUpperCase();
      if (letter && /[A-Z]/.test(letter) && !seen.has(letter)) {
        map.set(word.id, letter);
        seen.add(letter);
      }
    }
    return map;
  }, [tagFiltered, isAlphaSort]);

  // Letters in list order (A→Z or Z→A, matching the current sort)
  const alphaLetters = useMemo(
    () => Array.from(alphaAnchorMap.values()),
    [alphaAnchorMap]
  );

  function scrollToLetter(letter) {
    const anchor = tableWrapperRef.current?.querySelector(`[data-alpha-anchor="${letter}"]`);
    if (anchor) {
      anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActiveLetter(letter);
    }
  }

  // Track which letter section is currently at the top of the visible area
  useEffect(() => {
    if (!showAlphaScroller || !tableWrapperRef.current) return;
    const wrapper = tableWrapperRef.current;

    function updateActive() {
      const wrapperTop = wrapper.getBoundingClientRect().top;
      const anchors = Array.from(wrapper.querySelectorAll('[data-alpha-anchor]'));
      let active = anchors[0]?.dataset.alphaAnchor ?? '';
      for (const el of anchors) {
        if (el.getBoundingClientRect().top <= wrapperTop + 4) {
          active = el.dataset.alphaAnchor;
        }
      }
      setActiveLetter(active);
    }

    wrapper.addEventListener('scroll', updateActive, { passive: true });
    const raf = requestAnimationFrame(updateActive);
    return () => {
      wrapper.removeEventListener('scroll', updateActive);
      cancelAnimationFrame(raf);
    };
  }, [showAlphaScroller, filtered]);

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
    setSelectedIds(new Set(tagFiltered.map(w => w.id)));
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

            {/* Word type filter — only shown when at least one phrase or idiom exists */}
            {hasPhraseOrIdiom && (
              <div className={styles.langFilter}>
                {WORD_TYPE_CHIPS.map(({ value, label }) => (
                  <button
                    key={value || 'all'}
                    className={`${styles.levelBtn} ${wordTypeFilter === value ? styles.levelActive : ''}`}
                    onClick={() => setWordTypeFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* Tag filter — only shown when at least one word has a tag */}
            {hasTaggedWords && (
              <div className={styles.langFilter}>
                {WORD_TAGS.map(({ key, label, icon }) => {
                  const active = tagFilter.includes(key);
                  return (
                    <button
                      key={key}
                      className={`${styles.levelBtn} ${active ? styles.levelActive : ''}`}
                      title={label}
                      onClick={() => setTagFilter(prev =>
                        prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
                      )}
                    >
                      {icon} {label}
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
              {mistakeLoading && sortBy === 'recent-mistakes' ? 'Loading…' : (
                tagFiltered.length !== words.length
                  ? `${tagFiltered.length} / ${words.length}`
                  : `${words.length} words`
              )}
            </span>
          </>
        ) : (
          /* Bulk select toolbar */
          <>
            <span className={styles.selectInfo}>
              <strong>{selectedIds.size}</strong> selected
            </span>
            <button className={styles.selectAllBtn} onClick={handleSelectAll}>All ({tagFiltered.length})</button>
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

      <div className={styles.tableArea}>
        {tagFiltered.length === 0 ? (
          <div className={styles.empty}>
            {mistakeLoading && sortBy === 'recent-mistakes'
              ? 'Loading mistakes…'
              : 'No words match your filters.'}
          </div>
        ) : (
          <>
            <div className={styles.tableWrapper} ref={tableWrapperRef}>
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
                  {tagFiltered.map(word => (
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
                      anchorLetter={alphaAnchorMap.get(word.id)}
                      primaryLang={preferences?.primary_language || 'en'}
                      learningLang={learningLang}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {showAlphaScroller && (
              <AlphaScroller
                letters={alphaLetters}
                activeLetter={activeLetter}
                onLetterClick={scrollToLetter}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── AlphaScroller ─────────────────────────────────────────────────────────────

function AlphaScroller({ letters, activeLetter, onLetterClick }) {
  const [hoverLetter, setHoverLetter] = useState(null);
  const [popupTop, setPopupTop] = useState(0);
  const stripRef = useRef(null);

  function handleEnter(e, letter) {
    const stripRect = stripRef.current?.getBoundingClientRect();
    const btnRect = e.currentTarget.getBoundingClientRect();
    setPopupTop(btnRect.top - (stripRect?.top ?? 0) + btnRect.height / 2);
    setHoverLetter(letter);
  }

  function handleLeave() {
    setHoverLetter(null);
  }

  return (
    <div className={styles.alphaStrip} ref={stripRef}>
      {hoverLetter && (
        <div className={styles.alphaPopup} style={{ top: popupTop }}>
          {hoverLetter}
        </div>
      )}
      {letters.map(letter => (
        <button
          key={letter}
          className={`${styles.alphaBtn} ${activeLetter === letter ? styles.alphaBtnActive : ''}`}
          onClick={() => onLetterClick(letter)}
          onMouseEnter={e => handleEnter(e, letter)}
          onMouseLeave={handleLeave}
          onTouchStart={e => handleEnter(e.touches[0] ? { currentTarget: e.currentTarget } : e, letter)}
          onTouchEnd={handleLeave}
        >
          {letter}
        </button>
      ))}
    </div>
  );
}
