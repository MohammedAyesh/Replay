import type { pool as dbPool } from "@workspace/db";

type Pool = typeof dbPool;

/**
 * Additive, idempotent schema the code depends on. If a publish reaches a database that
 * never got it (the push ran on dev only), every `select *` on those tables fails with
 * "column does not exist" and takes whole pages down. Adding it at boot prevents that.
 * Only ADD COLUMN IF NOT EXISTS of nullable/defaulted columns and CREATE TABLE IF NOT
 * EXISTS belong here: nothing that drops, renames or rewrites data.
 */
const COLUMNS: Array<{ table: string; column: string; type: string }> = [
  // 0052_academy_profile.sql
  { table: "academies", column: "name_ar", type: "text" },
  { table: "academies", column: "whatsapp_phone", type: "text" },
  { table: "academies", column: "email", type: "text" },
  { table: "academies", column: "address", type: "text" },
  { table: "academies", column: "latitude", type: "real" },
  { table: "academies", column: "longitude", type: "real" },
  { table: "academies", column: "instagram_url", type: "text" },
  { table: "academies", column: "facebook_url", type: "text" },
  { table: "academies", column: "website_url", type: "text" },
  // 0053_academy_ad_wallet_media_templates.sql
  { table: "meta_ad_campaigns", column: "charged_spend_cents", type: "integer DEFAULT 0 NOT NULL" },
  { table: "meta_ads", column: "insights", type: "jsonb" },
  { table: "academy_ad_requests", column: "budget_fils", type: "integer" },
  { table: "academy_ad_requests", column: "cards", type: "jsonb" },
  { table: "academy_ad_requests", column: "variants", type: "jsonb" },
  { table: "academy_ad_requests", column: "questions", type: "jsonb" },
  { table: "academy_ad_requests", column: "meta_ads", type: "jsonb" },
  { table: "academy_ad_requests", column: "template_id", type: "integer" },
  { table: "academy_ad_requests", column: "paused_reason", type: "text" },
  // 0054_academy_team_access_and_chat_controls.sql
  { table: "academy_contacts", column: "archived_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "muted", type: "boolean DEFAULT false NOT NULL" },
  { table: "academy_contacts", column: "blocked_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "personal_at", type: "timestamp with time zone" },
  { table: "academy_contacts", column: "link_dismissed_at", type: "timestamp with time zone" },
];

const TABLES: Array<{ table: string; statements: string[] }> = [
  {
    table: "academy_ad_wallet_entries",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_ad_wallet_entries" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_ad_wallet_entries_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "kind" text NOT NULL, "amount_fils" integer NOT NULL, "status" text DEFAULT 'confirmed' NOT NULL,
        "method" text, "reference" text, "campaign_id" text, "meta_spend_cents" integer, "note" text,
        "created_by" integer CONSTRAINT "academy_ad_wallet_entries_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "confirmed_by" integer CONSTRAINT "academy_ad_wallet_entries_confirmed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "confirmed_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_ad_wallet_kind_check" CHECK ("kind" in ('topup', 'spend', 'adjustment')),
        CONSTRAINT "academy_ad_wallet_status_check" CHECK ("status" in ('pending', 'confirmed', 'rejected')))`,
      `CREATE INDEX IF NOT EXISTS "academy_ad_wallet_academy_idx" ON "academy_ad_wallet_entries" ("academy_id")`,
      `CREATE INDEX IF NOT EXISTS "academy_ad_wallet_status_idx" ON "academy_ad_wallet_entries" ("status")`,
    ],
  },
  {
    table: "academy_ad_media",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_ad_media" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_ad_media_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "kind" text NOT NULL, "name" text DEFAULT '' NOT NULL, "source" text DEFAULT 'upload' NOT NULL,
        "image_data" text, "storage_url" text, "bytes" integer, "width" integer, "height" integer, "duration_sec" real,
        "meta_videos" jsonb, "user_clip_id" integer, "status" text DEFAULT 'ready' NOT NULL, "error" text,
        "created_by" integer CONSTRAINT "academy_ad_media_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_ad_media_kind_check" CHECK ("kind" in ('image', 'video')),
        CONSTRAINT "academy_ad_media_status_check" CHECK ("status" in ('processing', 'ready', 'failed')))`,
      `CREATE INDEX IF NOT EXISTS "academy_ad_media_academy_idx" ON "academy_ad_media" ("academy_id")`,
    ],
  },
  {
    table: "academy_ad_templates",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_ad_templates" (
        "id" serial PRIMARY KEY, "key" text, "title" text NOT NULL, "title_ar" text, "description" text, "description_ar" text,
        "goal" text DEFAULT 'whatsapp' NOT NULL, "variants" jsonb NOT NULL, "questions" jsonb,
        "daily_budget_fils" integer DEFAULT 5000 NOT NULL, "days" integer DEFAULT 14 NOT NULL,
        "age_min" integer DEFAULT 25 NOT NULL, "age_max" integer DEFAULT 55 NOT NULL, "radius_km" integer DEFAULT 10 NOT NULL,
        "image_data" text, "is_active" boolean DEFAULT true NOT NULL, "sort_order" integer DEFAULT 0 NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_ad_templates_key_unique" UNIQUE ("key"),
        CONSTRAINT "academy_ad_templates_goal_check" CHECK ("goal" in ('whatsapp', 'lead_form')))`,
    ],
  },
  {
    table: "academy_access_settings",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_access_settings" (
        "academy_id" integer PRIMARY KEY CONSTRAINT "academy_access_settings_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "sections" jsonb DEFAULT '{}'::jsonb NOT NULL, "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "updated_by" integer CONSTRAINT "academy_access_settings_updated_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`,
    ],
  },
  {
    table: "academy_staff_invites",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_staff_invites" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_staff_invites_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "role" text NOT NULL, "token" text NOT NULL, "label" text,
        "created_by" integer CONSTRAINT "academy_staff_invites_created_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "accepted_by" integer CONSTRAINT "academy_staff_invites_accepted_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "accepted_at" timestamp with time zone, "revoked_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_staff_invites_token_unique" UNIQUE ("token"),
        CONSTRAINT "academy_staff_invites_role_check" CHECK ("role" in ('manager', 'coach')))`,
      `CREATE INDEX IF NOT EXISTS "academy_staff_invites_academy_idx" ON "academy_staff_invites" ("academy_id")`,
    ],
  },
  // 0055_academy_social.sql
  {
    table: "academy_social_accounts",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_accounts" (
        "academy_id" integer PRIMARY KEY CONSTRAINT "academy_social_accounts_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "token_enc" text, "page_id" text, "page_name" text, "page_token_enc" text,
        "ig_user_id" text, "ig_username" text, "ig_picture" text,
        "subscribed" boolean DEFAULT false NOT NULL, "status" text DEFAULT 'pending' NOT NULL, "error" text,
        "insights" jsonb, "insights_at" timestamp with time zone, "posts_synced_at" timestamp with time zone,
        "connected_by" integer CONSTRAINT "academy_social_accounts_connected_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "connected_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_accounts_status_check" CHECK ("status" in ('pending', 'connected', 'error')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_accounts_page_unique" ON "academy_social_accounts" ("page_id") WHERE "page_id" is not null`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_accounts_ig_unique" ON "academy_social_accounts" ("ig_user_id") WHERE "ig_user_id" is not null`,
    ],
  },
  {
    table: "academy_social_threads",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_threads" (
        "id" serial PRIMARY KEY,
        "academy_id" integer NOT NULL CONSTRAINT "academy_social_threads_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "channel" text NOT NULL, "external_user_id" text NOT NULL, "name" text, "username" text, "picture" text,
        "contact_id" integer CONSTRAINT "academy_social_threads_contact_id_academy_contacts_id_fk" REFERENCES "academy_contacts"("id") ON DELETE SET NULL,
        "stage" text, "last_in_at" timestamp with time zone, "last_at" timestamp with time zone, "last_read_at" timestamp with time zone, "archived_at" timestamp with time zone,
        "muted" boolean DEFAULT false NOT NULL, "blocked_at" timestamp with time zone, "personal_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_threads_channel_check" CHECK ("channel" in ('instagram', 'messenger')),
        CONSTRAINT "academy_social_threads_stage_check" CHECK ("stage" is null or "stage" in ('new', 'contacted', 'trial', 'joined', 'lost')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_threads_person_unique" ON "academy_social_threads" ("academy_id", "channel", "external_user_id")`,
      `CREATE INDEX IF NOT EXISTS "academy_social_threads_academy_idx" ON "academy_social_threads" ("academy_id", "last_at")`,
    ],
  },
  {
    table: "academy_social_messages",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_messages" (
        "id" serial PRIMARY KEY,
        "thread_id" integer NOT NULL CONSTRAINT "academy_social_messages_thread_id_academy_social_threads_id_fk" REFERENCES "academy_social_threads"("id") ON DELETE CASCADE,
        "academy_id" integer NOT NULL CONSTRAINT "academy_social_messages_academy_id_academies_id_fk" REFERENCES "academies"("id") ON DELETE CASCADE,
        "direction" text NOT NULL, "kind" text DEFAULT 'dm' NOT NULL, "body" text DEFAULT '' NOT NULL,
        "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL, "external_id" text,
        "status" text DEFAULT 'received' NOT NULL, "error" text,
        "sent_by" integer CONSTRAINT "academy_social_messages_sent_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "academy_social_messages_direction_check" CHECK ("direction" in ('in', 'out')),
        CONSTRAINT "academy_social_messages_status_check" CHECK ("status" in ('received', 'sent', 'failed')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_messages_external_unique" ON "academy_social_messages" ("external_id") WHERE "external_id" is not null`,
      `CREATE INDEX IF NOT EXISTS "academy_social_messages_thread_idx" ON "academy_social_messages" ("thread_id", "created_at")`,
    ],
  },
  {
    table: "academy_social_comments",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_comments" (
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
        CONSTRAINT "academy_social_comments_channel_check" CHECK ("channel" in ('instagram', 'facebook')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_comments_comment_unique" ON "academy_social_comments" ("channel", "comment_id")`,
      `CREATE INDEX IF NOT EXISTS "academy_social_comments_academy_idx" ON "academy_social_comments" ("academy_id", "created_at")`,
    ],
  },
  {
    table: "academy_social_posts",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_social_posts" (
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
        CONSTRAINT "academy_social_posts_status_check" CHECK ("status" in ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_posts_ig_unique" ON "academy_social_posts" ("ig_media_id") WHERE "ig_media_id" is not null`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_social_posts_fb_unique" ON "academy_social_posts" ("fb_post_id") WHERE "fb_post_id" is not null`,
      `CREATE INDEX IF NOT EXISTS "academy_social_posts_academy_idx" ON "academy_social_posts" ("academy_id", "published_at")`,
      `CREATE INDEX IF NOT EXISTS "academy_social_posts_due_idx" ON "academy_social_posts" ("status", "scheduled_for")`,
    ],
  },
  // 0056_academy_creative.sql
  {
    table: "academy_creative_projects",
    statements: [
      `CREATE TABLE IF NOT EXISTS "academy_creative_projects" (
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
  CONSTRAINT "academy_creative_projects_render_status_check" CHECK ("render_status" in ('none', 'queued', 'rendering', 'done', 'failed')))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "academy_creative_projects_origin_unique" ON "academy_creative_projects" ("academy_id", "origin_key") WHERE "origin_key" is not null`,
      `CREATE INDEX IF NOT EXISTS "academy_creative_projects_academy_idx" ON "academy_creative_projects" ("academy_id", "updated_at")`,
    ],
  },
];

/** Checks that only ever widen what's allowed (0054: academy managers). */
const WIDENED_CHECKS: Array<{ table: string; name: string; mustContain: string; definition: string }> = [
  { table: "academy_members", name: "academy_members_role_check", mustContain: "'manager'", definition: `CHECK ("role" in ('owner', 'manager', 'coach'))` },
];

/** Returns how many columns and tables it had to add. */
export async function ensureAdditiveColumns(pool: Pool): Promise<number> {
  const names = [...new Set([...COLUMNS.map((c) => c.table), ...TABLES.map((t) => t.table), ...WIDENED_CHECKS.map((c) => c.table)])];
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [names],
  );
  const tables = new Set(rows.map((r) => r.table_name));
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  let added = 0;
  for (const t of TABLES) {
    if (tables.has(t.table)) continue;
    for (const sql of t.statements) await pool.query(sql);
    added += 1;
  }
  for (const c of COLUMNS) {
    // A table the publish never created can't take a column; its own feature fails alone.
    if (!tables.has(c.table) || have.has(`${c.table}.${c.column}`)) continue;
    await pool.query(`ALTER TABLE "${c.table}" ADD COLUMN IF NOT EXISTS "${c.column}" ${c.type}`);
    added += 1;
  }
  for (const c of WIDENED_CHECKS) {
    if (!tables.has(c.table)) continue;
    const { rows: defs } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [c.name],
    );
    if (defs[0]?.def.includes(c.mustContain)) continue;
    await pool.query(`ALTER TABLE "${c.table}" DROP CONSTRAINT IF EXISTS "${c.name}"`);
    await pool.query(`ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.name}" ${c.definition}`);
    added += 1;
  }
  return added;
}
