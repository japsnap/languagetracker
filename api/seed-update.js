/**
 * Vercel serverless function — word_seeds write operations.
 *
 * Security model:
 *   - POST only
 *   - Requires a valid Supabase session token (Authorization: Bearer <token>)
 *   - Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS for word_seeds writes
 *
 * Actions:
 *   'enrich'   — UPDATE word_seeds SET enriched=true, level=? WHERE id=?
 *                Used when explore mode enriches a seed via AI; corrects level from AI response.
 *
 *   'add_seed' — INSERT into word_seeds ON CONFLICT (word, language) DO UPDATE SET level, enriched=true
 *                Used for cache recycling: any single-mode Input lookup auto-seeds the word.
 *
 * Both callers use fire-and-forget — this endpoint never blocks a user-facing response.
 * Rate limiting: calls are logged but no hard limit enforced yet.
 * Future: Option C (nightly cron) is a planned upgrade for any server-side fire-and-forget write pattern.
 */

const VALID_LEVELS    = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const VALID_LANGUAGES = new Set(['en', 'es', 'ja', 'de', 'ko', 'zh', 'ur', 'hi', 'pt', 'fr', 'it']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify the Supabase JWT. Returns true if valid. */
async function verifySession(token) {
  const supabaseUrl    = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return false;
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey },
  });
  return res.ok;
}

/** Build Supabase REST headers using the service role key. */
function serviceHeaders(serviceRoleKey, extra = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth gate
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!(await verifySession(authHeader.slice(7)))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl    = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { action, payload } = req.body ?? {};

  // ── action: enrich ──────────────────────────────────────────────────────────
  if (action === 'enrich') {
    const { seedId, level } = payload ?? {};

    if (!seedId || typeof seedId !== 'string' || !level || !VALID_LEVELS.has(level)) {
      return res.status(400).json({ error: 'Invalid payload for enrich: seedId and valid level required' });
    }

    const r = await fetch(
      `${supabaseUrl}/rest/v1/word_seeds?id=eq.${encodeURIComponent(seedId)}`,
      {
        method: 'PATCH',
        headers: serviceHeaders(serviceRoleKey, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ enriched: true, level }),
      },
    );

    if (!r.ok) {
      const text = await r.text();
      console.error('[seed-update] enrich failed:', r.status, text);
      return res.status(500).json({ error: 'DB write failed' });
    }

    console.log('[seed-update] enrich:', seedId, level);
    return res.status(200).json({ success: true });

  // ── action: add_seed ────────────────────────────────────────────────────────
  } else if (action === 'add_seed') {
    const { word, language, level, part_of_speech } = payload ?? {};

    if (
      !word || typeof word !== 'string' ||
      !language || !VALID_LANGUAGES.has(language) ||
      !level || !VALID_LEVELS.has(level)
    ) {
      return res.status(400).json({ error: 'Invalid payload for add_seed: word, valid language, and valid level required' });
    }

    const normalizedWord = word.toLowerCase().trim();

    // Attempt 1: INSERT with ON CONFLICT (word, language) DO UPDATE
    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/word_seeds`,
      {
        method: 'POST',
        headers: serviceHeaders(serviceRoleKey, {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({
          word:           normalizedWord,
          language,
          level,
          part_of_speech: part_of_speech || null,
          enriched:       true,
        }),
      },
    );

    if (insertRes.ok) {
      console.log('[seed-update] add_seed (upsert):', normalizedWord, language, level);
      return res.status(200).json({ success: true });
    }

    // Attempt 2: explicit PATCH for the existing row (handles 409 conflict and other insert failures).
    // A conflict means the word already exists — update enriched + level and return 200.
    console.warn(`[seed-update] add_seed upsert returned ${insertRes.status}, falling back to PATCH`);

    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/word_seeds?word=eq.${encodeURIComponent(normalizedWord)}&language=eq.${encodeURIComponent(language)}`,
      {
        method: 'PATCH',
        headers: serviceHeaders(serviceRoleKey, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ enriched: true, level }),
      },
    );

    if (!patchRes.ok) {
      const text = await patchRes.text();
      console.error('[seed-update] add_seed PATCH fallback failed:', patchRes.status, text);
      return res.status(500).json({ error: 'DB write failed' });
    }

    console.log('[seed-update] add_seed (patch fallback):', normalizedWord, language, level);
    return res.status(200).json({ success: true });

  // ── unknown action ──────────────────────────────────────────────────────────
  } else {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
}
