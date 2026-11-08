-- Template library: templates an admin uploads as a file, for every field and/or academy. Additive only.
CREATE TABLE IF NOT EXISTS "creative_library_templates" (
  "id" serial PRIMARY KEY,
  "key" text NOT NULL, "title_en" text NOT NULL, "title_ar" text NOT NULL, "description" text,
  "audience" text DEFAULT 'field' NOT NULL, "academy_ids" jsonb, "base_key" text, "replaces_base" boolean DEFAULT false NOT NULL, "clips" integer,
  "format" text NOT NULL, "kind" text DEFAULT 'image' NOT NULL, "scene" jsonb NOT NULL, "sample_data" jsonb, "active" boolean DEFAULT true NOT NULL,
  "uploaded_by" integer CONSTRAINT "creative_library_templates_uploaded_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_library_templates_audience_check" CHECK ("audience" in ('field', 'academy', 'all')),
  CONSTRAINT "creative_library_templates_kind_check" CHECK ("kind" in ('image', 'video')));
CREATE UNIQUE INDEX IF NOT EXISTS "creative_library_templates_key_format_unique" ON "creative_library_templates" ("key", "format");
CREATE INDEX IF NOT EXISTS "creative_library_templates_base_idx" ON "creative_library_templates" ("base_key", "format");
