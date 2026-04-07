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
- Lazy-loaded tab components (Input, Review, Quiz, Stats, Settings)

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
- user_events table exists but not yet populated
- Tabs: Input, Review, Quiz, Stats, Settings (CSV export)

@CHANGELOG.md
