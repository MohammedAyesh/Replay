-- follows table: one-way player follows
CREATE TABLE IF NOT EXISTS "follows" (
  "follower_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "followee_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("follower_id", "followee_id")
);

-- clips: nullable creator reference
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "creator_id" integer REFERENCES "users"("id") ON DELETE SET NULL;
