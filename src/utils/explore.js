/**
 * Explore mode word serving.
 *
 * Serving order (seeded languages — word_seeds table has rows for this language):
 *   1. Find an unseen seed for this user+level from word_seeds.
 *   2. Mark seed as seen in user_seed_progress.
 *   3. Serve from word_cache if already enriched.
 *   4. Otherwise call AI (mode=single, fixed word), save to cache, mark enriched.
 *   5. If all seeds for this level are seen: return { exhausted: true }.
 *
 * Serving order (unseeded languages — no word_seeds rows for this language):
 *   1. Random entry from word_cache matching (learningLang, primaryLang, level) — zero AI cost.
 *   2. Fresh AI call (explore mode prompt) if cache is empty.
 *      After AI returns: save to cache AND auto-seed into word_seeds (fire-and-forget).
 *
 * To add a new seeded language: run the insert-seeds script with the new language file.
 * No code changes required here.
 */

import { supabase } from './supabase';
import { getCachedWord, getRandomCachedExploreWord, setCachedWord } from './cache';
import { logEvent } from './events';

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

async function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const devKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (devKey) headers['x-api-key'] = devKey;
  const session = await getSession();
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
  return headers;
}

// ── AI call helpers ───────────────────────────────────────────────────────────

async function callExploreAPI(body, signal) {
  const response = await fetch('/api/anthropic', {
    method: 'POST',
    signal,
    headers: await buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let msg = `API error ${response.status}`;
    try { const err = await response.json(); if (err.error?.message) msg = err.error.message; } catch {}
    throw new Error(msg);
  }
  const data = await response.json();
  return (data.content?.[0]?.text || '').trim();
}

function parseResult(text, errorMsg) {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error(errorMsg);
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Fire-and-forget POST to /api/seed-update.
 * Passes the current session's Authorization header so the endpoint can verify the JWT.
 * Errors are logged as warnings and never bubble up.
 */
function fireSeedUpdate(action, payload, headers) {
  fetch('/api/seed-update', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  }).catch(err => console.warn('[explore] seed-update failed:', err.message));
}

/**
 * Auto-seed a word into word_seeds after an AI call.
 * Fire-and-forget — silently ignored if RLS denies or conflict exists.
 */
function autoSeedWord(word, language, level, partOfSpeech) {
  if (!word || !language || !level) return;
  supabase
    .from('word_seeds')
    .upsert(
      { word, language, level, part_of_speech: partOfSpeech || null, enriched: true },
      { onConflict: 'word,language', ignoreDuplicates: true }
    )
    .then(() => {})
    .catch(() => {});
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch one word for explore mode.
 *
 * Returns a word result object on success, or { exhausted: true, level, language, totalSeeds }
 * when the user has seen every seed for this language+level.
 *
 * @param {object}      opts
 * @param {string}      opts.learningLang
 * @param {string}      opts.primaryLang
 * @param {string}      opts.level       — 'A1'|'A2'|'B1'|'B2'|'C1'|'C2'
 * @param {string}      [opts.wordType]  — 'word'|'phrase'|'idiom'; default 'word'
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}
 */
export async function fetchExploreWord({
  learningLang,
  primaryLang,
  level,
  wordType = 'word',
  signal,
}) {
  const session = await getSession();
  const userId  = session?.user?.id ?? null;

  // ── SEEDED PATH ─────────────────────────────────────────────────────────────
  // Check whether word_seeds has entries for this language+level.
  if (userId) {
    const { data: allSeeds, error: seedsError } = await supabase
      .from('word_seeds')
      .select('id')
      .eq('language', learningLang)
      .eq('level', level)
      .limit(2000);

    if (!seedsError && allSeeds && allSeeds.length > 0) {
      const allSeedIds = allSeeds.map(s => s.id);

      // Find which seeds this user has already seen
      const { data: seenRows } = await supabase
        .from('user_seed_progress')
        .select('seed_id')
        .eq('user_id', userId)
        .in('seed_id', allSeedIds);

      const seenIds   = new Set((seenRows || []).map(r => r.seed_id));
      const unseenIds = allSeedIds.filter(id => !seenIds.has(id));

      if (unseenIds.length === 0) {
        // User has seen every seed for this level
        return { exhausted: true, level, language: learningLang, totalSeeds: allSeedIds.length };
      }

      // Pick a random unseen seed
      const randomId = unseenIds[Math.floor(Math.random() * unseenIds.length)];
      const { data: seed } = await supabase
        .from('word_seeds')
        .select('id, word, language, level, part_of_speech, enriched')
        .eq('id', randomId)
        .single();

      if (!seed) throw new Error('Failed to fetch seed word.');

      // Mark as seen (ignore conflict — already seen via concurrent request)
      supabase
        .from('user_seed_progress')
        .upsert({ user_id: userId, seed_id: seed.id }, { onConflict: 'user_id,seed_id', ignoreDuplicates: true })
        .then(() => {})
        .catch(() => {});

      // Check cache for this word
      const cached = await getCachedWord(seed.word, learningLang, learningLang, primaryLang, 'single');
      if (cached) {
        if (!seed.enriched) {
          supabase.from('word_seeds').update({ enriched: true }).eq('id', seed.id).then(() => {}).catch(() => {});
        }
        logEvent('word_lookup', {
          mode: 'explore', learning: learningLang, primary: primaryLang, level, cache_hit: true,
        });
        return cached;
      }

      // Cache miss — call AI with the specific seed word
      const text = await callExploreAPI({
        word:             seed.word,
        input_language:   learningLang,
        learning_language: learningLang,
        primary_language:  primaryLang,
        mode:             'single',
      }, signal);

      const result = parseResult(text, 'Could not parse explore word response. Try again.');
      const normalized = (result.word || seed.word).toLowerCase().trim();

      await setCachedWord(normalized, learningLang, learningLang, primaryLang, 'single', result);

      // Fire-and-forget: mark enriched=true AND correct level from AI response
      console.log('[debug] fireSeedUpdate enrich seedId:', seed.id, 'type:', typeof seed.id, 'level:', result.recommended_level);
      buildHeaders()
        .then(h => fireSeedUpdate('enrich', { seedId: seed.id, level: result.recommended_level || seed.level }, h))
        .catch(err => console.warn('[explore] seed-update header build failed:', err.message));

      logEvent('word_lookup', {
        mode: 'explore', learning: learningLang, primary: primaryLang, level, cache_hit: false,
      });
      return result;
    }
  }

  // ── UNSEEDED FALLBACK PATH ───────────────────────────────────────────────────
  // No word_seeds rows for this language — use old random cache / AI flow.

  const cached = await getRandomCachedExploreWord(learningLang, primaryLang, level, wordType);
  if (cached) {
    logEvent('word_lookup', {
      mode: 'explore', learning: learningLang, primary: primaryLang,
      level, word_type: wordType, cache_hit: true,
    });
    // Task 3: auto-seed cache hits that have a level set
    if (cached.word && cached.recommended_level) {
      autoSeedWord(
        (cached.word).toLowerCase().trim(),
        learningLang,
        cached.recommended_level,
        cached.part_of_speech,
      );
    }
    return cached;
  }

  // AI call — random word for this level
  logEvent('word_lookup', {
    mode: 'explore', learning: learningLang, primary: primaryLang,
    level, word_type: wordType, cache_hit: false,
  });

  const text = await callExploreAPI({
    learning_language: learningLang,
    primary_language:  primaryLang,
    level,
    word_type:         wordType,
    mode:              'explore',
  }, signal);

  const result = parseResult(text, 'Could not parse explore word response. Try again.');
  const normalized = (result.word || '').toLowerCase().trim();

  if (normalized) {
    await setCachedWord(normalized, learningLang, learningLang, primaryLang, 'single', result);
    // Task 3: auto-seed into word_seeds so future visits use the seeded path
    autoSeedWord(normalized, learningLang, result.recommended_level || level, result.part_of_speech);
  }

  return result;
}

/**
 * Delete all user_seed_progress rows for a given language+level combo.
 * Called when the user clicks "Reset [level] progress".
 */
export async function resetSeedProgress({ learningLang, level }) {
  const session = await getSession();
  const userId  = session?.user?.id;
  if (!userId) return;

  // Fetch seed IDs for this language+level
  const { data: seeds } = await supabase
    .from('word_seeds')
    .select('id')
    .eq('language', learningLang)
    .eq('level', level);

  if (!seeds?.length) return;
  const seedIds = seeds.map(s => s.id);

  await supabase
    .from('user_seed_progress')
    .delete()
    .eq('user_id', userId)
    .in('seed_id', seedIds);
}
