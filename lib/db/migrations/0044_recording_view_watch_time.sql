ALTER TABLE "recording_views"
  ADD COLUMN IF NOT EXISTS "watched_seconds" integer NOT NULL DEFAULT 0;
