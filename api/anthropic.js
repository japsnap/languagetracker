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
    ? `\n\nReturn between 1 and 3 items. Each item must have a DIFFERENT "word" value — provide synonyms, near-synonyms, and common alternatives even when the input has only one primary meaning. For example, "beautiful" should yield separate items for "hermoso", "lindo", "bello" — not three entries all with word="hermoso". Do not repeat the same word across items.`
    : '';

  const romaFields = NON_LATIN.has(learningLang) ? [
    `  "romanization": "English-readable pronunciation (${
      learningLang === 'ja' ? 'romaji' :
      learningLang === 'zh' ? 'pinyin with tone marks' :
      'romanized form'
    })"`,
    ...(learningLang === 'ja' ? ['  "kana_reading": "full hiragana or katakana reading of the word"'] : []),
  ] : [];

  // meaning_native: one-sentence native-language gloss for secondary mini-cards.
  // Excluded from multi-mode: each array item would need an identical gloss for the same
  // word, which confuses the model and reduces the number of distinct meanings returned.
  const meaningNativeField = (learningLang !== primaryLang && mode !== 'multi')
    ? `,\n  "meaning_native": "one-sentence meaning in ${learning} — empty string if the word is the same in both languages"`
    : '';

  const extraFieldsStr = romaFields.length
    ? ',\n' + romaFields.join(',\n')
    : '';

  return `You are a multilingual language expert. The user has entered a word or phrase in ${input}. Respond with ONLY ${shape} — no markdown fences, no explanation. The word field must be in ${learning}. The meaning, part_of_speech, and notes must be in ${primary}. The example sentence and related words must be in ${learning}. If the input has accent or spelling errors, correct them. Use exactly these fields:

{
  "word": "the word translated into ${learning} (corrected spelling if needed)",
  "word_type": "word" | "phrase" | "idiom" — classify the input: 'word' for single dictionary words, 'phrase' for multi-word expressions, 'idiom' for idiomatic expressions whose meaning differs from the literal words",
  "word_alternatives": ["up to 3 synonyms in ${learning} that are also valid translations for the same concept — do not repeat the main word; use empty array if none exist"],
  "part_of_speech": "in ${primary}: noun / verb / adjective / phrase / idiom / etc.",
  "base_form": "if part_of_speech is a verb: the infinitive or dictionary form in ${learning} (e.g. 'hablar' for 'hablo'); otherwise null",
  "meaning": "clear meaning in ${primary}. If there are multiple meanings, separate them with commas (e.g., 'weak, feeble, frail'). Do not use slashes or semicolons.",
  "meanings_array": ["up to 4 distinct meanings or translations in ${primary}, first is most common — include synonyms a learner might reasonably answer"]${meaningNativeField},
  "example": "a natural sentence in ${learning} using the word",
  "recommended_level": "A1 | A2 | B1 | B2 | C1 | C2",
  "related_words": "comma-separated related words in ${learning}, or empty string",
  "other_useful_notes": "grammar notes, usage tips in ${primary}, or empty string"${extraFieldsStr}
}${suffix}`;
}


function buildExplorePrompt(learningLang, primaryLang, level, wordType) {
  const learning = LANGUAGE_NAMES[learningLang];
  const primary  = LANGUAGE_NAMES[primaryLang];

  const romaFields = NON_LATIN.has(learningLang) ? [
    `  "romanization": "English-readable pronunciation (${
      learningLang === 'ja' ? 'romaji' :
      learningLang === 'zh' ? 'pinyin with tone marks' :
      'romanized form'
    })"`,
    ...(learningLang === 'ja' ? ['  "kana_reading": "full hiragana or katakana reading of the word"'] : []),
  ] : [];
  const extraFieldsStr = romaFields.length ? ',\n' + romaFields.join(',\n') : '';

  return `You are a language learning expert. Choose ONE random ${level}-level ${wordType} in ${learning} that a learner at that level should know. Vary your choices — do not repeat the most common filler words. Respond with ONLY a valid JSON object — no markdown fences, no explanation. The meaning, part_of_speech, and notes must be in ${primary}. Use exactly these fields:

{
  "word": "a ${level}-level ${wordType} in ${learning}",
  "word_type": "${wordType}",
  "word_alternatives": ["up to 3 synonyms in ${learning} — empty array if none"],
  "part_of_speech": "in ${primary}: noun / verb / adjective / etc.",
  "base_form": "if part_of_speech is a verb: the infinitive in ${learning}; otherwise null",
  "meaning": "clear meaning in ${primary}, comma-separated if multiple",
  "meanings_array": ["up to 4 distinct meanings in ${primary}"],
  "example": "a natural ${level}-appropriate sentence in ${learning}",
  "recommended_level": "${level}",
  "related_words": "comma-separated related words in ${learning}, or empty string",
  "other_useful_notes": "grammar notes, usage tips in ${primary}, or empty string"${extraFieldsStr}
}`;
}

