-- "Every child appears": public-post consent per child, the feature log, the owner's targets and each child's private clip per match. Additive only.
ALTER TABLE "academy_players" ADD COLUMN IF NOT EXISTS "public_posts_consent" boolean DEFAULT false NOT NULL;
ALTER TABLE "academy_players" ADD COLUMN IF NOT EXISTS "public_posts_consent_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS "academy_player_features" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_player_features_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_player_features_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "item_type" text NOT NULL, "item_id" text NOT NULL, "visibility" text NOT NULL, "solo" boolean DEFAULT false NOT NULL,
  "featured_at" timestamp with time zone NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_player_features_item_unique" UNIQUE("player_id", "item_type", "item_id"),
  CONSTRAINT "academy_player_features_type_check" CHECK ("item_type" in ('post', 'clip', 'whatsapp', 'phone_video')),
  CONSTRAINT "academy_player_features_visibility_check" CHECK ("visibility" in ('public', 'private')));
CREATE INDEX IF NOT EXISTS "academy_player_features_academy_idx" ON "academy_player_features" ("academy_id", "featured_at");
CREATE TABLE IF NOT EXISTS "academy_feature_settings" (
  "academy_id" integer PRIMARY KEY CONSTRAINT "academy_feature_settings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "public_posts_per_month" integer DEFAULT 1 NOT NULL, "private_clip_per_match" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_feature_settings_posts_check" CHECK ("public_posts_per_month" between 0 and 8));
CREATE TABLE IF NOT EXISTS "academy_player_clips" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_player_clips_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL CONSTRAINT "academy_player_clips_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_player_clips_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "recording_id" integer CONSTRAINT "academy_player_clips_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE SET NULL,
  "user_clip_id" integer CONSTRAINT "academy_player_clips_user_clip_id_user_clips_id_fk" REFERENCES "user_clips"("id") ON DELETE SET NULL,
  "token" text NOT NULL, "moment_kind" text, "moment_seconds" real, "note" jsonb, "status" text DEFAULT 'prepared' NOT NULL,
  "sent_at" timestamp with time zone, "opened_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_player_clips_session_player_unique" UNIQUE("session_id", "player_id"),
  CONSTRAINT "academy_player_clips_token_unique" UNIQUE("token"),
  CONSTRAINT "academy_player_clips_status_check" CHECK ("status" in ('prepared', 'sent', 'no_moment', 'failed')),
  CONSTRAINT "academy_player_clips_token_check" CHECK ("token" ~ '^[0-9a-f]{32}$'));
CREATE INDEX IF NOT EXISTS "academy_player_clips_academy_idx" ON "academy_player_clips" ("academy_id", "created_at");
