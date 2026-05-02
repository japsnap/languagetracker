import { useMemo, useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, AreaChart, Area,
} from 'recharts';
import { memorizationLevel } from '../../utils/vocabulary';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../Auth/AuthProvider';
import styles from './StatsPage.module.css';

const LEVEL_FILL = { A1: '#2E7D32', A2: '#81C784', B1: '#1565C0', B2: '#64B5F6', C1: '#7B1FA2', C2: '#E91E63' };

const STATE_COLORS = { new: '#9e9e9e', learning: '#fb8c00', relearning: '#e53935', review: '#2E7D32' };

const STABILITY_BINS = [
  { label: '<1d',    min: 0,   max: 1   },
  { label: '1–7d',  min: 1,   max: 7   },
  { label: '7–30d', min: 7,   max: 30  },
  { label: '30–90d',min: 30,  max: 90  },
  { label: '90d+',  min: 90,  max: Infinity },
];

// ---------------------------------------------------------------------------
// Timezone helper (mirrors QuizPage.getTodayMidnightUTC — extract to shared
// util if a third consumer appears)
// ---------------------------------------------------------------------------

function getTodayMidnightUTC(timezone) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = parseInt(p.value, 10);
    return acc;
  }, {});
  const tzAsUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMs = tzAsUTC - now.getTime();
  const [y, m, d] = todayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
}

// ---------------------------------------------------------------------------
// Legacy stat helpers (unchanged — hardest words, most reviewed, timeline)
// ---------------------------------------------------------------------------

function computeLegacyStats(words) {
  const byLevel = ['A1','A2','B1','B2','C1','C2'].map(lvl => ({
    level: lvl,
    count: words.filter(w => w.recommended_level === lvl).length,
  }));

  const withAttempts = words.filter(w => w.total_attempts >= 3);
  const hardest = [...withAttempts]
    .sort((a, b) => memorizationLevel(a) - memorizationLevel(b))
    .slice(0, 10)
    .map(w => ({ word: w.word, mem: memorizationLevel(w) }));

  const mostReviewed = [...words]
    .filter(w => w.total_attempts > 0)
    .sort((a, b) => b.total_attempts - a.total_attempts)
    .slice(0, 10)
    .map(w => ({ word: w.word, attempts: w.total_attempts, meaning: w.meaning || '' }));

  const dateMap = {};
  words.forEach(w => { if (w.date_added) dateMap[w.date_added] = (dateMap[w.date_added] || 0) + 1; });
  let running = 0;
  const timeline = Object.entries(dateMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => { running += count; return { date: date.slice(5), total: running }; });

  return { byLevel, hardest, mostReviewed, timeline };
}

function computeQuizModeStats(events) {
  const acc = {
    easy: { total: 0, correct: 0, wrong: 0, notSure: 0 },
    hard: { total: 0, correct: 0, wrong: 0, notSure: 0 },
  };
  for (const e of events) {
    const mode   = e.metadata?.quiz_mode;
    const answer = e.metadata?.answer;
    if (mode !== 'easy' && mode !== 'hard') continue;
    acc[mode].total++;
    if (answer === 'correct')        acc[mode].correct++;
    else if (answer === 'wrong')     acc[mode].wrong++;
    else if (answer === 'not-sure')  acc[mode].notSure++;
  }
  const withAccuracy = mode => ({
    ...acc[mode],
    accuracy: acc[mode].total > 0 ? Math.round((acc[mode].correct / acc[mode].total) * 100) : null,
  });
  return { easy: withAccuracy('easy'), hard: withAccuracy('hard') };
}

// ---------------------------------------------------------------------------
// StatsPage
// ---------------------------------------------------------------------------

