import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import fs from "node:fs";
import { PACK_STYLES } from "@workspace/api-zod";
import { CREATIVE_MUSIC_STATEMENTS, CREATIVE_PACK_COLUMN, PLAYER_PHOTOS_STATEMENTS, ensureAdditiveColumns } from "./ensureAdditiveColumns";

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

  it("adds academies.creative_pack (0057) with a check that allows exactly PACK_STYLES or null", async () => {
    await pool.query(`ALTER TABLE "academies" DROP COLUMN IF EXISTS "creative_pack"`);
    expect(await ensureAdditiveColumns(pool)).toBe(1);
    const { rows: cols } = await pool.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'academies' AND column_name = 'creative_pack'`);
    expect(cols).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    const { rows: defs } = await pool.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'academies_creative_pack_check'`);
    expect(defs).toHaveLength(1);
    const allowed = [...defs[0].def.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(allowed).toEqual([...PACK_STYLES].sort());
    // The migration says the same thing as the boot-time statement.
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0061_academy_creative_pack.sql", import.meta.url), "utf8");
    expect(migration).toContain(`ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "creative_pack" ${CREATIVE_PACK_COLUMN};`);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("creates academy_player_photos (0058) with one main photo per player, as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "academy_player_photos"`);
    expect(await ensureAdditiveColumns(pool)).toBe(1);
    const { rows: cols } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'academy_player_photos' ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(["academy_id", "created_at", "created_by", "height", "id", "is_primary", "label", "mime", "path", "player_id", "transparent", "width"]);
    const { rows: idx } = await pool.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'academy_player_photos_primary_unique'`);
    expect(idx[0]?.def).toMatch(/UNIQUE INDEX .* \(player_id\) WHERE is_primary/);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0062_academy_player_photos.sql", import.meta.url), "utf8");
    for (const statement of PLAYER_PHOTOS_STATEMENTS) expect(migration).toContain(`${statement};`);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("creates creative_music_tracks (0063) with its scope rules, as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "creative_music_tracks"`);
    expect(await ensureAdditiveColumns(pool)).toBe(1);
    const { rows: cols } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'creative_music_tracks' ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual([
      "academy_id", "artist", "bpm", "created_at", "created_by", "duration_ms", "id", "key", "license", "loudness_lufs", "mime", "mood", "path", "scope", "status", "title", "waveform",
    ]);
    // A Replay track has no academy; an academy track must name one.
    await expect(pool.query(`INSERT INTO creative_music_tracks (scope, academy_id, title, mood, duration_ms, path, license) VALUES ('academy', null, 'x', 'fun', 1000, 'p', 'l')`)).rejects.toThrow();
    await expect(pool.query(`INSERT INTO creative_music_tracks (scope, title, mood, duration_ms, path, license) VALUES ('replay', 'x', 'loud', 1000, 'p', 'l')`)).rejects.toThrow();
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0063_creative_music.sql", import.meta.url), "utf8");
    for (const statement of CREATIVE_MUSIC_STATEMENTS) expect(migration).toContain(`${statement};`);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });
});
