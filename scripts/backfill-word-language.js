/**
 * One-time backfill script — tags existing vocabulary rows with word_language.
 *
 * Run from the spanishapp directory:
 *   node --env-file=.env scripts/backfill-word-language.js
 *
 * Requires in .env:
 *   VITE_SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *
 * The service role key bypasses RLS so all users' rows can be updated.
 * Find it in: Supabase Dashboard → Project Settings → API → service_role secret.
 * Keep it out of git — it is already covered by .gitignore via .env.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Add SUPABASE_SERVICE_ROLE_KEY to your .env (Supabase → Settings → API).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

// ── Language detection ────────────────────────────────────────────────────────
// Non-Latin scripts are detected reliably by Unicode character ranges.
// Latin-script words fall back to the user's learning_language preference.
// Order matters: check hiragana/katakana before CJK so Japanese isn't tagged zh.

function detectScriptLanguage(word) {
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(word))              return 'ja'; // hiragana / katakana → Japanese
  if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(word)) return 'ko'; // Hangul → Korean
  if (/[\u0600-\u06FF]/.test(word))                            return 'ur'; // Arabic/Urdu script
  if (/[\u0900-\u097F]/.test(word))                            return 'hi'; // Devanagari → Hindi
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(word))              return 'zh'; // CJK only (no kana) → Chinese
  return null; // Latin-script — use user preference
}

// ── To add a new script language later: ──────────────────────────────────────
// Add a regex line above detectScriptLanguage's return null, in priority order.

async function run() {
  // 1. Fetch all vocabulary rows that haven't been tagged yet
  const { data: words, error: wordsErr } = await supabase
    .from('vocabulary')
    .select('id, word, user_id')
    .is('word_language', null);

  if (wordsErr) { console.error('Failed to fetch vocabulary:', wordsErr.message); process.exit(1); }
  console.log(`Found ${words.length} rows with no word_language.`);
  if (words.length === 0) { console.log('Nothing to backfill. Done.'); return; }

  // 2. Fetch user preferences to map user_id → learning_language
  const { data: prefs, error: prefsErr } = await supabase
    .from('user_preferences')
    .select('user_id, learning_language');

  if (prefsErr) { console.error('Failed to fetch preferences:', prefsErr.message); process.exit(1); }

  const userLang = {};
  for (const p of prefs) {
    if (p.user_id && p.learning_language) userLang[p.user_id] = p.learning_language;
  }

  // 3. Assign a language code to each word
  const counts = {};
  const updates = [];

  for (const row of words) {
    const detected = detectScriptLanguage(row.word);
    const lang = detected ?? (userLang[row.user_id] || 'es');
    updates.push({ id: row.id, word_language: lang });
    counts[lang] = (counts[lang] || 0) + 1;
  }

  // 4. Push updates in batches (upsert on id preserves all other columns)
  const BATCH = 200;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const { error } = await supabase.from('vocabulary').upsert(batch, { onConflict: 'id' });
    if (error) {
      console.error(`Batch ${i + 1}–${i + batch.length} failed:`, error.message);
      process.exit(1);
    }
    console.log(`  Updated rows ${i + 1}–${Math.min(i + BATCH, updates.length)}`);
  }

  // 5. Summary
  console.log('\nBackfill complete. Words tagged per language:');
  for (const [lang, count] of Object.entries(counts).sort()) {
    console.log(`  ${lang}: ${count}`);
  }
}

run();
