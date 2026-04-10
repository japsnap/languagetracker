/**
 * Diagnostic script — finds duplicate vocabulary entries per user.
 * Reports only — does NOT delete anything.
 *
 * Run from the spanishapp directory:
 *   node --env-file=.env scripts/find-duplicates.js
 *
 * Requires in .env:
 *   VITE_SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...  (bypasses RLS to see all users' rows)
 *
 * Find the service role key in: Supabase Dashboard → Settings → API → service_role secret.
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

async function run() {
  const { data: words, error } = await supabase
    .from('vocabulary')
    .select('id, word, user_id, meaning, date_added')
    .order('user_id')
    .order('word');

  if (error) { console.error('Failed to fetch vocabulary:', error.message); process.exit(1); }
  console.log(`Fetched ${words.length} total vocabulary rows.\n`);

  // Group by user_id + normalised word (case-insensitive, trimmed)
  const groups = {};
  for (const row of words) {
    const key = `${row.user_id}::${row.word.toLowerCase().trim()}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  const dupes = Object.values(groups).filter(g => g.length > 1);

  if (dupes.length === 0) {
    console.log('No duplicates found.');
    return;
  }

  console.log(`Found ${dupes.length} duplicate group(s):\n`);
  for (const group of dupes) {
    console.log(`Word: "${group[0].word}"  |  User: ${group[0].user_id}`);
    for (const row of group) {
      console.log(`  id=${row.id}  date_added=${row.date_added}  meaning="${row.meaning}"`);
    }
    console.log();
  }

  console.log(`Total duplicate rows (beyond first in each group): ${dupes.reduce((s, g) => s + g.length - 1, 0)}`);
  console.log('No changes were made. Review the above and delete unwanted rows manually in Supabase.');
}

run();
