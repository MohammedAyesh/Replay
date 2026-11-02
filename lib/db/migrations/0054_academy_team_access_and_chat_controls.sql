-- Academy managers, staff invites, per-role visibility/permissions, and chat controls
-- (archive, mute, block, personal, "who is this" later). Additive, plus widening the
-- academy_members role check to allow 'manager'.
ALTER TABLE "academy_members" DROP CONSTRAINT IF EXISTS "academy_members_role_check";
ALTER TABLE "academy_members" ADD CONSTRAINT "academy_members_role_check" CHECK ("role" in ('owner', 'manager', 'coach'));

ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "muted" boolean DEFAULT false NOT NULL;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "blocked_at" timestamp with time zone;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "personal_at" timestamp with time zone;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "link_dismissed_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "academy_access_settings" (
  "academy_id" integer PRIMARY KEY CONSTRAINT "academy_access_settings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by" integer CONSTRAINT "academy_access_settings_updated_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "academy_staff_invites" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_staff_invites_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "token" text NOT NULL,
  "label" text,
  "created_by" integer CONSTRAINT "academy_staff_invites_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_by" integer CONSTRAINT "academy_staff_invites_accepted_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "accepted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_staff_invites_token_unique" UNIQUE ("token"),
  CONSTRAINT "academy_staff_invites_role_check" CHECK ("role" in ('manager', 'coach'))
);
CREATE INDEX IF NOT EXISTS "academy_staff_invites_academy_idx" ON "academy_staff_invites" ("academy_id");
