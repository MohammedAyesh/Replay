-- Seed placeholder Bunny Stream clips.
-- Run with: psql "$DATABASE_URL" -f scripts/src/seed-bunny-placeholders.sql
--
-- Inserts 3 placeholder clips (with valid recording FK refs) when the table is
-- empty, then updates ALL clips to have Bunny-format playback URLs.
-- Safe to run multiple times (ON CONFLICT DO NOTHING for inserts).

-- Step 1: Ensure the Bunny columns exist (idempotent).
ALTER TABLE clips ADD COLUMN IF NOT EXISTS bunny_video_id TEXT;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS bunny_playback_url TEXT;

-- Step 2: Insert placeholder clips when none exist yet.
-- Uses recording IDs 1, 2, 3 which reference field_id=1 (Central Sports Hub).
INSERT INTO clips (recording_id, rank, moment_label, player_tags, like_count, bunny_video_id)
SELECT 1, 1, 'GOAL · 32''', '{}', 100, 'placeholder-seed-1'
WHERE NOT EXISTS (SELECT 1 FROM clips LIMIT 1);

INSERT INTO clips (recording_id, rank, moment_label, player_tags, like_count, bunny_video_id)
SELECT 2, 2, 'VOLLEY · 9''', '{}', 80, 'placeholder-seed-2'
WHERE NOT EXISTS (SELECT 1 FROM clips WHERE id > 1 LIMIT 1);

INSERT INTO clips (recording_id, rank, moment_label, player_tags, like_count, bunny_video_id)
SELECT 3, 3, 'PENALTY · 45''', '{}', 60, 'placeholder-seed-3'
WHERE NOT EXISTS (SELECT 1 FROM clips WHERE id > 2 LIMIT 1);

-- Step 3: Assign placeholder videoIds to any clip that doesn't have one yet.
UPDATE clips
SET bunny_video_id = 'placeholder-' || id
WHERE bunny_video_id IS NULL;

-- Step 4: Set Bunny-format playback URLs for all placeholder clips.
-- Format: https://<BUNNY_CDN_HOSTNAME>/<videoId>/playlist.m3u8
-- BUNNY_CDN_HOSTNAME is read from the BUNNY_CDN_HOSTNAME environment variable
-- via pg's app settings, or defaults to a recognisable stub if not set.
UPDATE clips
SET bunny_playback_url =
  'https://' ||
  COALESCE(
    NULLIF(current_setting('app.bunny_cdn_hostname', true), ''),
    'your-cdn.b-cdn.net'
  ) || '/' || bunny_video_id || '/playlist.m3u8'
WHERE bunny_video_id LIKE 'placeholder-%';

-- Step 5: Verify result.
SELECT id, moment_label, bunny_video_id, bunny_playback_url FROM clips ORDER BY id;
