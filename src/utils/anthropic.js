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
 * Send { word, source_language, target_language, mode } to the serverless proxy.
 * All prompt/model details are handled server-side.
 */
async function callAPI(word, sourceLanguage, targetLanguage, mode, signal) {
  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: await buildHeaders(),
    body: JSON.stringify({
      word,
      source_language: sourceLanguage,
      target_language: targetLanguage,
      mode,
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

/**
 * Look up a word: returns an array of up to 3 full-depth result objects.
 * source/target are language codes e.g. 'es', 'en', 'ja'.
 */
export async function lookupWord(word, sourceLanguage, targetLanguage, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, sourceLanguage, 'multi', targetLanguage);
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, source: sourceLanguage, target: targetLanguage, mode: 'multi', cache_hit: true });
    return Array.isArray(cached) ? cached : [cached];
  }
  logEvent('word_lookup', { word: normalized, source: sourceLanguage, target: targetLanguage, mode: 'multi', cache_hit: false });

  const text = await callAPI(normalized, sourceLanguage, targetLanguage, 'multi', signal);
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
  await setCachedWord(normalized, sourceLanguage, 'multi', result, targetLanguage);
  return result;
}

/**
 * Look up a word: returns one full-depth result object (most common meaning).
 * source/target are language codes e.g. 'es', 'en', 'ja'.
 */
export async function lookupWordSingle(word, sourceLanguage, targetLanguage, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, sourceLanguage, 'single', targetLanguage);
  if (cached !== null) {
    logEvent('word_lookup', { word: normalized, source: sourceLanguage, target: targetLanguage, mode: 'single', cache_hit: true });
    return Array.isArray(cached) ? cached[0] : cached;
  }
  logEvent('word_lookup', { word: normalized, source: sourceLanguage, target: targetLanguage, mode: 'single', cache_hit: false });

  const text = await callAPI(normalized, sourceLanguage, targetLanguage, 'single', signal);
  let result;
  try {
    const parsed = JSON.parse(text);
    result = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { result = JSON.parse(match[0]); }
    else throw new Error('Could not parse AI response. Try again or fill fields manually.');
  }
  await setCachedWord(normalized, sourceLanguage, 'single', result, targetLanguage);
  return result;
}

/**
 * Brief secondary translation: returns { word_in_target, meaning_brief, example_brief }.
 * Used for secondary language mini-cards alongside the primary result.
 */
export async function lookupSecondary(word, sourceLanguage, targetLanguage, signal) {
  const normalized = word.toLowerCase().trim();
  const cached = await getCachedWord(normalized, sourceLanguage, 'secondary', targetLanguage);
  if (cached !== null) {
    return cached;
  }

  const text = await callAPI(normalized, sourceLanguage, targetLanguage, 'secondary', signal);
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { result = JSON.parse(match[0]); }
    else throw new Error('Could not parse secondary lookup response.');
  }
  await setCachedWord(normalized, sourceLanguage, 'secondary', result, targetLanguage);
  return result;
}
