/**
 * One-time seed script — imports vocabulary.json into Supabase.
 *
 * Run from the spanishapp directory:
 *   node --env-file=.env scripts/seed-supabase.js
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in environment.');
  console.error('Run with: node --env-file=.env scripts/seed-supabase.js');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const words = JSON.parse(
  readFileSync(join(__dirname, '../src/data/vocabulary.json'), 'utf8')
);

const BATCH_SIZE = 100;

async function seed() {
  console.log(`Seeding ${words.length} words in batches of ${BATCH_SIZE}…`);

  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('vocabulary').insert(batch);
    if (error) {
      console.error(`Batch ${i}–${i + batch.length} failed:`, error.message);
      process.exit(1);
    }
    console.log(`  ✓ inserted rows ${i + 1}–${i + batch.length}`);
  }

  console.log('Done. Updating sequence…');

  // Reset the auto-increment sequence to continue from the max existing ID.
  const { error: seqError } = await supabase.rpc('reset_vocabulary_sequence');
  if (seqError) {
    console.warn('Could not reset sequence automatically:', seqError.message);
    console.warn('Run this SQL manually in the Supabase SQL editor:');
    console.warn("  SELECT setval(pg_get_serial_sequence('vocabulary','id'), (SELECT MAX(id) FROM vocabulary));");
  } else {
    console.log('Sequence reset. All done!');
  }
}

seed();
