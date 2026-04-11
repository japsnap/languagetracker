/**
 * Vercel serverless function — admin statistics.
 *
 * Security model:
 *   - GET only
 *   - Requires a valid Supabase session token (Authorization: Bearer <token>)
 *   - Token must belong to ADMIN_EMAIL — all other authenticated users get 403
 *   - Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS for cross-user queries
 *
 * To add more stats: extend the queries block and the returned JSON object.
 */

const ADMIN_EMAIL = 'wikipanna@gmail.com';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch the Supabase user for a given JWT. Returns user object or null. */
async function getSessionUser(token) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Run a COUNT(*) against a Supabase table using the service role key (bypasses RLS).
 * Returns the integer count, or 0 on failure.
 */
async function serviceCount(supabaseUrl, serviceRoleKey, table) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=id`, {
    method: 'HEAD',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'count=exact',
    },
  });
  if (!res.ok) return 0;
  // Content-Range: 0-24/25  or  */25
  const contentRange = res.headers.get('content-range');
  if (!contentRange) return 0;
  return parseInt(contentRange.split('/')[1], 10) || 0;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth gate — must have a Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);

  // Admin gate — token must belong to the admin email
  const user = await getSessionUser(token);
  if (!user || user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // ── Queries (add more here as needed) ───────────────────────────────────
    const total_words = await serviceCount(supabaseUrl, serviceRoleKey, 'vocabulary');

    return res.status(200).json({ total_words });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
