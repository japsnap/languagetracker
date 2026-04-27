# Changelog

## 2026-04-28 (FSRS surfacing in Quiz UI)

- **FSRS Queue toggle (Due / All / New)** — New toggle in the Quiz settings strip (leftmost position). Session-only; not persisted to `user_preferences`.
  - **Due** — only shows cards with `state in ('review','relearning')` AND `due_at <= now()`. Returns null when nothing is due → transitions to "All caught up!" done screen.
  - **All** — existing behaviour (full FSRS priority order). Default.
  - **New** — only FSRS-untouched new words (`state='new'`, `review_count=0`), respecting the daily new-card limit. Returns null when limit is hit or no new words remain.
  - Switching modes during an active session calls `restart()` — returns to idle in the new mode.

- **Due-today badge** — Strict count: `state in ('review','relearning') AND due_at <= now()`. Appears in two places:
  - **Nav Quiz tab** — small red pill badge (`99+` cap); computed from `word_reviews_state` on pool load.
  - **Queue "Due" button** — inline red badge showing the same count.
  - **Live decrement** — when a due review/relearning card is answered, count decrements immediately without a re-fetch; propagated up to Navigation via `onDueCountChange` callback.

- **Mode-aware empty states** — `DoneScreen` shows a different icon/title/subtitle based on `doneReason`:
  - `all_caught_up` (Due mode) — "All caught up!" + quick-switch to New mode.
  - `daily_limit` (New mode, limit hit) — "Daily limit reached!" + quick-switch to Due mode.
  - `no_new_words` (New mode, no untouched words) — "No new words left" + quick-switch to Due mode.
  - `done` (All mode, pool exhausted) — existing "No more words!" message.

- **IdleScreen due hint** — when `dueCount > 0` and fsrsMode is not 'due', shows a red hint above the start button so due cards are visible at a glance.

## 2026-04-26 (schema mismatch fixes)

- **FIX: sessions insert** — removed `mode` field; the sessions table has no mode column. Mode breakdown is available by joining `review_log ON session_id` and grouping by `review_log.mode`.
- **FIX: review_log insert** — removed `due_before` and `due_after` fields; those columns do not exist in the schema. FSRS due timestamps live in `word_reviews_state.due_at` only.
- **FIX: review_log day_of_week** — was sending a string ("Sunday") to a `SMALLINT` column; changed to `localDate.getDay()` → integer 0–6 (0=Sunday).

## 2026-04-25 (FSRS wired into Quiz UI)

DB migrations (already run in Supabase): tables `word_reviews_state`, `sessions`, `review_log`, `interference_events` created; `user_preferences` extended with `timezone`, `desired_retention`, `fsrs_weights`, `daily_review_goal`.

### What changed

- **FSRS card selection** (`pickNextFsrs` in `QuizPage.jsx`) replaces `pickNext` from `utils/quiz.js` for ordering decisions. Priority: 0-attempt new words → due learning → due relearning → remaining new → due review → earliest not-yet-due. The existing `buildPool` filter (level/starred/mastered/scene/language) is unchanged. New quiz modes (conjugation/cloze/audio/reverse) need no changes to this function — mode is stored in `word_reviews_state` and filtered by the caller.

- **Session management** — On the first card of each quiz session, a row is inserted into `sessions`. `session_id` is stored in a ref and attached to every `review_log` row. On component unmount or 10 minutes of inactivity, the session row is updated with `ended_at`, `review_count`, `correct_count`, `avg_response_ms`. `restart()` resets all session refs so "Start over" creates a fresh session. Device is detected via `matchMedia('display-mode: standalone')` (PWA) or UA string.

- **FSRS writes on every answer** (`_writeFsrsResult`) — upserts `word_reviews_state` (state, stability, difficulty, due_at, review_count, lapse_count) and inserts a `review_log` row with full before/after state snapshot, response time, grade, device, input method, local hour, and day of week. All DB ops are fire-and-forget with try/catch — the quiz flow is never blocked and the app degrades gracefully if tables don't exist yet.

- **Go-back FSRS undo** — `handleGoBack` now also reverts the FSRS write: deletes the `review_log` row and either restores the previous `word_reviews_state` row (upsert) or deletes it if the word was new. Session counters (review_count, correct_count, session_position) are decremented to match. Existing legacy field undo is preserved.

- **Response time capture** — `revealedAtRef` is set to `performance.now()` in `startOrNext` when the question phase begins. `handleAnswer` reads and clears it to compute `responseTimeMs`. Note: Hard mode response time starts at question display, not input focus — flagged for v1.5 improvement.

- **Grade inference** — Easy mode: `inferGradeEasyMode` maps tap type (easy/correct/not-sure/wrong) to FSRS grade (easy/good/hard/again). Hard mode: `inferGradeHardMode` infers grade from `isCorrect` + `responseTimeMs` + `wordLength` regardless of tap; self-assess buttons in Hard mode still send the typed-answer outcome.

