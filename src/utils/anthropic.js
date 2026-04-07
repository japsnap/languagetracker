import { supabase } from './supabase';

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
  const text = await callAPI(word.trim(), 'es-en', 'multi', signal);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) return [JSON.parse(objMatch[0])];
    throw new Error('Could not parse AI response. Try again or fill fields manually.');
  }
}

/** Spanish → English (single): returns one word object for the most common meaning. */
export async function lookupWordSingle(word, signal) {
  const text = await callAPI(word.trim(), 'es-en', 'single', signal);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response. Try again or fill fields manually.');
  }
}

/** English → Spanish: returns an array of up to 3 word objects. */
export async function lookupEnglishWord(word, signal) {
  const text = await callAPI(word.trim(), 'en-es', 'multi', signal);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response. Try again.');
  }
}

/** English → Spanish (single): returns one word object for the most common translation. */
export async function lookupEnglishWordSingle(word, signal) {
  const text = await callAPI(word.trim(), 'en-es', 'single', signal);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response. Try again.');
  }
}
