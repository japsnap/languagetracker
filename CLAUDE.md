# LanguageTracker

## Project Overview
Multilingual vocabulary learning app with FSRS spaced-repetition scheduling, AI-powered word lookup, multi-language support, and polyglot vocabulary saves. React (Vite) + Supabase + Anthropic API + Vercel.

## Tech Stack
- Frontend: React 19, Vite 8, CSS Modules, Recharts
- Backend: Supabase (PostgreSQL, Auth, RLS, Storage), Vercel serverless functions
- AI: Anthropic Claude claude-sonnet-4-20250514 (word lookup, insights)
- TTS: Google Cloud TTS (es/pt/it/hi/ur) + Web Speech API (en/ja/de/fr/ko/zh)
- FSRS: ts-fsrs 5.3.2 (spaced repetition scheduling)
- Auth: Google OAuth via Supabase Auth
- PWA: Web App Manifest + service worker

## Architecture
- All user data filtered by user_id via Supabase RLS
- API calls proxied through Vercel serverless functions — API keys never reach the browser
- Lazy-loaded tab components (Input, Review, Quiz, Stats, Settings, Admin)
- Three-role language system: input_language / learning_language / primary_language
- word_cache table: shared across users; keyed on (input_word, input_language, learning_language, primary_language, mode)
- Event logging via src/utils/events.js → user_events table (fire-and-forget)
- User preferences in user_preferences table

## Coding Rules
- Structure all changes so features can be added later without rewriting
- CSS Modules for all component styling; global tokens in global.css
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
- Auth: Google OAuth via Supabase; no password gate
- Tabs: Input, Review, Quiz, Stats, Settings, Admin (owner-only, `wikipanna@gmail.com`)

### Languages
- 11 supported: EN ES JA DE KO ZH UR HI PT FR IT
- Three-role system: input_language (user types), learning_language (word/example/related_words), primary_language (meaning/pos/notes)
- User preferences (`user_preferences`): primary_language, learning_language, secondary_languages (jsonb), timezone, desired_retention, fsrs_weights (jsonb), daily_review_goal
- Secondary language mini-cards shown alongside main card on Input page; each card has a Save button for polyglot vocabulary saves

### Vocabulary Table Schema (key columns)
- `word`, `meaning`, `part_of_speech`, `example`, `recommended_level`, `related_words`, `other_useful_notes`
- `romanization`, `kana_reading` — populated for JA/KO/ZH/UR/HI scripts
- `word_language` — language code per word (saved on every add)
- `word_type` — 'word' | 'phrase' | 'idiom'
- `base_form` — infinitive/canonical form (verbs); null otherwise
- `meanings_array` (jsonb) — up to 4 primary-language meanings
- `word_alternatives` (jsonb) — up to 3 synonyms in learning language; used in Hard quiz matching
- `tags` (jsonb) — array of tag keys (e.g. `['difficult', 'priority']`); see `src/utils/tags.js`; `'polyglot'` is system-assigned on secondary-language saves
- `lookup_session_id` (uuid) — groups all vocabulary rows added in a single Input lookup; shared between primary auto-save and any secondary saves from the same session
- `starred`, `mastered`, `total_attempts`, `correct_streak`, `error_counter`, `last_reviewed`, `date_added`

### Word Cache
- `word_cache` table: shared cross-user cache for all AI responses
- Key: `(input_word, input_language, learning_language, primary_language, mode)`
- UNIQUE constraint: `word_cache_three_role_key`
- Modes: `single` (primary and secondary lookups), `multi` (multiple meanings), `explore` (random word), `insights` (stored as `ai_insights` JSONB column on the `single` row — not a separate row)
- `result_word` stored (AI-corrected spelling); lookup matches on result_word OR input_word
- `audio_urls` (jsonb) — Supabase Storage public URLs for TTS audio, keyed by language code
- Old `mode='secondary'` rows are inert; secondary lookups now write under `mode='single'`
- Cache hits/misses logged to `user_events`

### Event Logging
- `user_events` table: `word_lookup` (cache_hit, quiz_mode), `word_added`, `quiz_answer` (quiz_mode: 'easy'|'hard'), `csv_export`
- All fire-and-forget via `src/utils/events.js`

