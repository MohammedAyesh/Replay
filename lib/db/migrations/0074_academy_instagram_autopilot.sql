-- Academies' Instagram autopilot: its switch and times, and the calendar of Creative hub designs it posts. Additive only.
CREATE TABLE IF NOT EXISTS "academy_ig_autopilot" (
  "academy_id" integer PRIMARY KEY CONSTRAINT "academy_ig_autopilot_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL, "publish_mode" text DEFAULT 'approve' NOT NULL, "times" jsonb,
  "updated_by" integer CONSTRAINT "academy_ig_autopilot_updated_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_ig_autopilot_publish_mode_check" CHECK ("publish_mode" in ('approve', 'auto')));
CREATE TABLE IF NOT EXISTS "academy_ig_items" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_ig_items_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL CONSTRAINT "academy_ig_items_project_id_academy_creative_projects_id_fk" REFERENCES "academy_creative_projects"("id") ON DELETE CASCADE,
  "placement" text NOT NULL, "slot_at" timestamp with time zone, "pinned" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'planned' NOT NULL, "error" text, "post_id" integer, "ig_permalink" text, "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_ig_items_project_unique" UNIQUE("project_id"),
  CONSTRAINT "academy_ig_items_placement_check" CHECK ("placement" in ('feed', 'reel', 'story')),
  CONSTRAINT "academy_ig_items_status_check" CHECK ("status" in ('planned', 'approved', 'publishing', 'published', 'skipped', 'failed')));
CREATE INDEX IF NOT EXISTS "academy_ig_items_academy_idx" ON "academy_ig_items" ("academy_id", "slot_at");
