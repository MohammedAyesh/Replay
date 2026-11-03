-- Field console → Instagram autopilot: consent per field and per booking, the posting calendar, weekly awards,
-- save nominations and removal requests. Additive only.

ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "ig_consent_mode" text DEFAULT 'off' NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "ig_consent_since" timestamp with time zone;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "ig_consent_by" integer;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "ig_consent_wording" text;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "ig_autopilot" boolean DEFAULT false NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "ig_publish_mode" text DEFAULT 'approve' NOT NULL;
ALTER TABLE "venue_settings" ADD COLUMN IF NOT EXISTS "ig_slots" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "ig_consent" text;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "ig_consent_source" text;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "ig_consent_at" timestamp with time zone;
ALTER TABLE "venue_bookings" ADD COLUMN IF NOT EXISTS "under_18" boolean DEFAULT false NOT NULL;
ALTER TABLE "recordings" ADD COLUMN IF NOT EXISTS "camera_tilted" boolean DEFAULT false NOT NULL;
DO $$ BEGIN
  ALTER TABLE "venue_settings" ADD CONSTRAINT "venue_settings_ig_consent_by_users_id_fk" FOREIGN KEY ("ig_consent_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "venue_settings" ADD CONSTRAINT "venue_settings_ig_consent_mode_check" CHECK ("ig_consent_mode" in ('ask', 'owner', 'off'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "venue_settings" ADD CONSTRAINT "venue_settings_ig_publish_mode_check" CHECK ("ig_publish_mode" in ('approve', 'auto'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "venue_bookings" ADD CONSTRAINT "venue_bookings_ig_consent_check" CHECK ("ig_consent" is null or "ig_consent" in ('yes', 'no'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "venue_ig_consent_events" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_consent_events_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "changed_by" integer CONSTRAINT "venue_ig_consent_events_changed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "old_mode" text, "new_mode" text NOT NULL, "wording" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_consent_events_mode_check" CHECK ("new_mode" in ('ask', 'owner', 'off') and ("old_mode" is null or "old_mode" in ('ask', 'owner', 'off'))));
CREATE INDEX IF NOT EXISTS "venue_ig_consent_events_academy_idx" ON "venue_ig_consent_events" ("academy_id", "created_at");
CREATE TABLE IF NOT EXISTS "venue_ig_awards" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_awards_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "week_start" text NOT NULL, "category" text NOT NULL, "status" text DEFAULT 'nominating' NOT NULL,
  "nominees" jsonb DEFAULT '[]'::jsonb NOT NULL, "voting_ends_at" timestamp with time zone,
  "winner_key" text, "decided_by" text, "decided_at" timestamp with time zone,
  "decided_by_user" integer CONSTRAINT "venue_ig_awards_decided_by_user_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_awards_week_unique" UNIQUE("academy_id", "week_start", "category"),
  CONSTRAINT "venue_ig_awards_category_check" CHECK ("category" in ('goal', 'dribble', 'shot', 'save', 'fastest')),
  CONSTRAINT "venue_ig_awards_status_check" CHECK ("status" in ('nominating', 'voting', 'owner_pick', 'decided', 'posted', 'skipped')));
CREATE TABLE IF NOT EXISTS "venue_ig_award_votes" (
  "id" serial PRIMARY KEY,
  "award_id" integer NOT NULL CONSTRAINT "venue_ig_award_votes_award_id_venue_ig_awards_id_fk" REFERENCES "venue_ig_awards"("id") ON DELETE CASCADE,
  "nominee_key" text NOT NULL,
  "user_id" integer NOT NULL CONSTRAINT "venue_ig_award_votes_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_award_votes_user_unique" UNIQUE("award_id", "user_id"));
CREATE TABLE IF NOT EXISTS "venue_ig_nominations" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_nominations_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "category" text DEFAULT 'save' NOT NULL,
  "recording_id" integer NOT NULL CONSTRAINT "venue_ig_nominations_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE CASCADE,
  "booking_id" integer CONSTRAINT "venue_ig_nominations_booking_id_venue_bookings_id_fk" REFERENCES "venue_bookings"("id") ON DELETE CASCADE,
  "at_seconds" integer NOT NULL, "source" text NOT NULL,
  "nominated_by" integer CONSTRAINT "venue_ig_nominations_nominated_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text, "status" text DEFAULT 'pending' NOT NULL,
  "reviewed_by" integer CONSTRAINT "venue_ig_nominations_reviewed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_nominations_moment_unique" UNIQUE("academy_id", "category", "recording_id", "at_seconds"),
  CONSTRAINT "venue_ig_nominations_category_check" CHECK ("category" in ('save')),
  CONSTRAINT "venue_ig_nominations_source_check" CHECK ("source" in ('player', 'shot')),
  CONSTRAINT "venue_ig_nominations_status_check" CHECK ("status" in ('pending', 'approved', 'rejected')));