function buildInsightsPrompt(learningLang, primaryLang, wordText, partOfSpeech) {
  const learning = LANGUAGE_NAMES[learningLang];
  const primary  = LANGUAGE_NAMES[primaryLang];
  const pos      = partOfSpeech ? ` (${partOfSpeech})` : '';

  return `You are a language learning expert. For the ${learning} word "${wordText}"${pos}, provide enrichment information for learners. Respond with ONLY a valid JSON object — no markdown fences, no explanation. Write all explanations in ${primary}. Use exactly these fields:

{
  "etymology": "brief etymology: language of origin, root meaning, how the word evolved — 1-2 sentences",
  "register": "exactly one of: formal | informal | colloquial | slang | written-only | neutral",
  "collocations": [
    { "phrase": "common collocation in ${learning}", "example": "natural example sentence in ${learning}" },
    { "phrase": "...", "example": "..." },
    { "phrase": "...", "example": "..." }
  ],
  "cultural_note": "one engaging cultural or historical note about this word, written conversationally in ${primary}"
}

Return exactly 3 collocations.`;
}

// To add a new insights field (e.g. false_friends, mnemonic):
//   1. Add it to buildInsightsPrompt above.
//   2. Add its key to INSIGHTS_SECTIONS in InsightsPanel.jsx.
//   The fetch and DB-save logic in insights.js requires no changes.

const MAX_TOKENS = { single: 700, multi: 2000, explore: 700, insights: 600 };

const VALID_LEVELS    = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const VALID_WORD_TYPES = new Set(['word', 'phrase', 'idiom']);

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
  const {
    word, input_language, learning_language, primary_language, meaning_language,
    mode, level, word_type, part_of_speech,
  } = req.body ?? {};

  let systemPrompt, userMessage;

  if (mode === 'explore') {
    // Explore mode: AI generates a random word — no input word needed
    if (
      !VALID_CODES.has(learning_language) ||
      !VALID_CODES.has(primary_language) ||
      !VALID_LEVELS.has(level) ||
      !VALID_WORD_TYPES.has(word_type)
    ) {
      return res.status(400).json({ error: 'Invalid request payload' });
    }
    systemPrompt = buildExplorePrompt(learning_language, primary_language, level, word_type);
    userMessage  = 'Generate.';

  } else if (mode === 'insights') {
    // Insights mode: enrichment for a saved vocabulary word
    if (
      typeof word !== 'string' || !word.trim() ||
      !VALID_CODES.has(learning_language) ||
      !VALID_CODES.has(primary_language)
    ) {
      return res.status(400).json({ error: 'Invalid request payload' });
    }
    systemPrompt = buildInsightsPrompt(
      learning_language, primary_language, word.trim(), part_of_speech || ''
    );
    userMessage = word.trim();

  } else {
    // Standard modes: require an input word
    if (
      typeof word !== 'string' || !word.trim() ||
      !VALID_CODES.has(input_language) ||
      !VALID_CODES.has(learning_language) ||
      !VALID_CODES.has(primary_language) ||
      (mode !== 'single' && mode !== 'multi')
    ) {
      return res.status(400).json({ error: 'Invalid request payload' });
    }
    systemPrompt = buildPrimaryPrompt(input_language, learning_language, primary_language, mode);
    userMessage = word.trim();
  }

  const maxTokens = MAX_TOKENS[mode] ?? MAX_TOKENS.single;

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
      body: JSON.stringify(buildUpstreamRequest(systemPrompt, userMessage, maxTokens)),
    });

    const data = await upstream.json();

    // Cache recycling — only for mode='single' (Input page lookup).
    // Explicit allowlist: 'multi', 'explore', 'insights', and any quiz-related modes excluded.
    // Fire-and-forget: never blocks or alters the main response.
    if (upstream.ok && ['single'].includes(mode)) {
      try {
        const textContent = data.content?.[0]?.text ?? '';
        const jsonMatch   = textContent.match(/\{[\s\S]*\}/);
        const parsed      = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        if (parsed?.word && parsed?.recommended_level) {
          const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'https';
          const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
          if (host) {
            fetch(`${proto}://${host}/api/seed-update`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: req.headers.authorization,
              },
              body: JSON.stringify({
                action: 'add_seed',
                payload: {
                  word:           parsed.word,
                  language:       learning_language,
                  level:          parsed.recommended_level,
                  part_of_speech: parsed.part_of_speech || null,
                },
              }),
            }).catch(err => console.warn('[anthropic] seed-update failed:', err.message));
          }
        }
      } catch {
        // Parse error — skip silently; never block the lookup response
      }
    }

    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
