-- Seed placeholder Bunny Stream clips.
-- Run with: psql "$DATABASE_URL" -f scripts/src/seed-bunny-placeholders.sql
--
-- Uses Bunny Stream CDN URL format: https://<BUNNY_CDN_HOSTNAME>/<videoId>/playlist.m3u8
-- Set BUNNY_CDN_HOSTNAME env var or pass it as a psql variable:
--   psql "$DATABASE_URL" -v cdn_host=your-cdn.b-cdn.net -f seed-bunny-placeholders.sql
--
-- Safe to run multiple times (idempotent UPDATE).

-- Step 1: Ensure the columns exist.
ALTER TABLE clips ADD COLUMN IF NOT EXISTS bunny_video_id TEXT;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS bunny_playback_url TEXT;

-- Step 2: Assign placeholder Bunny video IDs to all clips that don't have real ones.
UPDATE clips
SET bunny_video_id = 'placeholder-' || id
WHERE bunny_video_id IS NULL;

-- Step 3: Build Bunny-format playback URLs from the stored videoId.
-- Uses psql variable :cdn_host if supplied, otherwise falls back to the
-- BUNNY_CDN_HOSTNAME postgres setting (set externally) or a recognisable stub.
UPDATE clips
SET bunny_playback_url = 'https://' ||
  COALESCE(
    NULLIF(current_setting('app.bunny_cdn_hostname', true), ''),
    'your-cdn.b-cdn.net'
  ) || '/' || bunny_video_id || '/playlist.m3u8'
WHERE bunny_video_id LIKE 'placeholder-%';

-- Step 4: Verify.
SELECT id, moment_label, bunny_video_id, bunny_playback_url FROM clips ORDER BY id;
