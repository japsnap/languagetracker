/**
 * Insert seed words into word_seeds table.
 *
 * Run: node scripts/seeds/insert-seeds.js
 *
 * SQL — run once in Supabase SQL Editor before executing this script:
 *
 *   CREATE TABLE IF NOT EXISTS word_seeds (
 *     id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     word          text        NOT NULL,
 *     language      text        NOT NULL,
 *     level         text        NOT NULL,
 *     part_of_speech text,
 *     enriched      boolean     NOT NULL DEFAULT false,
 *     created_at    timestamptz DEFAULT now(),
 *     UNIQUE (word, language)
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS user_seed_progress (
 *     id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 *     seed_id    uuid        NOT NULL REFERENCES word_seeds(id)  ON DELETE CASCADE,
 *     seen_at    timestamptz DEFAULT now(),
 *     UNIQUE (user_id, seed_id)
 *   );
 *
 *   ALTER TABLE word_seeds ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "public read word_seeds"
 *     ON word_seeds FOR SELECT USING (true);
 *   CREATE POLICY "authenticated insert word_seeds"
 *     ON word_seeds FOR INSERT WITH CHECK (auth.role() = 'authenticated');
 *   CREATE POLICY "authenticated update enriched"
 *     ON word_seeds FOR UPDATE
 *     USING (auth.role() = 'authenticated')
 *     WITH CHECK (true);
 *
 *   ALTER TABLE user_seed_progress ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "users manage own progress"
 *     ON user_seed_progress FOR ALL USING (auth.uid() = user_id);
 *
 * To add a new language: create a new seed JSON file and import it here.
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (works without --env-file flag)
try {
  const envContent = readFileSync(join(__dirname, '../../.env'), 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on environment already being set
}

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('ERROR: Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  console.error('These must be set in .env or in the environment.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// ── Seed files to insert — add new language files here ────────────────────────
const SEED_FILES = [
  { file: join(__dirname, 'es-seeds.json'), label: 'es-seeds.json' },
];

async function insertFile(filePath, label) {
  let seeds;
  try {
    seeds = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`  Could not read ${label}:`, err.message);
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  console.log(`  ${label}: ${seeds.length} words`);

  const BATCH = 100;
  let inserted = 0;
  let skipped  = 0;
  let errors   = 0;

  for (let i = 0; i < seeds.length; i += BATCH) {
    const batch = seeds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('word_seeds')
      .upsert(batch, { onConflict: 'word,language', ignoreDuplicates: true })
      .select('id');

    if (error) {
      console.error(`  Batch ${Math.floor(i / BATCH) + 1} error:`, error.message);
      errors += batch.length;
      continue;
    }

    const batchInserted = data?.length ?? 0;
    const batchSkipped  = batch.length - batchInserted;
    inserted += batchInserted;
    skipped  += batchSkipped;
    console.log(
      `  Batch ${Math.floor(i / BATCH) + 1}: ${batchInserted} inserted, ${batchSkipped} skipped`
    );
  }

  return { inserted, skipped, errors };
}

async function main() {
  console.log('=== insert-seeds ===\n');

  let totalInserted = 0;
  let totalSkipped  = 0;
  let totalErrors   = 0;

  for (const { file, label } of SEED_FILES) {
    const result = await insertFile(file, label);
    totalInserted += result.inserted;
    totalSkipped  += result.skipped;
    totalErrors   += result.errors;
  }

  console.log('\n=== Summary ===');
  console.log(`Inserted : ${totalInserted}`);
  console.log(`Skipped  : ${totalSkipped}  (already existed)`);
  if (totalErrors > 0) console.log(`Errors   : ${totalErrors}`);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
