import type { pool as dbPool } from "@workspace/db";

type Pool = typeof dbPool;

/** academies.creative_pack: a PACK_STYLES key or null (0057). Exported for the test that compares it with PACK_STYLES. */
export const CREATIVE_PACK_COLUMN =
  `text CONSTRAINT "academies_creative_pack_check" CHECK ("creative_pack" is null or "creative_pack" in ('iris', 'souqar', 'barca', 'juventus', 'knights', 'jufa'))`;

/** 0058: players' photo galleries. Exported for the test that compares it with the migration file. */
export const PLAYER_PHOTOS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_player_photos" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_player_photos_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_player_photos_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "path" text NOT NULL, "mime" text NOT NULL, "width" integer NOT NULL, "height" integer NOT NULL,
  "transparent" boolean DEFAULT false NOT NULL, "label" text, "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" integer CONSTRAINT "academy_player_photos_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "academy_player_photos_mime_check" CHECK ("mime" in ('image/png', 'image/webp')))`,
  `CREATE INDEX IF NOT EXISTS "academy_player_photos_player_idx" ON "academy_player_photos" ("player_id", "created_at")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "academy_player_photos_primary_unique" ON "academy_player_photos" ("player_id") WHERE "is_primary"`,
];

/** 0063: the Creative hub music library. Exported for the test that compares it with the migration file. */
export const CREATIVE_MUSIC_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "creative_music_tracks" (
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
  CONSTRAINT "creative_music_tracks_status_check" CHECK ("status" in ('active', 'hidden')))`,
  `CREATE INDEX IF NOT EXISTS "creative_music_tracks_academy_idx" ON "creative_music_tracks" ("academy_id", "created_at")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "creative_music_tracks_key_unique" ON "creative_music_tracks" ("key") WHERE "key" is not null`,
];

/** 0064: admins' recommended music per template. Exported for the test that compares it with the migration file. */
export const CREATIVE_TEMPLATE_MUSIC_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "creative_template_music" (
  "template_key" text PRIMARY KEY,
  "track_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "volume" real NOT NULL, "duck" boolean DEFAULT false NOT NULL,
  "fade_in_ms" integer NOT NULL, "fade_out_ms" integer NOT NULL, "start_ms" integer DEFAULT 0 NOT NULL,
  "updated_by" integer CONSTRAINT "creative_template_music_updated_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`,
];

/** 0066: every child appears. Exported for the test that compares them with the migration file. */
export const PLAYER_FEATURES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_player_features" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_player_features_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "player_id" integer NOT NULL CONSTRAINT "academy_player_features_player_id_academy_players_id_fk" REFERENCES "academy_players"("id") ON DELETE CASCADE,
  "item_type" text NOT NULL, "item_id" text NOT NULL, "visibility" text NOT NULL, "solo" boolean DEFAULT false NOT NULL,
  "featured_at" timestamp with time zone NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_player_features_item_unique" UNIQUE("player_id", "item_type", "item_id"),
  CONSTRAINT "academy_player_features_type_check" CHECK ("item_type" in ('post', 'clip', 'whatsapp', 'phone_video')),
  CONSTRAINT "academy_player_features_visibility_check" CHECK ("visibility" in ('public', 'private')))`,
  `CREATE INDEX IF NOT EXISTS "academy_player_features_academy_idx" ON "academy_player_features" ("academy_id", "featured_at")`
];

export const FEATURE_SETTINGS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_feature_settings" (
  "academy_id" integer PRIMARY KEY CONSTRAINT "academy_feature_settings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "public_posts_per_month" integer DEFAULT 1 NOT NULL, "private_clip_per_match" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_feature_settings_posts_check" CHECK ("public_posts_per_month" between 0 and 8))`
];

export const PLAYER_CLIPS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_player_clips" (
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
  CONSTRAINT "academy_player_clips_token_check" CHECK ("token" ~ '^[0-9a-f]{32}$'))`,
  `CREATE INDEX IF NOT EXISTS "academy_player_clips_academy_idx" ON "academy_player_clips" ("academy_id", "created_at")`
];

/** 0067: phone media sorted by match time. Exported for the test that compares it with the migration file. */
export const PHONE_MEDIA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_phone_media" (
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
  CONSTRAINT "academy_phone_media_linked_by_check" CHECK ("linked_by" in ('auto', 'coach')))`,
  `CREATE INDEX IF NOT EXISTS "academy_phone_media_academy_idx" ON "academy_phone_media" ("academy_id", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "academy_phone_media_session_idx" ON "academy_phone_media" ("session_id")`
];

/** 0068: the value report. Exported for the test that compares them with the migration file. */
export const STAGE_EVENTS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_contact_stage_events" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_contact_stage_events_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "contact_id" integer NOT NULL CONSTRAINT "academy_contact_stage_events_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE CASCADE,
  "from_stage" text, "to_stage" text, "from_kind" text, "to_kind" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS "academy_contact_stage_events_academy_idx" ON "academy_contact_stage_events" ("academy_id", "at")`,
  `CREATE INDEX IF NOT EXISTS "academy_contact_stage_events_contact_idx" ON "academy_contact_stage_events" ("contact_id")`
];

export const REPORT_SHARES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_value_report_shares" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_value_report_shares_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "month" text NOT NULL, "token" text NOT NULL,
  "created_by" integer CONSTRAINT "academy_value_report_shares_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "revoked_at" timestamp with time zone,
  CONSTRAINT "academy_value_report_shares_token_unique" UNIQUE("token"),
  CONSTRAINT "academy_value_report_shares_month_check" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "academy_value_report_shares_token_check" CHECK ("token" ~ '^[0-9a-f]{32}$'))`
];

