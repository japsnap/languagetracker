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
- Never paste full SQL into CHANGELOG — reference migrations by date and table list only

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
- User preferences table (`user_preferences`): primary_language, learning_language, secondary_languages, timezone, desired_retention, fsrs_weights, daily_review_goal
- Secondary language mini-cards shown alongside main card on Input page

### Vocabulary Table Schema (key columns)
- `word`, `meaning`, `part_of_speech`, `example`, `recommended_level`, `related_words`, `other_useful_notes`
- `romanization`, `kana_reading` — populated for JA/KO/ZH/UR/HI scripts
- `word_language` — language code tag per word (backfill script + saved on every add)
- `meanings_array` (jsonb) — up to 4 primary-language meanings as array
- `word_alternatives` (jsonb) — up to 3 learning-language synonyms as array; used in Hard quiz matching
- `tags` (jsonb) — array of tag keys (e.g. `['difficult', 'priority']`); see `src/utils/tags.js` for config
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
- Easy mode: recognition, self-assess with 🎯 ✅ ❌ 🤷 (🎯 = FSRS 'easy' grade, counts as correct for legacy streak)
- Hard mode: typed production; user types the word from the meaning prompt; accepts `word` field OR any `word_alternatives` entry (Levenshtein ≤ 1 leniency for words > 3 chars)
- Revealed card always shows full content in both modes: correct word, answer comparison (Hard), meaning, example, related_words, notes
- Enter key on revealed card advances to next word (deferred via `setTimeout(0)`)
- Go-back one word: ← Previous button; undoes DB stats if already answered; restores session counts; reverts FSRS writes
- FSRS card selection (`pickNextFsrs`): 0-attempt new → due learning → due relearning → remaining new → due review → earliest not-yet-due
- On every answer: upserts `word_reviews_state`, inserts `review_log` row, updates `sessions` on unmount/inactivity — all fire-and-forget
- Language filter chips when vocabulary spans multiple languages
- TagBar in revealed section (small size) — tags use local state reset on word.id change; persist via onUpdateWord
- "Mark as mastered" button in revealed section — one-way, local state pattern; use Review to untoggle
- Hard mode wrong-answer collision hint: fire-and-forget `lookupCollision()` checks word_cache (result_word) then word_seeds; shows `"X is a valid word — which means Y"` if typed input matches a different valid word (no AI call; see `.claude/rules/quiz-answer-matching.md`)

### Review
- Alphabet quick-scroll strip on A→Z / Z→A sorts; active letter tracking; hover popup
- Language filter chips when vocabulary spans multiple languages
- Bulk-select mode for multi-word operations
- TagBar in expanded word row (detail grid) — tags saved immediately to vocabulary.tags via onUpdateWord
- Tag filter chip row in toolbar — visible only when ≥1 word is tagged; OR logic; second filter layer over existing filterAndSort result

### Stats
- "Quiz Performance by Mode" section: Easy and Hard cards side-by-side (stacked mobile), fetched from `user_events` per user
- Standard charts: Words by Level, Vocabulary Over Time (cumulative), Hardest Words, Most Reviewed

### UI
- translate="no" on all word-content containers (Input, Quiz, Review, Stats)
- Production sourcemaps disabled

### Word Tags
- Config: `src/utils/tags.js` — `WORD_TAGS` array (6 tags: difficult/priority/review/confusing/fun/practical). To add a tag: one entry here only.
- Component: `src/components/TagBar/TagBar.jsx` — props: `tags`, `onChange`, `size ('sm'|'md')`
- Stored in `vocabulary.tags` jsonb array
- Shown in: Review (expanded row), Quiz (revealed section), Input (preview card after auto-save)
- Input page requires `onUpdateWord` prop (threaded from App.jsx via `updateWord`)

### Explore Mode
- Seeded languages (word_seeds rows exist): tracks per-user progress via user_seed_progress; exhausted level shows reset + next-level options
- Unseeded languages: random cache / AI fallback (original behaviour)
- SpeakerButton on both card faces (front: wordBigRow wrapper; back: wordSmallRow wrapper)
- `src/utils/explore.js` — seeded cache-miss path uses `mode='single'` + `word=seed.word` (invariant: never swap to mode='explore')
- `api/seed-update.js` — enrich (PATCH by seedId) + add_seed (upsert by word+language); called fire-and-forget

### FSRS Tables (authoritative column lists — do not send fields not listed here)

`sessions`: id, user_id, device, started_at, ended_at, review_count, correct_count, avg_response_ms, created_at
- No `mode` column — sessions are mode-agnostic; join `review_log ON session_id` for per-mode breakdown

`review_log`: id, user_id, word_id, mode, session_id, session_position, grade, response_time_ms, is_correct, state_before, stability_before, difficulty_before, state_after, stability_after, difficulty_after, elapsed_days, device, input_method, interference_word_id, local_hour, day_of_week, reviewed_at, created_at
- No `due_before` / `due_after` columns — due timestamps live in `word_reviews_state.due_at` only
- `day_of_week` is SMALLINT: send integer 0–6 (0=Sunday), not a string

`word_reviews_state`: id, user_id, word_id, mode, state, stability, difficulty, due_at, last_review_at, review_count, lapse_count, updated_at, created_at

`interference_events`: id, user_id, target_word_id, typed_text, matched_word, matched_language, interference_type, session_id, created_at

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
