-- Seed placeholder Bunny Stream HLS URLs into all existing clips.
-- Run with: psql "$DATABASE_URL" -f scripts/src/seed-bunny-placeholders.sql
--
-- Alternates between two public HLS test streams so each clip has a
-- playable URL until real Bunny Stream videos are uploaded.

UPDATE clips
SET
  bunny_playback_url = CASE WHEN (id % 2) = 1
    THEN 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    ELSE 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8'
  END,
  bunny_video_id = 'placeholder-' || id
WHERE bunny_playback_url IS NULL OR bunny_video_id LIKE 'placeholder-%';

SELECT id, moment_label, bunny_video_id, bunny_playback_url FROM clips ORDER BY id;
