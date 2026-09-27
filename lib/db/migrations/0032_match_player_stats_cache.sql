CREATE TABLE "match_player_stats_cache" (
  "id" serial PRIMARY KEY NOT NULL,
  "match_id" integer NOT NULL REFERENCES "match_rooms"("id") ON DELETE CASCADE,
  "match_player_id" integer NOT NULL REFERENCES "match_players"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "recording_ids" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
  "fingerprint" text NOT NULL,
  "stats" jsonb NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "match_player_stats_cache_match_player_uidx"
  ON "match_player_stats_cache" USING btree ("match_id", "match_player_id");
CREATE INDEX "match_player_stats_cache_user_idx"
  ON "match_player_stats_cache" USING btree ("user_id");