CREATE INDEX IF NOT EXISTS "venue_ig_nominations_academy_idx" ON "venue_ig_nominations" ("academy_id", "status");
CREATE TABLE IF NOT EXISTS "venue_ig_items" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_items_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "origin_key" text NOT NULL, "kind" text NOT NULL, "placement" text DEFAULT 'story' NOT NULL,
  "booking_id" integer CONSTRAINT "venue_ig_items_booking_id_venue_bookings_id_fk" REFERENCES "venue_bookings"("id") ON DELETE SET NULL,
  "award_id" integer CONSTRAINT "venue_ig_items_award_id_venue_ig_awards_id_fk" REFERENCES "venue_ig_awards"("id") ON DELETE SET NULL,
  "recording_id" integer CONSTRAINT "venue_ig_items_recording_id_recordings_id_fk" REFERENCES "recordings"("id") ON DELETE SET NULL,
  "clip_id" integer CONSTRAINT "venue_ig_items_clip_id_user_clips_id_fk" REFERENCES "user_clips"("id") ON DELETE SET NULL,
  "source" text NOT NULL, "moment" jsonb, "score" integer DEFAULT 0 NOT NULL,
  "slot_at" timestamp with time zone, "status" text DEFAULT 'planned' NOT NULL, "pinned" boolean DEFAULT false NOT NULL,
  "project_id" integer CONSTRAINT "venue_ig_items_project_id_academy_creative_projects_id_fk" REFERENCES "academy_creative_projects"("id") ON DELETE SET NULL,
  "post_id" integer CONSTRAINT "venue_ig_items_post_id_academy_social_posts_id_fk" REFERENCES "academy_social_posts"("id") ON DELETE SET NULL,
  "ig_media_id" text, "ig_permalink" text, "consent_mode" text, "consent_ref" jsonb,
  "insights" jsonb, "insights_at" timestamp with time zone, "error" text,
  "approved_by" integer CONSTRAINT "venue_ig_items_approved_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at" timestamp with time zone, "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_items_origin_unique" UNIQUE("academy_id", "origin_key"),
  CONSTRAINT "venue_ig_items_kind_check" CHECK ("kind" in ('booking_clip', 'award_nominees', 'award_winner')),
  CONSTRAINT "venue_ig_items_placement_check" CHECK ("placement" in ('story', 'reel')),
  CONSTRAINT "venue_ig_items_status_check" CHECK ("status" in ('planned', 'approved', 'rendering', 'ready', 'publishing', 'published', 'skipped', 'failed', 'removed', 'removal_flagged')));
CREATE INDEX IF NOT EXISTS "venue_ig_items_slot_idx" ON "venue_ig_items" ("academy_id", "slot_at");
CREATE INDEX IF NOT EXISTS "venue_ig_items_status_idx" ON "venue_ig_items" ("status", "slot_at");
CREATE TABLE IF NOT EXISTS "venue_ig_removals" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_removals_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "item_id" integer CONSTRAINT "venue_ig_removals_item_id_venue_ig_items_id_fk" REFERENCES "venue_ig_items"("id") ON DELETE SET NULL,
  "booking_id" integer CONSTRAINT "venue_ig_removals_booking_id_venue_bookings_id_fk" REFERENCES "venue_bookings"("id") ON DELETE SET NULL,
  "requested_by" integer CONSTRAINT "venue_ig_removals_requested_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL, "error" text, "resolved_at" timestamp with time zone,
  "resolved_by" integer CONSTRAINT "venue_ig_removals_resolved_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_removals_outcome_check" CHECK ("outcome" in ('deleted', 'flagged', 'withdrawn')));
CREATE INDEX IF NOT EXISTS "venue_ig_removals_academy_idx" ON "venue_ig_removals" ("academy_id", "created_at");