- **🎯 Easy button** — Added to both Easy mode and Hard mode self-assess rows, before ✅ I knew it. Maps to FSRS grade 'easy' and counts as 'correct' for legacy streak. Card border shows `card_easy` (dark green) on reveal.

- **Interference event logging** (`src/utils/interference.js`) — New fire-and-forget helper. On Hard mode wrong answer, inserts into `interference_events` with `interference_type='unknown'` and `matched_word=null`. v1.5 will add matching logic (checking typed text against user vocab + similarity cache).

- **`computeChanges` — stop auto-mastering** — Removed `if (newStreak >= 5) changes.mastered = true`. FSRS `state='review'` with high stability will replace this concept. The `mastered` field remains in the DB; the manual "Mark as mastered" button is unchanged.

- **`handleChangeAnswer`** — Updated to treat `'easy'` as correct for session counter arithmetic. FSRS is not re-graded on change-answer (v1 acceptable; v1.5 to add re-grade).

### Legacy behavior preserved (do not remove)

- `total_attempts`, `error_counter`, `correct_streak`, `last_reviewed` are still written on every answer via `onUpdateWord`. Stats page, Review page, and CSV export all read these fields.
- `user_events` quiz_answer log is preserved unchanged alongside the new `review_log` writes.
- `buildPool` filter logic (mastered/starred/level/scene) is unchanged.
- `word_language` filter chips unchanged.
- Go-back legacy field undo unchanged.

### v1.5 flags

- `quiz.js` `wordWeight()` reads `last_reviewed` for weighted selection — replace with `word_reviews_state.due_at` once FSRS state is the source of truth for all users.
- Hard mode response time should start at input focus, not question display — add `onInputFocused` callback from QuizCard.
- `handleChangeAnswer` should re-grade the FSRS state with the new answer type.
- FSRS `desired_retention` / `fsrs_weights` / `timezone` settings UI needed in SettingsPage.
- `daily_review_goal` tracking not yet implemented.

## 2026-04-24 (FSRS scheduling module)

- **FSRS module** — installed `ts-fsrs`, created `src/utils/fsrs.js` with grade inference and scheduling helpers. Not yet wired to Quiz UI.
  - `getFsrsInstance(desiredRetention, weights)` — returns a configured FSRS scheduler; defaults to 80% retention.
  - `inferGradeHardMode({ isCorrect, responseTimeMs, wordLength })` — maps Hard mode outcome + response time to `again|hard|good|easy`. Thresholds scale with word length (baseline: easy <3 s, good ≤10 s at 6-char word; scales linearly for longer words).
  - `inferGradeEasyMode(userTap)` — maps ❌/🤷/✅/🎯 tap to grade string.
  - `gradeToRating(grade)` — converts grade string to ts-fsrs `Rating` enum.
  - `mapFsrsStateToString(state)` / `mapStateToFsrsState(stateStr)` — bidirectional State enum ↔ string.
  - `scheduleReview({ currentState, grade, desiredRetention, weights, now })` — core FSRS scheduling; accepts null `currentState` for first review; returns `next_state`, `due_at`, `stability`, `difficulty`, `elapsed_days`, `review_count`, `lapse_count` for DB writes.
  - `buildReviewLogRow(...)` — builds a `review_log` insert row including `local_hour` and `day_of_week` via Intl API (no external deps).
  - All functions have JSDoc. FSRS logic is mode-agnostic; new modes (conjugation/cloze/audio) only need entries in mode checks.

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


## 2026-04-24 (quiz speaker position + wrong-answer collision hint)

- **FIX: Easy mode speaker button position** — `SpeakerButton` was stacking below the word because `cardWordWrap` is `flex-direction: column`. Added `.cardWordRow` inline flex wrapper inside `cardWordWrap` so the word and speaker sit side-by-side (same pattern as Review and Input cards). Applied to both Easy mode question face and Hard mode revealed face.

- **FIX: Wrong-answer collision hint (Hard mode)** — When the user types a wrong answer that doesn't match the current quiz word, the app now checks whether the typed input matches a *different* valid word in the database (no AI call, no new endpoint). Lookup flow:
  1. Strip diacritics + lowercase + trim the typed input.
  2. Query `word_cache` for `result_word` entries starting with the same 3-char prefix (`learning_language = currentWordLang, mode = 'single'`), fetch up to 50 rows, filter client-side by normalized match.
  3. If no cache hit: query `word_seeds` by the same prefix + `language = currentWordLang`, filter client-side. On seed match, do a second cache lookup by `result_word` to retrieve the meaning.
  4. On match: show a subtle blue info card — `"'{correctedWord}' is a valid word — which means '{meaning}'"` (falls back to `"is a valid word in this language"` if no meaning available). The corrected word uses the properly-accented form from the DB.
  - The collision card is fire-and-forget (`lookupCollision` resolves after `handleAnswer` runs) so quiz flow is never blocked. Card resets on every new word.
  - Accent normalization uses the same NFD+diacritic-strip logic as `stripDiacritics` in the quiz answer matcher, ensuring "buenisima" matches "buenísima".

