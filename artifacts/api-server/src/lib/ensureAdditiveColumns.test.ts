import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { ensureAdditiveColumns } from "./ensureAdditiveColumns";

describe("ensureAdditiveColumns", () => {
  it("adds columns and tables a database is missing, and is a no-op after", async () => {
    await pool.query(`ALTER TABLE "academies" DROP COLUMN IF EXISTS "website_url", DROP COLUMN IF EXISTS "latitude"`);
    await pool.query(`ALTER TABLE "academy_ad_requests" DROP COLUMN IF EXISTS "cards"`);
    await pool.query(`DROP TABLE IF EXISTS "academy_ad_templates"`);
    await pool.query(`ALTER TABLE "academy_members" DROP CONSTRAINT "academy_members_role_check"`);
    await pool.query(`ALTER TABLE "academy_members" ADD CONSTRAINT "academy_members_role_check" CHECK ("role" in ('owner', 'coach')) NOT VALID`);
    expect(await ensureAdditiveColumns(pool)).toBe(5);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
    const { rows } = await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'academies' AND column_name IN ('website_url','latitude')) OR (table_name = 'academy_ad_requests' AND column_name = 'cards') OR (table_name = 'academy_ad_templates' AND column_name = 'variants')`);
    expect(rows).toHaveLength(4);
  });
});
