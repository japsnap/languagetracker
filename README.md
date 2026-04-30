# LanguageTracker

A multilingual vocabulary learning app with AI-powered word lookup, FSRS spaced-repetition scheduling, and multi-language support. Built for personal use; deployed on Vercel.

---

## Features

**Input tab** — Look up any word using Claude AI. The result auto-saves to your vocabulary with full metadata (meaning, example, level, alternatives, romanization for non-Latin scripts). Secondary language mini-cards show the same word in up to 4 additional languages simultaneously, each saveable as an independent vocabulary entry.

**Review tab** — Searchable, sortable table of all vocabulary. Filter by level (A1–C2), language, part of speech (word/phrase/idiom), scene, tags, and starred status. Inline expansion shows full word details, scene assignment, tag editor, and AI insights (etymology, collocations, cultural notes).

**Quiz tab** — Two modes:
- **Easy mode**: recognition; tap 🎯 ✅ ❌ 🤷 to self-assess
- **Hard mode**: typed production; accepts the target word or any listed synonym (Levenshtein ≤1 tolerance)

Both modes use FSRS (Free Spaced Repetition Scheduler) to schedule reviews. A queue toggle (Due / All / New) controls which cards appear. A due-today badge on the nav tab shows overdue card count.

**Explore mode** (within Quiz tab) — Flip-card drill for words you haven't saved yet. Spanish words follow a curated A1–C2 seed list; other languages use AI-generated random words.

**Stats tab** — FSRS metrics (In Review, Learning, Untouched, Due Today, Avg Stability, Accuracy Today), state distribution charts, stability histogram, reviews-per-day chart (30 days), and legacy charts (words by level, vocabulary over time, hardest words).

**Settings tab** — Language preferences (learning language, primary language, secondary languages), CSV export of full vocabulary.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 8, CSS Modules, Recharts |
| Database | Supabase (PostgreSQL + RLS) |
| Auth | Google OAuth via Supabase Auth |
| AI | Anthropic Claude claude-sonnet-4-20250514 |
| TTS | Google Cloud TTS (es/pt/it/hi/ur) + Web Speech API (other languages) |
| FSRS | ts-fsrs 5.3.2 |
| Hosting | Vercel (serverless functions + static frontend) |
| PWA | Web App Manifest + service worker |

---

## Supported Languages

EN · ES · JA · DE · KO · ZH · UR · HI · PT · FR · IT

---

## Local Development

### Prerequisites
- Node.js 18+
- A Supabase project (see Database Setup below)
- An Anthropic API key
- A Google Cloud TTS API key (optional; TTS falls back to Web Speech API without it)

### Setup

```bash
git clone https://github.com/japsnap/languagetracker.git
cd languagetracker
npm install
cp .env.example .env
# Fill in .env — see Environment Variables below
npm run dev
```

Open http://localhost:5173

### Environment Variables

| Variable | Scope | Required | Description |
|----------|-------|----------|-------------|
| `VITE_SUPABASE_URL` | Client + Server | Yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Client + Server | Yes | Supabase anon/public key |
| `ANTHROPIC_API_KEY` | Server only | Yes | Anthropic API key — never set with VITE_ prefix |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Yes | Supabase service-role key (bypasses RLS for admin/seed writes) |
| `GOOGLE_TTS_API_KEY` | Server only | Optional | Google Cloud TTS key; if absent, all TTS uses Web Speech API |
| `VITE_ANTHROPIC_API_KEY` | Local dev only | Dev only | Same Anthropic key; used by Vite dev proxy to bypass Vercel serverless |

> **Security**: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `GOOGLE_TTS_API_KEY` must only be set in Vercel environment variables (or `.env` locally). They must never appear in client-side code.

---

## Database Setup

This app requires a Supabase project with the following tables. Run the SQL below in the Supabase SQL Editor.

### Core tables

