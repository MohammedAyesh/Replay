-- Match rooms: the players' side of an owner booking (roster, teams, score,
-- MOTM vote, stats purchases), plus the player's own photo and shirt number.
-- Additive only; safe to apply to a live database.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_path" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shirt_number" integer;

CREATE TABLE IF NOT EXISTS "match_rooms" (
  "id" serial PRIMARY KEY NOT NULL,
  "footage_request_id" integer NOT NULL,
  "field_id" integer NOT NULL,
  "code" text NOT NULL,
  "captain_user_id" integer,
  "captain_token" text NOT NULL,
  "title" text,
  "players_per_side" integer DEFAULT 6 NOT NULL,
  "team_a_name" text,
  "team_b_name" text,
  "team_a_color" text DEFAULT '#F2F4F8' NOT NULL,
  "team_b_color" text DEFAULT '#FF6B1A' NOT NULL,
  "score_a" integer,
  "score_b" integer,
  "score_updated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "match_rooms_footage_request_id_unique" UNIQUE("footage_request_id"),
  CONSTRAINT "match_rooms_code_unique" UNIQUE("code")
);

CREATE TABLE IF NOT EXISTS "match_players" (
  "id" serial PRIMARY KEY NOT NULL,
  "match_id" integer NOT NULL,
  "user_id" integer,
  "display_name" text NOT NULL,
  "contact_phone" text,
  "contact_email" text,
  "invited_by_player_id" integer,
  "invite_token" text NOT NULL,
  "rsvp" text DEFAULT 'invited' NOT NULL,
  "team" text,
  "shirt_number" integer,
  "slot_x" real,
  "slot_y" real,
  "rsvp_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "match_players_invite_token_unique" UNIQUE("invite_token"),
  CONSTRAINT "match_players_match_user_unique" UNIQUE("match_id","user_id")
);
CREATE INDEX IF NOT EXISTS "match_players_user_idx" ON "match_players" ("user_id");

CREATE TABLE IF NOT EXISTS "match_games" (
  "id" serial PRIMARY KEY NOT NULL,
  "match_id" integer NOT NULL,
  "idx" integer NOT NULL,
  "start_offset_sec" integer NOT NULL,
  "end_offset_sec" integer NOT NULL,
  "score_a" integer,
  "score_b" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "match_games_match_idx_unique" UNIQUE("match_id","idx")
);

CREATE TABLE IF NOT EXISTS "motm_votes" (
  "id" serial PRIMARY KEY NOT NULL,
  "match_id" integer NOT NULL,
  "voter_user_id" integer NOT NULL,
  "candidate_player_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "motm_votes_match_voter_unique" UNIQUE("match_id","voter_user_id")
);

CREATE TABLE IF NOT EXISTS "stat_unlocks" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "match_id" integer,
  "kind" text NOT NULL,
  "amount_fils" integer NOT NULL,
  "method" text DEFAULT 'cliq' NOT NULL,
  "reference" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "valid_until" timestamp with time zone,
  "confirmed_by" integer,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stat_unlocks_reference_unique" UNIQUE("reference")
);
CREATE INDEX IF NOT EXISTS "stat_unlocks_user_idx" ON "stat_unlocks" ("user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_rooms_footage_request_id_footage_requests_id_fk') THEN
    ALTER TABLE "match_rooms" ADD CONSTRAINT "match_rooms_footage_request_id_footage_requests_id_fk"
      FOREIGN KEY ("footage_request_id") REFERENCES "footage_requests"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_rooms_field_id_fields_id_fk') THEN
    ALTER TABLE "match_rooms" ADD CONSTRAINT "match_rooms_field_id_fields_id_fk"
      FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_rooms_captain_user_id_users_id_fk') THEN
    ALTER TABLE "match_rooms" ADD CONSTRAINT "match_rooms_captain_user_id_users_id_fk"
      FOREIGN KEY ("captain_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_players_match_id_match_rooms_id_fk') THEN
    ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_match_rooms_id_fk"
      FOREIGN KEY ("match_id") REFERENCES "match_rooms"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_players_user_id_users_id_fk') THEN
    ALTER TABLE "match_players" ADD CONSTRAINT "match_players_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_games_match_id_match_rooms_id_fk') THEN
    ALTER TABLE "match_games" ADD CONSTRAINT "match_games_match_id_match_rooms_id_fk"
      FOREIGN KEY ("match_id") REFERENCES "match_rooms"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'motm_votes_match_id_match_rooms_id_fk') THEN
    ALTER TABLE "motm_votes" ADD CONSTRAINT "motm_votes_match_id_match_rooms_id_fk"
      FOREIGN KEY ("match_id") REFERENCES "match_rooms"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'motm_votes_voter_user_id_users_id_fk') THEN
    ALTER TABLE "motm_votes" ADD CONSTRAINT "motm_votes_voter_user_id_users_id_fk"
      FOREIGN KEY ("voter_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'motm_votes_candidate_player_id_match_players_id_fk') THEN
    ALTER TABLE "motm_votes" ADD CONSTRAINT "motm_votes_candidate_player_id_match_players_id_fk"
      FOREIGN KEY ("candidate_player_id") REFERENCES "match_players"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stat_unlocks_user_id_users_id_fk') THEN
    ALTER TABLE "stat_unlocks" ADD CONSTRAINT "stat_unlocks_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stat_unlocks_match_id_match_rooms_id_fk') THEN
    ALTER TABLE "stat_unlocks" ADD CONSTRAINT "stat_unlocks_match_id_match_rooms_id_fk"
      FOREIGN KEY ("match_id") REFERENCES "match_rooms"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stat_unlocks_confirmed_by_users_id_fk') THEN
    ALTER TABLE "stat_unlocks" ADD CONSTRAINT "stat_unlocks_confirmed_by_users_id_fk"
      FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
