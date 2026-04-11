# Changelog

## 2026-04-19

- **Secondary card meanings in own language (FIX 1)** — Secondary mini-cards now show meaning in the card's own target language (e.g. Urdu card shows meaning in Urdu, Portuguese card in Portuguese). Previously `meaningLang` was always set to the user's primary language. `fireSecondaryLookups` now passes `c` (the target language) as both `targetLanguage` and `meaningLanguage` to `lookupSecondary`. Cache key updates accordingly: old secondary entries become cache misses.
- **base_form added to CACHE_INDEXED_FIELDS (FIX 2)** — `base_form` is now stored as a dedicated text column on `word_cache` (same pattern as `part_of_speech`, `word_type`). SQL migration required: `ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS base_form text;`
- **ai_insights cache write fixed (FIX 3)** — Previous approach created a new `mode='insights'` row which could fail on NOT NULL column constraints. Redesigned: `ai_insights` is now a dedicated JSONB column on the existing `mode='single'` cache row, written via `setCachedExtra` (UPDATE only — never creates a new row). `getCachedWord` now selects and returns all `CACHE_EXTRA_JSONB_FIELDS` (including `ai_insights`) alongside the standard response. `fetchInsights` checks `cacheRow?.ai_insights` before calling AI; after AI call, writes to both `word_cache` (shared, cross-user) and `vocabulary.ai_insights` (per-user) in parallel. Console logs added on both read hit and write paths for debugging. SQL migration required: `ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS ai_insights jsonb;`

## 2026-04-19 (earlier)

- **AI Insights cached to word_cache** — `fetchInsights` checks word_cache before calling AI; writes to both word_cache and vocabulary.ai_insights. (Superseded by FIX 3 above.)
- **Explore mode: removed session exclusion list** — `seenWords` state removed from ExploreMode; selection is purely random from cache pool. Word selection strategy will be replaced with a seed table approach (`word_seeds`) in a future session.

## 2026-04-18

