-- Players confirming goals (2026-10-25): one row per player per goal candidate.
CREATE TABLE IF NOT EXISTS "recording_goal_votes" (
  "id" serial PRIMARY KEY NOT NULL,
  "recording_id" integer NOT NULL,
  "at_tenths" integer NOT NULL,
  "user_id" integer NOT NULL,
  "verdict" text NOT NULL,
  "match_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recording_goal_votes_recording_id_recordings_id_fk"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE CASCADE,
  CONSTRAINT "recording_goal_votes_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "recording_goal_votes_match_id_match_rooms_id_fk"
    FOREIGN KEY ("match_id") REFERENCES "match_rooms"("id") ON DELETE SET NULL,
  CONSTRAINT "recording_goal_votes_unique" UNIQUE ("recording_id", "at_tenths", "user_id"),
  CONSTRAINT "recording_goal_votes_verdict_check" CHECK ("verdict" IN ('goal', 'not_goal'))
);
CREATE INDEX IF NOT EXISTS "recording_goal_votes_recording_idx" ON "recording_goal_votes" USING btree ("recording_id");
