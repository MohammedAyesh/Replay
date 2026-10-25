-- "Is this you?" deck answers (2026-10-25): one row per player per moment.
CREATE TABLE IF NOT EXISTS "claim_moment_checks" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "recording_id" integer NOT NULL,
  "moment_id" text NOT NULL,
  "verdict" text NOT NULL,
  "track_id" text,
  "from_frame" integer,
  "to_frame" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_moment_checks_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_moment_checks_recording_id_recordings_id_fk"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_moment_checks_unique" UNIQUE ("user_id", "recording_id", "moment_id"),
  CONSTRAINT "claim_moment_checks_verdict_check" CHECK ("verdict" IN ('yes', 'no', 'skip'))
);
CREATE INDEX IF NOT EXISTS "claim_moment_checks_recording_idx" ON "claim_moment_checks" USING btree ("recording_id");