### AI / API
- `api/anthropic.js`: server-side only; client sends `{ word, input_language, learning_language, primary_language, mode }` — no prompt control from client
- Accepted modes: `single`, `multi`, `explore`, `insights`
- `buildPrimaryPrompt(inputLang, learningLang, primaryLang, mode)`:
  - Returns: `word`, `word_type`, `word_alternatives[]`, `part_of_speech`, `base_form`, `meaning`, `meanings_array[]`, `example`, `recommended_level`, `related_words`, `other_useful_notes`, `romanization`/`kana_reading` (non-Latin only)
  - Also returns `meaning_native` (one-sentence gloss in learning language) when `learningLang !== primaryLang`; used by secondary mini-cards
- `buildExplorePrompt`: generates a random word at a given level/type
- `buildInsightsPrompt`: enrichment data — etymology, register, collocations, cultural note
- `MAX_TOKENS`: `{ single: 700, multi: 2000, explore: 700, insights: 600 }`
- `api/admin-stats.js`: GET-only, admin-gated (403 for non-admin), uses `SUPABASE_SERVICE_ROLE_KEY`

### Text-to-Speech
- `api/tts.js`: POST `{ word, languageCode }`, auth-gated; proxies to Google Cloud TTS; returns `{ audioContent: base64 }`
- TTS routing (in `src/utils/speak.js`): Google Cloud for es/pt/it/hi/ur; Web Speech API for en/ja/de/fr/ko/zh; configurable via `TTS_PROVIDER` map
- Three-tier audio cache: (1) in-memory base64 (session), (2) in-memory URL (session), (3) `word_cache.audio_urls` (persistent)
- `api/audio-upload.js`: POST `{ word, languageCode, audioBase64 }`, auth-gated; uploads to Supabase Storage `audio` bucket; updates `word_cache.audio_urls` (read-merge-write)
- Audio filename: diacritics stripped, lowercased, non-alphanumeric → underscore (e.g. `confrontación` → `es/confrontacion.mp3`)

### Quiz
- Easy mode: recognition; self-assess 🎯 ✅ ❌ 🤷 (🎯 = FSRS 'easy' grade, counts as correct for legacy streak)
- Hard mode: typed production; accepts `word` OR any `word_alternatives` entry (Levenshtein ≤ 1 for words > 3 chars; see `.claude/rules/quiz-answer-matching.md`)
- FSRS queue toggle (Due / All / New) — session-only; not persisted
  - **Due**: state IN ('review','relearning') AND due_at ≤ now() only
  - **All**: full FSRS priority order (default)
  - **New**: untouched words (state='new', review_count=0) up to daily_review_goal
- Due-today badge: red pill in nav + queue button; live decrement on answer
- FSRS card selection (`pickNextFsrs`): 0-attempt new → due learning → due relearning → remaining new → due review → earliest not-yet-due
- Grade inference: Easy mode = tap icon → grade string; Hard mode = isCorrect + responseTimeMs + wordLength (thresholds scale linearly with word length)
- On every answer: upserts `word_reviews_state`, inserts `review_log`, updates `sessions` on unmount/inactivity — all fire-and-forget
- Go-back reverts FSRS write (deletes review_log row, restores/deletes word_reviews_state) and legacy field changes
- Revealed card shows full content: word, answer comparison (Hard), meaning, example, related_words, notes
- Enter key advances to next word (deferred via `setTimeout(0)`)
- Language filter chips when vocabulary spans multiple languages
- TagBar in revealed section — local state reset on word.id change; persists via onUpdateWord
- "Mark as mastered" one-way button in revealed section; use Review to untoggle
- Hard mode collision hint: `lookupCollision()` checks word_cache (result_word) then word_seeds fire-and-forget; shows `"X is a valid word — which means Y"`

### Review
- Alphabet quick-scroll strip on A→Z / Z→A sorts; active letter tracking
- Filter chips: language, level (A1–C2), scene, word-type (Word/Phrase/Idiom), starred
- Sort options: date-newest, date-oldest, A→Z, Z→A, always-wrong (error_counter > 0), recent-mistakes (last quiz_answer = wrong), reviewed-longest-ago
- Bulk-select mode for multi-word operations (bulk scene tag)
- TagBar in expanded word row — saved immediately to vocabulary.tags via onUpdateWord
- Tag filter chip row in toolbar — OR logic; visible when ≥1 word is tagged
- Romanization inline in word row (always visible, not just expanded): `kana_reading` shown first; `romanization` shown only if no `kana_reading`

