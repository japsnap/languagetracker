# Changelog

  ==================================================
  LAYER 1 — SYSTEM TRUTH (DO NOT OVERRIDE)
  ==================================================

  These are invariant system rules. All implementations must comply.

  1. Language Model
  - System uses THREE roles:
    input_language
    learning_language
    primary_language
  - No direction-based logic allowed anywhere

  2. Cache System
  - word_cache is the PRIMARY shared knowledge layer
  - vocabulary is USER-SCOPED layer
  - Cache must always be checked before AI calls
  - Cache must be correction-aware (input_word != result_word)

  3. Learning Philosophy
  - Hard mode (production) drives learning
  - Easy mode (recognition) is auxiliary only
  - System optimizes for recall, NOT lookup

  4. Data Integrity
  - No silent failures allowed (all DB ops must be verifiable)
  - Cache writes must be confirmed
  - Mismatched keys are considered critical bugs

  5. Feature Constraint
  - No feature expansion allowed unless it improves:
    recall loop OR retention


  ==================================================
  LAYER 2 — CURRENT SYSTEM STATE (AUTHORITATIVE)
  ==================================================

  ### Core Architecture

  - Three-role language system fully implemented
  - All API, cache, and UI flows aligned

  ### Cache System (FINAL FORM)

  Key:
  (input_word, input_language, learning_language, primary_language, mode)

  Enhancements:
  - result_word stored (AI-corrected output)
  - lookup uses (result_word OR input_word)
  - prevents cache miss on corrected entries

  Write logic:
  - UPDATE only for extras (no duplicate rows)
  - .select() used to confirm write success

  Read priority:
  1. word_cache
  2. vocabulary
  3. AI

  Backfill:
  - vocabulary → cache on access

  ### AI Insights

  - Stored as JSONB on mode='single' row
  - Never separate rows
  - Lazy-loaded + persisted
  - Cache-first retrieval

  ### Quiz System

  Modes:
  - Easy → recognition (no state progression)
  - Hard → production (state driver)

  Answer logic:
  - Levenshtein ≤1 (words >3 chars)
  - Exact match for short words
  - Leading articles stripped

  Flow:
  - 0-attempt words prioritized
  - weighted selection by error_counter / correct_streak
  - go-back restores full state

  ### Language System

  - word_language stored per entry
  - used for filtering and UI display
  - backfilled via script

  ### Secondary Language System

  - Uses ORIGINAL input word (not transformed)
  - Returns:
    meaning_brief (primary language)
    meaning_native (target language)

  - Cache key includes:
    sourceLang, targetLang, meaningLang

  - Expandable UI with no extra API calls

  ### Explore Mode

  - Cache-first word generation
  - AI fallback with immediate cache write
  - No session deduplication — purely random selection from cache pool

  ### Vocabulary Schema

  Includes:
  - word_type (word / phrase / idiom)
  - base_form
  - meanings_array
  - word_alternatives

  Central mapping via aiResultToWordFields()

  ### Event Logging

  Tracked:
  - word_lookup (cache_hit)
  - word_added
  - quiz_answer (mode)
  - csv_export

  Purpose:
  → future retention + funnel analysis


  ==================================================
  LAYER 3 — CHANGE HISTORY (COMPRESSED)
  ==================================================

  ## 04-09 → 04-12 (CONSOLIDATED)

  ### Cache System Stabilization
  - Fixed mismatch between input_word and result_word
  - Introduced result_word column
  - Unified lookup logic across read/write paths
  - Eliminated silent UPDATE failures via WHERE alignment
  - Enforced cache-first read hierarchy

  ### AI Insights Integration
  - Removed separate insights mode rows
  - Consolidated into JSONB column on existing cache row
  - Implemented lazy fetch + persistent storage
  - Enabled cross-user reuse via cache

  ### Quiz System Refinement
  - Formalized Easy vs Hard roles
  - Implemented Levenshtein tolerance + article stripping
  - Fixed reveal UX issues
  - Added go-back and improved navigation flow

  ### Secondary Language System Fixes
  - Corrected source word handling
  - Added dual-meaning display
  - Unified prompt + cache logic
  - Removed redundant API calls via expandable UI

  ### Data Model Expansion
  - Added word_type, base_form
  - Added meanings_array, word_alternatives
  - Centralized transformation logic

  ### System Integrity Fixes
  - Removed silent DB failures
  - Added explicit error logging
  - Fixed cache write false positives
  - Ensured all critical operations verifiable

  ==================================================


## 2026-04-23 (seeded explore mode)

