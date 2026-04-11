import { useMemo, useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, AreaChart, Area,
} from 'recharts';
import { memorizationLevel } from '../../utils/vocabulary';
import { supabase } from '../../utils/supabase';
import styles from './StatsPage.module.css';

const LEVEL_FILL = { A1: '#2E7D32', A2: '#81C784', B1: '#1565C0', B2: '#64B5F6', C1: '#7B1FA2', C2: '#E91E63' };

function computeStats(words) {
  const total        = words.length;
  const mastered     = words.filter(w => w.mastered).length;
  const neverReviewed = words.filter(w => !w.last_reviewed).length;

  const withAttempts = words.filter(w => w.total_attempts >= 3);
  const avgMem = withAttempts.length > 0
    ? Math.round(withAttempts.reduce((s, w) => s + memorizationLevel(w), 0) / withAttempts.length)
    : null;

  const totalAttempts = words.reduce((s, w) => s + w.total_attempts, 0);
  const totalErrors   = words.reduce((s, w) => s + w.error_counter, 0);
  const accuracy = totalAttempts > 0
    ? Math.round(((totalAttempts - totalErrors) / totalAttempts) * 100)
    : null;

  const byLevel = ['A1','A2','B1','B2','C1','C2'].map(lvl => ({
    level: lvl,
    count: words.filter(w => w.recommended_level === lvl).length,
  }));

  const hardest = [...withAttempts]
    .sort((a, b) => memorizationLevel(a) - memorizationLevel(b))
    .slice(0, 10)
    .map(w => ({ word: w.word, mem: memorizationLevel(w) }));

  const mostReviewed = [...words]
    .filter(w => w.total_attempts > 0)
    .sort((a, b) => b.total_attempts - a.total_attempts)
    .slice(0, 10)
    .map(w => ({ word: w.word, attempts: w.total_attempts }));

  // Cumulative words added — running total by date
  const dateMap = {};
  words.forEach(w => { if (w.date_added) dateMap[w.date_added] = (dateMap[w.date_added] || 0) + 1; });
  let running = 0;
  const timeline = Object.entries(dateMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => { running += count; return { date: date.slice(5), total: running }; });

  return { total, mastered, neverReviewed, avgMem, accuracy, byLevel, hardest, mostReviewed, timeline };
}

// ── Quiz-mode stats (from user_events) ───────────────────────────────────────

function computeQuizModeStats(events) {
  const acc = {
    easy: { total: 0, correct: 0, wrong: 0, notSure: 0 },
    hard: { total: 0, correct: 0, wrong: 0, notSure: 0 },
  };
  for (const e of events) {
    const mode   = e.metadata?.quiz_mode;
    const answer = e.metadata?.answer;
    if (mode !== 'easy' && mode !== 'hard') continue; // skip pre-mode events
    acc[mode].total++;
    if (answer === 'correct')   acc[mode].correct++;
    else if (answer === 'wrong')     acc[mode].wrong++;
    else if (answer === 'not-sure')  acc[mode].notSure++;
  }
  const withAccuracy = mode => ({
    ...acc[mode],
    accuracy: acc[mode].total > 0 ? Math.round((acc[mode].correct / acc[mode].total) * 100) : null,
  });
  return { easy: withAccuracy('easy'), hard: withAccuracy('hard') };
}

