-- Migration: per-academy intro video, prepended to clip export + playback
-- Safe to run multiple times.

ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "intro_video_url" text;

ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "academy_id" integer;

-- Guard on the COLUMN, not on a constraint name.
--
-- Postgres names an inline REFERENCES clause "user_clips_academy_id_fkey";
-- drizzle-kit push names the same thing
-- "user_clips_academy_id_academies_id_fk". A name-based IF NOT EXISTS check
-- misses whichever form is already present and adds a SECOND foreign key on
-- the same column. The live database currently carries the _fkey form (it was
-- pushed from the feature branch), so this normalises the name — after which
-- schema push and this migration agree and neither adds a duplicate.
DO $$
DECLARE
  existing_name text;
BEGIN
  SELECT con.conname INTO existing_name
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
  WHERE con.conrelid = 'user_clips'::regclass
    AND con.contype = 'f'
    AND att.attname = 'academy_id'
  LIMIT 1;

  IF existing_name IS NULL THEN
    ALTER TABLE "user_clips" ADD CONSTRAINT "user_clips_academy_id_academies_id_fk"
      FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE SET NULL;
  ELSIF existing_name <> 'user_clips_academy_id_academies_id_fk' THEN
    EXECUTE format(
      'ALTER TABLE "user_clips" RENAME CONSTRAINT %I TO %I',
      existing_name, 'user_clips_academy_id_academies_id_fk'
    );
  END IF;
END $$;