### Stats
- Mode toggle (Easy / Hard, default Easy) at page top; all FSRS metrics re-query on toggle
- **Tier 1 cards**: Total Words, In Review (state='review'), Learning (state IN ('learning','relearning')), Untouched (no FSRS row or state='new' AND review_count=0), Due Today (due_at < tomorrow midnight local)
- **Tier 2 cards**: Comfortable (stability ≥ 21d), Avg Stability, Reviews Today, Accuracy Today (grade != 'again' / total; green ≥70% / red <70%)
- **FSRS charts**: State Distribution (bar), Stability Histogram (bins: <1d, 1–7d, 7–30d, 30–90d, 90d+), Reviews per Day (last 30 days)
- **Legacy charts**: Words by Level, Vocabulary Over Time (cumulative), Hardest Words, Most Reviewed
- Quiz Performance by Mode section (from user_events)
- Timezone-aware: today midnight derived from user_preferences.timezone via Intl API

### Input Page
- Language selector: input language chips (all role langs); learning/primary info row with Settings link
- `handleLookup`: generates `lookup_session_id = crypto.randomUUID()` per lookup; resets on resetLookupState
- Auto-save on lookup (`AUTO_SAVE_ENABLED` constant, default true): inserts primary vocabulary row including `lookup_session_id`; shows "Saved automatically ✓" + 5s undo
- Search box clears and refocuses after successful lookup
- "See more" triggers multi-mode for up to 3 candidate cards
- Secondary mini-cards (one per secondary language from preferences):
  - Full vocabulary card via converged primary path (`lookupSecondary` → `lookupWordSingle`, mode='single')
  - Shows: word, level chip, word_alternatives chips, meaning, meaning_native (when ≠ meaning), example; expandable extras
  - **Save button**: creates vocabulary row with `tags=['polyglot']` and same `lookup_session_id` as primary save
  - Save blocked when: secondary lang = primary lang; word already in vocab for that language; card still loading
  - Pre-populates "Saved ✓" if word exists in vocab from a previous session
  - 5s undo window after save

### Explore Mode
- Seeded languages (word_seeds rows exist): picks unseen seed per user+level; serves from cache if enriched=true; else calls AI (mode='single', word=seed.word); saves to cache; sets enriched=true via api/seed-update
- Unseeded languages: random cache / AI fallback (mode='explore')
- Exhausted state: "Level complete" + reset progress + next-level button
- SpeakerButton on both card faces
- Cache recycling: every Input page mode='single' AI call fires add_seed to word_seeds (fire-and-forget)
- `api/seed-update.js`: actions: enrich (PATCH by seedId, sets enriched=true + corrects level), add_seed (upsert by word+language); auth-gated, service-role key; called fire-and-forget
- Mode invariant: seeded path always uses mode='single' (specific word). Unseeded always uses mode='explore' (random generation). Never swap.

### Word Tags
- Config: `src/utils/tags.js` — `WORD_TAGS` array (6 user-selectable tags: difficult/priority/review/confusing/fun/practical). To add a tag: one entry here only.
- `'polyglot'` is a system-assigned tag (not in WORD_TAGS); added automatically to secondary-language saves
- Component: `src/components/TagBar/TagBar.jsx` — props: `tags`, `onChange`, `size ('sm'|'md')`
- Stored in `vocabulary.tags` jsonb array
- Shown in: Review (expanded row), Quiz (revealed section), Input (preview card after save)

