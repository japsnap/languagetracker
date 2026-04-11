import { supabase } from './supabase';

export const ADMIN_EMAIL = 'wikipanna@gmail.com';

/*
 * Required Supabase RLS policies — run once in the Supabase SQL editor:
 *
 * -- Admin can read all events
 * CREATE POLICY "Admin reads all events" ON user_events FOR SELECT USING (
 *   auth.jwt()->>'email' = 'wikipanna@gmail.com'
 * );
 *
 * -- Admin can read all flags
 * CREATE POLICY "Admin reads all flags" ON word_flags FOR SELECT USING (
 *   auth.jwt()->>'email' = 'wikipanna@gmail.com'
 * );
 *
 * -- Admin can update all flags (resolve/dismiss)
 * CREATE POLICY "Admin updates all flags" ON word_flags FOR UPDATE USING (
 *   auth.jwt()->>'email' = 'wikipanna@gmail.com'
 * );
 *
 * -- Admin can read all vocabulary (for total count)
 * CREATE POLICY "Admin reads all vocabulary" ON vocabulary FOR SELECT USING (
 *   auth.jwt()->>'email' = 'wikipanna@gmail.com'
 * );
 */

export async function fetchAdminStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  // Fetch session token once — needed for the server-side admin-stats endpoint.
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const [lookupEventsRes, recentEventsRes, flagsRes, adminStatsRes, allUserIdsRes] = await Promise.all([
    supabase
      .from('user_events')
      .select('user_id, metadata, created_at')
      .eq('event_type', 'word_lookup'),
    supabase
      .from('user_events')
      .select('id, user_id, event_type, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('word_flags')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    fetch('/api/admin-stats', {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.ok ? r.json() : { total_words: 0 }).catch(() => ({ total_words: 0 })),
    supabase
      .from('user_events')
      .select('user_id'),
  ]);

  const lookups = lookupEventsRes.data || [];
  const allUserIds = allUserIdsRes.data || [];

  const distinctUsers = new Set(allUserIds.map(e => e.user_id)).size;
  const totalWords = adminStatsRes.total_words ?? 0;
  const lookupsToday = lookups.filter(e => e.created_at >= todayISO).length;
  const cacheHits = lookups.filter(e => e.metadata?.cache_hit === true).length;
  const cacheHitRate = lookups.length > 0 ? Math.round((cacheHits / lookups.length) * 100) : 0;

  const wordCounts = {};
  for (const e of lookups) {
    const w = e.metadata?.word;
    if (w) wordCounts[w] = (wordCounts[w] || 0) + 1;
  }
  const popularWords = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }));

  return {
    distinctUsers,
    totalWords,
    lookupsToday,
    cacheHitRate,
    totalLookups: lookups.length,
    recentEvents: recentEventsRes.data || [],
    pendingFlags: flagsRes.data || [],
    popularWords,
  };
}

export async function resolveFlag(flagId, status) {
  const { error } = await supabase
    .from('word_flags')
    .update({ status })
    .eq('id', flagId);
  if (error) throw new Error(error.message);
}
