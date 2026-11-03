-- Marketing practices: trial clips with a follow-up, referrals, the review link and the weekly content calendar. Additive only.
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "google_review_url" text;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "referred_by_contact_id" integer CONSTRAINT "academy_contacts_referred_by_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE SET NULL;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "referral_note" text;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "trial_session_id" integer CONSTRAINT "academy_contacts_trial_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE SET NULL;
ALTER TABLE "academy_feature_settings" ADD COLUMN IF NOT EXISTS "content_calendar" jsonb;
CREATE TABLE IF NOT EXISTS "academy_trial_clips" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_trial_clips_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "contact_id" integer NOT NULL CONSTRAINT "academy_trial_clips_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE CASCADE,
  "session_id" integer CONSTRAINT "academy_trial_clips_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE SET NULL,
  "recording_id" integer CONSTRAINT "academy_trial_clips_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE SET NULL,
  "user_clip_id" integer CONSTRAINT "academy_trial_clips_user_clip_id_user_clips_id_fk" REFERENCES "user_clips"("id") ON DELETE SET NULL,
  "token" text NOT NULL, "child_name" text, "moment_seconds" real NOT NULL,
  "status" text DEFAULT 'prepared' NOT NULL,
  "sent_at" timestamp with time zone, "opened_at" timestamp with time zone,
  "follow_up_status" text, "follow_up_at" timestamp with time zone,
  "created_by" integer CONSTRAINT "academy_trial_clips_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_trial_clips_token_unique" UNIQUE("token"),
  CONSTRAINT "academy_trial_clips_token_check" CHECK ("token" ~ '^[0-9a-f]{32}$'),
  CONSTRAINT "academy_trial_clips_status_check" CHECK ("status" in ('prepared', 'sent', 'failed')),
  CONSTRAINT "academy_trial_clips_follow_up_check" CHECK ("follow_up_status" is null or "follow_up_status" in ('pending', 'sent', 'skipped')));
CREATE INDEX IF NOT EXISTS "academy_trial_clips_academy_idx" ON "academy_trial_clips" ("academy_id", "created_at");
CREATE INDEX IF NOT EXISTS "academy_trial_clips_follow_up_idx" ON "academy_trial_clips" ("follow_up_status", "follow_up_at");