### SQL migration — run once in Supabase SQL Editor
```sql
CREATE TABLE IF NOT EXISTS word_seeds (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  word           text        NOT NULL,
  language       text        NOT NULL,
  level          text        NOT NULL,
  part_of_speech text,
  enriched       boolean     NOT NULL DEFAULT false,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (word, language)
);
CREATE TABLE IF NOT EXISTS user_seed_progress (
  id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seed_id  uuid        NOT NULL REFERENCES word_seeds(id)  ON DELETE CASCADE,
  seen_at  timestamptz DEFAULT now(),
  UNIQUE (user_id, seed_id)
);
ALTER TABLE word_seeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read word_seeds" ON word_seeds FOR SELECT USING (true);
CREATE POLICY "authenticated insert word_seeds" ON word_seeds FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "authenticated update enriched" ON word_seeds FOR UPDATE USING (auth.role() = 'authenticated') WITH CHECK (true);
ALTER TABLE user_seed_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own progress" ON user_seed_progress FOR ALL USING (auth.uid() = user_id);
```

- **word_seeds table** — 600 Spanish words (A1–C2) seeded via `scripts/seeds/es-seeds.json` + `scripts/seeds/insert-seeds.js`. To add a new language: create a seed JSON file and add it to `SEED_FILES` in `insert-seeds.js`, then run the script.
- **user_seed_progress table** — tracks which seeds each user has seen; unique on (user_id, seed_id).
- **Seeded explore path** (`src/utils/explore.js`) — for languages with word_seeds rows: picks a random unseen seed per user+level, marks it seen, serves from word_cache if `enriched=true`, otherwise calls AI with the specific word (mode=single), saves to cache, sets `enriched=true`. Returns `{ exhausted: true }` when all seeds for the level are seen.
- **Exhausted state** (`ExploreMode.jsx`) — new `exhausted` phase: shows "Level [X] complete" message with word count, a "Reset [X] progress" button (deletes user_seed_progress rows for that language+level via `resetSeedProgress()`), and a "Try [next level] →" button.
- **Unseeded fallback** — languages with no word_seeds rows use the original random cache / AI flow unchanged.
- **Cache recycling (Task 3)** — after any explore AI call (seeded or fallback), the returned word is auto-inserted into word_seeds with `enriched=true` (fire-and-forget, `ON CONFLICT DO NOTHING`). Builds the seed list organically from user lookups for unseeded languages.

## 2026-04-23 (seed-update endpoint + cache recycling)

- **`api/seed-update.js`** — new auth-gated serverless endpoint. POST only. Verifies Supabase JWT (same pattern as `api/anthropic.js`). Uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS for `word_seeds` writes. Two actions:
  - `enrich` — `PATCH word_seeds SET enriched=true, level=? WHERE id=?`. Used when explore mode enriches a seed via AI; corrects the level field from the AI response alongside the enriched flag.
  - `add_seed` — `INSERT … ON CONFLICT (word, language) DO UPDATE SET level, enriched=true`. Used for cache recycling; upserts any looked-up word into word_seeds.
- **FIX: explore.js seeded AI path** — after AI enriches a seed word, replaced the direct `supabase.update({ enriched: true })` call with a fire-and-forget POST to `/api/seed-update` (`action='enrich'`). The new call also sends `level: result.recommended_level` so the seed row's level is corrected to the AI-returned value, not just left at the original seed level.
- **Cache recycling via Input page** — `api/anthropic.js` now fires a seed-update (`action='add_seed'`) after every successful `mode='single'` lookup. Parses the AI response text to extract `word`, `recommended_level`, and `part_of_speech`, then POSTs to `/api/seed-update` fire-and-forget. The main lookup response is never delayed or blocked. Only `mode='single'` triggers this; `secondary`, `explore`, and `multi` do not.

## 2026-04-22 (cache.js audio_urls)

- **FIX: `audio_urls` added to `CACHE_EXTRA_JSONB_FIELDS`** — `getCachedWord` and `findCachedWordRow` now select and return `audio_urls` alongside `ai_insights` via the shared extra-JSONB mechanism. `findCachedWordRow` also has `audio_urls` listed explicitly in its `selectCols`. `getRandomCachedExploreWord` updated to include `audio_urls` in its explicit select string.

## 2026-04-20 (audio storage fixes)

- **FIX: Audio filename sanitization** — `speak.js` now uses a shared `sanitizeAudioKey()` helper that strips diacritics via NFD normalization, lowercases, and replaces non-alphanumeric characters with underscores before composing the Storage path. Example: `confrontación` → `es/confrontacion.mp3`. Consistent with `sanitizeFilename()` in `api/audio-upload.js`.
- **FIX: RLS bypass for Storage upload** — client-side upload (which failed Supabase RLS) replaced with a server-side `api/audio-upload.js` endpoint. Accepts POST `{ word, languageCode, audioBase64 }`, auth-gated (Supabase JWT), uses `SUPABASE_SERVICE_ROLE_KEY` to upload to the `audio` Storage bucket and update `word_cache.audio_urls` (read-merge-write). Returns `{ publicUrl }`. Client plays audio from the returned URL; base64 kept in memory as an in-flight fallback if upload fails.