export default function StatsPage({ words, preferences }) {
  const { user } = useAuth();
  const [fsrsMode, setFsrsMode] = useState('easy'); // 'easy' | 'hard'
  const [fsrsRows, setFsrsRows]         = useState(null); // word_reviews_state, null = loading
  const [reviewLogRows, setReviewLogRows] = useState(null); // review_log last 30 days
  const [quizEvents, setQuizEvents]     = useState(null);  // legacy user_events

  const timezone = preferences?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const legacyStats = useMemo(() => computeLegacyStats(words), [words]);

  // ── Fetch word_reviews_state for selected mode ───────────────────────────
  useEffect(() => {
    if (!user?.id) { setFsrsRows(null); return; }
    let cancelled = false;
    setFsrsRows(null);
    (async () => {
      const { data, error } = await supabase
        .from('word_reviews_state')
        .select('word_id, state, review_count, stability, difficulty, lapse_count, due_at')
        .eq('user_id', user.id)
        .eq('mode', fsrsMode);
      if (cancelled) return;
      if (error) { console.error('Stats word_reviews_state:', error); setFsrsRows([]); return; }
      setFsrsRows(data || []);
    })().catch(err => { if (!cancelled) { console.error('Stats word_reviews_state (catch):', err); setFsrsRows([]); } });
    return () => { cancelled = true; };
  }, [user?.id, fsrsMode]);

  // ── Fetch review_log — last 30 days, selected mode ──────────────────────
  useEffect(() => {
    if (!user?.id) { setReviewLogRows(null); return; }
    let cancelled = false;
    setReviewLogRows(null);
    (async () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('review_log')
        .select('reviewed_at, grade')
        .eq('user_id', user.id)
        .eq('mode', fsrsMode)
        .gte('reviewed_at', since);
      if (cancelled) return;
      if (error) { console.error('Stats review_log:', error); setReviewLogRows([]); return; }
      setReviewLogRows(data || []);
    })().catch(err => { if (!cancelled) { console.error('Stats review_log (catch):', err); setReviewLogRows([]); } });
    return () => { cancelled = true; };
  }, [user?.id, fsrsMode]);

  // ── Fetch legacy quiz events (mode comparison section) ───────────────────
  useEffect(() => {
    if (!user?.id) { setQuizEvents(null); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('user_events')
        .select('metadata')
        .eq('event_type', 'quiz_answer')
        .eq('user_id', user.id);
      if (cancelled) return;
      if (error) { console.error('Stats user_events:', error); setQuizEvents([]); return; }
      setQuizEvents(data || []);
    })().catch(err => { if (!cancelled) { console.error('Stats user_events (catch):', err); setQuizEvents([]); } });
    return () => { cancelled = true; };
  }, [user?.id]);

  const modeStats = useMemo(
    () => (quizEvents ? computeQuizModeStats(quizEvents) : null),
    [quizEvents]
  );

  // ── FSRS metrics from word_reviews_state ────────────────────────────────
  const fsrsMetrics = useMemo(() => {
    if (!fsrsRows) return null;
    const todayMidnight = getTodayMidnightUTC(timezone);
    const tomorrowMidnight = new Date(todayMidnight.getTime() + 24 * 60 * 60 * 1000);

    // Untouched = words with no FSRS row OR row where state='new' AND review_count=0.
    // Subtracts from total vocabulary, not from fsrsRows, to include words never in any session.
    const touchedIds = new Set(
      fsrsRows.filter(r => !(r.state === 'new' && r.review_count === 0)).map(r => r.word_id)
    );
    const untouched = words.length - touchedIds.size;

    const inReview   = fsrsRows.filter(r => r.state === 'review').length;
    const inLearning = fsrsRows.filter(r => r.state === 'learning' || r.state === 'relearning').length;

    // Due Today: state in ('review','relearning') AND due_at < tomorrow_midnight_local
    // Includes overdue cards (due_at in the past) — correct behaviour.
    const dueToday = fsrsRows.filter(r =>
      (r.state === 'review' || r.state === 'relearning') &&
      r.due_at && new Date(r.due_at) < tomorrowMidnight
    ).length;

    // Comfortable: review cards with stability >= 21 days
    const comfortable = fsrsRows.filter(r => r.state === 'review' && (r.stability ?? 0) >= 21).length;

    const reviewRows = fsrsRows.filter(r => r.state === 'review' && r.stability != null);
    const avgStability = reviewRows.length > 0
      ? (reviewRows.reduce((s, r) => s + r.stability, 0) / reviewRows.length).toFixed(1)
      : null;

    // State distribution (chart A)
    const stateDistribution = [
      { name: 'New',        count: fsrsRows.filter(r => r.state === 'new').length,        fill: STATE_COLORS.new },
      { name: 'Learning',   count: fsrsRows.filter(r => r.state === 'learning').length,   fill: STATE_COLORS.learning },
      { name: 'Relearning', count: fsrsRows.filter(r => r.state === 'relearning').length, fill: STATE_COLORS.relearning },
      { name: 'Review',     count: fsrsRows.filter(r => r.state === 'review').length,      fill: STATE_COLORS.review },
    ];

    // Stability histogram (chart B) — review cards only
    const stabilityHist = STABILITY_BINS.map(b => ({ ...b, count: 0 }));
    reviewRows.forEach(r => {
      const bin = stabilityHist.find(b => r.stability >= b.min && r.stability < b.max);
      if (bin) bin.count++;
    });

    return { inReview, inLearning, untouched, dueToday, comfortable, avgStability, stateDistribution, stabilityHist };
  }, [fsrsRows, words, timezone]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Hardest words from FSRS (lapse_count primary, difficulty tiebreaker) ─
  const hardestFsrs = useMemo(() => {
    if (!fsrsRows) return null;
    const wordMap = new Map(words.map(w => [w.id, w.word]));
    return [...fsrsRows]
      .filter(r => r.review_count >= 1)
      .sort((a, b) => {
        const lapsDiff = (b.lapse_count || 0) - (a.lapse_count || 0);
        if (lapsDiff !== 0) return lapsDiff;
        return (b.difficulty || 0) - (a.difficulty || 0);
      })
      .slice(0, 10)
      .map(r => ({
        word: wordMap.get(r.word_id) || '?',
        lapses: r.lapse_count || 0,
        difficulty: r.difficulty != null ? +r.difficulty.toFixed(1) : null,
      }));
  }, [fsrsRows, words]);

  // ── Today's activity from review_log ────────────────────────────────────
  const logMetrics = useMemo(() => {
    if (!reviewLogRows) return null;
    const todayMidnight = getTodayMidnightUTC(timezone);
    const todayRows = reviewLogRows.filter(r => new Date(r.reviewed_at) >= todayMidnight);
    const reviewsToday = todayRows.length;
    const correctToday = todayRows.filter(r => r.grade !== 'again').length;
    const accuracyToday = reviewsToday > 0
      ? Math.round((correctToday / reviewsToday) * 100)
      : null;

    // Reviews per day last 30 days (chart C)
    const dateCountMap = {};
    reviewLogRows.forEach(r => {
      const dateStr = new Date(r.reviewed_at).toLocaleDateString('en-CA', { timeZone: timezone });
      dateCountMap[dateStr] = (dateCountMap[dateStr] || 0) + 1;
    });
    const reviewsPerDay = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toLocaleDateString('en-CA', { timeZone: timezone });
      reviewsPerDay.push({ date: dateStr.slice(5), count: dateCountMap[dateStr] || 0 });
    }

    return { reviewsToday, accuracyToday, reviewsPerDay };
  }, [reviewLogRows, timezone]);

  const loading = fsrsRows === null || reviewLogRows === null;

  // Safe display helper: returns '…' while loading, '—' when loaded but missing.
  function v(val) {
    if (val !== undefined && val !== null) return val;
    return loading ? '…' : '—';
  }

  const modeLabel = fsrsMode === 'easy' ? 'Easy' : 'Hard';

  return (
    <div className={styles.page}>
      <div className={styles.content}>

        {/* Title + mode toggle */}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Progress Overview</h1>
          <div className={styles.modeToggle}>
            <span className={styles.modeToggleLabel}>Mode:</span>
            <button
              className={`${styles.modeBtn} ${fsrsMode === 'easy' ? styles.modeBtnActive : ''}`}
              onClick={() => setFsrsMode('easy')}
            >Easy</button>
            <button
              className={`${styles.modeBtn} ${fsrsMode === 'hard' ? styles.modeBtnActive : ''}`}
              onClick={() => setFsrsMode('hard')}
            >Hard</button>
          </div>
        </div>

        {/* Tier 1 — prominent FSRS snapshot cards */}
        <div className={styles.tier1Grid}>
          <StatCard label="Total Words" value={words.length} prominent />
          <StatCard
            label="In Review"
            value={v(fsrsMetrics?.inReview)}
            color="var(--olive)"
            sub="graduated cards"
          />
          <StatCard
            label="Learning"
            value={v(fsrsMetrics?.inLearning)}
            color="#fb8c00"
            sub="active steps"
          />
          <StatCard
            label="Untouched"
            value={v(fsrsMetrics?.untouched)}
            color="var(--text-muted)"
            sub="never introduced"
          />
          <StatCard
            label="Due Today"
            value={v(fsrsMetrics?.dueToday)}
            color={fsrsMetrics?.dueToday > 0 ? '#e53935' : undefined}
            sub="review + relearning"
          />
        </div>

        {/* Tier 2 — secondary metrics, lighter weight */}
        <div className={styles.tier2Grid}>
          <StatCard
            label="Comfortable"
            value={v(fsrsMetrics?.comfortable)}
            sub="21+ day stability — reliably remembered"
            sm
          />
          <StatCard
            label="Avg Stability"
            value={
              fsrsMetrics?.avgStability != null
                ? `${fsrsMetrics.avgStability}d`
                : v(fsrsMetrics?.avgStability)
            }
            sub="across review cards"
            sm
          />
          <StatCard
            label="Reviews Today"
            value={v(logMetrics?.reviewsToday)}
            sub={`${modeLabel} mode`}
            sm
          />
          <StatCard
            label="Accuracy Today"
            value={
              logMetrics?.accuracyToday != null
                ? `${logMetrics.accuracyToday}%`
                : (loading ? '…' : '—')
            }
            color={
              logMetrics?.accuracyToday != null
                ? (logMetrics.accuracyToday >= 70 ? 'var(--olive)' : 'var(--terracotta)')
                : undefined
            }
            sub="grade ≠ again / total"
            sm
          />
        </div>

        {/* Chart A + B — state distribution & stability histogram */}
        <div className={styles.chartsRow}>
          <div className={styles.chartCard}>
            <h2 className={styles.chartTitle}>FSRS State Distribution</h2>
            <p className={styles.chartSub}>{modeLabel} mode · words with FSRS data</p>
            {!fsrsMetrics ? (
              <div className={styles.chartEmpty}><p>Loading…</p></div>
            ) : fsrsMetrics.stateDistribution.every(d => d.count === 0) ? (
              <div className={styles.chartEmpty}>
                <p>No FSRS data yet. Complete some quizzes to populate.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={fsrsMetrics.stateDistribution} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={n => Math.floor(n)} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    cursor={{ fill: 'var(--bg-hover)' }}
                    formatter={(val, _name, props) => [val, props.payload.name]}
                  />
                  <Bar dataKey="count" radius={[4,4,0,0]}>
                    {fsrsMetrics.stateDistribution.map(entry => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className={styles.chartCard}>
            <h2 className={styles.chartTitle}>Stability Distribution</h2>
            <p className={styles.chartSub}>Review cards only · longer bar = stronger long-term recall</p>
            {!fsrsMetrics ? (
              <div className={styles.chartEmpty}><p>Loading…</p></div>
            ) : fsrsMetrics.stabilityHist.every(b => b.count === 0) ? (
              <div className={styles.chartEmpty}><p>No review-state cards yet.</p></div>
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={fsrsMetrics.stabilityHist} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={n => Math.floor(n)} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    cursor={{ fill: 'var(--bg-hover)' }}
                    formatter={val => [val, 'Cards']}
                  />
                  <Bar dataKey="count" fill={STATE_COLORS.review} radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Chart C — Reviews per day last 30 days */}
        <div className={styles.chartCard}>
          <h2 className={styles.chartTitle}>Reviews per Day — Last 30 Days</h2>
          <p className={styles.chartSub}>{modeLabel} mode · source: review_log</p>
          {!logMetrics ? (
            <div className={styles.chartEmpty}><p>Loading…</p></div>
          ) : logMetrics.reviewsPerDay.every(d => d.count === 0) ? (
            <div className={styles.chartEmpty}><p>No reviews in the last 30 days.</p></div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={logMetrics.reviewsPerDay} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} interval={4} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={n => Math.floor(n)} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                  cursor={{ fill: 'var(--bg-hover)' }}
                  formatter={val => [val, 'Reviews']}
                />
                <Bar dataKey="count" fill="var(--gold)" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Existing charts — level + cumulative timeline */}
        <div className={styles.chartsRow}>
          <div className={styles.chartCard}>
            <h2 className={styles.chartTitle}>Words by Level</h2>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={legacyStats.byLevel} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="level" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={n => Math.floor(n)} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                  cursor={{ fill: 'var(--bg-hover)' }}
                />
                <Bar dataKey="count" radius={[4,4,0,0]}>
                  {legacyStats.byLevel.map(entry => (
                    <Cell key={entry.level} fill={LEVEL_FILL[entry.level]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.chartCard}>
            <h2 className={styles.chartTitle}>Total Vocabulary Over Time</h2>
            {legacyStats.timeline.length < 2 ? (
              <div className={styles.chartEmpty}>
                <p>Add words on multiple days to see a timeline.</p>
                <p className={styles.chartEmptySub}>
                  Currently {legacyStats.timeline.length === 1
                    ? `all ${words.length} words added on one date.`
                    : 'no data.'}
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={legacyStats.timeline} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#111111" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#111111" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={n => Math.floor(n)} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '4 2' }}
                    formatter={val => [val, 'Total words']}
                  />
                  <Area type="monotone" dataKey="total" stroke="#111111" strokeWidth={2} fill="url(#goldGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Existing charts — hardest words + most reviewed */}
        <div className={styles.chartsRow}>
          <div className={styles.chartCard} translate="no">
            <h2 className={styles.chartTitle}>Hardest Words</h2>
            <p className={styles.chartSub}>Most forgotten · sorted by lapse count then difficulty</p>
            {!hardestFsrs ? (
              <div className={styles.chartEmpty}><p>Loading…</p></div>
            ) : hardestFsrs.length === 0 ? (
              <div className={styles.chartEmpty}>
                <p>No reviewed words yet. Complete some quizzes to see your hardest words.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(hardestFsrs.length * 28, 80)}>
                <BarChart data={hardestFsrs} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={n => `${n}×`} />
                  <YAxis type="category" dataKey="word" width={110} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    formatter={(val, name, props) => {
                      const d = props.payload?.difficulty;
                      const lines = [`${val} lapse${val !== 1 ? 's' : ''}`, `Difficulty: ${d ?? '—'}`];
                      return [lines.join(' · '), ''];
                    }}
                    cursor={{ fill: 'var(--bg-hover)' }}
                  />
                  <Bar dataKey="lapses" fill="var(--terracotta)" radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className={styles.chartCard} translate="no">
            <h2 className={styles.chartTitle}>Most Reviewed Words</h2>
            <p className={styles.chartSub}>Top 10 by total quiz attempts</p>
            {legacyStats.mostReviewed.length === 0 ? (
              <div className={styles.chartEmpty}>
                <p>Start the Quiz to track your most reviewed words.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(legacyStats.mostReviewed.length * 28, 80)}>
                <BarChart data={legacyStats.mostReviewed} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
                  <XAxis type="number" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={n => Math.floor(n)} />
                  <YAxis type="category" dataKey="word" width={110} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
                  <Tooltip
                    cursor={{ fill: 'var(--bg-hover)' }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, maxWidth: 240 }}>
                          <div style={{ fontWeight: 600, marginBottom: 2 }}>{d.word}</div>
                          <div style={{ color: 'var(--text-muted)' }}>{d.attempts} attempts</div>
                          {d.meaning && <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4, lineHeight: 1.4 }}>{d.meaning}</div>}
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="attempts" fill="var(--gold)" radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Quiz Performance by Mode (legacy — unchanged) */}
        <div>
          <h2 className={styles.sectionTitle}>Quiz Performance by Mode</h2>
          <div className={styles.modeGrid}>
            <ModeCard mode="easy" stats={modeStats?.easy ?? null} loading={modeStats === null} />
            <ModeCard mode="hard" stats={modeStats?.hard ?? null} loading={modeStats === null} />
          </div>
        </div>

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub, color, sm, prominent }) {
  return (
    <div className={[
      styles.statCard,
      sm        ? styles.statCardSm        : '',
      prominent ? styles.statCardProminent : '',
    ].filter(Boolean).join(' ')}>
      <span className={styles.statLabel}>{label}</span>
      <span
        className={sm ? styles.statValueSm : styles.statValue}
        style={color ? { color } : {}}
      >
        {value}
      </span>
      {sub && <span className={styles.statSub}>{sub}</span>}
    </div>
  );
}

function ModeCard({ mode, stats, loading }) {
  const isEasy = mode === 'easy';
  return (
    <div className={`${styles.modeCard} ${isEasy ? styles.modeCardEasy : styles.modeCardHard}`}>
      <div className={styles.modeCardHeader}>
        <span className={styles.modeCardTitle}>{isEasy ? 'Easy Mode' : 'Hard Mode'}</span>
        <span className={styles.modeCardSub}>
          {isEasy ? 'Recognition · self-assessed' : 'Production · typed answers'}
        </span>
      </div>
      {loading ? (
        <p className={styles.modeCardEmpty}>Loading…</p>
      ) : !stats || stats.total === 0 ? (
        <p className={styles.modeCardEmpty}>No attempts yet</p>
      ) : (
        <div className={styles.modeCardStats}>
          <ModeStatRow label="Total attempts" value={stats.total} />
          <ModeStatRow label="Correct"        value={stats.correct}  color="#4caf79" />
          <ModeStatRow label="Wrong"          value={stats.wrong}    color="#e07070" />
          {isEasy && <ModeStatRow label="Not sure" value={stats.notSure} color="#e8a44a" />}
          <ModeStatRow
            label="Accuracy"
            value={stats.accuracy !== null ? `${stats.accuracy}%` : '—'}
            bold
            color={isEasy ? '#2E7D32' : '#1565C0'}
          />
        </div>
      )}
    </div>
  );
}

function ModeStatRow({ label, value, color, bold }) {
  return (
    <div className={styles.modeStatRow}>
      <span className={styles.modeStatLabel}>{label}</span>
      <span
        className={styles.modeStatValue}
        style={{ ...(color ? { color } : {}), ...(bold ? { fontWeight: 700 } : {}) }}
      >
        {value}
      </span>
    </div>
  );
}
