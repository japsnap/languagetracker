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
- Auth: Google OAuth via Supabase, password gate removed
- ~784 words in Supabase, backfilled to owner user_id
- Tabs: Input, Review, Quiz, Stats, Settings, Admin (owner-only)
- 11 supported languages: EN ES JA DE KO ZH UR HI PT FR IT
- Three-role language system live on Input page (input / learning / primary)
- User preferences table: primary_language, learning_language, secondary_languages
- word_cache table: caches API responses by (input_word, input_language, learning_language, primary_language, mode)
- user_events table: populated — word_lookup (cache_hit), word_added, quiz_answer, csv_export
- Romanization fields on vocabulary table: romanization, kana_reading (populated for JA/KO/ZH/UR/HI)
- Romanization shown on Input (PreviewCard, CandidateCard, mini-cards), Review (word cell), Quiz (revealed only)
- Production sourcemaps disabled

@CHANGELOG.md
