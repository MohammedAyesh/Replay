import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import fs from "node:fs";
import { PACK_STYLES } from "@workspace/api-zod";
import { CREATIVE_MUSIC_STATEMENTS, CREATIVE_PACK_COLUMN, CREATIVE_TEMPLATE_MUSIC_STATEMENTS, PLAYER_PHOTOS_STATEMENTS, VENUE_IG_STATEMENTS, ensureAdditiveColumns, PLAYER_FEATURES_STATEMENTS, FEATURE_SETTINGS_STATEMENTS, PLAYER_CLIPS_STATEMENTS, PHONE_MEDIA_STATEMENTS, STAGE_EVENTS_STATEMENTS, REPORT_SHARES_STATEMENTS, STAGE_TRIGGER_STATEMENTS, TRIAL_CLIPS_STATEMENTS, COLUMNS, FAVORITES_STATEMENTS, MY_TEMPLATES_STATEMENTS, ACADEMY_IG_STATEMENTS } from "./ensureAdditiveColumns";

describe("ensureAdditiveColumns", () => {
  it("adds columns and tables a database is missing, and is a no-op after", async () => {
    await pool.query(`ALTER TABLE "academies" DROP COLUMN IF EXISTS "website_url", DROP COLUMN IF EXISTS "latitude"`);
    await pool.query(`ALTER TABLE "academy_ad_requests" DROP COLUMN IF EXISTS "cards"`);
    await pool.query(`DROP TABLE IF EXISTS "academy_ad_templates"`);
    await pool.query(`ALTER TABLE "academy_members" DROP CONSTRAINT "academy_members_role_check"`);
    await pool.query(`ALTER TABLE "academy_members" ADD CONSTRAINT "academy_members_role_check" CHECK ("role" in ('owner', 'coach')) NOT VALID`);
    // A pushed database has the 0068 tables but never the People stage trigger: boot installs it.
    await pool.query(`DROP TRIGGER IF EXISTS "academy_contacts_stage_events" ON "academy_contacts"`);
    expect(await ensureAdditiveColumns(pool)).toBe(6);
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

  it("adds public-post consent and the every-child tables (0066), as the migration says", async () => {
    for (const t of ["academy_player_clips", "academy_player_features", "academy_feature_settings"]) await pool.query(`DROP TABLE IF EXISTS "${t}"`);
    await pool.query(`ALTER TABLE "academy_players" DROP COLUMN IF EXISTS "public_posts_consent", DROP COLUMN IF EXISTS "public_posts_consent_at"`);
    // Three tables, the two consent columns, and 0069's calendar column on the table made just now.
    expect(await ensureAdditiveColumns(pool)).toBe(6);
    const { rows } = await pool.query<{ column_name: string; column_default: string | null }>(`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'academy_players' AND column_name LIKE 'public_posts%' ORDER BY column_name`);
    expect(rows.map((r) => r.column_name)).toEqual(["public_posts_consent", "public_posts_consent_at"]);
    expect(rows[0].column_default).toBe("false");
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0066_every_child_appears.sql", import.meta.url), "utf8");
    for (const statement of [...PLAYER_FEATURES_STATEMENTS, ...FEATURE_SETTINGS_STATEMENTS, ...PLAYER_CLIPS_STATEMENTS]) expect(migration).toContain(`${statement};`);
    expect(migration).toContain(`ALTER TABLE "academy_players" ADD COLUMN IF NOT EXISTS "public_posts_consent" boolean DEFAULT false NOT NULL;`);
    // A family link token is 32 hex characters, nothing else.
    await expect(pool.query(`INSERT INTO academy_player_clips (academy_id, session_id, player_id, token) VALUES (1, 1, 1, 'short')`)).rejects.toThrow();
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("creates academy_phone_media (0067), with no column for coordinates, as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "academy_phone_media"`);
    expect(await ensureAdditiveColumns(pool)).toBe(1);
    const { rows } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'academy_phone_media'`);
    expect(rows.map((r) => r.column_name).filter((c) => /lat|lon|gps|location/.test(c))).toEqual([]);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0067_academy_phone_media.sql", import.meta.url), "utf8");
    for (const statement of PHONE_MEDIA_STATEMENTS) expect(migration).toContain(`${statement};`);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("creates the value-report tables and the People stage trigger (0068), as the migration says", async () => {
    await pool.query(`DROP TRIGGER IF EXISTS "academy_contacts_stage_events" ON "academy_contacts"`);
    for (const t of ["academy_contact_stage_events", "academy_value_report_shares"]) await pool.query(`DROP TABLE IF EXISTS "${t}"`);
    expect(await ensureAdditiveColumns(pool)).toBe(3);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0068_academy_value_report.sql", import.meta.url), "utf8");
    for (const statement of [...STAGE_EVENTS_STATEMENTS, ...REPORT_SHARES_STATEMENTS, ...STAGE_TRIGGER_STATEMENTS]) expect(migration).toContain(`${statement};`);
    // Every stage or kind change of a contact is written, whichever code path made it.
    const { rows: [f] } = await pool.query<{ id: number }>(`INSERT INTO fields (name, camera_id) VALUES ('Stage field', 'stage-' || floor(random()*1e9)::text) RETURNING id`);
    const { rows: [a] } = await pool.query<{ id: number }>(`INSERT INTO academies (name, field_id) VALUES ('Stage test', $1) RETURNING id`, [f.id]);
    const { rows: [c] } = await pool.query<{ id: number }>(`INSERT INTO academy_contacts (academy_id, phone, kind, stage) VALUES ($1, '+962790000001', 'lead', 'new') RETURNING id`, [a.id]);
    await pool.query(`UPDATE academy_contacts SET stage = 'trial' WHERE id = $1`, [c.id]);
    await pool.query(`UPDATE academy_contacts SET name = 'x' WHERE id = $1`, [c.id]);
    await pool.query(`UPDATE academy_contacts SET stage = 'joined', kind = 'parent' WHERE id = $1`, [c.id]);
    const { rows: ev } = await pool.query(`SELECT from_stage, to_stage, from_kind, to_kind FROM academy_contact_stage_events WHERE contact_id = $1 ORDER BY id`, [c.id]);
    expect(ev).toEqual([
      { from_stage: null, to_stage: "new", from_kind: null, to_kind: "lead" },
      { from_stage: "new", to_stage: "trial", from_kind: "lead", to_kind: "lead" },
      { from_stage: "trial", to_stage: "joined", from_kind: "lead", to_kind: "parent" },
    ]);
    await pool.query(`DELETE FROM academies WHERE id = $1`, [a.id]);
    await pool.query(`DELETE FROM fields WHERE id = $1`, [f.id]);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("adds the marketing-practice columns and academy_trial_clips (0069), as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "academy_trial_clips"`);
    await pool.query(`ALTER TABLE "academy_contacts" DROP COLUMN IF EXISTS "referred_by_contact_id", DROP COLUMN IF EXISTS "referral_note", DROP COLUMN IF EXISTS "trial_session_id"`);
    await pool.query(`ALTER TABLE "academies" DROP COLUMN IF EXISTS "google_review_url"`);
    await pool.query(`ALTER TABLE "academy_feature_settings" DROP COLUMN IF EXISTS "content_calendar"`);
    expect(await ensureAdditiveColumns(pool)).toBe(6);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0069_marketing_practices.sql", import.meta.url), "utf8");
    for (const statement of TRIAL_CLIPS_STATEMENTS) expect(migration).toContain(`${statement};`);
    for (const c of COLUMNS.filter((x) => ["google_review_url", "referred_by_contact_id", "referral_note", "trial_session_id", "content_calendar"].includes(x.column))) {
      expect(migration).toContain(`ALTER TABLE "${c.table}" ADD COLUMN IF NOT EXISTS "${c.column}" ${c.type};`);
    }
    const { rows } = await pool.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conname IN ('academy_contacts_referred_by_contact_id_academy_contacts_id_fk', 'academy_contacts_trial_session_id_academy_sessions_id_fk') ORDER BY conname`);
    expect(rows).toHaveLength(2);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("creates academy_favorites (0072), as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "academy_favorites"`);
    expect(await ensureAdditiveColumns(pool)).toBe(1);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0072_academy_favorites.sql", import.meta.url), "utf8");
    for (const statement of FAVORITES_STATEMENTS) expect(migration).toContain(`${statement};`);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("creates the academy Instagram autopilot tables (0074), as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "academy_ig_items"`);
    await pool.query(`DROP TABLE IF EXISTS "academy_ig_autopilot"`);
    expect(await ensureAdditiveColumns(pool)).toBe(2);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0074_academy_instagram_autopilot.sql", import.meta.url), "utf8");
    for (const statement of ACADEMY_IG_STATEMENTS) expect(migration).toContain(`${statement};`);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("creates academy_creative_templates (0073), as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "academy_creative_templates"`);
    expect(await ensureAdditiveColumns(pool)).toBe(1);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0073_academy_creative_templates.sql", import.meta.url), "utf8");
    for (const statement of MY_TEMPLATES_STATEMENTS) expect(migration).toContain(`${statement};`);
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

  it("creates creative_template_music (0064), as the migration says", async () => {
    await pool.query(`DROP TABLE IF EXISTS "creative_template_music"`);
    expect(await ensureAdditiveColumns(pool)).toBe(1);
    const { rows: cols } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'creative_template_music' ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(["duck", "fade_in_ms", "fade_out_ms", "start_ms", "template_key", "track_ids", "updated_at", "updated_by", "volume"]);
    await pool.query(`INSERT INTO creative_template_music (template_key, volume, fade_in_ms, fade_out_ms) VALUES ('t-0064', 0.5, 300, 1500)`);
    const { rows } = await pool.query(`SELECT track_ids, duck, start_ms FROM creative_template_music WHERE template_key = 't-0064'`);
    expect(rows).toEqual([{ track_ids: [], duck: false, start_ms: 0 }]);
    await expect(pool.query(`INSERT INTO creative_template_music (template_key, volume, fade_in_ms, fade_out_ms) VALUES ('t-0064', 0.5, 300, 1500)`)).rejects.toThrow();
    await pool.query(`DELETE FROM creative_template_music WHERE template_key = 't-0064'`);
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0064_creative_template_music.sql", import.meta.url), "utf8");
    for (const statement of CREATIVE_TEMPLATE_MUSIC_STATEMENTS) expect(migration).toContain(`${statement};`);
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });

  it("adds the Instagram autopilot's tables and columns (0070), as the migration says", async () => {
    const migration = fs.readFileSync(new URL("../../../../lib/db/migrations/0070_venue_instagram_autopilot.sql", import.meta.url), "utf8");
    for (const statement of VENUE_IG_STATEMENTS) expect(migration).toContain(`${statement};`);
    await pool.query(`DROP TABLE IF EXISTS "venue_ig_removals"`);
    await pool.query(`ALTER TABLE "venue_bookings" DROP COLUMN IF EXISTS "under_18"`);
    await pool.query(`ALTER TABLE "venue_settings" DROP COLUMN IF EXISTS "ig_consent_mode"`);
    expect(await ensureAdditiveColumns(pool)).toBe(3);
    const { rows } = await pool.query<{ column_default: string }>(`SELECT column_default FROM information_schema.columns WHERE table_name = 'venue_settings' AND column_name = 'ig_consent_mode'`);
    expect(rows[0].column_default).toContain("'off'");
    expect(await ensureAdditiveColumns(pool)).toBe(0);
  });
});
