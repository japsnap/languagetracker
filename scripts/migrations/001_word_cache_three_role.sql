-- Migration 001: word_cache three-role cache key
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- This creates the UNIQUE constraint that the client-side upsert depends on.
-- Without it, every setCachedWord() call silently fails and the cache never writes.
--
-- Safe to re-run — all steps are idempotent.

-- Step 1: Add new columns (IF NOT EXISTS — safe to re-run)
ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS input_language    text NOT NULL DEFAULT '';
ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS learning_language text NOT NULL DEFAULT '';
ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS primary_language  text NOT NULL DEFAULT '';

-- Step 2: Drop the old UNIQUE constraint if it still exists.
-- First, check what constraints exist:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'word_cache'::regclass;
-- Replace the name below if yours differs from the PostgreSQL default naming convention.
ALTER TABLE word_cache
  DROP CONSTRAINT IF EXISTS word_cache_input_word_direction_mode_target_language_key;

-- Step 3: Add the new UNIQUE constraint (guarded — safe to re-run)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'word_cache'::regclass
      AND conname = 'word_cache_three_role_key'
  ) THEN
    ALTER TABLE word_cache
      ADD CONSTRAINT word_cache_three_role_key
      UNIQUE (input_word, input_language, learning_language, primary_language, mode);
  END IF;
END $$;

-- Verify:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'word_cache'::regclass;
-- Expected: 'word_cache_three_role_key' appears in the results.