### PWA
- Manifest: `public/manifest.json` (name "LanguageTracker", standalone, black theme, 192×512 icons)
- Service worker: `public/sw.js` (cache-first for static assets; network-only for /api/*, Supabase, Google TTS)
- SW registration in `src/main.jsx` on load; production only
- Install prompt on mobile (touch devices, `beforeinstallprompt`); dismissal in localStorage

### FSRS Tables (authoritative column lists — do not send fields not listed here)

`sessions`: id, user_id, device, started_at, ended_at, review_count, correct_count, avg_response_ms, created_at
- No `mode` column; join review_log ON session_id for per-mode breakdown

`review_log`: id, user_id, word_id, mode, session_id, session_position, grade, response_time_ms, is_correct, state_before, stability_before, difficulty_before, state_after, stability_after, difficulty_after, elapsed_days, device, input_method, interference_word_id, local_hour, day_of_week, reviewed_at, created_at
- No `due_before` / `due_after` columns — due timestamps live in `word_reviews_state.due_at` only
- `day_of_week` is SMALLINT: send integer 0–6 (0=Sunday), not a string

`word_reviews_state`: id, user_id, word_id, mode, state, stability, difficulty, due_at, last_review_at, review_count, lapse_count, updated_at, created_at

`interference_events`: id, user_id, target_word_id, typed_text, matched_word, matched_language, interference_type, session_id, created_at

## Serverless Functions (api/)
- `api/anthropic.js` — AI word lookup proxy; modes: single, multi, explore, insights; auth-gated (401)
- `api/admin-stats.js` — cross-user vocabulary count; admin-gated (403); service-role key
- `api/tts.js` — Google Cloud TTS proxy; POST `{ word, languageCode }`; returns `{ audioContent: base64 }`; auth-gated
- `api/audio-upload.js` — uploads TTS audio to Supabase Storage `audio` bucket; updates `word_cache.audio_urls`; auth-gated; service-role key
- `api/seed-update.js` — word_seeds writes (enrich + add_seed); auth-gated; service-role key; fire-and-forget

## One-time Scripts (scripts/)
- `migrations/001_word_cache_three_role.sql` — UNIQUE constraint on word_cache (already run)
- `backfill-word-language.js` — tags existing vocab rows with word_language (already run)
- `find-duplicates.js` — duplicate detection; read-only; needs SUPABASE_SERVICE_ROLE_KEY
- `seed-supabase.js` — original data seed (already run)
- `seeds/insert-seeds.js` — inserts word_seeds rows from JSON seed files; run once per language

## Completed Schema Changes
All of these have been applied in Supabase SQL Editor:
- `vocabulary`: added word_type, base_form, meanings_array, word_alternatives, tags, word_language, romanization, kana_reading, lookup_session_id; index on lookup_session_id
- `word_cache`: added audio_urls jsonb; dropped direction column
- FSRS tables created: word_reviews_state, sessions, review_log, interference_events
- user_preferences extended with: timezone, desired_retention, fsrs_weights, daily_review_goal
- word_seeds and user_seed_progress tables created with RLS policies

## Known v1.5 Items
- Hard mode response time should start at input focus, not question display
- `handleChangeAnswer` should re-grade FSRS state with the new answer type
- FSRS desired_retention / fsrs_weights / timezone settings UI not yet in SettingsPage
- daily_review_goal tracking not yet implemented
- `quiz.js` `wordWeight()` reads `last_reviewed` — replace with `word_reviews_state.due_at` once FSRS is source of truth for all users

==================================================
SYSTEM INVARIANTS (DO NOT OVERRIDE)
==================================================

**Language roles**
- Three roles only: input_language, learning_language, primary_language
- No direction-based logic anywhere

**Cache system**
- word_cache is the PRIMARY shared knowledge layer (cross-user)
- vocabulary is USER-SCOPED (RLS-protected per user)
- Cache must be checked before any AI call
- Cache is correction-aware: input_word may differ from result_word
- Lookup matches on result_word OR input_word

**Learning philosophy**
- Hard mode (typed production) drives FSRS state and learning
- Easy mode (recognition) is auxiliary only
- Optimize for recall, not lookup convenience

**Data integrity**
- No silent DB failures — use console.error on catch, never swallow errors
- Cache writes use .select() to confirm success
- Mismatched cache keys are critical bugs

**Feature constraint**
- New features must improve the recall loop or long-term retention

**Mode semantics**
- mode='single': look up a specific known word → buildPrimaryPrompt
- mode='multi': same prompt, returns array of up to 3 meanings
- mode='explore': generate a random word at a level → buildExplorePrompt
- mode='insights': enrichment for a saved word → buildInsightsPrompt
- Secondary lookups use mode='single' with swapped language roles — not a separate mode
- Seeded explore path always uses mode='single' (word=seed.word). Unseeded always uses mode='explore'. Never swap.

@CHANGELOG.md
