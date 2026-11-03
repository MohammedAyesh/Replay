-- Academy Chats, second batch: replies, reactions, edits/deletes, mentions, profile photos,
-- typing, saved replies, greeting/away/missed-call options, Status and Channel posts. Additive only.
ALTER TABLE "academy_whatsapp_settings" ADD COLUMN IF NOT EXISTS "chat_options" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "reply_to_wa_id" text;
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "reactions" jsonb;
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "mentions" jsonb;
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;
ALTER TABLE "academy_whatsapp_messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "avatar_path" text;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "avatar_checked_at" timestamp with time zone;
ALTER TABLE "academy_contacts" ADD COLUMN IF NOT EXISTS "typing_until" timestamp with time zone;
ALTER TABLE "academy_whatsapp_groups" ADD COLUMN IF NOT EXISTS "avatar_path" text;
ALTER TABLE "academy_whatsapp_groups" ADD COLUMN IF NOT EXISTS "avatar_checked_at" timestamp with time zone;
ALTER TABLE "academy_whatsapp_groups" ADD COLUMN IF NOT EXISTS "typing_until" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "academy_whatsapp_saved_replies" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_saved_replies_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "shortcut" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_by" integer CONSTRAINT "academy_whatsapp_saved_replies_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_whatsapp_saved_replies_academy_shortcut_unique" UNIQUE ("academy_id", "shortcut")
);

CREATE TABLE IF NOT EXISTS "academy_whatsapp_posts" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_whatsapp_posts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "target" text NOT NULL,
  "kind" text NOT NULL,
  "text" text,
  "media" jsonb,
  "background_color" text,
  "wa_message_id" text,
  "error" text,
  "created_by" integer CONSTRAINT "academy_whatsapp_posts_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_whatsapp_posts_target_check" CHECK ("target" in ('status', 'channel')),
  CONSTRAINT "academy_whatsapp_posts_kind_check" CHECK ("kind" in ('text', 'image', 'video'))
);
CREATE INDEX IF NOT EXISTS "academy_whatsapp_posts_academy_idx" ON "academy_whatsapp_posts" ("academy_id", "created_at");
