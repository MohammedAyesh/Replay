CREATE TABLE IF NOT EXISTS "recording_tracking_bundles" (
  "id" serial PRIMARY KEY,
  "recording_id" integer NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "payload" jsonb NOT NULL,
  "uploaded_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "recording_tracking_bundles_recording_unique"
  ON "recording_tracking_bundles" ("recording_id");

CREATE TABLE IF NOT EXISTS "claim_match_progress" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "recording_id" integer NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "current_track_id" text,
  "stage" text NOT NULL DEFAULT 'find',
  "confirmed_from_seconds" double precision NOT NULL DEFAULT 0,
  "current_position_seconds" double precision NOT NULL DEFAULT 0,
  "claimed_percent" double precision NOT NULL DEFAULT 0,
  "clips_unlocked" integer NOT NULL DEFAULT 0,
  "correction_count" integer NOT NULL DEFAULT 0,
  "completed" boolean NOT NULL DEFAULT false,
  "earned_clips" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "claim_match_progress_user_recording_unique"
  ON "claim_match_progress" ("user_id", "recording_id");

CREATE TABLE IF NOT EXISTS "claim_match_corrections" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "recording_id" integer NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL,
  "moment_seconds" double precision NOT NULL,
  "rejected_track_id" text,
  "chosen_track_id" text NOT NULL,
  "answer_method" text NOT NULL,
  "question_count" integer NOT NULL DEFAULT 0,
  "undone" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "claim_match_corrections_client_unique"
  ON "claim_match_corrections" ("user_id", "recording_id", "client_id");