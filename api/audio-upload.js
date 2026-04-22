/**
 * Vercel serverless function — audio Storage upload proxy.
 *
 * Security model:
 *   - Requires a valid Supabase session token (Authorization: Bearer <token>)
 *   - Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS for Storage upload and
 *     word_cache.audio_urls update
 *   - Client never touches the service role key
 *
 * Flow:
 *   1. Verify user JWT
 *   2. Decode base64 audio → upload to Storage bucket 'audio'
 *   3. Read-merge-write word_cache.audio_urls with the new public URL
 *   4. Return { publicUrl } to client
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Language codes accepted by this endpoint — must stay in sync with
// TTS_PROVIDER 'google' entries in src/utils/speak.js
const ALLOWED_LANG_CODES = new Set(['es-ES', 'pt-BR', 'it-IT', 'hi-IN', 'ur-PK']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify a Supabase JWT against the anon-key /auth/v1/user endpoint. */
async function verifySession(token) {
  const url    = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return false;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  return res.ok;
}

/**
 * Sanitize a word into a safe storage filename segment.
 * Strips accents, lowercases, replaces non-alphanumeric with underscore.
 * Example: 'confrontación' → 'confrontacion'
 */
function sanitizeFilename(word) {
  const s = word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return s || 'word';
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
    return res.status(500).json({ error: 'Storage not configured' });
  }

  const { word, languageCode, audioBase64 } = req.body || {};

  if (!word || typeof word !== 'string' || !word.trim()) {
    return res.status(400).json({ error: 'Missing word' });
  }
  if (!languageCode || !ALLOWED_LANG_CODES.has(languageCode)) {
    return res.status(400).json({ error: 'Unsupported language code' });
  }
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing audioBase64' });
  }

  const lang         = languageCode.split('-')[0]; // 'es-ES' → 'es'
  const filename     = sanitizeFilename(word.trim());
  const storagePath  = `${lang}/${filename}.mp3`;
  const audioBuffer  = Buffer.from(audioBase64, 'base64');

  try {
    // ── 1. Upload to Storage ────────────────────────────────────────────────
    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/audio/${storagePath}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          'Content-Type': 'audio/mpeg',
          'x-upsert': 'true',
        },
        body: audioBuffer,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('[audio-upload] storage upload failed:', uploadRes.status, errText);
      return res.status(502).json({ error: 'Storage upload failed' });
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/audio/${storagePath}`;

    // ── 2. Update word_cache.audio_urls (read-merge-write) ─────────────────
    // Search by result_word OR input_word (same pattern as findCachedWordRow in cache.js)
    const normalized = word.trim().toLowerCase();
    const orFilter   = `(result_word.eq.${encodeURIComponent(normalized)},input_word.eq.${encodeURIComponent(normalized)})`;

    const findRes = await fetch(
      `${supabaseUrl}/rest/v1/word_cache?select=id,audio_urls&or=${orFilter}&mode=eq.single&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      }
    );

    if (findRes.ok) {
      const rows = await findRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const row    = rows[0];
        const merged = { ...(row.audio_urls || {}), [lang]: publicUrl };
        await fetch(
          `${supabaseUrl}/rest/v1/word_cache?id=eq.${row.id}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ audio_urls: merged }),
          }
        );
      } else {
        console.warn('[audio-upload] no word_cache row to update for:', normalized);
      }
    }

    return res.status(200).json({ publicUrl });
  } catch (err) {
    console.error('[audio-upload] failed:', err.message);
    return res.status(500).json({ error: 'Audio upload failed' });
  }
}
