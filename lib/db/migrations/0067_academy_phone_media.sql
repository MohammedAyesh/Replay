-- Phone videos and photos sorted by match time (before / during / after / not linked). Additive only. No GPS is stored.
CREATE TABLE IF NOT EXISTS "academy_phone_media" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_phone_media_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "media_id" integer NOT NULL CONSTRAINT "academy_phone_media_media_id_academy_ad_media_id_fk" REFERENCES "academy_ad_media"("id") ON DELETE CASCADE,
  "kind" text NOT NULL, "file_name" text DEFAULT '' NOT NULL,
  "uploaded_by" integer CONSTRAINT "academy_phone_media_uploaded_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "uploader_role" text NOT NULL,
  "player_id" integer CONSTRAINT "academy_phone_media_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE SET NULL,
  "captured_start" timestamp with time zone, "captured_end" timestamp with time zone, "capture_date" text,
  "capture_source" text DEFAULT 'none' NOT NULL, "capture_confidence" text DEFAULT 'low' NOT NULL, "capture_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "venue" text DEFAULT 'unknown' NOT NULL,
  "session_id" integer CONSTRAINT "academy_phone_media_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE SET NULL,
  "phase" text DEFAULT 'unlinked' NOT NULL, "offset_sec" real,
  "recording_id" integer CONSTRAINT "academy_phone_media_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE SET NULL,
  "needs_review" boolean DEFAULT false NOT NULL, "review_reason" text, "linked_by" text DEFAULT 'auto' NOT NULL,
  "player_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_phone_media_kind_check" CHECK ("kind" in ('image', 'video')),
  CONSTRAINT "academy_phone_media_phase_check" CHECK ("phase" in ('before', 'during', 'after', 'unlinked')),
  CONSTRAINT "academy_phone_media_role_check" CHECK ("uploader_role" in ('owner', 'manager', 'coach', 'parent')),
  CONSTRAINT "academy_phone_media_venue_check" CHECK ("venue" in ('at_venue', 'elsewhere', 'unknown')),
  CONSTRAINT "academy_phone_media_linked_by_check" CHECK ("linked_by" in ('auto', 'coach')));
CREATE INDEX IF NOT EXISTS "academy_phone_media_academy_idx" ON "academy_phone_media" ("academy_id", "created_at");
CREATE INDEX IF NOT EXISTS "academy_phone_media_session_idx" ON "academy_phone_media" ("session_id");