/** 0069: trial clips. Exported for the test that compares them with the migration file. */
export const TRIAL_CLIPS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "academy_trial_clips" (
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
  CONSTRAINT "academy_trial_clips_follow_up_check" CHECK ("follow_up_status" is null or "follow_up_status" in ('pending', 'sent', 'skipped')))`,
  `CREATE INDEX IF NOT EXISTS "academy_trial_clips_academy_idx" ON "academy_trial_clips" ("academy_id", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "academy_trial_clips_follow_up_idx" ON "academy_trial_clips" ("follow_up_status", "follow_up_at")`
];

/**
 * 0068: the trigger that writes academy_contact_stage_events on every stage or
 * kind change of a People contact. Not a Drizzle object, so the publish review
 * never sees it: it is installed here, at boot, idempotently.
 */
export const STAGE_TRIGGER_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION replay_contact_stage_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'lead' OR NEW.stage IS NOT NULL THEN
      INSERT INTO academy_contact_stage_events (academy_id, contact_id, from_stage, to_stage, from_kind, to_kind) VALUES (NEW.academy_id, NEW.id, NULL, NEW.stage, NULL, NEW.kind);
    END IF;
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    INSERT INTO academy_contact_stage_events (academy_id, contact_id, from_stage, to_stage, from_kind, to_kind) VALUES (NEW.academy_id, NEW.id, OLD.stage, NEW.stage, OLD.kind, NEW.kind);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS "academy_contacts_stage_events" ON "academy_contacts"`,
  `CREATE TRIGGER "academy_contacts_stage_events" AFTER INSERT OR UPDATE OF "stage", "kind" ON "academy_contacts" FOR EACH ROW EXECUTE FUNCTION replay_contact_stage_event()`,
];

