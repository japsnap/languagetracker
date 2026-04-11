import { supabase } from './supabase';
import { getCachedWord, setCachedWord } from './cache';
import { logEvent } from './events';

async function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };

  // Dev: vite proxy sends directly to Anthropic, which requires x-api-key.
  // VITE_ANTHROPIC_API_KEY is only needed locally and is never deployed.
  const devKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (devKey) headers['x-api-key'] = devKey;

  // Prod: serverless function validates this token before forwarding the request.
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }

  return headers;
}

/**
 * Low-level API call. Accepts a pre-built payload object.
 * All prompt/model details are handled server-side.
 */
async function callAPI(payload, signal) {
  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: await buildHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try { const err = await response.json(); if (err.error?.message) msg = err.error.message; } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  return (data.content?.[0]?.text || '').trim();
}

/**
 * Look up a word (multi — up to 3 meanings).
 * Returns an array of full result objects.
 *
 * @param {string} word             - raw input from the user
 * @param {string} inputLanguage    - language the user typed in
 * @param {string} learningLanguage - word/example/related_words returned in this language
 * @param {string} primaryLanguage  - meaning/part_of_speech/notes returned in this language
 * @param {AbortSignal} signal
 */
export async function lookupWord(word, inputLanguage, learningLanguage, primaryLanguage, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, inputLanguage, learningLanguage, primaryLanguage, 'multi');
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, input: inputLanguage, learning: learningLanguage, primary: primaryLanguage, mode: 'multi', cache_hit: true });
    return Array.isArray(cached) ? cached : [cached];
  }
  logEvent('word_lookup', { word: normalized, input: inputLanguage, learning: learningLanguage, primary: primaryLanguage, mode: 'multi', cache_hit: false });

  const text = await callAPI(
    { word: normalized, input_language: inputLanguage, learning_language: learningLanguage, primary_language: primaryLanguage, mode: 'multi' },
    signal,
  );
  let result;
  try {
    const parsed = JSON.parse(text);
    result = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) { result = JSON.parse(arrMatch[0]); }
    else {
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) { result = [JSON.parse(objMatch[0])]; }
      else throw new Error('Could not parse AI response. Try again or fill fields manually.');
    }
  }
  await setCachedWord(normalized, inputLanguage, learningLanguage, primaryLanguage, 'multi', result);
  return result;
}

/**
 * Look up a word (single — most common meaning).
 * Returns one full result object.
 */
export async function lookupWordSingle(word, inputLanguage, learningLanguage, primaryLanguage, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, inputLanguage, learningLanguage, primaryLanguage, 'single');
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, input: inputLanguage, learning: learningLanguage, primary: primaryLanguage, mode: 'single', cache_hit: true });
    return Array.isArray(cached) ? cached[0] : cached;
  }
  logEvent('word_lookup', { word: normalized, input: inputLanguage, learning: learningLanguage, primary: primaryLanguage, mode: 'single', cache_hit: false });

  const text = await callAPI(
    { word: normalized, input_language: inputLanguage, learning_language: learningLanguage, primary_language: primaryLanguage, mode: 'single' },
    signal,
  );
  let result;
  try {
    const parsed = JSON.parse(text);
    result = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { result = JSON.parse(match[0]); }
    else throw new Error('Could not parse AI response. Try again or fill fields manually.');
  }
  await setCachedWord(normalized, inputLanguage, learningLanguage, primaryLanguage, 'single', result);
  return result;
}

/**
 * Brief secondary translation: returns { word_in_target, meaning_brief, example_brief }.
 * Independent of the three-role system — takes explicit source and target codes.
 * For secondary mini-cards: source = learning language, target = secondary language code.
 */
export async function lookupSecondary(word, sourceLanguage, targetLanguage, signal) {
  const normalized = word.toLowerCase().trim();
  // Cache key: input_language unused for secondary; use sourceLanguage for both input and learning slots
  const cached = await getCachedWord(normalized, sourceLanguage, sourceLanguage, targetLanguage, 'secondary');
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, source: sourceLanguage, target: targetLanguage, mode: 'secondary', cache_hit: true });
    return cached;
  }
  logEvent('word_lookup', { word: normalized, source: sourceLanguage, target: targetLanguage, mode: 'secondary', cache_hit: false });

  // Server: secondary mode uses learning_language as source, primary_language as target
  const text = await callAPI(
    { word: normalized, learning_language: sourceLanguage, primary_language: targetLanguage, mode: 'secondary' },
    signal,
  );
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { result = JSON.parse(match[0]); }
    else throw new Error('Could not parse secondary lookup response.');
  }
  await setCachedWord(normalized, sourceLanguage, sourceLanguage, targetLanguage, 'secondary', result);
  return result;
}
