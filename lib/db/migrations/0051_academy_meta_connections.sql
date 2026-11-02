-- Academies connect Meta (share their Page with Replay, or their own ad account) and build ads in Replay. Additive only.
ALTER TABLE "meta_ad_campaigns" ADD COLUMN IF NOT EXISTS "ad_account_id" text;

CREATE TABLE IF NOT EXISTS "academy_meta_connections" (
  "academy_id" integer PRIMARY KEY CONSTRAINT "academy_meta_connections_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "mode" text NOT NULL DEFAULT 'replay',
  "page_id" text,
  "page_name" text,
  "whatsapp_number" text,
  "ad_account_id" text,
  "ad_account_name" text,
  "currency" text,
  "client_business_id" text,
  "token_enc" text,
  "leads_subscribed" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "connected_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_meta_connections_mode_check" CHECK ("mode" IN ('replay', 'own')),
  CONSTRAINT "academy_meta_connections_status_check" CHECK ("status" IN ('pending', 'connected', 'error'))
);
CREATE INDEX IF NOT EXISTS "academy_meta_connections_page_idx" ON "academy_meta_connections" ("page_id");

CREATE TABLE IF NOT EXISTS "academy_ad_requests" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_ad_requests_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "mode" text NOT NULL,
  "goal" text NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "daily_budget" integer NOT NULL,
  "currency" text NOT NULL,
  "start_at" timestamptz,
  "end_at" timestamptz,
  "latitude" real,
  "longitude" real,
  "radius_km" integer NOT NULL DEFAULT 10,
  "age_min" integer NOT NULL DEFAULT 25,
  "age_max" integer NOT NULL DEFAULT 55,
  "headline" text NOT NULL,
  "primary_text" text NOT NULL,
  "locale" text NOT NULL DEFAULT 'ar',
  "image_data" text,
  "extra_question" text,
  "meta_campaign_id" text,
  "meta_adset_id" text,
  "meta_ad_id" text,
  "meta_form_id" text,
  "error" text,
  "created_by" integer CONSTRAINT "academy_ad_requests_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_by" integer CONSTRAINT "academy_ad_requests_reviewed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "submitted_at" timestamptz,
  "launched_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "academy_ad_requests_mode_check" CHECK ("mode" IN ('replay', 'own')),
  CONSTRAINT "academy_ad_requests_goal_check" CHECK ("goal" IN ('whatsapp', 'lead_form')),
  CONSTRAINT "academy_ad_requests_status_check" CHECK ("status" IN ('draft', 'pending_approval', 'launching', 'active', 'paused', 'rejected', 'failed'))
);
CREATE INDEX IF NOT EXISTS "academy_ad_requests_academy_idx" ON "academy_ad_requests" ("academy_id");
CREATE INDEX IF NOT EXISTS "academy_ad_requests_status_idx" ON "academy_ad_requests" ("status");
