const SYSTEM_PROMPT = `You are a Spanish language expert. When given a Spanish word or phrase, respond with ONLY a valid JSON object — no markdown fences, no explanation whatsoever. Use exactly these fields:

{
  "part_of_speech": "string — e.g. noun, verb, adjective, phrase, gerund, verb form, etc.",
  "meaning": "string — clear English meaning",
  "example": "string — a natural Spanish sentence using the word",
  "recommended_level": "string — exactly one of: A1, A2, B1, B2",
  "related_words": "string — comma-separated related Spanish words, or empty string",
  "other_useful_notes": "string — grammar notes, usage tips, conjugation info, or empty string"
}`;

export async function lookupWord(word, signal) {
  // In dev: Vite proxies /api/anthropic → api.anthropic.com (API key sent as header)
  // In prod: Vercel routes /api/anthropic → api/anthropic.js serverless function (key stays server-side)
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  // Dev only: include key so Vite proxy can forward it
  const devKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (devKey) headers['x-api-key'] = devKey;

  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: word.trim() }],
    }),
  });

  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try { const err = await response.json(); if (err.error?.message) msg = err.error.message; } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  const text = (data.content?.[0]?.text || '').trim();

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response. Try again or fill fields manually.');
  }
}
