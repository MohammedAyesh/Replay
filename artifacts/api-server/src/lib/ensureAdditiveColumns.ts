import type { pool as dbPool } from "@workspace/db";

type Pool = typeof dbPool;

/**
 * Additive, idempotent columns the code reads with `select *`. If a publish reaches a
 * database that never got them (the push ran on dev only), every academy read fails
 * with "column does not exist". Adding them at boot keeps that from taking pages down.
 * Only ADD COLUMN IF NOT EXISTS of nullable columns belongs here: nothing that drops,
 * renames or rewrites data.
 */
const STATEMENTS = [
  // 0052_academy_profile.sql
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "name_ar" text`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "whatsapp_phone" text`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "email" text`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "address" text`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "latitude" real`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "longitude" real`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "instagram_url" text`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "facebook_url" text`,
  `ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "website_url" text`,
];

export async function ensureAdditiveColumns(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'academies'`,
  );
  const have = new Set(rows.map((r) => r.column_name));
  const missing = STATEMENTS.filter((sql) => !have.has(/ADD COLUMN IF NOT EXISTS "([a-z_]+)"/.exec(sql)![1]));
  for (const sql of missing) await pool.query(sql);
  return missing.length;
}
