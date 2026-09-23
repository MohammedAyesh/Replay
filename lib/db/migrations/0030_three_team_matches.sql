-- Three-team matches: a third team (C) on the room, and which two teams played
-- each game. Additive only; safe to apply to a live database.

ALTER TABLE "match_rooms" ADD COLUMN IF NOT EXISTS "team_count" integer DEFAULT 2 NOT NULL;
ALTER TABLE "match_rooms" ADD COLUMN IF NOT EXISTS "team_c_name" text;
ALTER TABLE "match_rooms" ADD COLUMN IF NOT EXISTS "team_c_color" text DEFAULT '#2FD8C4' NOT NULL;

ALTER TABLE "match_games" ADD COLUMN IF NOT EXISTS "team_x" text DEFAULT 'A' NOT NULL;
ALTER TABLE "match_games" ADD COLUMN IF NOT EXISTS "team_y" text DEFAULT 'B' NOT NULL;
