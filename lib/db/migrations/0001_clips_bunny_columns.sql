-- Migration: add Bunny Stream columns to clips table
-- Safe to run multiple times (IF NOT EXISTS).
ALTER TABLE clips ADD COLUMN IF NOT EXISTS bunny_video_id TEXT;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS bunny_playback_url TEXT;