```sql
-- Vocabulary
CREATE TABLE vocabulary (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  word               text,
  word_language      text,
  word_type          text DEFAULT 'word',
  base_form          text,
  part_of_speech     text,
  meaning            text,
  meanings_array     jsonb,
  example            text,
  recommended_level  text,
  related_words      text,
  other_useful_notes text,
  romanization       text,
  kana_reading       text,
  word_alternatives  jsonb,
  tags               jsonb,
  lookup_session_id  uuid DEFAULT NULL,
  date_added         date,
  last_reviewed      timestamptz,
  total_attempts     int DEFAULT 0,
  error_counter      int DEFAULT 0,
  correct_streak     int DEFAULT 0,
  starred            boolean DEFAULT false,
  mastered           boolean DEFAULT false,
  scene              text
);
ALTER TABLE vocabulary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own vocabulary" ON vocabulary FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_vocabulary_lookup_session ON vocabulary(lookup_session_id) WHERE lookup_session_id IS NOT NULL;

-- Word cache (shared across users — no RLS)
CREATE TABLE word_cache (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  input_word       text,
  input_language   text,
  learning_language text,
  primary_language  text,
  mode             text,
  result           jsonb,
  result_word      text,
  ai_insights      jsonb,
  audio_urls       jsonb,
  cached_at        timestamptz DEFAULT now(),
  CONSTRAINT word_cache_three_role_key UNIQUE (input_word, input_language, learning_language, primary_language, mode)
);

-- User preferences
CREATE TABLE user_preferences (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  primary_language   text DEFAULT 'en',
  learning_language  text DEFAULT 'es',
  secondary_languages jsonb DEFAULT '[]',
  timezone           text,
  desired_retention  float DEFAULT 0.8,
  fsrs_weights       jsonb,
  daily_review_goal  int DEFAULT 20
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own preferences" ON user_preferences FOR ALL USING (auth.uid() = user_id);

-- Event log
CREATE TABLE user_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text,
  metadata   jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE user_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own events" ON user_events FOR ALL USING (auth.uid() = user_id);

-- Word flags
CREATE TABLE word_flags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  word_id    uuid REFERENCES vocabulary(id) ON DELETE CASCADE,
  word_text  text,
  reason     text,
  status     text DEFAULT 'open',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE word_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own flags" ON word_flags FOR ALL USING (auth.uid() = user_id);
```

### FSRS tables

```sql
CREATE TABLE word_reviews_state (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  word_id       uuid REFERENCES vocabulary(id) ON DELETE CASCADE,
  mode          text,
  state         text DEFAULT 'new',
  stability     float,
  difficulty    float,
  due_at        timestamptz,
  last_review_at timestamptz,
  review_count  int DEFAULT 0,
  lapse_count   int DEFAULT 0,
  updated_at    timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now(),
  UNIQUE (user_id, word_id, mode)
);
ALTER TABLE word_reviews_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own fsrs state" ON word_reviews_state FOR ALL USING (auth.uid() = user_id);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  device          text,
  started_at      timestamptz DEFAULT now(),
  ended_at        timestamptz,
  review_count    int DEFAULT 0,
  correct_count   int DEFAULT 0,
  avg_response_ms float,
  created_at      timestamptz DEFAULT now()
);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own sessions" ON sessions FOR ALL USING (auth.uid() = user_id);

CREATE TABLE review_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  word_id             uuid REFERENCES vocabulary(id) ON DELETE CASCADE,
  mode                text,
  session_id          uuid,
  session_position    int,
  grade               text,
  response_time_ms    int,
  is_correct          boolean,
  state_before        text,
  stability_before    float,
  difficulty_before   float,
  state_after         text,
  stability_after     float,
  difficulty_after    float,
  elapsed_days        int,
  device              text,
  input_method        text,
  interference_word_id uuid,
  local_hour          smallint,
  day_of_week         smallint,
  reviewed_at         timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now()
);
ALTER TABLE review_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own review log" ON review_log FOR ALL USING (auth.uid() = user_id);

CREATE TABLE interference_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  target_word_id    uuid REFERENCES vocabulary(id) ON DELETE CASCADE,
  typed_text        text,
  matched_word      text,
  matched_language  text,
  interference_type text,
  session_id        uuid,
  created_at        timestamptz DEFAULT now()
);
ALTER TABLE interference_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own interference events" ON interference_events FOR ALL USING (auth.uid() = user_id);
```

### Explore / seed tables

