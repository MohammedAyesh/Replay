-- 0015_matches.sql
-- Adds camera_id to fields, creates the matches table with FK + index,
-- and seeds Jordan Galaxy's camera_id.

-- (a) Add camera_id to fields if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'fields'
      AND column_name  = 'camera_id'
  ) THEN
    ALTER TABLE fields ADD COLUMN camera_id TEXT;
  END IF;
END $$;

-- (b) Seed Jordan Galaxy
UPDATE fields
  SET camera_id = 'camera1'
  WHERE name ILIKE '%jordan%galaxy%'
    AND (camera_id IS NULL OR camera_id = '');

-- (c) Create matches table
CREATE TABLE IF NOT EXISTS matches (
  id               SERIAL PRIMARY KEY,
  field_id         INTEGER NOT NULL,
  title            TEXT NOT NULL,
  scheduled_start  TIMESTAMPTZ NOT NULL,
  scheduled_end    TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled',
  auto_start_live  BOOLEAN NOT NULL DEFAULT TRUE,
  live_started_at  TIMESTAMPTZ,
  live_stopped_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (d) Add FK from matches.field_id → fields.id — guarded by checking the
--     column reference in information_schema (NOT by constraint name, because
--     the inline-reference name Postgres assigns and drizzle's generated name
--     differ and a name-based guard silently creates a duplicate FK).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage kcu
      ON  rc.constraint_name   = kcu.constraint_name
      AND rc.constraint_schema = kcu.constraint_schema
    WHERE kcu.table_schema  = 'public'
      AND kcu.table_name    = 'matches'
      AND kcu.column_name   = 'field_id'
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_field_id_fk
      FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE;
  END IF;
END $$;

-- (e) Index on (field_id, scheduled_start)
CREATE INDEX IF NOT EXISTS matches_field_id_scheduled_start_idx
  ON matches (field_id, scheduled_start);
