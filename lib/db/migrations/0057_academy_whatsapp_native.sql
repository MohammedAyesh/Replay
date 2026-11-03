-- Native WhatsApp in academy Chats: media, locations, polls (with votes), groups and
-- handing chats to a manager or coach. Additive only.
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "content" jsonb;
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "author_phone" text;
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "author_name" text;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "assigned_user_id" integer CONSTRAINT "academy_contacts_assigned_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "academy_social_threads" ADD COLUMN IF NOT EXISTS "assigned_user_id" integer CONSTRAINT "academy_social_threads_assigned_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "academy_whatsapp_groups" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_groups_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "group_id" text NOT NULL,
  "session" text NOT NULL,
  "subject" text NOT NULL,
  "origin" text DEFAULT 'replay' NOT NULL,
  "squad_id" integer CONSTRAINT "academy_whatsapp_groups_squad_id_academy_squads_id_fk" REFERENCES "academy_squads"("id") ON DELETE SET NULL,
  "assigned_user_id" integer CONSTRAINT "academy_whatsapp_groups_assigned_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "last_read_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "muted" boolean DEFAULT false NOT NULL,
  "created_by" integer CONSTRAINT "academy_whatsapp_groups_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_whatsapp_groups_academy_group_unique" UNIQUE ("academy_id", "group_id"),
  CONSTRAINT "academy_whatsapp_groups_origin_check" CHECK ("origin" in ('replay', 'existing'))
);
CREATE INDEX IF NOT EXISTS "academy_whatsapp_groups_group_idx" ON "academy_whatsapp_groups" ("group_id");

CREATE TABLE IF NOT EXISTS "academy_whatsapp_poll_votes" (
  "id" serial PRIMARY KEY,
  "message_id" integer NOT NULL CONSTRAINT "academy_whatsapp_poll_votes_message_id_academy_whatsapp_messages_id_fk" REFERENCES "academy_whatsapp_messages"("id") ON DELETE CASCADE,
  "voter_phone" text NOT NULL,
  "voter_name" text,
  "options" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "voted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_whatsapp_poll_votes_message_voter_unique" UNIQUE ("message_id", "voter_phone")
);