```sql
CREATE TABLE word_seeds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  word           text NOT NULL,
  language       text NOT NULL,
  level          text NOT NULL,
  part_of_speech text,
  enriched       boolean NOT NULL DEFAULT false,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (word, language)
);
ALTER TABLE word_seeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read word_seeds" ON word_seeds FOR SELECT USING (true);
CREATE POLICY "authenticated insert word_seeds" ON word_seeds FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "authenticated update enriched" ON word_seeds FOR UPDATE USING (auth.role() = 'authenticated') WITH CHECK (true);

CREATE TABLE user_seed_progress (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seed_id  uuid NOT NULL REFERENCES word_seeds(id) ON DELETE CASCADE,
  seen_at  timestamptz DEFAULT now(),
  UNIQUE (user_id, seed_id)
);
ALTER TABLE user_seed_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own progress" ON user_seed_progress FOR ALL USING (auth.uid() = user_id);
```

### Audio storage

Create a Storage bucket named `audio` with **public read access** enabled. The app uploads TTS MP3s to `{language}/{word}.mp3` paths.

---

## Deployment

### Vercel

1. Push the repo to GitHub
2. Import the project at [vercel.com](https://vercel.com)
3. Vercel auto-detects Vite — leave build settings as default
4. Add all environment variables listed above under **Environment Variables**
5. Deploy

Every push to `main` triggers an automatic redeploy.

### Auth callback URL

In Supabase → Authentication → URL Configuration, add your Vercel deployment URL as an allowed redirect URL:
```
https://your-app.vercel.app
```

---

## Architecture Notes

**API security** — All AI, TTS, and admin requests go through Vercel serverless functions in `api/`. The browser never sees `ANTHROPIC_API_KEY`, `GOOGLE_TTS_API_KEY`, or `SUPABASE_SERVICE_ROLE_KEY`. Serverless functions verify the Supabase session token on every request.

**Word cache** — AI results are cached in `word_cache` and shared across all users. The cache key is `(input_word, input_language, learning_language, primary_language, mode)`. A cache hit skips the AI call entirely.

**Three-role language system** — Every lookup specifies three roles: `input_language` (what the user typed), `learning_language` (the word/example language), `primary_language` (the meaning/notes language). Secondary language lookups reuse the primary prompt path with swapped roles.

**FSRS** — Free Spaced Repetition Scheduler (ts-fsrs). Tracks stability and difficulty per word per quiz mode. Writes are fire-and-forget — the quiz never blocks on DB operations.

---

## Current Limitations

- FSRS desired retention, custom weights, and timezone cannot yet be configured in the Settings UI (stored in DB but no UI)
- Daily new-card goal is stored in preferences but not enforced in the UI
- Explore mode seed coverage: Spanish (A1–C2 curated list); other languages auto-populate from lookups
- Hard mode response time measured from card display, not first keystroke
- No account management (cannot delete account from the app)

---

## File Structure

```
api/                    Vercel serverless functions
  anthropic.js          AI word lookup proxy
  tts.js                Google Cloud TTS proxy
  audio-upload.js       TTS audio → Supabase Storage
  seed-update.js        word_seeds writes (fire-and-forget)
  admin-stats.js        Admin-only cross-user stats

public/
  manifest.json         PWA manifest
  sw.js                 Service worker
  icon-192.png
  icon-512.png

scripts/
  migrations/           One-time SQL migrations
  seeds/                Word seed data + insert scripts

src/
  components/
    Admin/              Admin dashboard (owner-only)
    Auth/               AuthProvider, LoginPage
    FlagButton/         Word quality flag UI
    Input/              InputPage (AI lookup + secondary cards)
    InstallPrompt/      PWA install banner
    Navigation/         Tab bar
    Quiz/               QuizPage, ExploreMode
    Review/             ReviewPage, WordRow, InsightsPanel
    Settings/           SettingsPage
    SpeakerButton/      Shared TTS button
    Stats/              StatsPage (Recharts)
    TagBar/             Word tag UI
  hooks/
    useVocabulary.js    Vocabulary state management
  utils/
    anthropic.js        Client-side API request builder
    cache.js            Word cache read/write layer
    events.js           Fire-and-forget event logging
    explore.js          Explore mode logic
    flags.js            Word flag queries
    fsrs.js             FSRS scheduling helpers
    insights.js         AI insights fetch/persist
    interference.js     Interference event logging
    preferences.js      User preferences helpers
    quiz.js             Quiz pool building + word selection
    sorting.js          Filter + sort helpers
    speak.js            TTS routing (Google + Web Speech)
    supabase.js         Supabase client
    tags.js             Tag config (6 user tags)
    vocabulary.js       Core DB operations + aiResultToWordFields
```
