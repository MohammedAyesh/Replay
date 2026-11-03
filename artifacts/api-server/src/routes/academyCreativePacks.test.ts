import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import { academiesTable, academyMembersTable, brandingProfilesTable, db, fieldsTable, usersTable } from "@workspace/db";
import { CREATIVE_PACKS } from "@workspace/api-zod";

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

import creativeRouter from "./academyCreative";
import renderRouter from "./academyCreativeRender";
import academiesRouter from "./academies";
import fontsRouter from "./creativeFonts";

const tag = Date.now();
let app: Express;
let ownerA: number;
let ownerB: number;
let adminId: number;
let academyA: number;
let academyB: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (academy: number, p: string) => `/api/academy/console/academies/${academy}/creative${p}`;
const scene = (style?: string) => ({
  v: 1, format: "post", background: "@paper", layers: [], locale: "en",
  ...(style ? { template: { key: "fulltime", style } } : {}),
});

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", fontsRouter, creativeRouter, renderRouter, academiesRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner A ${tag}`, email: `owner-a-pack-${tag}@test.local` },
    { name: `Owner B ${tag}`, email: `owner-b-pack-${tag}@test.local` },
    { name: `Admin ${tag}`, email: `admin-pack-${tag}@test.local`, isAdmin: true },
  ]).returning({ id: usersTable.id });
  [ownerA, ownerB, adminId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Pack field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([
    { name: `IRIS ${tag}`, fieldId: field.id, creativePack: "iris" },
    { name: `Barca ${tag}`, fieldId: field.id, creativePack: "barca" },
  ]).returning({ id: academiesTable.id });
  [academyA, academyB] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId: academyA, userId: ownerA, role: "owner" },
    { academyId: academyB, userId: ownerB, role: "owner" },
  ]);
});

describe("Creative brand packs: scoping", () => {
  it("tells each academy its own pack on GET …/brand", async () => {
    const a = await request(app).get(url(academyA, "/brand")).set(auth(ownerA)).expect(200);
    expect(a.body.pack).toEqual({ key: "iris", name: CREATIVE_PACKS.iris.name, franchise: false });
    const b = await request(app).get(url(academyB, "/brand")).set(auth(ownerB)).expect(200);
    expect(b.body.pack).toEqual({ key: "barca", name: CREATIVE_PACKS.barca.name, franchise: true });
  });

  it("lets academy A use its own pack and the house styles, never pack B", async () => {
    const own = await request(app).post(url(academyA, "/projects")).set(auth(ownerA)).send({ style: "iris", scene: scene("iris") }).expect(201);
    expect(own.body.project.style).toBe("iris");
    await request(app).post(url(academyA, "/projects")).set(auth(ownerA)).send({ style: "stadium", scene: scene("stadium") }).expect(201);

    const foreign = await request(app).post(url(academyA, "/projects")).set(auth(ownerA)).send({ style: "barca", scene: scene("barca") });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("style_not_allowed");
    // A foreign pack hidden in the scene's template is refused too.
    expect((await request(app).post(url(academyA, "/projects")).set(auth(ownerA)).send({ scene: scene("barca") })).status).toBe(400);

    const id = own.body.project.id as number;
    expect((await request(app).patch(url(academyA, `/projects/${id}`)).set(auth(ownerA)).send({ style: "barca" })).status).toBe(400);
    expect((await request(app).patch(url(academyA, `/projects/${id}`)).set(auth(ownerA)).send({ scene: scene("juventus") })).status).toBe(400);
    const ok = await request(app).patch(url(academyA, `/projects/${id}`)).set(auth(ownerA)).send({ style: "broadcast" }).expect(200);
    expect(ok.body.project.style).toBe("broadcast");

    // Background plates for a pack: own only.
    expect((await request(app).get(url(academyA, "/artwork/backgrounds?style=iris")).set(auth(ownerA))).status).toBe(200);
    expect((await request(app).get(url(academyA, "/artwork/backgrounds?style=barca")).set(auth(ownerA))).status).toBe(400);
  });
});

describe("Creative brand packs: admin", () => {
  it("is admin only", async () => {
    expect((await request(app).get(`/api/admin/academies/${academyA}/creative-pack`).set(auth(ownerA))).status).toBe(403);
    expect((await request(app).put(`/api/admin/academies/${academyA}/creative-pack`).set(auth(ownerA)).send({ pack: "jufa" })).status).toBe(403);
    expect((await request(app).post(`/api/admin/academies/${academyA}/creative-pack/apply-colours`).set(auth(ownerA))).status).toBe(403);
  });

  it("assigns, validates and clears a pack, and applies its colours only when asked", async () => {
    const got = await request(app).get(`/api/admin/academies/${academyB}/creative-pack`).set(auth(adminId)).expect(200);
    expect(got.body.pack).toBe("barca");
    expect(got.body.packs.map((p: { key: string }) => p.key)).toEqual(["iris", "souqar", "barca", "juventus", "knights", "jufa"]);

    expect((await request(app).put(`/api/admin/academies/${academyB}/creative-pack`).set(auth(adminId)).send({ pack: "nope" })).status).toBe(400);
    const set = await request(app).put(`/api/admin/academies/${academyB}/creative-pack`).set(auth(adminId)).send({ pack: "knights" }).expect(200);
    expect(set.body.pack).toBe("knights");
    // Assigning a pack leaves the academy's colours alone.
    const before = await db.select().from(brandingProfilesTable)
      .where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyB)));
    expect(before).toHaveLength(0);

    const applied = await request(app).post(`/api/admin/academies/${academyB}/creative-pack/apply-colours`).set(auth(adminId)).expect(200);
    expect(applied.body).toEqual({ primaryColor: CREATIVE_PACKS.knights.palette.primary, accentColor: CREATIVE_PACKS.knights.palette.accent });
    const [profile] = await db.select().from(brandingProfilesTable)
      .where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyB)));
    expect([profile.primaryColor, profile.accentColor]).toEqual([CREATIVE_PACKS.knights.palette.primary, CREATIVE_PACKS.knights.palette.accent]);
    // Applying again updates the same profile.
    await request(app).post(`/api/admin/academies/${academyB}/creative-pack/apply-colours`).set(auth(adminId)).expect(200);

    // Owner B now gets knights, and barca is no longer theirs.
    expect((await request(app).get(url(academyB, "/brand")).set(auth(ownerB))).body.pack.key).toBe("knights");
    expect((await request(app).post(url(academyB, "/projects")).set(auth(ownerB)).send({ style: "barca", scene: scene("barca") })).status).toBe(400);

    await request(app).put(`/api/admin/academies/${academyB}/creative-pack`).set(auth(adminId)).send({ pack: null }).expect(200);
    expect((await request(app).get(url(academyB, "/brand")).set(auth(ownerB))).body.pack).toBeNull();
    expect((await request(app).post(`/api/admin/academies/${academyB}/creative-pack/apply-colours`).set(auth(adminId))).status).toBe(400);
  });
});

describe("GET /api/creative/fonts/:file", () => {
  it("serves library fonts publicly with a long cache, and nothing else", async () => {
    const res = await request(app).get("/api/creative/fonts/BebasNeue-400.ttf").expect(200);
    expect(res.headers["content-type"]).toMatch(/font\/ttf/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await request(app).get("/api/creative/fonts/OFL.txt")).status).toBe(404);
    expect((await request(app).get("/api/creative/fonts/..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await request(app).get("/api/creative/fonts/Cairo-700.ttf.bak")).status).toBe(404);
    const list = await request(app).get("/api/creative/fonts").expect(200);
    expect(list.body.families).toContain("Bebas Neue");
  });
});
