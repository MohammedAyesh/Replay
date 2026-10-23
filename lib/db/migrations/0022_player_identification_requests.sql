CREATE TABLE IF NOT EXISTS "player_identification_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "recording_id" integer NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "requester_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "recipient_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "match_code" text,
  "roster_player_id" text NOT NULL,
  "player_name" text,
  "shirt_number" text,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "responded_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "player_identification_requests_recipient_status_idx"
  ON "player_identification_requests" ("recipient_user_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "player_identification_requests_pending_unique"
  ON "player_identification_requests" ("recording_id", "requester_user_id", "recipient_user_id", "roster_player_id")
  WHERE "status" = 'pending';
