/**
 * Vercel serverless function — Google Cloud Text-to-Speech proxy.
 *
 * Security model:
 *   - Requires a valid Supabase session token (Authorization: Bearer <token>)
 *   - Client sends only { word, languageCode } — API key never leaves the server
 *
 * To switch TTS provider: update PROVIDER and buildTTSRequest below.
 */

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------
const PROVIDER = {
  name: 'google-tts',
  apiUrl: 'https://texttospeech.googleapis.com/v1/text:synthesize',
  apiKeyEnvVar: 'GOOGLE_TTS_API_KEY',
};

// Accepted language codes — must match TTS_PROVIDER google entries in speak.js
const ALLOWED_LANGUAGE_CODES = new Set(['es-ES', 'pt-BR', 'it-IT', 'hi-IN', 'ur-PK']);

// ---------------------------------------------------------------------------
// Auth helper (same pattern as api/anthropic.js)
// ---------------------------------------------------------------------------
async function verifySession(token) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return false;
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey },
  });
  return res.ok;
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

  const { word, languageCode } = req.body || {};

  if (!word || typeof word !== 'string' || !word.trim()) {
    return res.status(400).json({ error: 'Missing word' });
  }
  if (!languageCode || !ALLOWED_LANGUAGE_CODES.has(languageCode)) {
    return res.status(400).json({ error: 'Unsupported language code' });
  }

  const apiKey = process.env[PROVIDER.apiKeyEnvVar];
  if (!apiKey) {
    return res.status(500).json({ error: 'TTS not configured' });
  }

  try {
    const ttsRes = await fetch(`${PROVIDER.apiUrl}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: word.trim() },
        voice: { languageCode, ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      console.error('[tts] Google TTS error:', ttsRes.status, errText);
      return res.status(502).json({ error: 'TTS upstream error' });
    }

    const data = await ttsRes.json();
    return res.status(200).json({ audioContent: data.audioContent });
  } catch (err) {
    console.error('[tts] fetch failed:', err.message);
    return res.status(500).json({ error: 'TTS request failed' });
  }
}
