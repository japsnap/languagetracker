import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, AreaChart, Area,
} from 'recharts';
import { memorizationLevel } from '../../utils/vocabulary';
import styles from './StatsPage.module.css';

const LEVEL_FILL = { A1: '#5E7228', A2: '#2A7A5A', B1: '#C9942A', B2: '#B84320', C1: '#7B3FA0', C2: '#3F5EA0' };

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

  // Words added by date
  const dateMap = {};
  words.forEach(w => { if (w.date_added) dateMap[w.date_added] = (dateMap[w.date_added] || 0) + 1; });
  const timeline = Object.entries(dateMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date: date.slice(5), count })); // MM-DD

  return { total, mastered, neverReviewed, avgMem, accuracy, byLevel, hardest, mostReviewed, timeline };
}

export default function StatsPage({ words }) {
  const stats = useMemo(() => computeStats(words), [words]);
  const masteredPct = stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0;

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
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
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

          {/* Words added timeline */}
          <div className={styles.chartCard}>
            <h2 className={styles.chartTitle}>Words Added Over Time</h2>
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
                      <stop offset="5%"  stopColor="#C9942A" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#C9942A" stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                    cursor={{ stroke: 'var(--gold)', strokeDasharray: '4 2' }}
                  />
                  <Area type="monotone" dataKey="count" stroke="#C9942A" strokeWidth={2} fill="url(#goldGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className={styles.chartsRow}>
          {/* Hardest words */}
          <div className={styles.chartCard}>
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
          <div className={styles.chartCard}>
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
                  <XAxis type="number" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
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
      </div>
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
