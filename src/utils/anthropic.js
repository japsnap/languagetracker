const ES_EN_SYSTEM = `You are a Spanish language expert. When given a Spanish word or phrase, respond with ONLY a valid JSON object — no markdown fences, no explanation whatsoever. Use exactly these fields:

{
  "part_of_speech": "string — e.g. noun, verb, adjective, phrase, gerund, verb form, etc.",
  "meaning": "string — clear English meaning",
  "example": "string — a natural Spanish sentence using the word",
  "recommended_level": "string — exactly one of: A1, A2, B1, B2, C1, C2",
  "related_words": "string — comma-separated related Spanish words, or empty string",
  "other_useful_notes": "string — grammar notes, usage tips, conjugation info, or empty string"
}`;

const EN_ES_SYSTEM = `You are a Spanish language expert. Given an English word or expression, respond with ONLY a valid JSON array of up to 3 Spanish equivalents — no markdown fences, no explanation. Each item must use exactly these fields:

{
  "word": "Spanish word or phrase",
  "part_of_speech": "noun / verb / adjective / phrase / etc.",
  "meaning": "English meaning",
  "example": "Natural Spanish sentence using this word",
  "recommended_level": "A1 | A2 | B1 | B2 | C1 | C2",
  "related_words": "comma-separated related Spanish words, or empty string",
  "other_useful_notes": "grammar notes, usage tips, conjugation info, or empty string"
}

Return between 1 and 3 items. Only include genuinely useful Spanish equivalents.`;

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  const devKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (devKey) headers['x-api-key'] = devKey;
  return headers;
}

async function callAPI(systemPrompt, userContent, signal, maxTokens) {
  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: buildHeaders(),
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try { const err = await response.json(); if (err.error?.message) msg = err.error.message; } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  return (data.content?.[0]?.text || '').trim();
}

/** Spanish → English: returns a single word object. */
export async function lookupWord(word, signal) {
  const text = await callAPI(ES_EN_SYSTEM, word.trim(), signal, 600);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response. Try again or fill fields manually.');
  }
}

/** English → Spanish: returns an array of up to 3 word objects. */
export async function lookupEnglishWord(word, signal) {
  const text = await callAPI(EN_ES_SYSTEM, word.trim(), signal, 1400);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response. Try again.');
  }
}
