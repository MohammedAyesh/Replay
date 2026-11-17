-- Portable cameras: kits, and one set-up per kit per pitch with its own calibration. Additive only.
CREATE TABLE IF NOT EXISTS "camera_kits" (
  "id" serial PRIMARY KEY,
  "academy_id" integer CONSTRAINT "camera_kits_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE SET NULL,
  "name" text NOT NULL, "camera_id" text NOT NULL,
  "field_id" integer CONSTRAINT "camera_kits_field_id_fields_id_fk" REFERENCES "fields"("id") ON DELETE SET NULL,
  "wifi_ssid" text, "wifi_password" text, "local_url" text,
  "token" text NOT NULL, "archived" boolean DEFAULT false NOT NULL,
  "created_by" integer CONSTRAINT "camera_kits_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "camera_kits_token_unique" UNIQUE("token"));
CREATE INDEX IF NOT EXISTS "camera_kits_academy_idx" ON "camera_kits" ("academy_id");
CREATE INDEX IF NOT EXISTS "camera_kits_camera_idx" ON "camera_kits" ("camera_id");
CREATE TABLE IF NOT EXISTS "camera_setups" (
  "id" serial PRIMARY KEY,
  "kit_id" integer NOT NULL CONSTRAINT "camera_setups_kit_id_camera_kits_id_fk" REFERENCES "camera_kits"("id") ON DELETE CASCADE,
  "academy_id" integer CONSTRAINT "camera_setups_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE SET NULL,
  "pitch_id" integer CONSTRAINT "camera_setups_pitch_id_venue_pitches_id_fk" REFERENCES "venue_pitches"("id") ON DELETE SET NULL,
  "place_name" text, "place_size" text, "known_length_m" real, "known_width_m" real,
  "mast_height_m" real NOT NULL, "kind" text DEFAULT 'match' NOT NULL, "title" text,
  "status" text DEFAULT 'setting_up' NOT NULL,
  "view_confirmed_at" timestamp with time zone, "started_at" timestamp with time zone,
  "ends_at" timestamp with time zone, "stopped_at" timestamp with time zone,
  "start_local" text, "end_local" text,
  "footage_request_id" integer CONSTRAINT "camera_setups_footage_request_id_footage_requests_id_fk" REFERENCES "footage_requests"("id") ON DELETE SET NULL,
  "calibration" jsonb, "pitch_model" jsonb, "measured_length_m" real, "measured_width_m" real,
  "review_note" text,
  "reviewed_by" integer CONSTRAINT "camera_setups_reviewed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  "created_by" integer CONSTRAINT "camera_setups_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "camera_setups_kind_check" CHECK ("kind" in ('match', 'training', 'session')),
  CONSTRAINT "camera_setups_status_check" CHECK ("status" in ('setting_up', 'recording', 'measuring', 'measured', 'needs_look', 'approved', 'failed', 'cancelled')),
  CONSTRAINT "camera_setups_mast_check" CHECK ("mast_height_m" between 1 and 20));
CREATE INDEX IF NOT EXISTS "camera_setups_kit_idx" ON "camera_setups" ("kit_id", "created_at");
CREATE INDEX IF NOT EXISTS "camera_setups_academy_idx" ON "camera_setups" ("academy_id", "created_at");
CREATE INDEX IF NOT EXISTS "camera_setups_status_idx" ON "camera_setups" ("status");
ALTER TABLE "venue_pitches" ADD COLUMN IF NOT EXISTS "length_m" real;
ALTER TABLE "venue_pitches" ADD COLUMN IF NOT EXISTS "width_m" real;
ALTER TABLE "venue_pitches" ADD COLUMN IF NOT EXISTS "auto_approve_size" boolean DEFAULT true NOT NULL;