/** 0070: the field console's Instagram autopilot. Exported for the test that compares it with the migration file. */
export const VENUE_IG_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "venue_ig_consent_events" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_consent_events_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "changed_by" integer CONSTRAINT "venue_ig_consent_events_changed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "old_mode" text, "new_mode" text NOT NULL, "wording" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_consent_events_mode_check" CHECK ("new_mode" in ('ask', 'owner', 'off') and ("old_mode" is null or "old_mode" in ('ask', 'owner', 'off'))))`,
  `CREATE INDEX IF NOT EXISTS "venue_ig_consent_events_academy_idx" ON "venue_ig_consent_events" ("academy_id", "created_at")`,
  `CREATE TABLE IF NOT EXISTS "venue_ig_awards" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_awards_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "week_start" text NOT NULL, "category" text NOT NULL, "status" text DEFAULT 'nominating' NOT NULL,
  "nominees" jsonb DEFAULT '[]'::jsonb NOT NULL, "voting_ends_at" timestamp with time zone,
  "winner_key" text, "decided_by" text, "decided_at" timestamp with time zone,
  "decided_by_user" integer CONSTRAINT "venue_ig_awards_decided_by_user_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_awards_week_unique" UNIQUE("academy_id", "week_start", "category"),
  CONSTRAINT "venue_ig_awards_category_check" CHECK ("category" in ('goal', 'dribble', 'shot', 'save', 'fastest')),
  CONSTRAINT "venue_ig_awards_status_check" CHECK ("status" in ('nominating', 'voting', 'owner_pick', 'decided', 'posted', 'skipped')))`,
  `CREATE TABLE IF NOT EXISTS "venue_ig_award_votes" (
  "id" serial PRIMARY KEY,
  "award_id" integer NOT NULL CONSTRAINT "venue_ig_award_votes_award_id_venue_ig_awards_id_fk" REFERENCES "venue_ig_awards"("id") ON DELETE CASCADE,
  "nominee_key" text NOT NULL,
  "user_id" integer NOT NULL CONSTRAINT "venue_ig_award_votes_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_award_votes_user_unique" UNIQUE("award_id", "user_id"))`,
  `CREATE TABLE IF NOT EXISTS "venue_ig_nominations" (
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
  CONSTRAINT "venue_ig_nominations_status_check" CHECK ("status" in ('pending', 'approved', 'rejected')))`,
  `CREATE INDEX IF NOT EXISTS "venue_ig_nominations_academy_idx" ON "venue_ig_nominations" ("academy_id", "status")`,
  `CREATE TABLE IF NOT EXISTS "venue_ig_items" (
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
  CONSTRAINT "venue_ig_items_status_check" CHECK ("status" in ('planned', 'approved', 'rendering', 'ready', 'publishing', 'published', 'skipped', 'failed', 'removed', 'removal_flagged')))`,
  `CREATE INDEX IF NOT EXISTS "venue_ig_items_slot_idx" ON "venue_ig_items" ("academy_id", "slot_at")`,
  `CREATE INDEX IF NOT EXISTS "venue_ig_items_status_idx" ON "venue_ig_items" ("status", "slot_at")`,
  `CREATE TABLE IF NOT EXISTS "venue_ig_removals" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "venue_ig_removals_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "item_id" integer CONSTRAINT "venue_ig_removals_item_id_venue_ig_items_id_fk" REFERENCES "venue_ig_items"("id") ON DELETE SET NULL,
  "booking_id" integer CONSTRAINT "venue_ig_removals_booking_id_venue_bookings_id_fk" REFERENCES "venue_bookings"("id") ON DELETE SET NULL,
  "requested_by" integer CONSTRAINT "venue_ig_removals_requested_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL, "error" text, "resolved_at" timestamp with time zone,
  "resolved_by" integer CONSTRAINT "venue_ig_removals_resolved_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venue_ig_removals_outcome_check" CHECK ("outcome" in ('deleted', 'flagged', 'withdrawn')))`,
  `CREATE INDEX IF NOT EXISTS "venue_ig_removals_academy_idx" ON "venue_ig_removals" ("academy_id", "created_at")`,
];

/**
 * Additive, idempotent schema the code depends on. If a publish reaches a database that
 * never got it (the push ran on dev only), every `select *` on those tables fails with
 * "column does not exist" and takes whole pages down. Adding it at boot prevents that.
 * Only ADD COLUMN IF NOT EXISTS of nullable/defaulted columns and CREATE TABLE IF NOT
 * EXISTS belong here: nothing that drops, renames or rewrites data.
 */
export const COLUMNS: Array<{ table: string; column: string; type: string }> = [
  // 0052_academy_profile.sql
  // 0069_marketing_practices.sql
  { table: "academies", column: "google_review_url", type: "text" },
  { table: "academy_contacts", column: "referred_by_contact_id", type: `integer CONSTRAINT "academy_contacts_referred_by_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE SET NULL` },
  { table: "academy_contacts", column: "referral_note", type: "text" },
  { table: "academy_contacts", column: "trial_session_id", type: `integer CONSTRAINT "academy_contacts_trial_session_id_academy_sessions_id_fk" REFERENCES "academy_sessions"("id") ON DELETE SET NULL` },
  { table: "academy_feature_settings", column: "content_calendar", type: "jsonb" },
  // 0066_every_child_appears.sql
  { table: "academy_players", column: "public_posts_consent", type: "boolean DEFAULT false NOT NULL" },
  { table: "academy_players", column: "public_posts_consent_at", type: "timestamp with time zone" },
  { table: "academies", column: "name_ar", type: "text" },
  { table: "academies", column: "whatsapp_phone", type: "text" },
  { table: "academies", column: "email", type: "text" },
  { table: "academies", column: "address", type: "text" },
  { table: "academies", column: "latitude", type: "real" },
  { table: "academies", column: "longitude", type: "real" },
  { table: "academies", column: "instagram_url", type: "text" },
  { table: "academies", column: "facebook_url", type: "text" },
  { table: "academies", column: "website_url", type: "text" },
  // 0053_academy_ad_wallet_media_templates.sql
  { table: "meta_ad_campaigns", column: "charged_spend_cents", type: "integer DEFAULT 0 NOT NULL" },
  { table: "meta_ads", column: "insights", type: "jsonb" },
  { table: "academy_ad_requests", column: "budget_fils", type: "integer" },
  { table: "academy_ad_requests", column: "cards", type: "jsonb" },
  { table: "academy_ad_requests", column: "variants", type: "jsonb" },
  { table: "academy_ad_requests", column: "questions", type: "jsonb" },
  { table: "academy_ad_requests", column: "meta_ads", type: "jsonb" },
  { table: "academy_ad_requests", column: "template_id", type: "integer" },
  { table: "academy_ad_requests", column: "paused_reason", type: "text" },
  // 0054_academy_team_access_and_chat_controls.sql
  { table: "academy_contacts", column: "archived_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "muted", type: "boolean DEFAULT false NOT NULL" },
  { table: "academy_contacts", column: "blocked_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "personal_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "link_dismissed_at", type: "timestamp with time zone" },
  // 0057_academy_whatsapp_native.sql
  { table: "academy_whatsapp_messages", column: "content", type: "jsonb" },
  { table: "academy_whatsapp_messages", column: "author_phone", type: "text" },
  { table: "academy_whatsapp_messages", column: "author_name", type: "text" },
  { table: "academy_contacts", column: "assigned_user_id", type: `integer CONSTRAINT "academy_contacts_assigned_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL` },
  { table: "academy_social_threads", column: "assigned_user_id", type: `integer CONSTRAINT "academy_social_threads_assigned_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL` },
  // 0058_academy_whatsapp_chat_features.sql
  { table: "academy_whatsapp_settings", column: "chat_options", type: "jsonb DEFAULT '{}'::jsonb NOT NULL" },
  { table: "academy_whatsapp_messages", column: "reply_to_wa_id", type: "text" },
  { table: "academy_whatsapp_messages", column: "reactions", type: "jsonb" },
  { table: "academy_whatsapp_messages", column: "mentions", type: "jsonb" },
  { table: "academy_whatsapp_messages", column: "edited_at", type: "timestamp with time zone" },
  { table: "academy_whatsapp_messages", column: "deleted_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "avatar_path", type: "text" },
  { table: "academy_contacts", column: "avatar_checked_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "typing_until", type: "timestamp with time zone" },
  { table: "academy_whatsapp_groups", column: "avatar_path", type: "text" },
  { table: "academy_whatsapp_groups", column: "avatar_checked_at", type: "timestamp with time zone" },
  { table: "academy_whatsapp_groups", column: "typing_until", type: "timestamp with time zone" },
  // 0059_venues.sql
  { table: "academies", column: "kind", type: "text DEFAULT 'academy' NOT NULL" },
  // 0060_venue_booking_rules.sql
  { table: "venue_settings", column: "accept_cliq", type: "boolean DEFAULT true NOT NULL" },
  { table: "venue_settings", column: "deposit_percent", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_settings", column: "new_customer_policy", type: "text DEFAULT 'same' NOT NULL" },
  { table: "venue_settings", column: "no_show_policy", type: "text DEFAULT 'same' NOT NULL" },
  { table: "venue_settings", column: "late_cancel_mode", type: "text DEFAULT 'refuse' NOT NULL" },
  { table: "venue_settings", column: "late_cancel_value", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_settings", column: "no_show_fee_mode", type: "text DEFAULT 'deposit' NOT NULL" },
  { table: "venue_settings", column: "no_show_fee_value", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_settings", column: "allow_changes", type: "boolean DEFAULT true NOT NULL" },
  { table: "venue_settings", column: "change_hours", type: "integer DEFAULT 6 NOT NULL" },
  { table: "venue_settings", column: "change_fee_fils", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_settings", column: "max_changes", type: "integer DEFAULT 2 NOT NULL" },
  { table: "venue_bookings", column: "fee_fils", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_bookings", column: "fee_reason", type: "text" },
  { table: "venue_bookings", column: "refund_due_fils", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_bookings", column: "refunded_fils", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_bookings", column: "change_count", type: "integer DEFAULT 0 NOT NULL" },
  { table: "venue_bookings", column: "policy", type: "jsonb" },
  { table: "venue_bookings", column: "cancelled_by", type: "text" },
  // 0070_venue_instagram_autopilot.sql
  { table: "venue_settings", column: "ig_consent_mode", type: "text DEFAULT 'off' NOT NULL" },
  { table: "venue_settings", column: "ig_consent_since", type: "timestamp with time zone" },
  { table: "venue_settings", column: "ig_consent_by", type: "integer" },
  { table: "venue_settings", column: "ig_consent_wording", type: "text" },
  { table: "venue_settings", column: "ig_autopilot", type: "boolean DEFAULT false NOT NULL" },
  { table: "venue_settings", column: "ig_publish_mode", type: "text DEFAULT 'approve' NOT NULL" },
  { table: "venue_settings", column: "ig_slots", type: "jsonb DEFAULT '{}'::jsonb NOT NULL" },
  { table: "venue_bookings", column: "ig_consent", type: "text" },
  { table: "venue_bookings", column: "ig_consent_source", type: "text" },
  { table: "venue_bookings", column: "ig_consent_at", type: "timestamp with time zone" },
  { table: "venue_bookings", column: "under_18", type: "boolean DEFAULT false NOT NULL" },
  { table: "recordings", column: "camera_tilted", type: "boolean DEFAULT false NOT NULL" },
  // 0061_academy_creative_pack.sql
  { table: "academies", column: "creative_pack", type: CREATIVE_PACK_COLUMN },
];

const TABLES: Array<{ table: string; statements: string[] }> = [
  {
    table: "academy_ad_wallet_entries",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_ad_wallet_entries" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_ad_wallet_entries_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "kind" text NOT NULL, "amount_fils" integer NOT NULL, "status" text DEFAULT 'confirmed' NOT NULL,
        "method" text, "reference" text, "campaign_id" text, "meta_spend_cents" integer, "note" text,
        "created_by" integer CONSTRAINT "academy_ad_wallet_entries_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "confirmed_by" integer CONSTRAINT "academy_ad_wallet_entries_confirmed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "confirmed_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_ad_wallet_kind_check" CHECK ("kind" in ('topup', 'spend', 'adjustment')),
        CONSTRAINT "academy_ad_wallet_status_check" CHECK ("status" in ('pending', 'confirmed', 'rejected')))`,
      `CREATE INDEX IF NOT EXISTS "academy_ad_wallet_academy_idx" ON "academy_ad_wallet_entries" ("academy_id")`,
      `CREATE INDEX IF NOT EXISTS "academy_ad_wallet_status_idx" ON "academy_ad_wallet_entries" ("status")`,
    ],
  },
  {
    table: "academy_ad_media",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_ad_media" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_ad_media_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "kind" text NOT NULL, "name" text DEFAULT '' NOT NULL, "source" text DEFAULT 'upload' NOT NULL,
        "image_data" text, "storage_url" text, "bytes" integer, "width" integer, "height" integer, "duration_sec" real,
        "meta_videos" jsonb, "user_clip_id" integer, "status" text DEFAULT 'ready' NOT NULL, "error" text,
        "created_by" integer CONSTRAINT "academy_ad_media_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_ad_media_kind_check" CHECK ("kind" in ('image', 'video')),
        CONSTRAINT "academy_ad_media_status_check" CHECK ("status" in ('processing', 'ready', 'failed')))`,
      `CREATE INDEX IF NOT EXISTS "academy_ad_media_academy_idx" ON "academy_ad_media" ("academy_id")`,
    ],
  },
  {
    table: "academy_ad_templates",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_ad_templates" (
        "id" serial PRIMARY KEY, "key" text, "title" text NOT NULL, "title_ar" text, "description" text, "description_ar" text,
        "goal" text DEFAULT 'whatsapp' NOT NULL, "variants" jsonb NOT NULL, "questions" jsonb,
        "daily_budget_fils" integer DEFAULT 5000 NOT NULL, "days" integer DEFAULT 14 NOT NULL,
        "age_min" integer DEFAULT 25 NOT NULL, "age_max" integer DEFAULT 55 NOT NULL, "radius_km" integer DEFAULT 10 NOT NULL,
        "image_data" text, "is_active" boolean DEFAULT true NOT NULL, "sort_order" integer DEFAULT 0 NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_ad_templates_key_unique" UNIQUE ("key"),
        CONSTRAINT "academy_ad_templates_goal_check" CHECK ("goal" in ('whatsapp', 'lead_form')))`,
    ],
  },
  {
    table: "academy_access_settings",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_access_settings" (
        "academy_id" integer PRIMARY KEY CONSTRAINT "academy_access_settings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "sections" jsonb DEFAULT '{}'::jsonb NOT NULL, "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "updated_by" integer CONSTRAINT "academy_access_settings_updated_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`,
    ],
  },
  {
    table: "academy_staff_invites",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_staff_invites" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_staff_invites_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "role" text NOT NULL, "token" text NOT NULL, "label" text,
        "created_by" integer CONSTRAINT "academy_staff_invites_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "accepted_by" integer CONSTRAINT "academy_staff_invites_accepted_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "accepted_at" timestamp with time zone, "revoked_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_staff_invites_token_unique" UNIQUE ("token"),
        CONSTRAINT "academy_staff_invites_role_check" CHECK ("role" in ('manager', 'coach')))`,
      `CREATE INDEX IF NOT EXISTS "academy_staff_invites_academy_idx" ON "academy_staff_invites" ("academy_id")`,
    ],
  },
  // 0055_academy_social.sql
  {
    table: "academy_social_accounts",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_accounts" (
        "academy_id" integer PRIMARY KEY CONSTRAINT "academy_social_accounts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "token_enc" text, "page_id" text, "page_name" text, "page_token_enc" text,
        "ig_user_id" text, "ig_username" text, "ig_picture" text,
        "subscribed" boolean DEFAULT false NOT NULL, "status" text DEFAULT 'pending' NOT NULL, "error" text,
        "insights" jsonb, "insights_at" timestamp with time zone, "posts_synced_at" timestamp with time zone,
        "connected_by" integer CONSTRAINT "academy_social_accounts_connected_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "connected_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_accounts_status_check" CHECK ("status" in ('pending', 'connected', 'error')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_accounts_page_unique" ON "academy_social_accounts" ("page_id") WHERE "page_id" is not null`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_accounts_ig_unique" ON "academy_social_accounts" ("ig_user_id") WHERE "ig_user_id" is not null`,
    ],
  },
  {
    table: "academy_social_threads",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_threads" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_social_threads_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "channel" text NOT NULL, "external_user_id" text NOT NULL, "name" text, "username" text, "picture" text,
        "contact_id" integer CONSTRAINT "academy_social_threads_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE SET NULL,
        "stage" text, "last_in_at" timestamp with time zone, "last_at" timestamp with time zone, "last_read_at" timestamp with time zone, "archived_at" timestamp with time zone,
        "muted" boolean DEFAULT false NOT NULL, "blocked_at" timestamp with time zone, "personal_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_threads_channel_check" CHECK ("channel" in ('instagram', 'messenger')),
        CONSTRAINT "academy_social_threads_stage_check" CHECK ("stage" is null or "stage" in ('new', 'contacted', 'trial', 'joined', 'lost')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_threads_person_unique" ON "academy_social_threads" ("academy_id", "channel", "external_user_id")`,
      `CREATE INDEX IF NOT EXISTS "academy_social_threads_academy_idx" ON "academy_social_threads" ("academy_id", "last_at")`,
    ],
  },
  {
    table: "academy_social_messages",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_messages" (
        "id" serial PRIMARY KEY,
        "thread_id" integer NOT NULL CONSTRAINT "academy_social_messages_thread_id_academy_social_threads_id_fk" REFERENCES "academy_social_threads"("id") ON DELETE CASCADE,
        "academy_id" integer NOT NULL CONSTRAINT "academy_social_messages_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "direction" text NOT NULL, "kind" text DEFAULT 'dm' NOT NULL, "body" text DEFAULT '' NOT NULL,
        "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL, "external_id" text,
        "status" text DEFAULT 'received' NOT NULL, "error" text,
        "sent_by" integer CONSTRAINT "academy_social_messages_sent_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_messages_direction_check" CHECK ("direction" in ('in', 'out')),
        CONSTRAINT "academy_social_messages_status_check" CHECK ("status" in ('received', 'sent', 'failed')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_messages_external_unique" ON "academy_social_messages" ("external_id") WHERE "external_id" is not null`,
      `CREATE INDEX IF NOT EXISTS "academy_social_messages_thread_idx" ON "academy_social_messages" ("thread_id", "created_at")`,
    ],
  },
  {
    table: "academy_social_comments",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_comments" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_social_comments_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "channel" text NOT NULL, "comment_id" text NOT NULL, "parent_id" text, "post_id" text,
        "post_permalink" text, "post_caption" text, "from_id" text, "from_name" text,
        "body" text DEFAULT '' NOT NULL, "hidden" boolean DEFAULT false NOT NULL,
        "reply_body" text, "replied_at" timestamp with time zone,
        "replied_by" integer CONSTRAINT "academy_social_comments_replied_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "private_replied_at" timestamp with time zone,
        "thread_id" integer CONSTRAINT "academy_social_comments_thread_id_academy_social_threads_id_fk" REFERENCES "academy_social_threads"("id") ON DELETE SET NULL,
        "read_at" timestamp with time zone, "deleted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_comments_channel_check" CHECK ("channel" in ('instagram', 'facebook')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_comments_comment_unique" ON "academy_social_comments" ("channel", "comment_id")`,
      `CREATE INDEX IF NOT EXISTS "academy_social_comments_academy_idx" ON "academy_social_comments" ("academy_id", "created_at")`,
    ],
  },
  {
    table: "academy_social_posts",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_posts" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_social_posts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "source" text DEFAULT 'replay' NOT NULL, "targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "format" text DEFAULT 'image' NOT NULL, "caption" text DEFAULT '' NOT NULL,
        "media" jsonb DEFAULT '[]'::jsonb NOT NULL, "status" text DEFAULT 'draft' NOT NULL,
        "scheduled_for" timestamp with time zone, "published_at" timestamp with time zone, "ig_media_id" text, "ig_permalink" text,
        "fb_post_id" text, "fb_permalink" text, "thumbnail" text, "error" text,
        "insights" jsonb, "insights_at" timestamp with time zone,
        "created_by" integer CONSTRAINT "academy_social_posts_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_posts_source_check" CHECK ("source" in ('replay', 'synced')),
        CONSTRAINT "academy_social_posts_format_check" CHECK ("format" in ('image', 'carousel', 'video', 'reel', 'story')),
        CONSTRAINT "academy_social_posts_status_check" CHECK ("status" in ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_posts_ig_unique" ON "academy_social_posts" ("ig_media_id") WHERE "ig_media_id" is not null`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_posts_fb_unique" ON "academy_social_posts" ("fb_post_id") WHERE "fb_post_id" is not null`,
      `CREATE INDEX IF NOT EXISTS "academy_social_posts_academy_idx" ON "academy_social_posts" ("academy_id", "published_at")`,
      `CREATE INDEX IF NOT EXISTS "academy_social_posts_due_idx" ON "academy_social_posts" ("status", "scheduled_for")`,
    ],
  },
  // 0056_academy_creative.sql
  {
    table: "academy_creative_projects",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_creative_projects" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_creative_projects_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "kind" text DEFAULT 'image' NOT NULL, "format" text DEFAULT 'post' NOT NULL, "title" text DEFAULT '' NOT NULL,
  "template_key" text, "style" text, "status" text DEFAULT 'draft' NOT NULL,
  "origin" text DEFAULT 'manual' NOT NULL, "origin_key" text, "source_session_id" integer,
  "scene" jsonb NOT NULL, "data" jsonb,
  "output_path" text, "output_mime" text, "render_status" text DEFAULT 'none' NOT NULL, "render_error" text,
  "rendered_at" timestamp with time zone, "publish_targets" jsonb,
  "scheduled_at" timestamp with time zone, "published_at" timestamp with time zone,
  "created_by" integer CONSTRAINT "academy_creative_projects_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_creative_projects_kind_check" CHECK ("kind" in ('image', 'video')),
  CONSTRAINT "academy_creative_projects_format_check" CHECK ("format" in ('post', 'square', 'story')),
  CONSTRAINT "academy_creative_projects_status_check" CHECK ("status" in ('draft', 'ready', 'scheduled', 'published', 'skipped')),
  CONSTRAINT "academy_creative_projects_origin_check" CHECK ("origin" in ('auto', 'manual')),
  CONSTRAINT "academy_creative_projects_render_status_check" CHECK ("render_status" in ('none', 'queued', 'rendering', 'done', 'failed')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_creative_projects_origin_unique" ON "academy_creative_projects" ("academy_id", "origin_key") WHERE "origin_key" is not null`,
      `CREATE INDEX IF NOT EXISTS "academy_creative_projects_academy_idx" ON "academy_creative_projects" ("academy_id", "updated_at")`,
    ],
  },
  // 0057_academy_whatsapp_native.sql
  {
    table: "academy_whatsapp_groups",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_whatsapp_groups" ("id" serial PRIMARY KEY, "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_groups_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "group_id" text NOT NULL, "session" text NOT NULL, "subject" text NOT NULL, "origin" text DEFAULT 'replay' NOT NULL, "squad_id" integer CONSTRAINT "academy_whatsapp_groups_squad_id_academy_squads_id_fk" REFERENCES "academy_squads"("id") ON DELETE SET NULL, "assigned_user_id" integer CONSTRAINT "academy_whatsapp_groups_assigned_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL, "last_read_at" timestamp with time zone, "archived_at" timestamp with time zone, "muted" boolean DEFAULT false NOT NULL, "created_by" integer CONSTRAINT "academy_whatsapp_groups_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "academy_whatsapp_groups_academy_group_unique" UNIQUE ("academy_id", "group_id"), CONSTRAINT "academy_whatsapp_groups_origin_check" CHECK ("origin" in ('replay', 'existing')))`,
      `CREATE INDEX IF NOT EXISTS "academy_whatsapp_groups_group_idx" ON "academy_whatsapp_groups" ("group_id")`,
    ],
  },
  {
    table: "academy_whatsapp_poll_votes",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_whatsapp_poll_votes" ("id" serial PRIMARY KEY, "message_id" integer NOT NULL CONSTRAINT "academy_whatsapp_poll_votes_message_id_academy_whatsapp_messages_id_fk" REFERENCES "academy_whatsapp_messages"("id") ON DELETE CASCADE, "voter_phone" text NOT NULL, "voter_name" text, "options" jsonb DEFAULT '[]'::jsonb NOT NULL, "voted_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "academy_whatsapp_poll_votes_message_voter_unique" UNIQUE ("message_id", "voter_phone"))`,
    ],
  },
  // 0058_academy_whatsapp_chat_features.sql
  {
    table: "academy_whatsapp_saved_replies",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_whatsapp_saved_replies" ("id" serial PRIMARY KEY, "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_saved_replies_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "shortcut" text NOT NULL, "title" text NOT NULL, "body" text NOT NULL, "created_by" integer CONSTRAINT "academy_whatsapp_saved_replies_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "academy_whatsapp_saved_replies_academy_shortcut_unique" UNIQUE ("academy_id", "shortcut"))`,
    ],
  },
  {
    table: "academy_whatsapp_posts",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_whatsapp_posts" ("id" serial PRIMARY KEY, "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_posts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "target" text NOT NULL, "kind" text NOT NULL, "text" text, "media" jsonb, "background_color" text, "wa_message_id" text, "error" text, "created_by" integer CONSTRAINT "academy_whatsapp_posts_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL, "deleted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "academy_whatsapp_posts_target_check" CHECK ("target" in ('status', 'channel')), CONSTRAINT "academy_whatsapp_posts_kind_check" CHECK ("kind" in ('text', 'image', 'video')))`,
      `CREATE INDEX IF NOT EXISTS "academy_whatsapp_posts_academy_idx" ON "academy_whatsapp_posts" ("academy_id", "created_at")`,
    ],
  },
  // 0059_venues.sql (field console)
  {
    table: "venue_settings",
    statements: [
      `CREATE TABLE IF NOT EXISTS "venue_settings" ( "academy_id" integer PRIMARY KEY CONSTRAINT "venue_settings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "slug" text NOT NULL, "booking_enabled" boolean DEFAULT true NOT NULL, "opening_hours" jsonb DEFAULT '{}'::jsonb NOT NULL, "slot_step_minutes" integer DEFAULT 30 NOT NULL, "durations" jsonb DEFAULT '[60, 90, 120]'::jsonb NOT NULL, "max_days_ahead" integer DEFAULT 14 NOT NULL, "min_notice_minutes" integer DEFAULT 30 NOT NULL, "hold_minutes" integer DEFAULT 30 NOT NULL, "money_to" text DEFAULT 'venue' NOT NULL, "cliq_alias" text, "cliq_name" text, "pay_at_field" boolean DEFAULT true NOT NULL, "deposit_mode" text DEFAULT 'full' NOT NULL, "deposit_fils" integer DEFAULT 0 NOT NULL, "cancel_hours" integer DEFAULT 6 NOT NULL, "auto_confirm_receipts" boolean DEFAULT false NOT NULL, "replay_fee_bps" integer DEFAULT 0 NOT NULL, "card_provider" text DEFAULT 'none' NOT NULL, "card_enabled" boolean DEFAULT false NOT NULL, "card_config_enc" text, "agent_mode" text DEFAULT 'off' NOT NULL, "agent_name" text, "agent_notes" text, "agent_pause_minutes" integer DEFAULT 120 NOT NULL, "automations" jsonb DEFAULT '{}'::jsonb NOT NULL, "site_enabled" boolean DEFAULT true NOT NULL, "site_tagline" text, "site_tagline_ar" text, "site_about" text, "site_about_ar" text, "hero_image_url" text, "accent_color" text, "custom_domain" text, "domain_token" text, "domain_status" text DEFAULT 'none' NOT NULL, "domain_checked_at" timestamp with time zone, "domain_error" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "venue_settings_slug_unique" UNIQUE("slug"), CONSTRAINT "venue_settings_money_to_check" CHECK ("money_to" in ('venue', 'replay')), CONSTRAINT "venue_settings_deposit_mode_check" CHECK ("deposit_mode" in ('full', 'deposit', 'none')), CONSTRAINT "venue_settings_card_provider_check" CHECK ("card_provider" in ('none', 'paytabs')), CONSTRAINT "venue_settings_agent_mode_check" CHECK ("agent_mode" in ('off', 'ai', 'menu')), CONSTRAINT "venue_settings_domain_status_check" CHECK ("domain_status" in ('none', 'pending', 'live', 'error')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "venue_settings_custom_domain_unique" ON "venue_settings" ("custom_domain") WHERE "custom_domain" is not null`,
    ],
  },
  {
    table: "venue_pitches",
    statements: [
      `CREATE TABLE IF NOT EXISTS "venue_pitches" ( "id" serial PRIMARY KEY, "academy_id" integer NOT NULL CONSTRAINT "venue_pitches_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "name" text NOT NULL, "name_ar" text, "size" text DEFAULT '5' NOT NULL, "surface" text, "indoor" boolean DEFAULT false NOT NULL, "field_id" integer CONSTRAINT "venue_pitches_field_id_fields_id_fk" REFERENCES "fields"("id") ON DELETE SET NULL, "record_bookings" boolean DEFAULT true NOT NULL, "price_per_hour_fils" integer DEFAULT 20000 NOT NULL, "price_rules" jsonb DEFAULT '[]'::jsonb NOT NULL, "image_url" text, "active" boolean DEFAULT true NOT NULL, "sort_order" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS "venue_pitches_academy_idx" ON "venue_pitches" ("academy_id")`,
    ],
  },
  {
    table: "venue_bookings",
    statements: [
      `CREATE TABLE IF NOT EXISTS "venue_bookings" ( "id" serial PRIMARY KEY, "academy_id" integer NOT NULL CONSTRAINT "venue_bookings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "pitch_id" integer NOT NULL CONSTRAINT "venue_bookings_pitch_id_venue_pitches_id_fk" REFERENCES "venue_pitches"("id") ON DELETE CASCADE, "starts_at" timestamp with time zone NOT NULL, "ends_at" timestamp with time zone NOT NULL, "start_local" text NOT NULL, "end_local" text NOT NULL, "status" text DEFAULT 'held' NOT NULL, "payment_status" text DEFAULT 'unpaid' NOT NULL, "pay_with" text DEFAULT 'cliq' NOT NULL, "money_to" text DEFAULT 'venue' NOT NULL, "amount_fils" integer DEFAULT 0 NOT NULL, "due_online_fils" integer DEFAULT 0 NOT NULL, "paid_fils" integer DEFAULT 0 NOT NULL, "reference" text NOT NULL, "customer_name" text, "customer_phone" text, "contact_id" integer CONSTRAINT "venue_bookings_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE SET NULL, "team_name" text, "notes" text, "source" text DEFAULT 'console' NOT NULL, "series_id" text, "hold_expires_at" timestamp with time zone, "footage_request_id" integer CONSTRAINT "venue_bookings_footage_request_id_footage_requests_id_fk" REFERENCES "footage_requests"("id") ON DELETE SET NULL, "footage_note" text, "video_sent_at" timestamp with time zone, "reminded_at" timestamp with time zone, "receipt_path" text, "receipt_check" jsonb, "card_ref" text, "card_url" text, "confirmed_at" timestamp with time zone, "paid_at" timestamp with time zone, "paid_by" integer CONSTRAINT "venue_bookings_paid_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL, "cancelled_at" timestamp with time zone, "cancel_reason" text, "created_by" integer CONSTRAINT "venue_bookings_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "venue_bookings_reference_unique" UNIQUE("reference"), CONSTRAINT "venue_bookings_status_check" CHECK ("status" in ('held', 'confirmed', 'cancelled', 'completed', 'no_show')), CONSTRAINT "venue_bookings_payment_status_check" CHECK ("payment_status" in ('unpaid', 'receipt', 'paid', 'refunded', 'waived')), CONSTRAINT "venue_bookings_pay_with_check" CHECK ("pay_with" in ('cliq', 'field', 'card', 'none')), CONSTRAINT "venue_bookings_money_to_check" CHECK ("money_to" in ('venue', 'replay')), CONSTRAINT "venue_bookings_source_check" CHECK ("source" in ('console', 'whatsapp', 'website', 'app')))`,
      `CREATE INDEX IF NOT EXISTS "venue_bookings_pitch_time_idx" ON "venue_bookings" ("pitch_id", "starts_at")`,
      `CREATE INDEX IF NOT EXISTS "venue_bookings_academy_time_idx" ON "venue_bookings" ("academy_id", "starts_at")`,
      `CREATE INDEX IF NOT EXISTS "venue_bookings_academy_phone_idx" ON "venue_bookings" ("academy_id", "customer_phone")`,
    ],
  },
  {
    table: "venue_agent_threads",
    statements: [
      `CREATE TABLE IF NOT EXISTS "venue_agent_threads" ( "id" serial PRIMARY KEY, "academy_id" integer NOT NULL CONSTRAINT "venue_agent_threads_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "phone" text NOT NULL, "state" jsonb DEFAULT '{}'::jsonb NOT NULL, "paused_until" timestamp with time zone, "handover_at" timestamp with time zone, "turns" integer DEFAULT 0 NOT NULL, "last_in_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "venue_agent_threads_academy_phone_unique" UNIQUE("academy_id", "phone"))`,
    ],
  },
  {
    table: "venue_payouts",
    statements: [
      `CREATE TABLE IF NOT EXISTS "venue_payouts" ( "id" serial PRIMARY KEY, "academy_id" integer NOT NULL CONSTRAINT "venue_payouts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE, "amount_fils" integer NOT NULL, "method" text DEFAULT 'cliq' NOT NULL, "note" text, "created_by" integer CONSTRAINT "venue_payouts_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS "venue_payouts_academy_idx" ON "venue_payouts" ("academy_id")`,
    ],
  },
  // 0062_academy_player_photos.sql (the statements are the migration's, one per statement)
  {
    table: "academy_player_photos",
    statements: PLAYER_PHOTOS_STATEMENTS,
  },
  // 0063_creative_music.sql (the statements are the migration's, one per statement)
  {
    table: "creative_music_tracks",
    statements: CREATIVE_MUSIC_STATEMENTS,
  },
  // 0064_creative_template_music.sql (the statements are the migration's, one per statement)
  {
    table: "creative_template_music",
    statements: CREATIVE_TEMPLATE_MUSIC_STATEMENTS,
  },
  // 0066_every_child_appears.sql (the statements are the migration's, one per statement)
  { table: "academy_player_features", statements: PLAYER_FEATURES_STATEMENTS },
  { table: "academy_feature_settings", statements: FEATURE_SETTINGS_STATEMENTS },
  { table: "academy_player_clips", statements: PLAYER_CLIPS_STATEMENTS },
  // 0067_academy_phone_media.sql
  { table: "academy_phone_media", statements: PHONE_MEDIA_STATEMENTS },
  // 0068_academy_value_report.sql
  { table: "academy_contact_stage_events", statements: STAGE_EVENTS_STATEMENTS },
  { table: "academy_value_report_shares", statements: REPORT_SHARES_STATEMENTS },
  // 0069_marketing_practices.sql
  { table: "academy_trial_clips", statements: TRIAL_CLIPS_STATEMENTS },
  // 0070_venue_instagram_autopilot.sql (the statements are the migration's, one per statement)
  { table: "venue_ig_consent_events", statements: [VENUE_IG_STATEMENTS[0], VENUE_IG_STATEMENTS[1]] },
  { table: "venue_ig_awards", statements: [VENUE_IG_STATEMENTS[2]] },
  { table: "venue_ig_award_votes", statements: [VENUE_IG_STATEMENTS[3]] },
  { table: "venue_ig_nominations", statements: [VENUE_IG_STATEMENTS[4], VENUE_IG_STATEMENTS[5]] },
  { table: "venue_ig_items", statements: [VENUE_IG_STATEMENTS[6], VENUE_IG_STATEMENTS[7], VENUE_IG_STATEMENTS[8]] },
  { table: "venue_ig_removals", statements: [VENUE_IG_STATEMENTS[9], VENUE_IG_STATEMENTS[10]] },
];

