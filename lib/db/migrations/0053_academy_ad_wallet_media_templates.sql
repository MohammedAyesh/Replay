-- Academy ads: a prepaid wallet for ads on Replay's account, a media library (phone photos and
-- videos, Studio output), carousels / text variants / extra form questions, and ready-made
-- campaign templates. Additive only.
ALTER TABLE "meta_ad_campaigns" ADD COLUMN IF NOT EXISTS "charged_spend_cents" integer DEFAULT 0 NOT NULL;
ALTER TABLE "meta_ads" ADD COLUMN IF NOT EXISTS "insights" jsonb;
ALTER TABLE "academy_ad_requests" ADD COLUMN IF NOT EXISTS "budget_fils" integer;
ALTER TABLE "academy_ad_requests" ADD COLUMN IF NOT EXISTS "cards" jsonb;
ALTER TABLE "academy_ad_requests" ADD COLUMN IF NOT EXISTS "variants" jsonb;
ALTER TABLE "academy_ad_requests" ADD COLUMN IF NOT EXISTS "questions" jsonb;
ALTER TABLE "academy_ad_requests" ADD COLUMN IF NOT EXISTS "meta_ads" jsonb;
ALTER TABLE "academy_ad_requests" ADD COLUMN IF NOT EXISTS "template_id" integer;
ALTER TABLE "academy_ad_requests" ADD COLUMN IF NOT EXISTS "paused_reason" text;

CREATE TABLE IF NOT EXISTS "academy_ad_wallet_entries" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_ad_wallet_entries_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "amount_fils" integer NOT NULL,
  "status" text DEFAULT 'confirmed' NOT NULL,
  "method" text,
  "reference" text,
  "campaign_id" text,
  "meta_spend_cents" integer,
  "note" text,
  "created_by" integer CONSTRAINT "academy_ad_wallet_entries_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "confirmed_by" integer CONSTRAINT "academy_ad_wallet_entries_confirmed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_ad_wallet_kind_check" CHECK ("kind" in ('topup', 'spend', 'adjustment')),
  CONSTRAINT "academy_ad_wallet_status_check" CHECK ("status" in ('pending', 'confirmed', 'rejected'))
);
CREATE INDEX IF NOT EXISTS "academy_ad_wallet_academy_idx" ON "academy_ad_wallet_entries" ("academy_id");
CREATE INDEX IF NOT EXISTS "academy_ad_wallet_status_idx" ON "academy_ad_wallet_entries" ("status");

CREATE TABLE IF NOT EXISTS "academy_ad_media" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_ad_media_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text DEFAULT '' NOT NULL,
  "source" text DEFAULT 'upload' NOT NULL,
  "image_data" text,
  "storage_url" text,
  "bytes" integer,
  "width" integer,
  "height" integer,
  "duration_sec" real,
  "meta_videos" jsonb,
  "user_clip_id" integer,
  "status" text DEFAULT 'ready' NOT NULL,
  "error" text,
  "created_by" integer CONSTRAINT "academy_ad_media_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_ad_media_kind_check" CHECK ("kind" in ('image', 'video')),
  CONSTRAINT "academy_ad_media_status_check" CHECK ("status" in ('processing', 'ready', 'failed'))
);
CREATE INDEX IF NOT EXISTS "academy_ad_media_academy_idx" ON "academy_ad_media" ("academy_id");

CREATE TABLE IF NOT EXISTS "academy_ad_templates" (
  "id" serial PRIMARY KEY,
  "key" text,
  "title" text NOT NULL,
  "title_ar" text,
  "description" text,
  "description_ar" text,
  "goal" text DEFAULT 'whatsapp' NOT NULL,
  "variants" jsonb NOT NULL,
  "questions" jsonb,
  "daily_budget_fils" integer DEFAULT 5000 NOT NULL,
  "days" integer DEFAULT 14 NOT NULL,
  "age_min" integer DEFAULT 25 NOT NULL,
  "age_max" integer DEFAULT 55 NOT NULL,
  "radius_km" integer DEFAULT 10 NOT NULL,
  "image_data" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_ad_templates_key_unique" UNIQUE ("key"),
  CONSTRAINT "academy_ad_templates_goal_check" CHECK ("goal" in ('whatsapp', 'lead_form'))
);
