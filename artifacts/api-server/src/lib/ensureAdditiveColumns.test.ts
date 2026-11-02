import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { ensureAdditiveColumns } from "./ensureAdditiveColumns";

describe("ensureAdditiveColumns", () => {
  it("adds academy profile columns a database is missing, and is a no-op after", async () => {
    await pool.query(`ALTER TABLE "academies" DROP COLUMN IF EXISTS "website_url", DROP COLUMN IF EXISTS "latitude"`);
    expect(await ensureAdditiveColumns(pool)).toBe(2);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
    const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'academies' AND column_name IN ('website_url','latitude')`);
    expect(rows).toHaveLength(2);
  });
});
