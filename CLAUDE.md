# LanguageTracker

## Project Overview
Multilingual vocabulary learning app. React (Vite) + Supabase + Anthropic API + Vercel.

## Tech Stack
- Frontend: React with Vite, CSS Modules, Recharts
- Backend: Supabase (auth, database, RLS), Vercel serverless functions
- AI: Anthropic Claude API (word lookup)
- Auth: Google OAuth via Supabase Auth

## Architecture
- All user data filtered by user_id via Supabase RLS
- API calls proxied through /api/anthropic.js (Vercel serverless)
- Lazy-loaded tab components (Input, Review, Quiz, Stats, Settings, Admin)
- Three-role language system: input_language / learning_language / primary_language
- Word cache in Supabase (word_cache table) keyed on all three language roles + mode
- Event logging via src/utils/events.js → user_events table (fire-and-forget)
- User preferences in user_preferences table (primary, learning, secondary languages)

## Coding Rules
- Structure all changes so features can be added later without rewriting
- CSS Modules for all component styling, global tokens in global.css
- Match existing design language: Nunito font, minimal grey/black/white
- Never expose API keys in client-side code

## Commands
- Dev server: npm run dev
- Build: npm run build
- Deploy: git push to main (Vercel auto-deploys)

## Security
- NEVER read, access, cat, echo, or reference .env files
- NEVER log or display environment variable values
- API keys are in Vercel env vars and .env (gitignored)

## Current State

### Auth & Tabs
- Auth: Google OAuth via Supabase, password gate removed
- Tabs: Input, Review, Quiz, Stats, Settings, Admin (owner-only, `wikipanna@gmail.com`)

### Languages
- 11 supported languages: EN ES JA DE KO ZH UR HI PT FR IT
- Three-role language system: input_language (what user types), learning_language (word/example/related_words), primary_language (meaning/pos/notes)
- User preferences table (`user_preferences`): primary_language, learning_language, secondary_languages
- Secondary language mini-cards shown alongside main card on Input page

### Vocabulary Table Schema (key columns)
- `word`, `meaning`, `part_of_speech`, `example`, `recommended_level`, `related_words`, `other_useful_notes`
- `romanization`, `kana_reading` — populated for JA/KO/ZH/UR/HI scripts
- `word_language` — language code tag per word (backfill script + saved on every add)
- `meanings_array` (jsonb) — up to 4 primary-language meanings as array
- `word_alternatives` (jsonb) — up to 3 learning-language synonyms as array; used in Hard quiz matching
- `starred`, `mastered`, `total_attempts`, `correct_streak`, `error_counter`, `last_reviewed`, `date_added`

### Word Cache
- `word_cache` table: caches all API responses by `(input_word, input_language, learning_language, primary_language, mode)`
- UNIQUE constraint: `word_cache_three_role_key` — created via `scripts/migrations/001_word_cache_three_role.sql` (already run)
- Modes: `single`, `multi`, `secondary`
- Cache hits/misses logged to `user_events`

### Event Logging
- `user_events` table: `word_lookup` (with `cache_hit`, `quiz_mode`), `word_added`, `quiz_answer` (with `quiz_mode: 'easy'|'hard'`), `csv_export`
- All fire-and-forget via `src/utils/events.js`

### AI / API
- `api/anthropic.js`: server-side only, builds prompts, proxies to Anthropic. Client sends `{ word, input_language, learning_language, primary_language, mode }` — no prompt control from client
- Prompt returns: `word`, `word_alternatives[]`, `part_of_speech`, `meaning`, `meanings_array[]`, `example`, `recommended_level`, `related_words`, `other_useful_notes`, `romanization`/`kana_reading` (non-Latin only)
- Meanings comma-separated in `meaning` field; `meanings_array` is the structured version
- `MAX_TOKENS`: single=600, multi=1800, secondary=300
- `api/admin-stats.js`: GET-only, admin-gated (403 for non-admin), uses `SUPABASE_SERVICE_ROLE_KEY` to count vocabulary rows across all users bypassing RLS

### Quiz
- Easy mode: recognition, self-assess with ✅ ❌ 🤷
- Hard mode: typed production; user types the word from the meaning prompt; accepts `word` field OR any `word_alternatives` entry (Levenshtein ≤ 1 leniency for words > 3 chars)
- Revealed card always shows full content in both modes: correct word, answer comparison (Hard), meaning, example, related_words, notes
- Enter key on revealed card advances to next word (deferred via `setTimeout(0)`)
- Go-back one word: ← Previous button; undoes DB stats if already answered; restores session counts
- 0-attempt words shown first before weighted selection
- Language filter chips when vocabulary spans multiple languages

### Review
- Alphabet quick-scroll strip on A→Z / Z→A sorts; active letter tracking; hover popup
- Language filter chips when vocabulary spans multiple languages
- Bulk-select mode for multi-word operations

### Stats
- "Quiz Performance by Mode" section: Easy and Hard cards side-by-side (stacked mobile), fetched from `user_events` per user
- Standard charts: Words by Level, Vocabulary Over Time (cumulative), Hardest Words, Most Reviewed

### UI
- translate="no" on all word-content containers (Input, Quiz, Review, Stats)
- Production sourcemaps disabled

## Serverless Functions (api/)
- `api/anthropic.js` — AI word lookup proxy, auth-gated (401 for unauthenticated)
- `api/admin-stats.js` — cross-user vocabulary count, admin-gated (403 for non-admin)
- `api/seed-update.js` — word_seeds writes (enrich + add_seed), auth-gated, service-role key; called fire-and-forget from explore.js and anthropic.js

> **Note:** Option C (nightly cron for seed recycling) flagged for future security upgrade — applies to any server-side fire-and-forget write pattern in the app.

## One-time Scripts (scripts/)
- `migrations/001_word_cache_three_role.sql` — adds UNIQUE constraint to word_cache (already run)
- `backfill-word-language.js` — tags existing vocab rows with word_language (already run; needs SUPABASE_SERVICE_ROLE_KEY)
- `find-duplicates.js` — reports duplicate words per user, read-only (needs SUPABASE_SERVICE_ROLE_KEY)
- `seed-supabase.js` — original data seed (already run)

## Pending DB Migration
- `ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS word_alternatives jsonb;` — needed for word_alternatives field (run in Supabase SQL Editor if not done)

@CHANGELOG.md
