/**
 * Vercel serverless function — proxies requests to the Anthropic API.
 *
 * Security model:
 *   - Requires a valid Supabase session token (Authorization: Bearer <token>)
 *   - Client sends only { word, input_language, learning_language, primary_language, mode }
 *     — all prompt/model details are hardcoded here and never controllable by the client
 *
 * Three-role language system:
 *   - input_language:    the language the user typed in
 *   - learning_language: word, example, related_words are returned in this language
 *   - primary_language:  meaning, part_of_speech, notes are returned in this language
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
// Language registry
// ---------------------------------------------------------------------------
const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish',
  ja: 'Japanese',
  de: 'German',
  ko: 'Korean',
  zh: 'Chinese',
  ur: 'Urdu',
  hi: 'Hindi',
  pt: 'Portuguese',
  fr: 'French',
  it: 'Italian',
};
const VALID_CODES = new Set(Object.keys(LANGUAGE_NAMES));

// Languages that use non-Latin scripts and need romanization in output
const NON_LATIN = new Set(['ja', 'ko', 'zh', 'ur', 'hi']);

// ---------------------------------------------------------------------------
// Dynamic prompt builders — never sent to or modifiable by the client
// ---------------------------------------------------------------------------

function buildPrimaryPrompt(inputLang, learningLang, primaryLang, mode) {
  const input    = LANGUAGE_NAMES[inputLang];
  const learning = LANGUAGE_NAMES[learningLang];
  const primary  = LANGUAGE_NAMES[primaryLang];
  const shape  = mode === 'multi'
    ? 'a valid JSON array of up to 3 items'
    : 'a valid JSON object';
  const suffix = mode === 'multi'
    ? '\n\nReturn between 1 and 3 items. Only include genuinely different meanings or usages.'
    : '';

  const romaFields = NON_LATIN.has(learningLang) ? [
    `  "romanization": "English-readable pronunciation (${
      learningLang === 'ja' ? 'romaji' :
      learningLang === 'zh' ? 'pinyin with tone marks' :
      'romanized form'
    })"`,
    ...(learningLang === 'ja' ? ['  "kana_reading": "full hiragana or katakana reading of the word"'] : []),
  ] : [];

  const extraFieldsStr = romaFields.length
    ? ',\n' + romaFields.join(',\n')
    : '';

  return `You are a multilingual language expert. The user has entered a word or phrase in ${input}. Respond with ONLY ${shape} — no markdown fences, no explanation. The word field must be in ${learning}. The meaning, part_of_speech, and notes must be in ${primary}. The example sentence and related words must be in ${learning}. If the input has accent or spelling errors, correct them. Use exactly these fields:

{
  "word": "the word translated into ${learning} (corrected spelling if needed)",
  "word_alternatives": ["up to 3 synonyms in ${learning} that are also valid translations for the same concept — do not repeat the main word; use empty array if none exist"],
  "part_of_speech": "in ${primary}: noun / verb / adjective / phrase / etc.",
  "meaning": "clear meaning in ${primary}. If there are multiple meanings, separate them with commas (e.g., 'weak, feeble, frail'). Do not use slashes or semicolons.",
  "meanings_array": ["up to 4 distinct meanings or translations in ${primary}, first is most common — include synonyms a learner might reasonably answer"],
  "example": "a natural sentence in ${learning} using the word",
  "recommended_level": "A1 | A2 | B1 | B2 | C1 | C2",
  "related_words": "comma-separated related words in ${learning}, or empty string",
  "other_useful_notes": "grammar notes, usage tips in ${primary}, or empty string"${extraFieldsStr}
}${suffix}`;
}

function buildSecondaryPrompt(sourceLang, targetLang) {
  const source = LANGUAGE_NAMES[sourceLang];
  const target = LANGUAGE_NAMES[targetLang];

  const romaFields = NON_LATIN.has(targetLang) ? [
    `  "romanization": "English-readable pronunciation (${
      targetLang === 'ja' ? 'romaji' :
      targetLang === 'zh' ? 'pinyin with tone marks' :
      'romanized form'
    })"`,
    ...(targetLang === 'ja' ? ['  "kana_reading": "full hiragana or katakana reading"'] : []),
  ] : [];

  const extraFieldsStr = romaFields.length
    ? ',\n' + romaFields.join(',\n')
    : '';

  return `You are a multilingual language expert. Given a word in ${source}, respond with ONLY a valid JSON object — no markdown fences, no explanation. Provide a brief translation in ${target}. Use exactly these fields:

{
  "word_in_target": "the word translated into ${target}",
  "meaning_brief": "a short meaning/definition in ${target} (1 sentence max)",
  "example_brief": "one short example sentence in ${target} using this word"${extraFieldsStr}
}`;
}

const MAX_TOKENS = { single: 600, multi: 1800, secondary: 300 };

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

  // Validate client payload
  const { word, input_language, learning_language, primary_language, mode } = req.body ?? {};
  if (
    typeof word !== 'string' || !word.trim() ||
    (mode !== 'secondary' && !VALID_CODES.has(input_language)) ||
    !VALID_CODES.has(learning_language) ||
    !VALID_CODES.has(primary_language) ||
    (mode !== 'single' && mode !== 'multi' && mode !== 'secondary')
  ) {
    return res.status(400).json({ error: 'Invalid request payload' });
  }

  // For secondary mode, input_language doubles as source, learning_language as target
  const systemPrompt = mode === 'secondary'
    ? buildSecondaryPrompt(learning_language, primary_language)
    : buildPrimaryPrompt(input_language, learning_language, primary_language, mode);
  const maxTokens = MAX_TOKENS[mode];

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
