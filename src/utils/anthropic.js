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
 * Send { word, direction, mode } to the serverless proxy.
 * All prompt/model details are handled server-side.
 */
async function callAPI(word, direction, mode, signal) {
  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: await buildHeaders(),
    body: JSON.stringify({ word, direction, mode }),
  });

  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try { const err = await response.json(); if (err.error?.message) msg = err.error.message; } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  return (data.content?.[0]?.text || '').trim();
}

/** Spanish → English: returns an array of up to 3 word objects. */
export async function lookupWord(word, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, 'es-en', 'multi');
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, direction: 'es-en', mode: 'multi', cache_hit: true });
    return Array.isArray(cached) ? cached : [cached];
  }
  logEvent('word_lookup', { word: normalized, direction: 'es-en', mode: 'multi', cache_hit: false });

  const text = await callAPI(normalized, 'es-en', 'multi', signal);
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
  await setCachedWord(normalized, 'es-en', 'multi', result);
  return result;
}

/** Spanish → English (single): returns one word object for the most common meaning. */
export async function lookupWordSingle(word, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, 'es-en', 'single');
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, direction: 'es-en', mode: 'single', cache_hit: true });
    return Array.isArray(cached) ? cached[0] : cached;
  }
  logEvent('word_lookup', { word: normalized, direction: 'es-en', mode: 'single', cache_hit: false });

  const text = await callAPI(normalized, 'es-en', 'single', signal);
  let result;
  try {
    const parsed = JSON.parse(text);
    result = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { result = JSON.parse(match[0]); }
    else throw new Error('Could not parse AI response. Try again or fill fields manually.');
  }
  await setCachedWord(normalized, 'es-en', 'single', result);
  return result;
}

/** English → Spanish: returns an array of up to 3 word objects. */
export async function lookupEnglishWord(word, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, 'en-es', 'multi');
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, direction: 'en-es', mode: 'multi', cache_hit: true });
    return Array.isArray(cached) ? cached : [cached];
  }
  logEvent('word_lookup', { word: normalized, direction: 'en-es', mode: 'multi', cache_hit: false });

  const text = await callAPI(normalized, 'en-es', 'multi', signal);
  let result;
  try {
    const parsed = JSON.parse(text);
    result = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) { result = JSON.parse(match[0]); }
    else throw new Error('Could not parse AI response. Try again.');
  }
  await setCachedWord(normalized, 'en-es', 'multi', result);
  return result;
}

/** English → Spanish (single): returns one word object for the most common translation. */
export async function lookupEnglishWordSingle(word, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, 'en-es', 'single');
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, direction: 'en-es', mode: 'single', cache_hit: true });
    return Array.isArray(cached) ? cached[0] : cached;
  }
  logEvent('word_lookup', { word: normalized, direction: 'en-es', mode: 'single', cache_hit: false });

  const text = await callAPI(normalized, 'en-es', 'single', signal);
  let result;
  try {
    const parsed = JSON.parse(text);
    result = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { result = JSON.parse(match[0]); }
    else throw new Error('Could not parse AI response. Try again.');
  }
  await setCachedWord(normalized, 'en-es', 'single', result);
  return result;
}
