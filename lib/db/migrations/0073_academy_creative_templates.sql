-- My templates: designs an academy or field saved from a catalogue template, optionally used in its place (autopilots too). Additive only.
CREATE TABLE IF NOT EXISTS "academy_creative_templates" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_creative_templates_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "base_key" text NOT NULL, "style" text, "format" text NOT NULL, "kind" text DEFAULT 'image' NOT NULL, "title" text NOT NULL,
  "scene" jsonb NOT NULL, "sample_data" jsonb, "replaces_base" boolean DEFAULT false NOT NULL,
  "created_by" integer CONSTRAINT "academy_creative_templates_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_creative_templates_kind_check" CHECK ("kind" in ('image', 'video')));
CREATE INDEX IF NOT EXISTS "academy_creative_templates_academy_idx" ON "academy_creative_templates" ("academy_id", "updated_at");
CREATE UNIQUE INDEX IF NOT EXISTS "academy_creative_templates_replaces_unique" ON "academy_creative_templates" ("academy_id", "base_key", "format") WHERE "replaces_base";
