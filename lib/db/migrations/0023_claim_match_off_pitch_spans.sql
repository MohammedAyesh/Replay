CREATE TABLE IF NOT EXISTS "claim_match_off_pitch_spans" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "recording_id" integer NOT NULL,
  "client_id" text NOT NULL,
  "from_seconds" double precision NOT NULL,
  "to_seconds" double precision NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_match_off_pitch_spans_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "claim_match_off_pitch_spans_recording_id_recordings_id_fk"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "claim_match_off_pitch_spans_user_recording_client_unique"
  ON "claim_match_off_pitch_spans" USING btree ("user_id", "recording_id", "client_id");