# Changelog

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