export default function StatsPage({ words }) {
  const stats = useMemo(() => computeStats(words), [words]);
  const masteredPct = stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0;

  // Fetch quiz events for mode-specific stats
  const [quizEvents, setQuizEvents] = useState(null); // null = loading
  useEffect(() => {
    async function fetchQuizEvents() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setQuizEvents([]); return; }
      const { data } = await supabase
        .from('user_events')
        .select('metadata')
        .eq('event_type', 'quiz_answer')
        .eq('user_id', user.id);
      setQuizEvents(data || []);
    }
    fetchQuizEvents();
  }, []);

  const modeStats = useMemo(
    () => (quizEvents ? computeQuizModeStats(quizEvents) : null),
    [quizEvents]
  );

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h1 className={styles.title}>Progress Overview</h1>

        {/* Summary cards */}
        <div className={styles.summaryGrid}>
          <StatCard label="Total words"      value={stats.total} />
          <StatCard
            label="Mastered"
            value={stats.mastered}
            sub={`${masteredPct}% of vocabulary`}
            color="var(--olive)"
          />
          <StatCard
            label="Never reviewed"
            value={stats.neverReviewed}
            sub={`${stats.total - stats.neverReviewed} reviewed`}
            color={stats.neverReviewed > 0 ? 'var(--gold)' : 'var(--olive)'}
          />
          <StatCard
            label="Accuracy rate"
            value={stats.accuracy !== null ? `${stats.accuracy}%` : '—'}
            sub={stats.accuracy !== null ? 'correct / total attempts' : 'No quiz data yet'}
            color={stats.accuracy !== null ? (stats.accuracy >= 70 ? 'var(--olive)' : 'var(--terracotta)') : undefined}
          />
          <StatCard
            label="Avg memory score"
            value={stats.avgMem !== null ? `${stats.avgMem}%` : '—'}
            sub={stats.avgMem !== null ? 'words with 3+ attempts' : 'Complete quizzes to track'}
          />
        </div>

        <div className={styles.chartsRow}>
          {/* Words by level */}
          <div className={styles.chartCard}>
            <h2 className={styles.chartTitle}>Words by Level</h2>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.byLevel} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="level" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={v => Math.floor(v)} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                  cursor={{ fill: 'var(--bg-hover)' }}
                />
                <Bar dataKey="count" radius={[4,4,0,0]}>
                  {stats.byLevel.map(entry => (
                    <Cell key={entry.level} fill={LEVEL_FILL[entry.level]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Words added timeline — cumulative */}
          <div className={styles.chartCard}>
            <h2 className={styles.chartTitle}>Total Vocabulary Over Time</h2>
            {stats.timeline.length < 2 ? (
              <div className={styles.chartEmpty}>
                <p>Add words on multiple days to see a timeline.</p>
                <p className={styles.chartEmptySub}>
                  Currently {stats.timeline.length === 1 ? `all ${stats.total} words added on one date.` : 'no data.'}
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={stats.timeline} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#111111" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#111111" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={v => Math.floor(v)} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '4 2' }}
                    formatter={v => [v, 'Total words']}
                  />
                  <Area type="monotone" dataKey="total" stroke="#111111" strokeWidth={2} fill="url(#goldGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className={styles.chartsRow}>
          {/* Hardest words */}
          <div className={styles.chartCard} translate="no">
            <h2 className={styles.chartTitle}>Hardest Words</h2>
            <p className={styles.chartSub}>Lowest memorization % (3+ attempts required)</p>
            {stats.hardest.length === 0 ? (
              <div className={styles.chartEmpty}>
                <p>Complete some quizzes to see your weakest words.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(stats.hardest.length * 28, 80)}>
                <BarChart
                  data={stats.hardest}
                  layout="vertical"
                  margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
                >
                  <XAxis type="number" domain={[0,100]} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={v => `${v}%`} />
                  <YAxis type="category" dataKey="word" width={110} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    formatter={v => [`${v}%`, 'Memory']}
                    cursor={{ fill: 'var(--bg-hover)' }}
                  />
                  <Bar dataKey="mem" fill="var(--terracotta)" radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Most reviewed */}
          <div className={styles.chartCard} translate="no">
            <h2 className={styles.chartTitle}>Most Reviewed Words</h2>
            <p className={styles.chartSub}>Top 10 by total quiz attempts</p>
            {stats.mostReviewed.length === 0 ? (
              <div className={styles.chartEmpty}>
                <p>Start the Quiz to track your most reviewed words.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(stats.mostReviewed.length * 28, 80)}>
                <BarChart
                  data={stats.mostReviewed}
                  layout="vertical"
                  margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
                >
                  <XAxis type="number" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} allowDecimals={false} tickFormatter={v => Math.floor(v)} />
                  <YAxis type="category" dataKey="word" width={110} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    formatter={v => [v, 'Attempts']}
                    cursor={{ fill: 'var(--bg-hover)' }}
                  />
                  <Bar dataKey="attempts" fill="var(--gold)" radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Quiz Performance by Mode */}
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

// ── Mode card ─────────────────────────────────────────────────────────────────

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

function StatCard({ label, value, sub, color }) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} style={color ? { color } : {}}>{value}</span>
      {sub && <span className={styles.statSub}>{sub}</span>}
    </div>
  );
}
