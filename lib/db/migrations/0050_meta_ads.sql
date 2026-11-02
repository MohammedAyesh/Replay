-- Meta ads run by Replay for academies: synced campaigns and ads, and the leads they bring. Additive only.
CREATE TABLE IF NOT EXISTS "meta_ad_campaigns" (
  "id" text PRIMARY KEY,
  "academy_id" integer CONSTRAINT "meta_ad_campaigns_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "status" text,
  "objective" text,
  "started_at" timestamptz,
  "insights" jsonb,
  "insights_30d" jsonb,
  "synced_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "meta_ad_campaigns_academy_idx" ON "meta_ad_campaigns" ("academy_id");

CREATE TABLE IF NOT EXISTS "meta_ads" (
  "id" text PRIMARY KEY,
  "campaign_id" text NOT NULL CONSTRAINT "meta_ads_campaign_id_meta_ad_campaigns_id_fk" REFERENCES "meta_ad_campaigns"("id") ON DELETE CASCADE,
  "name" text,
  "status" text,
  "synced_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "meta_ads_campaign_idx" ON "meta_ads" ("campaign_id");

CREATE TABLE IF NOT EXISTS "meta_ad_leads" (
  "id" serial PRIMARY KEY,
  "source" text NOT NULL,
  "external_id" text NOT NULL,
  "academy_id" integer CONSTRAINT "meta_ad_leads_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE SET NULL,
  "contact_id" integer CONSTRAINT "meta_ad_leads_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE SET NULL,
  "campaign_id" text,
  "ad_id" text,
  "form_id" text,
  "page_id" text,
  "phone" text,
  "name" text,
  "email" text,
  "ctwa_clid" text,
  "headline" text,
  "answers" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "meta_ad_leads_external_unique" UNIQUE ("external_id"),
  CONSTRAINT "meta_ad_leads_source_check" CHECK ("source" IN ('lead_form', 'whatsapp'))
);
CREATE INDEX IF NOT EXISTS "meta_ad_leads_academy_idx" ON "meta_ad_leads" ("academy_id");
CREATE INDEX IF NOT EXISTS "meta_ad_leads_campaign_idx" ON "meta_ad_leads" ("campaign_id");
