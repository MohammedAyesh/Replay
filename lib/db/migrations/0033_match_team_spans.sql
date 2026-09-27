CREATE TABLE "match_team_spans" (
  "id" serial PRIMARY KEY NOT NULL,
  "match_id" integer NOT NULL REFERENCES "match_rooms"("id") ON DELETE CASCADE,
  "match_player_id" integer NOT NULL REFERENCES "match_players"("id") ON DELETE CASCADE,
  "from_offset_sec" integer NOT NULL,
  "to_offset_sec" integer,
  "team" text,
  "source" text NOT NULL,
  "changed_shirt" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "match_team_spans_match_player_idx"
  ON "match_team_spans" USING btree ("match_id", "match_player_id");