import { supabase } from './supabase';

/**
 * Log a potential interference event when a user types a wrong answer in Hard mode.
 *
 * v1 stub: stores the typed text with interference_type='unknown' and matched_word=null.
 * The row exists so the data is captured for analysis.
 *
 * v1.5 plan: add matching logic here — check the typed text against the user's
 * own vocabulary (same learning language) and the similarity cache to identify
 * which word was being confused. Update interference_type and matched_word accordingly.
 *
 * @param {object} params
 * @param {string} params.userId       - Supabase user UUID.
 * @param {string} params.targetWordId - vocabulary.id of the word the user was trying to recall.
 * @param {string} params.typedText    - What the user typed (the wrong answer).
 * @param {string|null} params.sessionId - sessions.id for the current quiz session, or null.
 * @returns {Promise<void>} Resolves when the insert completes (or silently if table absent).
 */
export async function logInterferenceEvent({ userId, targetWordId, typedText, sessionId }) {
  if (!userId || !targetWordId) return;
  await supabase.from('interference_events').insert({
    user_id: userId,
    target_word_id: targetWordId,
    typed_text: typedText,
    matched_word: null,
    interference_type: 'unknown',
    session_id: sessionId ?? null,
  });
}
