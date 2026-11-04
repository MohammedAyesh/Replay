-- Starred templates, clips and drafts in the Creative hub, per console user. Additive only.
CREATE TABLE IF NOT EXISTS "academy_favorites" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_favorites_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL CONSTRAINT "academy_favorites_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL, "item_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_favorites_item_unique" UNIQUE("academy_id", "user_id", "kind", "item_key"),
  CONSTRAINT "academy_favorites_kind_check" CHECK ("kind" in ('template', 'clip', 'project')));
CREATE INDEX IF NOT EXISTS "academy_favorites_user_idx" ON "academy_favorites" ("academy_id", "user_id");
