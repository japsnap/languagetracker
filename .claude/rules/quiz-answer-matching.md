# Quiz Answer Matching Rules

Applies to Hard mode typed-answer comparison in `src/components/Quiz/QuizPage.jsx` (`answersMatch`).

## Comparison pipeline (applied in order)

1. **Lowercase + trim** — both sides normalised before anything else.
2. **Diacritics stripped** — `str.normalize('NFD').replace(/[\u0300-\u036f]/g, '')` so "espanol" matches "español".
3. **Leading article stripped** — language-specific articles removed from the start of both the typed answer and the stored word before comparison (see table below). Stripping is exact — no fuzzy prefix matching.
4. **Levenshtein ≤ 1** — one edit (insert/delete/substitute) accepted for words longer than 3 characters. Words ≤ 3 characters require exact match after steps 1–3.

## Article lists by language

| Code | Articles |
|------|----------|
| ES   | un, una, el, la, los, las |
| FR   | l', un, une, le, la, les |
| DE   | ein, eine, der, die, das |
| IT   | un, una, il, la, i, le |
| PT   | um, uma, o, a, os, as |
| EN   | a, an, the |
| JA, KO, ZH, UR, HI | *(no articles — skip stripping)* |

To add a new language: add an entry to `LEADING_ARTICLES` in `QuizPage.jsx`. No other code needs to change.

## What this does NOT do

- No fuzzy prefix matching beyond the single leading article.
- No partial-word stripping.
- No synonym expansion (that is handled by `word_alternatives`, not this function).

## Future fill-in-the-blanks / grammar mode

**This comparison function (`answersMatch`) must NOT be used for a future fill-in-the-blanks or grammar quiz type.** In that mode, articles are part of the graded answer — stripping them would incorrectly accept wrong answers. Grammar mode will use its own comparison logic.
