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
];

/** Returns how many columns and tables it had to add. */
export async function ensureAdditiveColumns(pool: Pool): Promise<number> {
  const names = [...new Set([...COLUMNS.map((c) => c.table), ...TABLES.map((t) => t.table)])];
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
  return added;
}