- **Secondary language source fix (FIX 1)** — Secondary mini-cards were translating the learning-language output word (e.g. "precioso") instead of the original typed word. `fireSecondaryLookups` now receives the original input term and `actualInputLang`; passes these to `lookupSecondary` as the source word and source language. Result: typing "gorgeous" in English now correctly returns the Urdu/other-language translation of "gorgeous", not of the Spanish result.
- **Secondary cache unification (FIX 2)** — `buildSecondaryPrompt` in `api/anthropic.js` now returns the full field set: `word_in_target`, `part_of_speech`, `word_type`, `base_form`, `meaning_brief`, `example_brief`, `related_words`, `other_useful_notes` (+ romanization for non-Latin scripts). Meaning/pos/notes language is now explicit via `meaning_language` param (user's primary language). `lookupSecondary` sends `meaning_language` to the server and uses it in the cache key `(word, sourceLang, meaningLang, targetLang, 'secondary')`. `MAX_TOKENS.secondary` bumped 300→500.
- **Secondary card Show more (FIX 3)** — Each secondary mini-card now has a "Show more ▼" / "Show less ▲" toggle button. Expanded view shows `part_of_speech`, `example_brief`, `related_words`, `other_useful_notes` from the already-fetched data — no extra API call. Fields are driven by a `SECONDARY_EXTRA_FIELDS` config array so adding new fields to the expanded view requires only one new entry there. Compact view is unchanged.

## 2026-04-17

- **More Info panel on word detail** — "More info ▼" button added to the expanded word row in Review. On first tap: checks `word.ai_insights` (populated from a prior session via DB); if null, calls AI and saves the result to `vocabulary.ai_insights` (JSONB). No API call on subsequent opens — the word prop is kept fresh by `useVocabulary`'s optimistic update. Panel renders etymology, register (colored badge), 3 common collocations with examples, and a cultural note.
- **Extensible insights renderer** — `InsightsPanel.jsx` uses a `INSIGHTS_SECTIONS` config array (key, label, type). Adding a new field (false_friends, mnemonic, etc.) requires: one entry in `INSIGHTS_SECTIONS` + one update to `buildInsightsPrompt`. `RENDERERS` maps types (text, badge, collocations, list) to render functions; adding a novel data shape requires only a new renderer entry. `fetchInsights` in `insights.js` stores the raw JSONB and requires no changes for new fields.
- **Insights API prompt** — `api/anthropic.js` new `buildInsightsPrompt` for `mode='insights'`. Client sends `{ word, part_of_speech, learning_language, primary_language, mode: 'insights' }`. Prompt requests: etymology (1-2 sentences), register (one of 6 values), exactly 3 collocations `{ phrase, example }`, cultural_note. `MAX_TOKENS.insights = 600`.
- **SQL migration required** — `ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS ai_insights jsonb;`

## 2026-04-16

- **Explore mode** — new third mode in the Quiz tab (Easy | Hard | **Explore**). Auto-activates when the user has 0 words. Level chips (A1–C2, default A1) replace quiz settings when Explore is active. Each card flips on tap: front shows the word + romanization; back shows part-of-speech, meaning, example, and related words. "Next word →" always visible; "+ Save to my vocabulary" appears after flip (disabled if already in vocabulary or already saved this session). Duplicate check compares against the live `words` prop so saves made during the session are immediately reflected.
- **Explore word serving** — `src/utils/explore.js` `fetchExploreWord`: (1) queries `word_cache` for a random unseen entry matching `(learning_language, primary_language, level, word_type)` via new `getRandomCachedExploreWord` in `cache.js` — zero AI cost on cache hit; (2) falls back to a fresh AI call (`mode: 'explore'`); (3) saves the AI response to `word_cache` immediately so future sessions reuse it. Seen words are tracked per session (reset on level/language change). Extensibility: phrase/idiom filtering → pass `wordType`; community pools → add a `pool` param to `fetchExploreWord` without touching `ExploreMode` component.
- **Explore API prompt** — `api/anthropic.js` new `buildExplorePrompt` for `mode='explore'`. Client sends `{ learning_language, primary_language, level, word_type, mode: 'explore' }` — no input word. Returns same JSON shape as standard single lookup. `VALID_LEVELS` and `VALID_WORD_TYPES` server-side sets added for validation. `userMessage` is `'Generate.'`
- **`recommended_level` cache column** — added to `CACHE_INDEXED_FIELDS` in `cache.js`. All future cache writes store `recommended_level` as a dedicated column, enabling the explore mode query (`WHERE recommended_level = 'A1'`). SQL migration required: `ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS recommended_level text;`
- **`aiResultToWordFields` moved to `vocabulary.js`** — shared helper now exported from `src/utils/vocabulary.js`. `InputPage.jsx` imports it from there; `ExploreMode.jsx` uses it for the same save path. Adding a new AI-returned field still requires only one edit.

## 2026-04-15

- **word_type and base_form fields** — AI prompt (`api/anthropic.js`) now returns two new fields: `word_type` ("word" | "phrase" | "idiom", AI-detected from input) and `base_form` (infinitive/dictionary form for verbs, null otherwise). Both saved to vocabulary on word add via the shared `aiResultToWordFields` helper. `MAX_TOKENS` bumped: single 600→700, multi 1800→2000.
- **Extensible vocabulary save** — `InputPage.jsx` now has a single `aiResultToWordFields(result)` helper used by both the preview save and candidate save paths. Adding a new AI-returned field now only requires updating this one function.
- **Extensible cache indexed columns** — `src/utils/cache.js` introduces `CACHE_INDEXED_FIELDS` (`['part_of_speech', 'word_type']`). `setCachedWord` automatically extracts these from the AI response and stores them as dedicated columns alongside the `response` JSONB. `getCachedWord` selects all indexed columns and merges them into single-mode responses as a fallback for pre-migration cache entries. Adding a new indexed column requires: one SQL `ALTER TABLE word_cache ADD COLUMN`, one entry in `CACHE_INDEXED_FIELDS`. Requires SQL migration: `ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS word_type text; ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS word_type text DEFAULT 'word'; ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS base_form text;`

## 2026-04-14

- **Hard mode article stripping** — `answersMatch` in `QuizPage.jsx` now strips leading articles from both the typed answer and the stored word before running Levenshtein comparison. Language-specific article lists live in `LEADING_ARTICLES` (ES, FR, DE, IT, PT, EN); languages without articles (JA/KO/ZH/UR/HI) are unaffected. Stripping is exact — no fuzzy prefix matching. Lang code resolved from `current.word_language` then `preferences.learning_language`. Rules documented in `.claude/rules/quiz-answer-matching.md`. Future fill-in-the-blanks / grammar mode is a separate quiz type and will NOT use this logic.

## 2026-04-13

- **Word cache fixed** — `word_cache` upserts were silently failing because the required UNIQUE constraint was never created. `scripts/migrations/001_word_cache_three_role.sql` added and run in Supabase SQL Editor — creates `word_cache_three_role_key UNIQUE(input_word, input_language, learning_language, primary_language, mode)`. Old `direction` column was also causing 400 errors; resolved. Cache now writes and reads correctly (confirmed 200 responses).
- **Cache error surfacing** — `getCachedWord` and `setCachedWord` now log `console.error` on Supabase failures instead of silently swallowing errors. `lookupSecondary` in `anthropic.js` now logs `word_lookup` events with `cache_hit` flag (was previously untracked).
- **Enter key advances quiz on revealed card** — pressing Enter during the revealed phase moves to the next word. Listener is registered via `setTimeout(0)` so the same keydown that triggered "Check" in Hard mode cannot also immediately skip the reveal.
- **Server-side admin stats endpoint** — `api/admin-stats.js`: GET-only Vercel serverless function. Verifies the session token belongs to `wikipanna@gmail.com` (403 otherwise). Uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS and count vocabulary rows across all users. `src/utils/admin.js` `fetchAdminStats` now calls `/api/admin-stats` instead of the RLS-blocked client-side vocabulary count.
- **meanings_array and word_alternatives** — AI prompt (`api/anthropic.js`) now returns two new fields: `meanings_array` (up to 4 primary-language meanings as array) and `word_alternatives` (up to 3 learning-language synonyms as array). Both saved to vocabulary on word add. Hard mode quiz accepts any `word_alternatives` entry as a correct answer (full Levenshtein leniency). `MAX_TOKENS` bumped: single 400→600, multi 1400→1800. Vocabulary table needs: `ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS word_alternatives jsonb;`
- **Easy/Hard quiz stats on Stats page** — new "Quiz Performance by Mode" section: two side-by-side cards (stacked on mobile). Fetches `user_events` directly with `user_id` filter, groups by `metadata.quiz_mode`. Easy card: attempts, correct/wrong/not-sure, accuracy %. Hard card: same without not-sure. Green accent for Easy, blue for Hard. "No attempts yet" shown if a mode has no data.
- **Hard mode reveal fix** — revealed card now always shows full content after all answer paths (typed correct, typed wrong, ✅ ❌ 🤷 self-assess). Meaning is now included in Hard mode revealed (previously hidden since it was the question prompt — this made the reveal appear blank for words with no example/notes, especially on correct answers where the card border change was subtle).

## 2026-04-12

- **Quiz go-back** — "← Previous" button on the quiz card (visible in both question and revealed phases). Stores the previous word snapshot including session state; clicking back restores the previous card in revealed phase, undoes DB stat changes for the current word if it was already answered, and restores session counts. Button disappears after going back once and reappears when a new word is shown. `prevEntry` state includes `typedAnswer` so go-back works correctly in Hard mode.
- **0-attempt words shown first** — `pickNext` in `src/utils/quiz.js` now uses a two-tier strategy: words with `total_attempts === 0` are always shown before any weighted selection (uniform random among them). Once exhausted, falls back to existing memorization/recency weighting.
- **Easy / Hard quiz modes** — replaces "Normal / Reverse" naming. Easy = recognition (self-assess with ✅ ❌ 🤷). Hard = production (type the word from the meaning prompt). Mode toggle in quiz settings strip; default is Easy.
- **Hard mode typed answer** — question phase shows meaning (large) + part of speech + level badge; user types the word and presses Enter or Check. Revealed phase shows the correct word + romanization/kana, an answer comparison (green cell if correct, red + "Correct" cell if wrong), example/notes. Meaning omitted from revealed (it was the question). Self-assess buttons remain available below the input.
- **Answer leniency** — `answersMatch` now uses Levenshtein distance ≤ 1 for words longer than 3 characters (one typo or missing accent accepted). Words 3 characters or shorter require exact match. Diacritic normalization still runs first.
- **quiz_answer event** — now logs `quiz_mode: "easy" | "hard"` in metadata.
- **Alphabet quick-scroll on Review** — a vertical letter strip appears on the right edge of the review table when sort is A→Z or Z→A (hidden for all other sorts). Shows only letters that have words; ordered to match sort direction. Clicking a letter smooth-scrolls to the first word of that section. Scroll listener tracks the active letter in real time (highlighted in gold). Hovering/touching a letter shows an enlarged popup bubble positioned at the hovered letter's Y offset. Hidden in bulk-select mode. `WordRow` accepts `anchorLetter` prop → `data-alpha-anchor` on `<tr>` for DOM querying.

## 2026-04-11

- **translate="no" on word content** — added `translate="no"` to all word-display containers (Input: search field, PreviewCard, CandidateCard, SecondaryMiniCard; Quiz: card; Review: word cell + detail row; Stats: hardest/most-reviewed chart cards). Prevents browser auto-translation from mangling vocabulary content for users browsing in a different UI language.
- **word_language column** — vocabulary table now tagged per word with its language code. New `scripts/backfill-word-language.js` script: detects non-Latin scripts by Unicode range (JA/KO/ZH/UR/HI), falls back to user's `learning_language` preference for Latin-script words, updates in batches of 200 with per-language count summary. Requires `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
- **word_language saved on new words** — InputPage now includes `word_language: learningLang` in every `handleSave` and `handleSaveCandidate` call.
- **Quiz language filter** — language chips appear in the quiz settings strip when vocabulary spans multiple languages. Defaults to user's `learning_language` (set once on preferences load via ref). Pool is pre-filtered before `buildPool`. Language badge (flag + code) shown on quiz card header.
- **Review language filter** — language chips appear in the review toolbar when vocabulary spans multiple languages. Default is "All". Language badge (code) shown in word cell when multiple languages are present (`showLangBadge` prop on WordRow).
- **filterAndSort language param** — `src/utils/sorting.js` `filterAndSort` now accepts a `language` option; filters words by `word_language`.
- **preferences passed to Quiz and Review** — `App.jsx` now forwards `preferences` prop to both `QuizPage` and `ReviewPage`.
- **Duplicate finder script** — `scripts/find-duplicates.js`: reports duplicate rows (same word + user_id, case-insensitive) with ids, meanings, and dates. Read-only — no deletes. Run with `node --env-file=.env scripts/find-duplicates.js`. Duplicates found and cleaned from Supabase manually.
- **Comma-separated meanings** — `api/anthropic.js` primary prompt now instructs the model: "If there are multiple meanings, separate them with commas (e.g., 'weak, feeble, frail'). Do not use slashes or semicolons." Applies to single and multi-mode lookups.
- **Integer-only stats charts** — `StatsPage.jsx`: added `allowDecimals={false}` and `tickFormatter={v => Math.floor(v)}` to count-based axes on Words by Level (YAxis), Total Vocabulary Over Time (YAxis), and Most Reviewed Words (XAxis).

## 2026-04-10

- **Three-role language system** — word lookup now separates three distinct roles: *input language* (what the user types), *learning language* (determines word, example, related words in the response), and *primary language* (determines meaning, part of speech, notes). Any input language produces output anchored to the learning language. Client sends `{ word, input_language, learning_language, primary_language, mode }`; all prompt logic is server-side.
- **User preferences** — new `user_preferences` Supabase table (`primary_language`, `learning_language`, `secondary_languages`). Defaults: primary=EN, learning=ES. Loaded on login, saved optimistically. Settings tab exposes all three with ordered UI: Learning → Primary → Secondary.
- **Dynamic language chip selector** — Input page chip row replaces the old direction toggle. Chips built from `[learning, primary, ...secondaries]` deduped. Selecting a chip sets the input language; learning and primary are shown as a static info label with a "Change in Settings" link.
- **Secondary language mini-cards** — after a primary lookup, parallel `lookupSecondary` calls fire for each secondary language (filtered to exclude source and target). Results appear in a 65/35 split column alongside the main card. New languages can be added inline.
- **11 supported languages** — EN 🇺🇸, ES 🇪🇸, JA 🇯🇵, DE 🇩🇪, KO 🇰🇷, ZH 🇨🇳, UR 🇵🇰, HI 🇮🇳, PT 🇵🇹, FR 🇫🇷, IT 🇮🇹.
- **Romanization for non-Latin scripts** — when `learning_language` is JA/KO/ZH/UR/HI, the server prompt requests `romanization` (romaji, pinyin, or romanized form) and, for Japanese only, `kana_reading`. Displayed below the word on Input page (PreviewCard, CandidateCard, SecondaryMiniCard), Review page (word cell + expanded detail), and Quiz page (revealed phase only — hidden during question to preserve challenge). Fields saved to vocabulary as `romanization` and `kana_reading` columns.
- **Shared word cache** — new `word_cache` Supabase table. Responses are cached before hitting the Anthropic API and reused across all users. Cache key: `(input_word, input_language, learning_language, primary_language, mode)`. Cache hits logged to `user_events`. Secondary lookups also cached.
- **Event logging** — `user_events` table now populated. Events: `word_lookup` (with `cache_hit` flag), `word_added`, `quiz_answer`, `csv_export`. All fire-and-forget via `src/utils/events.js`.
- **Admin dashboard** — hidden tab visible only to `wikipanna@gmail.com`. Four sections: overview stats (distinct users, total words, lookups today, cache hit %, top words), recent activity feed, flagged content queue (resolve/dismiss), popular words. Logic in `src/utils/admin.js`, component in `src/components/Admin/AdminPage.jsx`.
- **Production sourcemaps disabled** — `vite.config.js` sets `build: { sourcemap: false }`.
- **word_cache schema** — updated from `(input_word, direction, mode, target_language)` to `(input_word, input_language, learning_language, primary_language, mode)` to support the three-role system. Old entries become cache misses, no errors.
- **UI polish** — Settings language order changed to Learning → Primary → Secondary. Input page label changed from "I'm looking up:" to "Type in:". Language info label made more prominent (1rem, medium weight). Mobile: info label breaks into two lines, separator hidden. American flag 🇺🇸 for English replacing 🇬🇧.

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
