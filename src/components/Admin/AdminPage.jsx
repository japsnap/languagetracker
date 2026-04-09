import { useState, useEffect, useCallback } from 'react';
import { fetchAdminStats, resolveFlag, ADMIN_EMAIL } from '../../utils/admin';
import styles from './AdminPage.module.css';

export default function AdminPage({ user }) {
  if (user?.email !== ADMIN_EMAIL) {
    return <div className={styles.denied}>Access denied.</div>;
  }
  return <AdminDashboard />;
}

function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [flags, setFlags] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminStats();
      setStats(data);
      setFlags(data.pendingFlags);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleResolveFlag(flagId, status) {
    try {
      await resolveFlag(flagId, status);
      setFlags(prev => prev.filter(f => f.id !== flagId));
    } catch {}
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <p className={styles.stateMsg}>Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.page}>
        <p className={styles.errorMsg}>{error}</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <div className={styles.header}>
          <h1 className={styles.title}>Admin Dashboard</h1>
          <button className={styles.refreshBtn} onClick={load}>Refresh</button>
        </div>

        {/* Section 1 — Overview */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Overview</h2>
          <div className={styles.overviewGrid}>
            <StatCard label="Approx. Users" value={stats.distinctUsers} />
            <StatCard label="Total Words" value={stats.totalWords} />
            <StatCard label="Lookups Today" value={stats.lookupsToday} />
            <StatCard
              label="Cache Hit Rate"
              value={`${stats.cacheHitRate}%`}
              sub={`${stats.totalLookups} total lookups`}
            />
          </div>
        </section>

        {/* Section 2 — Recent activity */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Recent Activity (last 50)</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Metadata</th>
                  <th>User</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentEvents.map(ev => (
                  <tr key={ev.id}>
                    <td className={styles.tdTime}>{fmtTime(ev.created_at)}</td>
                    <td><span className={`${styles.eventBadge} ${styles[`badge_${ev.event_type}`]}`}>{ev.event_type}</span></td>
                    <td className={styles.tdMeta}>{JSON.stringify(ev.metadata)}</td>
                    <td className={styles.tdUser}>{ev.user_id?.slice(0, 8)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 3 — Flagged content */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Flagged Content ({flags.length} pending)</h2>
          {flags.length === 0 ? (
            <p className={styles.empty}>No pending flags.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Word</th>
                    <th>Reason</th>
                    <th>Flagged</th>
                    <th>User</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map(flag => (
                    <tr key={flag.id}>
                      <td className={styles.tdWord}>{flag.word_text}</td>
                      <td>{flag.reason}</td>
                      <td className={styles.tdTime}>{fmtTime(flag.created_at)}</td>
                      <td className={styles.tdUser}>{flag.user_id?.slice(0, 8)}…</td>
                      <td>
                        <div className={styles.flagActions}>
                          <button
                            className={`${styles.flagBtn} ${styles.flagBtnResolve}`}
                            onClick={() => handleResolveFlag(flag.id, 'resolved')}
                          >
                            Resolve
                          </button>
                          <button
                            className={`${styles.flagBtn} ${styles.flagBtnDismiss}`}
                            onClick={() => handleResolveFlag(flag.id, 'dismissed')}
                          >
                            Dismiss
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Section 4 — Popular words */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Top 20 Looked-up Words</h2>
          {stats.popularWords.length === 0 ? (
            <p className={styles.empty}>No lookup data yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.thRank}>#</th>
                    <th>Word</th>
                    <th>Lookups</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.popularWords.map((item, i) => (
                    <tr key={item.word}>
                      <td className={styles.tdRank}>{i + 1}</td>
                      <td className={styles.tdWord}>{item.word}</td>
                      <td>{item.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
      {sub && <span className={styles.statSub}>{sub}</span>}
    </div>
  );
}

function fmtTime(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
