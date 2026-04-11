/**
 * On-demand word insights — etymology, register, collocations, cultural note.
 *
 * Fetch order:
 *   1. Return word.ai_insights immediately if already populated (DB hit from prior fetch).
 *   2. Call AI (mode='insights'), parse response, save to vocabulary.ai_insights, return.
 *
 * Extensibility: ai_insights is stored as opaque JSONB. Adding new fields (false_friends,
 * mnemonic, etc.) only requires updating buildInsightsPrompt in api/anthropic.js and
 * INSIGHTS_SECTIONS in InsightsPanel.jsx. This file requires no changes.
 */

import { supabase } from './supabase';
import { updateWordDB } from './vocabulary';

async function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const devKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (devKey) headers['x-api-key'] = devKey;
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
  return headers;
}

/**
 * Fetch ai_insights for a vocabulary word.
 *
 * @param {object} word         — full vocabulary row (must have .id, .word, .word_language)
 * @param {string} primaryLang  — user's primary language code (for response language)
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}   — the ai_insights object (from cache or fresh AI call)
 */
export async function fetchInsights(word, primaryLang, signal) {
  // 1. Already fetched — return immediately (optimistic update from useVocabulary ensures
  //    word.ai_insights is populated after the first successful fetch in a session).
  if (word.ai_insights) return word.ai_insights;

  const learningLang = word.word_language || 'es';

  // 2. Call AI
  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: await buildHeaders(),
    body: JSON.stringify({
      word:              word.word,
      part_of_speech:    word.part_of_speech || '',
      learning_language: learningLang,
      primary_language:  primaryLang,
      mode:              'insights',
    }),
  });

  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try {
      const err = await response.json();
      if (err.error?.message) msg = err.error.message;
    } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  const text = (data.content?.[0]?.text || '').trim();

  let insights;
  try {
    insights = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) insights = JSON.parse(match[0]);
    else throw new Error('Could not parse insights response. Try again.');
  }

  // 3. Persist to vocabulary — updateWordDB also fires the optimistic UI update via
  //    onUpdateWord in the caller, so subsequent row expansions skip the API call.
  await updateWordDB(word.id, { ai_insights: insights });

  return insights;
}
