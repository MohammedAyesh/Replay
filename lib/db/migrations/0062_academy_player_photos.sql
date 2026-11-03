-- Players' photo galleries for the Creative hub (line-ups, player posts). Additive only.
-- One primary photo per player; files live in Bunny Storage and are served only through the academy console.
CREATE TABLE IF NOT EXISTS "academy_player_photos" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_player_photos_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_player_photos_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "path" text NOT NULL, "mime" text NOT NULL, "width" integer NOT NULL, "height" integer NOT NULL,
  "transparent" boolean DEFAULT false NOT NULL, "label" text, "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" integer CONSTRAINT "academy_player_photos_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "academy_player_photos_mime_check" CHECK ("mime" in ('image/png', 'image/webp')));
CREATE INDEX IF NOT EXISTS "academy_player_photos_player_idx" ON "academy_player_photos" ("player_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "academy_player_photos_primary_unique" ON "academy_player_photos" ("player_id") WHERE "is_primary";
