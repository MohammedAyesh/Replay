-- Migration: per-academy intro video, prepended to clip export + playback
-- Safe to run multiple times (IF NOT EXISTS / DO NOTHING).

ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "intro_video_url" text;

ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "academy_id" integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'user_clips' AND constraint_name = 'user_clips_academy_id_fkey'
  ) THEN
    ALTER TABLE "user_clips" ADD CONSTRAINT "user_clips_academy_id_fkey"
      FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE SET NULL;
  END IF;
END $$;
