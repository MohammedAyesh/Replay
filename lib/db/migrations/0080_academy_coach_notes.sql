-- Coach board: a coach's saved moments of a match (drawings, spotlighted players, a comment). Additive only.
CREATE TABLE IF NOT EXISTS "academy_coach_notes" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_coach_notes_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL CONSTRAINT "academy_coach_notes_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE CASCADE,
  "recording_id" integer CONSTRAINT "academy_coach_notes_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE SET NULL,
  "title" text DEFAULT '' NOT NULL, "body" text, "at_ms" integer NOT NULL, "end_ms" integer,
  "board" jsonb NOT NULL, "player_ids" jsonb DEFAULT '[]'::jsonb NOT NULL, "shared" boolean DEFAULT false NOT NULL,
  "created_by" integer CONSTRAINT "academy_coach_notes_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE INDEX IF NOT EXISTS "academy_coach_notes_session_idx" ON "academy_coach_notes" ("session_id", "at_ms");
CREATE INDEX IF NOT EXISTS "academy_coach_notes_academy_idx" ON "academy_coach_notes" ("academy_id", "created_at");
