-- Migration: per-academy intro video, prepended to clip export + playback
-- Safe to run multiple times (IF NOT EXISTS / DO NOTHING).

ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "intro_video_url" text;

ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "academy_id" integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'user_clips' AND constraint_name = 'user_clips_academy_id_academies_id_fk'
  ) THEN
    ALTER TABLE "user_clips" ADD CONSTRAINT "user_clips_academy_id_academies_id_fk"
      FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Constraint name matches what `drizzle-kit push` generates for
-- academyId: integer("academy_id").references(() => academiesTable.id, ...)
-- in lib/db/src/schema/userClips.ts. Naming it anything else means a later
-- push adds a SECOND foreign key on the same column, because the IF NOT EXISTS
-- guard above only checks the name written here.
