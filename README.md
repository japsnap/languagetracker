# SpanishTool

A personal Spanish vocabulary learning app with AI-powered word lookup, a spaced-repetition quiz, and progress tracking.

---

## Features

- **Review tab** — searchable, sortable table of all words with inline expansion. Filter by level, scene, or starred status. Bulk-tag words with a scene.
- **Stats tab** — progress dashboard with accuracy rate, mastery %, level breakdown charts, hardest words, and most reviewed words.
- **Quiz tab** — weighted random quiz (lower memorization % = appears more often). Tracks correct streaks, auto-masters words at streak 5. Change-answer support before moving on.
- **Input tab** — type a Spanish word, Claude AI fills in meaning, example, level, and notes. Editable before saving. Duplicate detection and session undo.
- **Persistent storage** — all data lives in `localStorage`; no backend required for personal use.

---

## Tech Stack

- React + Vite
- CSS Modules (Latin-themed warm palette, Playfair Display + Inter fonts)
- Recharts (stats charts)
- Anthropic Claude API (`claude-sonnet-4-20250514`) for word lookup

---

## Setup

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd spanishapp

# 2. Install dependencies
npm install

# 3. Add your API key
cp .env.example .env
# Edit .env and set: VITE_ANTHROPIC_API_KEY=sk-ant-...

# 4. Start dev server
npm run dev
```

Open http://localhost:5173 (or the port shown in your terminal).

---

## Importing Your Own Vocabulary CSV

1. Format your CSV with these columns:

   ```
   ID, word, part_of_speech, meaning, example, recommended_level, related_words, other_useful_notes
   ```

2. Place the CSV in the project root as `01042026_Spanishvocab.csv` (or update the path in `scripts/generate-json.js`).

3. Run the import script:

   ```bash
   node scripts/generate-json.js
   ```

   This generates `src/data/vocabulary.json` with all tracking fields initialized to defaults.

4. To clear existing progress and reload fresh data: DevTools → Application → Local Storage → delete `spanish_vocab_v1` → refresh.

---

## Deployment (Vercel)

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# Create repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/spanishapp.git
git push -u origin main
```

### 2. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo
3. Vercel auto-detects Vite — leave build settings as-is
4. Under **Environment Variables**, add:
   - Name: `ANTHROPIC_API_KEY`  Value: `sk-ant-...`
   - (No `VITE_` prefix — this key stays server-side only)
5. Click **Deploy**

The `api/anthropic.js` serverless function proxies all Claude API calls — **your key is never sent to the browser in production**.

Every push to `main` triggers an automatic re-deploy.

---

## File Structure

```
src/
├── components/
│   ├── Navigation/
│   ├── Review/        # ReviewPage, WordRow
│   ├── Stats/         # StatsPage (Recharts dashboard)
│   ├── Quiz/          # QuizPage
│   └── Input/         # InputPage
├── hooks/
│   └── useVocabulary.js
├── utils/
│   ├── vocabulary.js  # data layer (swap for Supabase calls later)
│   ├── sorting.js     # filter + sort + SCENES constant
│   ├── quiz.js        # weighted word selection
│   └── anthropic.js   # API call utility
└── data/
    └── vocabulary.json  # seed data (generated from CSV)
api/
└── anthropic.js         # Vercel serverless function (keeps API key server-side)
scripts/
└── generate-json.js     # CSV → JSON importer
```
