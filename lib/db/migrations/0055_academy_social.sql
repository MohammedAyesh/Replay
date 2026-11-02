-- Academy social: Facebook Page + Instagram connection, DMs (Instagram Direct, Messenger),
-- comments, and posts with engagement. Additive only.

CREATE TABLE IF NOT EXISTS "academy_social_accounts" (
  "academy_id" integer PRIMARY KEY CONSTRAINT "academy_social_accounts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "token_enc" text, "page_id" text, "page_name" text, "page_token_enc" text,
  "ig_user_id" text, "ig_username" text, "ig_picture" text,
  "subscribed" boolean DEFAULT false NOT NULL, "status" text DEFAULT 'pending' NOT NULL, "error" text,
  "insights" jsonb, "insights_at" timestamp with time zone, "posts_synced_at" timestamp with time zone,
  "connected_by" integer CONSTRAINT "academy_social_accounts_connected_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "connected_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_social_accounts_status_check" CHECK ("status" in ('pending', 'connected', 'error')));
CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_accounts_page_unique" ON "academy_social_accounts" ("page_id") WHERE "page_id" is not null;
CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_accounts_ig_unique" ON "academy_social_accounts" ("ig_user_id") WHERE "ig_user_id" is not null;

CREATE TABLE IF NOT EXISTS "academy_social_threads" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_social_threads_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "channel" text NOT NULL, "external_user_id" text NOT NULL, "name" text, "username" text, "picture" text,
  "contact_id" integer CONSTRAINT "academy_social_threads_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE SET NULL,
  "stage" text, "last_in_at" timestamp with time zone, "last_at" timestamp with time zone, "last_read_at" timestamp with time zone, "archived_at" timestamp with time zone,
  "muted" boolean DEFAULT false NOT NULL, "blocked_at" timestamp with time zone, "personal_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_social_threads_channel_check" CHECK ("channel" in ('instagram', 'messenger')),
  CONSTRAINT "academy_social_threads_stage_check" CHECK ("stage" is null or "stage" in ('new', 'contacted', 'trial', 'joined', 'lost')));
CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_threads_person_unique" ON "academy_social_threads" ("academy_id", "channel", "external_user_id");
CREATE INDEX IF NOT EXISTS "academy_social_threads_academy_idx" ON "academy_social_threads" ("academy_id", "last_at");

CREATE TABLE IF NOT EXISTS "academy_social_messages" (
  "id" serial PRIMARY KEY,
  "thread_id" integer NOT NULL CONSTRAINT "academy_social_messages_thread_id_academy_social_threads_id_fk" REFERENCES "academy_social_threads"("id") ON DELETE CASCADE,
  "academy_id" integer NOT NULL CONSTRAINT "academy_social_messages_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "direction" text NOT NULL, "kind" text DEFAULT 'dm' NOT NULL, "body" text DEFAULT '' NOT NULL,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL, "external_id" text,
  "status" text DEFAULT 'received' NOT NULL, "error" text,
  "sent_by" integer CONSTRAINT "academy_social_messages_sent_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_social_messages_direction_check" CHECK ("direction" in ('in', 'out')),
  CONSTRAINT "academy_social_messages_status_check" CHECK ("status" in ('received', 'sent', 'failed')));
CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_messages_external_unique" ON "academy_social_messages" ("external_id") WHERE "external_id" is not null;
CREATE INDEX IF NOT EXISTS "academy_social_messages_thread_idx" ON "academy_social_messages" ("thread_id", "created_at");

CREATE TABLE IF NOT EXISTS "academy_social_comments" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_social_comments_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "channel" text NOT NULL, "comment_id" text NOT NULL, "parent_id" text, "post_id" text,
  "post_permalink" text, "post_caption" text, "from_id" text, "from_name" text,
  "body" text DEFAULT '' NOT NULL, "hidden" boolean DEFAULT false NOT NULL,
  "reply_body" text, "replied_at" timestamp with time zone,
  "replied_by" integer CONSTRAINT "academy_social_comments_replied_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "private_replied_at" timestamp with time zone,
  "thread_id" integer CONSTRAINT "academy_social_comments_thread_id_academy_social_threads_id_fk" REFERENCES "academy_social_threads"("id") ON DELETE SET NULL,
  "read_at" timestamp with time zone, "deleted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_social_comments_channel_check" CHECK ("channel" in ('instagram', 'facebook')));
CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_comments_comment_unique" ON "academy_social_comments" ("channel", "comment_id");
CREATE INDEX IF NOT EXISTS "academy_social_comments_academy_idx" ON "academy_social_comments" ("academy_id", "created_at");

CREATE TABLE IF NOT EXISTS "academy_social_posts" (
  "id" serial PRIMARY KEY,
  "academy_id" integer NOT NULL CONSTRAINT "academy_social_posts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
  "source" text DEFAULT 'replay' NOT NULL, "targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "format" text DEFAULT 'image' NOT NULL, "caption" text DEFAULT '' NOT NULL,
  "media" jsonb DEFAULT '[]'::jsonb NOT NULL, "status" text DEFAULT 'draft' NOT NULL,
  "scheduled_for" timestamp with time zone, "published_at" timestamp with time zone, "ig_media_id" text, "ig_permalink" text,
  "fb_post_id" text, "fb_permalink" text, "thumbnail" text, "error" text,
  "insights" jsonb, "insights_at" timestamp with time zone,
  "created_by" integer CONSTRAINT "academy_social_posts_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "academy_social_posts_source_check" CHECK ("source" in ('replay', 'synced')),
  CONSTRAINT "academy_social_posts_format_check" CHECK ("format" in ('image', 'carousel', 'video', 'reel', 'story')),
  CONSTRAINT "academy_social_posts_status_check" CHECK ("status" in ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed')));
CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_posts_ig_unique" ON "academy_social_posts" ("ig_media_id") WHERE "ig_media_id" is not null;
CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_posts_fb_unique" ON "academy_social_posts" ("fb_post_id") WHERE "fb_post_id" is not null;
CREATE INDEX IF NOT EXISTS "academy_social_posts_academy_idx" ON "academy_social_posts" ("academy_id", "published_at");
CREATE INDEX IF NOT EXISTS "academy_social_posts_due_idx" ON "academy_social_posts" ("status", "scheduled_for");
