import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  academiesTable,
  academyMembersTable,
  brandingProfilesTable,
  db,
  fieldsTable,
  settingsRulesTable,
  usersTable,
} from "@workspace/db";

vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    isBunnyStorageConfigured: () => true,
    uploadBufferToBunnyStorage: vi.fn(async (_buffer: Buffer, remotePath: string) => `https://cdn.test/${remotePath}`),
  };
});

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }),
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import brandingRouter, { ACADEMY_RULE_PRIORITY } from "./academyBranding";
import { getSettingValue } from "../lib/settings";
import { createCanvas } from "@napi-rs/canvas";
import { uploadBufferToBunnyStorage } from "../lib/bunny";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let outsiderId: number;
let academyId: number;
let otherAcademyId: number;
let fieldId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (path = "") => `/api/academy/console/academies/${academyId}/branding${path}`;

/** A 2×2 transparent PNG. */
const PNG_2X2 = createCanvas(2, 2).toBuffer("image/png");

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", brandingRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-brand-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-brand-${tag}@test.local` },
    { name: `Out ${tag}`, email: `out-brand-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, outsiderId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Brand field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const academies = await db.insert(academiesTable).values([
    {
      name: `Galaxy Kids ${tag}`, nameAr: "أكاديمية جالاكسي", fieldId, whatsappPhone: "962791234567",
      instagramUrl: "https://instagram.com/galaxy.kids/", logoUrl: `data:image/png;base64,${PNG_2X2.toString("base64")}`,
    },
    { name: `Other ${tag}`, fieldId },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
});

afterAll(async () => {
  await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.scopeType, "academy"), inArray(settingsRulesTable.scopeId, [academyId, otherAcademyId])));
  await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), inArray(brandingProfilesTable.scopeId, [academyId, otherAcademyId])));
});

describe("academy console branding: access", () => {
  it("lets the owner in and gives coaches and outsiders 403 on every endpoint", async () => {
    const owner = await request(app).get(url()).set(auth(ownerId));
    expect(owner.status).toBe(200);
    for (const id of [coachId, outsiderId]) {
      expect((await request(app).get(url()).set(auth(id))).status).toBe(403);
      expect((await request(app).put(url("/profile")).set(auth(id)).send({ nameEn: "X", primaryColor: "#112233" })).status).toBe(403);
      expect((await request(app).put(url("/settings")).set(auth(id)).send({ key: "branding.endScreenEnabled", value: true })).status).toBe(403);
      expect((await request(app).delete(url("/settings/branding.endScreenEnabled")).set(auth(id))).status).toBe(403);
      expect((await request(app).put(url("/crest")).set(auth(id)).attach("crest", PNG_2X2, { filename: "c.png", contentType: "image/png" })).status).toBe(403);
      expect((await request(app).post(url("/crest/from-logo")).set(auth(id))).status).toBe(403);
      expect((await request(app).get(url("/preview?what=signOff")).set(auth(id))).status).toBe(403);
    }
    expect((await request(app).get(url())).status).toBe(401);
  });

  it("starts from defaults taken from the academy row", async () => {
    const res = await request(app).get(url()).set(auth(ownerId));
    expect(res.body.hasOwnLook).toBe(false);
    expect(res.body.look).toMatchObject({
      nameEn: `Galaxy Kids ${tag}`.slice(0, 40), nameAr: "أكاديمية جالاكسي", bookingPhone: "079 123 4567",
      instagram: "galaxy.kids", showPlayerNames: false,
    });
    expect(res.body.crest.source).toBe("logo");
    expect(res.body.outputSizes.portrait.h).toBeGreaterThan(res.body.outputSizes.portrait.w);
    const keys = res.body.settings.map((s: { key: string }) => s.key);
    expect(keys).toContain("branding.overlayStyle");
    expect(keys).toContain("branding.endScreen.seconds");
    expect(res.body.settings.every((s: { source: string }) => s.source === "replay")).toBe(true);
  });
});

describe("academy console branding: profile", () => {
  it("validates like Admin → Branding", async () => {
    const noName = await request(app).put(url("/profile")).set(auth(ownerId)).send({ nameEn: "  ", primaryColor: "#112233" });
    expect(noName.status).toBe(400);
    expect(noName.body.field).toBe("nameEn");
    const badColour = await request(app).put(url("/profile")).set(auth(ownerId)).send({ nameEn: "Galaxy", primaryColor: "red" });
    expect(badColour.status).toBe(400);
    expect(badColour.body.field).toBe("primaryColor");
    const badAccent = await request(app).put(url("/profile")).set(auth(ownerId)).send({ nameEn: "Galaxy", primaryColor: "#112233", accentColor: "#12" });
    expect(badAccent.status).toBe(400);
    expect(badAccent.body.field).toBe("accentColor");
  });

  it("saves the look into this academy's scope only", async () => {
    const res = await request(app).put(url("/profile")).set(auth(ownerId)).send({
      nameEn: "Galaxy Kids", nameAr: "جالاكسي", taglineAr: "كل تمرين متصوّر", primaryColor: "#f4cf1f",
      accentColor: "", bookingPhone: "079 123 4567", instagram: "@galaxy.kids", showPlayerNames: true, scope: "global",
    });
    expect(res.status).toBe(200);
    expect(res.body.hasOwnLook).toBe(true);
    expect(res.body.look).toMatchObject({ nameEn: "Galaxy Kids", primaryColor: "#F4CF1F", accentColor: null, instagram: "galaxy.kids", showPlayerNames: true });
    const rows = await db.select().from(brandingProfilesTable).where(eq(brandingProfilesTable.updatedBy, ownerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeType: "academy", scopeId: academyId });
  });

  it("stores an uploaded crest, converting a JPEG to PNG, and can use the academy logo", async () => {
    const jpeg = createCanvas(40, 30).toBuffer("image/jpeg");
    const up = await request(app).put(url("/crest")).set(auth(ownerId)).attach("crest", jpeg, { filename: "c.jpg", contentType: "image/jpeg" });
    expect(up.status).toBe(200);
    expect(up.body.crest.source).toBe("own");
    const stored = vi.mocked(uploadBufferToBunnyStorage).mock.calls.at(-1)!;
    expect(stored[0].subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(stored[1]).toMatch(new RegExp(`^branding/academy-${academyId}/crest-`));

    const gif = await request(app).put(url("/crest")).set(auth(ownerId)).attach("crest", PNG_2X2, { filename: "c.gif", contentType: "image/gif" });
    expect(gif.status).toBe(400);

    const fromLogo = await request(app).post(url("/crest/from-logo")).set(auth(ownerId));
    expect(fromLogo.status).toBe(200);
    expect(fromLogo.body.profile.crestWidth).toBe(2);
    const removed = await request(app).delete(url("/crest")).set(auth(ownerId));
    expect(removed.body.crest.source).toBe("none");
  });
});

describe("academy console branding: settings rules", () => {
  const ownRules = (key: string) => db.select().from(settingsRulesTable).where(and(
    eq(settingsRulesTable.key, key), eq(settingsRulesTable.scopeType, "academy"), eq(settingsRulesTable.scopeId, academyId),
  ));

  it("creates one academy rule at priority 10, then updates it in place", async () => {
    const first = await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.endScreenEnabled", value: true });
    expect(first.status).toBe(200);
    let rules = await ownRules("branding.endScreenEnabled");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ value: true, priority: ACADEMY_RULE_PRIORITY, scopeType: "academy", scopeId: academyId, enabled: true });
    expect(first.body.settings.find((s: { key: string }) => s.key === "branding.endScreenEnabled")).toMatchObject({ value: true, source: "academy" });

    const style = await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.overlayStyle", value: "academyFrame" });
    expect(style.status).toBe(200);
    const second = await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.endScreenEnabled", value: false });
    expect(second.status).toBe(200);
    rules = await ownRules("branding.endScreenEnabled");
    expect(rules).toHaveLength(1);
    expect(rules[0].value).toBe(false);

    // Resolution: this academy gets its own value, another academy at the same field does not.
    expect(await getSettingValue("branding.overlayStyle", { academyId, fieldId })).toBe("academyFrame");
    expect(await getSettingValue("branding.overlayStyle", { academyId: otherAcademyId, fieldId })).toBe("uploaded");
  });

  it("validates the key against the whitelist and the value against the registry", async () => {
    expect((await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "pricing.statsPerMatch", value: 0 })).status).toBe(400);
    expect((await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.endScreen.seconds", value: 9 })).status).toBe(400);
    expect((await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.endScreen.blur", value: 2.5 })).status).toBe(400);
    expect((await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.overlayStyle", value: "neon" })).status).toBe(400);
    expect((await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.endScreen.seconds", value: 4.5 })).status).toBe(200);
    expect(await ownRules("pricing.statsPerMatch")).toHaveLength(0);
  });

  it("resets to Replay's default by deleting only this academy's own rule", async () => {
    await db.insert(settingsRulesTable).values({ key: "branding.overlayStyle", value: "broadcastBar", priority: 10, scopeType: "academy", scopeId: otherAcademyId });
    const res = await request(app).delete(url("/settings/branding.overlayStyle")).set(auth(ownerId));
    expect(res.status).toBe(200);
    expect(await ownRules("branding.overlayStyle")).toHaveLength(0);
    expect(res.body.settings.find((s: { key: string }) => s.key === "branding.overlayStyle")).toMatchObject({ value: "uploaded", source: "replay", hasOwn: false });
    const other = await db.select().from(settingsRulesTable).where(and(eq(settingsRulesTable.scopeType, "academy"), eq(settingsRulesTable.scopeId, otherAcademyId)));
    expect(other).toHaveLength(1);
    expect((await request(app).delete(url("/settings/pricing.statsPerMatch")).set(auth(ownerId))).status).toBe(400);
  });

  it("reports a stronger Replay rule as overriding the academy's own", async () => {
    await request(app).put(url("/settings")).set(auth(ownerId)).send({ key: "branding.endScreen.dim", value: 30 });
    const [strong] = await db.insert(settingsRulesTable).values({ key: "branding.endScreen.dim", value: 70, priority: 50, scopeType: "field", scopeId: fieldId }).returning();
    try {
      const { invalidateSettingsCache } = await import("../lib/settings");
      invalidateSettingsCache();
      const res = await request(app).get(url()).set(auth(ownerId));
      expect(res.body.settings.find((s: { key: string }) => s.key === "branding.endScreen.dim")).toMatchObject({ value: 70, source: "replay", overridden: true });
    } finally {
      await db.delete(settingsRulesTable).where(eq(settingsRulesTable.id, strong.id));
    }
  });
});

describe("academy console branding: preview", () => {
  it("draws this academy's look as a PNG", async () => {
    const res = await request(app).get(url("/preview?what=cornerCrest&aspect=9:16")).set(auth(ownerId)).buffer(true)
      .parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect((res.body as Buffer).readUInt32BE(16)).toBe(608);
    expect((await request(app).get(url("/preview?what=nonsense")).set(auth(ownerId))).status).toBe(400);
  });
});
