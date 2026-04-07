/**
 * Vercel serverless function — proxies requests to the Anthropic API.
 *
 * Security model:
 *   - Requires a valid Supabase session token (Authorization: Bearer <token>)
 *   - Client sends only { word, direction, mode } — all prompt/model details
 *     are hardcoded here and never controllable by the client
 *
 * To switch AI provider: update PROVIDER + the buildUpstreamRequest function.
 */

// ---------------------------------------------------------------------------
// Provider config — change this block to switch AI backends
// ---------------------------------------------------------------------------
const PROVIDER = {
  name: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  apiUrl: 'https://api.anthropic.com/v1/messages',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
};

// ---------------------------------------------------------------------------
// System prompts — never sent to or modifiable by the client
// ---------------------------------------------------------------------------
const PROMPTS = {
  'es-en': `You are a Spanish language expert. When given a Spanish word or phrase, respond with ONLY a valid JSON array of up to 3 meanings — no markdown fences, no explanation. If the user input has accent or spelling errors, correct them in the word field (e.g. espanol → español, nino → niño). Each item must use exactly these fields:

{
  "word": "the Spanish word or phrase, correctly spelled with proper accents",
  "part_of_speech": "string — e.g. noun, verb, adjective, phrase, gerund, verb form, etc.",
  "meaning": "string — clear English meaning",
  "example": "string — a natural Spanish sentence using the word",
  "recommended_level": "string — exactly one of: A1, A2, B1, B2, C1, C2",
  "related_words": "string — comma-separated related Spanish words, or empty string",
  "other_useful_notes": "string — grammar notes, usage tips, conjugation info, or empty string"
}

Return between 1 and 3 items. Only include genuinely different meanings or usages.`,

  'es-en-single': `You are a Spanish language expert. When given a Spanish word or phrase, respond with ONLY a valid JSON object — no markdown fences, no explanation. If the user input has accent or spelling errors, correct them in the word field (e.g. espanol → español, nino → niño). Return ONLY ONE JSON object (not an array) for the single most common meaning. Use exactly these fields:

{
  "word": "the Spanish word or phrase, correctly spelled with proper accents",
  "part_of_speech": "string — e.g. noun, verb, adjective, phrase, gerund, verb form, etc.",
  "meaning": "string — clear English meaning",
  "example": "string — a natural Spanish sentence using the word",
  "recommended_level": "string — exactly one of: A1, A2, B1, B2, C1, C2",
  "related_words": "string — comma-separated related Spanish words, or empty string",
  "other_useful_notes": "string — grammar notes, usage tips, conjugation info, or empty string"
}`,

  'en-es': `You are a Spanish language expert. Given an English word or expression, respond with ONLY a valid JSON array of up to 3 Spanish equivalents — no markdown fences, no explanation. If the user input has accent or spelling errors, correct them in the word field (e.g. espanol → español, nino → niño). Each item must use exactly these fields:

{
  "word": "Spanish word or phrase",
  "part_of_speech": "noun / verb / adjective / phrase / etc.",
  "meaning": "English meaning",
  "example": "Natural Spanish sentence using this word",
  "recommended_level": "A1 | A2 | B1 | B2 | C1 | C2",
  "related_words": "comma-separated related Spanish words, or empty string",
  "other_useful_notes": "grammar notes, usage tips, conjugation info, or empty string"
}

Return between 1 and 3 items. Only include genuinely useful Spanish equivalents.`,

  'en-es-single': `You are a Spanish language expert. Given an English word or expression, respond with ONLY a valid JSON object — no markdown fences, no explanation. If the user input has accent or spelling errors, correct them in the word field. Return ONLY ONE JSON object (not an array) for the single most common meaning. Use exactly these fields:

{
  "word": "Spanish word or phrase",
  "part_of_speech": "noun / verb / adjective / phrase / etc.",
  "meaning": "English meaning",
  "example": "Natural Spanish sentence using this word",
  "recommended_level": "A1 | A2 | B1 | B2 | C1 | C2",
  "related_words": "comma-separated related Spanish words, or empty string",
  "other_useful_notes": "grammar notes, usage tips, conjugation info, or empty string"
}`,
};

// max_tokens per direction + mode
const MAX_TOKENS = {
  'es-en': { single: 400, multi: 600 },
  'en-es': { single: 400, multi: 1400 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify the Supabase JWT. Returns true if valid. */
async function verifySession(token) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return false;
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey },
  });
  return res.ok;
}

/** Build the provider-specific upstream request body. */
function buildUpstreamRequest(systemPrompt, word, maxTokens) {
  // Anthropic format — update this function when switching providers
  return {
    model: PROVIDER.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: word }],
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

  // Validate client payload — only these three fields are accepted
  const { word, direction, mode } = req.body ?? {};
  if (
    typeof word !== 'string' || !word.trim() ||
    (direction !== 'es-en' && direction !== 'en-es') ||
    (mode !== 'single' && mode !== 'multi')
  ) {
    return res.status(400).json({ error: 'Invalid request payload' });
  }

  const promptKey = mode === 'single' ? `${direction}-single` : direction;
  const systemPrompt = PROMPTS[promptKey];
  const maxTokens = MAX_TOKENS[direction][mode];

  const apiKey = process.env[PROVIDER.apiKeyEnvVar];
  if (!apiKey) {
    return res.status(500).json({ error: `${PROVIDER.apiKeyEnvVar} is not set` });
  }

  try {
    const upstream = await fetch(PROVIDER.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(buildUpstreamRequest(systemPrompt, word.trim(), maxTokens)),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
