-- Creative hub music library: Replay's tracks (scope 'replay', academy_id null) and academies' own uploads. Additive only.
-- Bundled tracks carry a key (assets/creative/music/<key>.m4a) and are seeded on boot; files are served only through the API.
CREATE TABLE IF NOT EXISTS "creative_music_tracks" (
  "id" serial PRIMARY KEY,
  "scope" text NOT NULL,
  "academy_id" integer CONSTRAINT "creative_music_tracks_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "key" text, "title" text NOT NULL, "artist" text, "mood" text NOT NULL, "bpm" integer,
  "duration_ms" integer NOT NULL, "path" text NOT NULL, "mime" text DEFAULT 'audio/mp4' NOT NULL,
  "loudness_lufs" real, "waveform" jsonb, "license" text NOT NULL, "status" text DEFAULT 'active' NOT NULL,
  "created_by" integer CONSTRAINT "creative_music_tracks_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_music_tracks_scope_check" CHECK ("scope" in ('replay', 'academy')),
  CONSTRAINT "creative_music_tracks_scope_academy_check" CHECK (("scope" = 'replay' and "academy_id" is null) or ("scope" = 'academy' and "academy_id" is not null)),
  CONSTRAINT "creative_music_tracks_mood_check" CHECK ("mood" in ('hype', 'epic', 'chill', 'fun', 'emotional', 'cinematic')),
  CONSTRAINT "creative_music_tracks_status_check" CHECK ("status" in ('active', 'hidden')));
CREATE INDEX IF NOT EXISTS "creative_music_tracks_academy_idx" ON "creative_music_tracks" ("academy_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "creative_music_tracks_key_unique" ON "creative_music_tracks" ("key") WHERE "key" is not null;
