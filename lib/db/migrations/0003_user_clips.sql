-- Migration: create user_clips table for live-recorded crop-path clips
-- Safe to run multiple times (IF NOT EXISTS / DO NOTHING).

CREATE TABLE IF NOT EXISTS user_clips (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  start_time  NUMERIC(10, 6) NOT NULL,
  end_time    NUMERIC(10, 6) NOT NULL,
  crop_path   JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
