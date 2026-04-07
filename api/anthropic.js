/**
 * Vercel serverless function — proxies requests to the Anthropic API.
 * The API key lives in Vercel's environment variables (ANTHROPIC_API_KEY),
 * so it is NEVER sent to or exposed in the browser.
 *
 * Requests must include a valid Supabase session token in the Authorization
 * header (Bearer <token>). Unauthenticated requests are rejected with 401.
 *
 * Dev: requests reach here via Vite's server.proxy config.
 * Prod: Vercel routes /api/anthropic to this function automatically.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Auth gate ---
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  const authCheck = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: supabaseAnonKey,
    },
  });
  if (!authCheck.ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // --- End auth gate ---

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set in environment variables.',
    });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
