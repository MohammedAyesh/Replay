CREATE TABLE IF NOT EXISTS "free_match_rewards" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "source_match_id" integer NOT NULL,
  "status" text DEFAULT 'available' NOT NULL,
  "free_hours" integer NOT NULL,
  "worth_fils" integer NOT NULL,
  "friend_names" text[] DEFAULT '{}' NOT NULL,
  "earned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_match_id" integer,
  "used_at" timestamp with time zone,
  CONSTRAINT "free_match_rewards_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "free_match_rewards_source_match_id_match_rooms_id_fk"
    FOREIGN KEY ("source_match_id") REFERENCES "match_rooms"("id") ON DELETE CASCADE,
  CONSTRAINT "free_match_rewards_used_match_id_match_rooms_id_fk"
    FOREIGN KEY ("used_match_id") REFERENCES "match_rooms"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "free_match_rewards_source_unique" ON "free_match_rewards" USING btree ("source_match_id");
CREATE INDEX IF NOT EXISTS "free_match_rewards_user_idx" ON "free_match_rewards" USING btree ("user_id");
