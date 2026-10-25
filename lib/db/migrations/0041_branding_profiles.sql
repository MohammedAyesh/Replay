-- Venue branding drawn by the export itself (2026-10-25): crest, colours, names
-- and booking line per field / academy / global. Additive: one new table.
CREATE TABLE IF NOT EXISTS "branding_profiles" (
  "id" serial PRIMARY KEY NOT NULL,
  "scope_type" text NOT NULL,
  "scope_id" integer DEFAULT 0 NOT NULL,
  "name_en" text DEFAULT '' NOT NULL,
  "name_ar" text,
  "tagline_ar" text,
  "primary_color" text DEFAULT '#2FD8C4' NOT NULL,
  "accent_color" text,
  "booking_phone" text,
  "instagram" text,
  "crest_url" text,
  "crest_width" integer,
  "crest_height" integer,
  "show_player_names" boolean DEFAULT false NOT NULL,
  "updated_by" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "branding_profiles" ADD CONSTRAINT "branding_profiles_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "branding_profiles_scope_unique" ON "branding_profiles" USING btree ("scope_type", "scope_id");