## 2026-04-23 (word tags, mastered from quiz, explore audio)

- **Word tags** — Six emoji icon tags (🔥 Difficult, ⭐ Priority, 🔄 Review, ❓ Confusing, 😄 Fun, 💼 Practical) stored as a jsonb array in `vocabulary.tags`. Tag config lives in `src/utils/tags.js` — adding a new tag requires one entry there only. `TagBar` component (`src/components/TagBar/`) renders the icon buttons: inactive = greyscale/dimmed, active = colored.
  - **Review**: TagBar in expanded word row (detail grid). Tag filter chip row in toolbar, visible only when at least one word is tagged. OR logic: word must have any selected tag. Filter is a second layer (`tagFiltered`) on top of the existing `filterAndSort` result — all existing filters unchanged.
  - **Quiz**: TagBar in revealed section (small size). Uses local state (`localTags`) reset on `word.id` change to handle the snapshot-current pattern. Tags persist via `onUpdateWord` (now threaded to QuizCard).
  - **Input**: TagBar appears below the auto-save status bar when a word has been saved (has an id). Tags apply immediately via `onUpdateWord`. `previewTags` state reset in `resetLookupState()`. `onUpdateWord={updateWord}` added to InputPage in App.jsx.

- **Mark as mastered from Quiz** — "Mark as mastered" button in QuizCard revealed section. Uses `localMastered` state (reset on `word.id` change). On click: sets `mastered: true` via `onUpdateWord` and shows "Mastered ✓" confirmation. One-way only (no untoggle in quiz; use Review for that).

- **Speaker button on Explore card** — `SpeakerButton` added to both card faces in ExploreMode: front face (`wordBigRow` flex wrapper) and back face (`wordSmallRow` flex wrapper). Plays the word in the current learning language using the existing TTS routing (web speech / Google Cloud TTS).

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

## 2026-04-23 (revert seeded explore path to mode=single)

- **ROOT CAUSE FIX: seeded explore path reverted to `mode='single'`** — The previous update changed the seeded cache-miss AI call from `mode='single'` (specific word lookup) to `mode='explore'` (random word generation). This broke three things: (1) AI ignored seed.word entirely, generating arbitrary common words that repeated across seeds; (2) the cache was written under the random result word but looked up by seed.word, so the cache always missed; (3) the `enrich` fire-and-forget patched the seed row's level with the random word's level, corrupting level data. The seeded path is now correctly restored to `mode='single'` with `word=seed.word`, matching `getCachedWord(seed.word, ..., 'single')` exactly.

- **Mode semantics (invariant):** `mode='single'` = look up a specific known word (buildPrimaryPrompt). `mode='explore'` = generate a random word at a given level (buildExplorePrompt). The seeded path always needs the former; the unseeded fallback path always uses the latter. These must never be swapped.

- **`fireSeedUpdate('enrich', { seedId, level })`** — kept alongside the `add_seed` that fires from `anthropic.js` for mode='single'. Both are harmless fire-and-forget upserts targeting the same row in normal operation. `enrich` (by seedId) is more precise when AI corrects spelling and the result word differs from the seed word.

## 2026-04-23 (explore mode + enrich validation fixes)

- **FIX: explore seeded path uses mode='explore'** — `src/utils/explore.js` cache-miss AI call changed from `mode='single'` (with word/input_language) to `mode='explore'` (with level/word_type). Prevents `api/anthropic.js` from firing a redundant `add_seed` for words already in `word_seeds`; explore's own `fireSeedUpdate('enrich', ...)` handles enrichment. The existing `['single'].includes(mode)` allowlist in `api/anthropic.js` blocks `mode='explore'` from triggering seed-update.
- **FIX: enrich seedId type validation** — `api/seed-update.js` enrich action removed `typeof seedId !== 'string'` check; any truthy seedId (integer or string) is now accepted. Diagnostic `console.error` log added before the 400 path to surface which validation check fails.
- Removed temporary `[debug]` console.log statements from `api/anthropic.js` and `src/utils/explore.js`.

## 2026-04-23 (seed-update fixes)

- **FIX: add_seed conflict handling** — `api/seed-update.js` `add_seed` action now uses a two-attempt strategy: (1) INSERT with `Prefer: resolution=merge-duplicates` (upsert); (2) if that returns any non-OK status (including 409), falls back to an explicit `PATCH word_seeds WHERE word=? AND language=?` to update `enriched=true` + `level`. Conflicts never produce a 4XX/5XX response — an existing row is always updated and 200 returned.
- **FIX: seed-update mode allowlist** — `api/anthropic.js` fire-and-forget seed-update now guards with `['single'].includes(mode)` (explicit allowlist) instead of `mode === 'single'`. Makes intent unambiguous: `multi`, `secondary`, `explore`, `insights`, and any quiz-related modes are categorically excluded from triggering seed-update.

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
