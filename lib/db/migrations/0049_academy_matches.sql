-- Academy match pages, lineups with shirt numbers, and per-player match stats. Additive only.
CREATE TABLE IF NOT EXISTS "academy_match_pages" (
  "session_id" integer PRIMARY KEY CONSTRAINT "academy_match_pages_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE CASCADE,
  "academy_id" integer NOT NULL CONSTRAINT "academy_match_pages_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "recording_id" integer CONSTRAINT "academy_match_pages_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE SET NULL,
  "published" boolean NOT NULL DEFAULT false,
  "kit_color" text,
  "opponent_kit_color" text,
  "players_per_side" integer,
  "shirts_have_numbers" text NOT NULL DEFAULT 'yes',
  "team_stats" jsonb,
  "stats_fingerprint" text,
  "stats_computed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_match_pages_shirts_check" CHECK ("shirts_have_numbers" IN ('yes', 'no', 'unknown')),
  CONSTRAINT "academy_match_pages_players_per_side_check" CHECK ("players_per_side" IS NULL OR "players_per_side" BETWEEN 3 AND 11)
);
CREATE INDEX IF NOT EXISTS "academy_match_pages_academy_idx" ON "academy_match_pages" ("academy_id");

CREATE TABLE IF NOT EXISTS "academy_match_lineups" (
  "id" serial PRIMARY KEY,
  "session_id" integer NOT NULL CONSTRAINT "academy_match_lineups_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_match_lineups_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "shirt_number" integer,
  "in_squad" boolean NOT NULL DEFAULT true,
  "roster_player_id" text,
  "bound_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_match_lineups_session_player_unique" UNIQUE ("session_id", "player_id"),
  CONSTRAINT "academy_match_lineups_shirt_check" CHECK ("shirt_number" IS NULL OR "shirt_number" BETWEEN 0 AND 99),
  CONSTRAINT "academy_match_lineups_bound_by_check" CHECK ("bound_by" IS NULL OR "bound_by" IN ('owner'))
);

CREATE TABLE IF NOT EXISTS "academy_match_player_stats" (
  "id" serial PRIMARY KEY,
  "session_id" integer NOT NULL CONSTRAINT "academy_match_player_stats_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE CASCADE,
  "academy_id" integer NOT NULL CONSTRAINT "academy_match_player_stats_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_match_player_stats_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "recording_id" integer NOT NULL CONSTRAINT "academy_match_player_stats_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE CASCADE,
  "roster_player_id" text,
  "stats" jsonb NOT NULL,
  "computed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_match_player_stats_session_player_unique" UNIQUE ("session_id", "player_id")
);
CREATE INDEX IF NOT EXISTS "academy_match_player_stats_player_idx" ON "academy_match_player_stats" ("player_id");
CREATE INDEX IF NOT EXISTS "academy_match_player_stats_academy_idx" ON "academy_match_player_stats" ("academy_id");