## 2026-04-20 (PWA)

- **PWA manifest** — `public/manifest.json`: name "LanguageTracker", short name "LangTracker", standalone display, black theme, icons at 192×192 and 512×512. `<link rel="manifest">` and `<meta name="theme-color">` added to `index.html`.
- **Service worker** (`public/sw.js`) — Cache name `languagetracker-v1`. Install pre-caches app shell (`/`, manifest, icons). Activate deletes stale caches. Fetch: cache-first for static assets (JS, CSS, fonts, images); network-only (no caching) for Supabase, Anthropic, Google TTS, and `/api/*`. To bust cache: increment `CACHE_NAME` in `sw.js`.
- **SW registration** — `src/main.jsx` registers `/sw.js` on `load`. Active in production only (Vite dev server bypasses it).
- **Install prompt** — `src/components/InstallPrompt/` shows a bottom banner on touch/mobile devices when `beforeinstallprompt` fires. "Install LanguageTracker for quick access →" with Install and Dismiss buttons. Dismissal stored in `localStorage` (`pwa-install-dismissed`) — never shown again after. Hidden on desktop via `@media (pointer: fine)`.
- **Placeholder icons** — `public/icon-192.png` and `public/icon-512.png` generated by `scripts/generate-icons.cjs` (pure Node.js, no external dependencies). Dark background (#111111), white "LT" pixel-art letters. To swap real icons: replace the two PNG files in `/public` — no code changes required.

## 2026-04-20 (continued again)

- **Supabase Storage audio caching** — Google TTS playback now uses a three-tier cache: (1) in-memory base64 cache (existing, session-scoped); (2) in-memory URL cache for Supabase Storage URLs fetched this session; (3) `word_cache.audio_urls` JSONB column queried for a persisted public URL from a previous session. On first fetch, audio is uploaded to the `audio` Storage bucket (`{lang}/{word}.mp3`) and the public URL is written back into `word_cache.audio_urls` (read-merge-write to preserve other lang entries). Web Speech API is unaffected. SQL required: `ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS audio_urls jsonb;` — Storage bucket `audio` must be created with public read access.

- **Auto-save word on lookup** — When the AI returns a result on the Input page, the word is saved to vocabulary automatically without the user clicking "Save". The PreviewCard changes to show "Saved automatically ✓" + an **Undo** button for 5 seconds; after 5 s the Undo button disappears. If the word already exists in vocabulary, auto-save is skipped and the duplicate warning is shown instead (existing behaviour). The `AUTO_SAVE_ENABLED` constant in `InputPage.jsx` can be flipped to disable this or wired to a future Settings toggle. `handleAutoSave` and `handleUndoAutoSave` are isolated helpers; `resetLookupState` always clears the auto-save timer to prevent stale state on the next lookup.

## 2026-04-20 (continued)

- **Google Cloud TTS for weak-browser languages** — `speak()` now routes by language engine: Web Speech API for en/ja/de/fr/ko/zh; Google Cloud TTS (server-side) for es/pt/it/hi/ur. Config lives in `TTS_PROVIDER` map — one line to move a language between engines. Google language codes in `GOOGLE_LANG` map — one line to add a new language.
- **Session-scoped audio cache** — Google TTS responses (base64 MP3) stored in an in-memory `Map` keyed by `word_lang`. Same word is never fetched twice in a session; cache is cleared on page reload.
- **Graceful fallback** — if Google TTS API call fails (network error, bad key, upstream error), `speak()` falls back to Web Speech API silently. No error shown to the user.
- **`api/tts.js` serverless endpoint** — auth-gated (Supabase JWT, same pattern as `api/anthropic.js`). Accepts POST `{ word, languageCode }`, validates against allowlist, proxies to Google Cloud TTS REST API, returns `{ audioContent: base64 }`. `GOOGLE_TTS_API_KEY` env var required (add to Vercel environment variables).

## 2026-04-20

- **word_type filter on Review page** — New filter chips (All / Word / Phrase / Idiom) appear in the Review toolbar when at least one phrase or idiom exists in the user's vocabulary. Filters by `word_type` column; "Word" chip includes entries where `word_type` is null (older words pre-dating the field). Works independently alongside the existing level, scene, and language filters.

- **Mistake filters on Review page** — Two new sort/filter options: (1) **Always Wrong** — words with `error_counter > 0`, sorted highest first; no extra query needed. (2) **Recent Mistakes** — words whose most recent `quiz_answer` event was `wrong`, sorted by recency; fetched lazily from `user_events`, cached per session. Both also act as filters (non-matching words hidden). Sort label "Least Recently Reviewed" renamed to "Reviewed Longest Ago".

- **Audio (Review/Input/Quiz)** — 🔊 speaker button on every Review word row, on Input preview/candidate/secondary cards, and on Quiz revealed card only (not during question phase). Shared `src/utils/speak.js` utility with `VOICE_LANG` map (11 languages; one entry to add more). Reusable `SpeakerButton` component stops propagation and gracefully no-ops when browser lacks `speechSynthesis` support.

## 2026-04-08 (continued)

- **Cumulative vocabulary graph** — "Words Added Over Time" chart in Stats now shows a running total instead of daily counts, so a bulk import day no longer dwarfs everything else. Chart always trends upward.
- **Flag button** — small 🚩 button added to the expanded word row in Review and to the revealed answer card in Quiz. Clicking opens an inline text input; on submit, the issue is saved to the `word_flags` Supabase table (`id`, `user_id`, `word_id`, `word_text`, `reason`, `status`, `created_at`). Shows "Flagged — thanks!" confirmation for 3 seconds. Logic isolated in `src/utils/flags.js`, component in `src/components/FlagButton/`.
- **Profile section in Settings** — new section above Data showing email, date joined, total words, words mastered, total quiz attempts, correct answers, and overall accuracy percentage.
- **Level color contrast** — A1/A2 and B1/B2 were too similar; updated to dark/light pairs: A1 `#2E7D32`, A2 `#81C784`, B1 `#1565C0`, B2 `#64B5F6`, C1 `#7B1FA2`, C2 `#E91E63`. Stats chart updated to match.
- **Default Review sort** — changed from A→Z to "Date Added: Newest" so recently added words appear first.

## 2026-04-08

- **Server-side prompt lockdown** — client now sends only `{ word, direction, mode }`; all system prompts, model name, and token limits are hardcoded server-side in `api/anthropic.js`. Logged-in users can no longer modify prompts via DevTools.
- **Provider config object** — `api/anthropic.js` has a top-level `PROVIDER` constant so the AI backend (model, URL, key env var) can be swapped in one place.
- **Auth gate on `/api/anthropic`** — serverless function rejects unauthenticated requests with 401; verifies the Supabase session token before forwarding anything to the AI provider.
- **CLAUDE.md + security rules** — added project overview, coding conventions, and mandatory security rules (`.claude/rules/security.md`) for Claude Code sessions. Added `.env.*` to `.gitignore`.

## 2026-04-07

- **Google OAuth** — replaced the session-based password gate (`VITE_APP_PASSWORD`) with Google OAuth via Supabase Auth. Added `AuthProvider` context, `LoginPage`, and sign-out button in the nav. Removed `PasswordGate` component. Words saved by new users are now tagged with their Supabase `user_id`. The ~784 words imported from CSV were backfilled to owner UUID `fb1e35bb-49e2-4dd1-8ef7-b0f7e788198e`.

## 2026-04-06

- **Multi-meaning input** — default lookup uses a single cheap API call (one meaning); a "See more" button triggers a second call returning up to 3 meanings/translations.
- **Auto-correct accents** — AI prompts updated to correct spelling errors in the `word` field (e.g. `espanol → español`, `nino → niño`).
- **Level badge colors** — A1–C2 badges changed from greyscale to distinct colors (green/blue/purple/pink); consistent across Review, Quiz, and Input tabs.
- **Settings tab** — new tab with CSV export of the full vocabulary (BOM-encoded, all 15 fields, proper escaping).
- **Mobile nav fix** — navigation bar no longer overflows on small screens; app defaults to the Input tab on load.

## 2026-04-05

- **Design overhaul** — replaced warm Latin palette and Playfair Display font with minimal grey/black/white using Nunito throughout.
- **Level filter in Review** — multi-select A1–C2 toggle buttons to filter the word list by level.
- **Code splitting** — tabs (Review, Quiz, Input, Stats) are lazy-loaded with `React.lazy` + `Suspense`. Main bundle reduced from ~786 KB to ~189 KB.
- **C1 and C2 levels** — added throughout the app: input form, quiz, stats, sorting, and AI prompts.
- **EN→ES direction** — Input tab gained a direction toggle; English→Spanish lookup returns up to 3 candidate cards, each saved individually.
- **Password gate** — simple session-based password gate added using `VITE_APP_PASSWORD` env var (later replaced by Google OAuth on 2026-04-07).
- **Supabase migration** — data layer moved from `localStorage` to Supabase; added async loading/error states, seed script, and `supabase.js` client utility. ~784 words imported from `01042025_Spanishvocab.csv`.
- **Initial release** — full-featured app with Review, Quiz, Input, and Stats tabs. Stages 1–4 complete: vocabulary table, spaced-repetition quiz, Claude API word lookup (via Vercel serverless proxy), Recharts stats dashboard, scene tagging. Deployed to Vercel.
