-- Creative hub: an admin's recommended music per template (ordered Replay track ids and how they play). Additive only.
-- No row = Replay's built-in recommendation (TEMPLATE_RECOMMENDED_MUSIC); deleting a row resets the template to it.
CREATE TABLE IF NOT EXISTS "creative_template_music" (
  "template_key" text PRIMARY KEY,
  "track_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "volume" real NOT NULL, "duck" boolean DEFAULT false NOT NULL,
  "fade_in_ms" integer NOT NULL, "fade_out_ms" integer NOT NULL, "start_ms" integer DEFAULT 0 NOT NULL,
  "updated_by" integer CONSTRAINT "creative_template_music_updated_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
