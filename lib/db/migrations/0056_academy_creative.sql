-- Academy creative hub: posts, stories and videos made from scenes. Additive only.

CREATE TABLE IF NOT EXISTS "academy_creative_projects" (
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
  CONSTRAINT "academy_creative_projects_render_status_check" CHECK ("render_status" in ('none', 'queued', 'rendering', 'done', 'failed')));
CREATE UNIQUE INDEX IF NOT EXISTS "academy_creative_projects_origin_unique" ON "academy_creative_projects" ("academy_id", "origin_key") WHERE "origin_key" is not null;
CREATE INDEX IF NOT EXISTS "academy_creative_projects_academy_idx" ON "academy_creative_projects" ("academy_id", "updated_at");