/** Checks that only ever widen what's allowed (0054: academy managers). */
const WIDENED_CHECKS: Array<{ table: string; name: string; mustContain: string; definition: string }> = [
  { table: "academy_members", name: "academy_members_role_check", mustContain: "'manager'", definition: `CHECK ("role" in ('owner', 'manager', 'coach'))` },
  // 0065_creative_wide_format.sql: 16:9 clip videos.
  { table: "academy_creative_projects", name: "academy_creative_projects_format_check", mustContain: "'wide'", definition: `CHECK ("format" in ('post', 'square', 'story', 'wide'))` },
];

/** Returns how many columns and tables it had to add. */
export async function ensureAdditiveColumns(pool: Pool): Promise<number> {
  const names = [...new Set([...COLUMNS.map((c) => c.table), ...TABLES.map((t) => t.table), ...WIDENED_CHECKS.map((c) => c.table)])];
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [names],
  );
  let tables = new Set(rows.map((r) => r.table_name));
  let have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  let added = 0;
  for (const t of TABLES) {
    if (tables.has(t.table)) continue;
    for (const sql of t.statements) await pool.query(sql);
    added += 1;
  }
  if (added) {
    // A table created just now from an older migration still needs the columns later ones added.
    const { rows: now } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [names],
    );
    tables = new Set(now.map((r) => r.table_name));
    have = new Set(now.map((r) => `${r.table_name}.${r.column_name}`));
  }
  for (const c of COLUMNS) {
    // A table the publish never created can't take a column; its own feature fails alone.
    if (!tables.has(c.table) || have.has(`${c.table}.${c.column}`)) continue;
    await pool.query(`ALTER TABLE "${c.table}" ADD COLUMN IF NOT EXISTS "${c.column}" ${c.type}`);
    added += 1;
  }
  // The People stage trigger (0068): installed once the events table exists, when missing.
  const { rows: trigTables } = await pool.query(`SELECT to_regclass('academy_contacts') AS c, to_regclass('academy_contact_stage_events') AS e`);
  if (trigTables[0]?.c && trigTables[0]?.e) {
    const { rows: trig } = await pool.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'academy_contacts_stage_events'`);
    if (!trig.length) {
      for (const sql of STAGE_TRIGGER_STATEMENTS) await pool.query(sql);
      added += 1;
    }
  }
  for (const c of WIDENED_CHECKS) {
    if (!tables.has(c.table)) continue;
    const { rows: defs } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [c.name],
    );
    if (defs[0]?.def.includes(c.mustContain)) continue;
    await pool.query(`ALTER TABLE "${c.table}" DROP CONSTRAINT IF EXISTS "${c.name}"`);
    await pool.query(`ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.name}" ${c.definition}`);
    added += 1;
  }
  return added;
}
