/**
 * The branding upload API.
 *
 * The interesting failures here are not CRUD ones. An overlay is composited at
 * 0,0 with no scaling and no format conversion, so the two things that quietly
 * ruin a hundred exports are a file with no alpha channel and a file authored
 * at the wrong size — neither of which fails anything at upload time on its own.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, fieldsTable, academiesTable, brandingAssetsTable, brandingProfilesTable } from "@workspace/db";

vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    isBunnyStorageConfigured: () => true,
    uploadBufferToBunnyStorage: vi.fn(async (_buffer: Buffer, remotePath: string) =>
      `https://cdn.test/${remotePath}`),
  };
});

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));
import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);

const TAG = `brand_${Date.now()}`;
let app: Express;
let adminId: number;
let plainId: number;
let fieldId: number;
let academyId: number;
const assetIds = new Set<number>();

async function cleanupAssets() {
  if (assetIds.size) {
    await db.delete(brandingAssetsTable).where(inArray(brandingAssetsTable.id, [...assetIds]));
    assetIds.clear();
  }
}

/** A real PNG of the given size, so the IHDR probe has something to read. */
function png(width: number, height: number): Buffer {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4)])),
  );
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

beforeAll(async () => {
  const existing = await db.select({ id: brandingAssetsTable.id }).from(brandingAssetsTable);
  if (existing.length) throw new Error("Branding tests require an empty branding_assets table; refusing to replace existing assets");
  const { default: brandingRouter } = await import("./branding");
  app = express();
  app.use(express.json());
  app.use("/api", brandingRouter);

  const [admin] = await db.insert(usersTable)
    .values({ name: "Admin", email: `admin_${TAG}@test.local`, isAdmin: true })
    .returning({ id: usersTable.id });
  const [plain] = await db.insert(usersTable)
    .values({ name: "Plain", email: `plain_${TAG}@test.local` })
    .returning({ id: usersTable.id });
  adminId = admin.id; plainId = plain.id;

  const [field] = await db.insert(fieldsTable)
    .values({ name: `Branding field ${TAG}`, location: "Test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable)
    .values({ name: `Branding academy ${TAG}`, fieldId })
    .returning({ id: academiesTable.id });
  academyId = academy.id;
});

afterAll(async () => {
  await cleanupAssets();
  await db.delete(brandingProfilesTable).where(inArray(brandingProfilesTable.scopeId, [0, fieldId, academyId]));
  await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, plainId]));
});

beforeEach(async () => {
  await cleanupAssets();
  mockedGetLocalUserId.mockResolvedValue(adminId);
});

const putOverlay = async (scope: string, buffer: Buffer, name = "overlay.png") => {
  const response = await request(app).put("/api/admin/branding/overlay").field("scope", scope).attach("asset", buffer, name);
  if (response.status === 200) assetIds.add(response.body.id);
  return response;
};

describe("uploading branding", () => {
  it("stores an overlay for a scope and reports its size", async () => {
    const res = await putOverlay("global", png(1920, 1080));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scopeType: "global", scopeId: 0, kind: "overlay", width: 1920, height: 1080 });
    expect(res.body.assetUrl).toContain("branding/global/overlay-");
  });

  it("replaces rather than accumulating, so an old overlay cannot win by being found first", async () => {
    expect((await putOverlay("global", png(1920, 1080))).status).toBe(200);
    expect((await putOverlay("global", png(1280, 720))).status).toBe(200);
    const rows = await db.select().from(brandingAssetsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].width).toBe(1280);
  });

  it("gives each upload a fresh path so the CDN cannot serve the previous one", async () => {
    const first = await putOverlay("global", png(1920, 1080));
    expect(first.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    const second = await putOverlay("global", png(1920, 1080));
    expect(second.status).toBe(200);
    expect(second.body.assetUrl).not.toBe(first.body.assetUrl);
  });

  it("refuses anything that is not a PNG", async () => {
    // An overlay is composited with an alpha channel. A JPEG has none, so it
    // would paint a solid rectangle over the entire frame.
    const res = await putOverlay("global", Buffer.from("\xff\xd8\xff\xe0 not a png"), "logo.jpg");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("PNG");
  });

  it("records a size that does not match the output, rather than silently scaling it", async () => {
    // Scaling to fit would change the mark's proportions and move it. The
    // console shows the mismatch instead; the render leaves it alone.
    const res = await putOverlay("global", png(800, 600));
    expect(res.status).toBe(200);
    expect(res.body.fitsLandscape).toBe(false);
    const list = await request(app).get("/api/admin/branding").expect(200);
    expect(list.body.assets[0].fitsLandscape).toBe(false);
    expect(list.body.outputSizes.landscape).toEqual({ w: 1920, h: 1080 });
  });

  it("scopes to an academy or a field, and refuses one that does not exist", async () => {
    expect((await putOverlay(`academy:${academyId}`, png(1920, 1080))).status).toBe(200);
    expect((await putOverlay(`field:${fieldId}`, png(1920, 1080))).status).toBe(200);
    const missing = await putOverlay("academy:999999", png(1920, 1080));
    expect(missing.status).toBe(404);
    const malformed = await putOverlay("academy", png(1920, 1080));
    expect(malformed.status).toBe(400);

    const rows = await db.select().from(brandingAssetsTable);
    expect(rows).toHaveLength(2);
  });

  it("keeps the stored object when a row is removed", async () => {
    // Deleting the bytes to tidy a row is how a clip exported an hour ago loses
    // its picture.
    expect((await putOverlay("global", png(1920, 1080))).status).toBe(200);
    await request(app).delete("/api/admin/branding/overlay?scope=global").expect(200);
    expect(await db.select().from(brandingAssetsTable)).toHaveLength(0);
  });

  it("refuses a plain user", async () => {
    mockedGetLocalUserId.mockResolvedValue(plainId);
    await request(app).get("/api/admin/branding").expect(401);
    expect((await putOverlay("global", png(1920, 1080))).status).toBe(401);
    await request(app).delete("/api/admin/branding/overlay?scope=global").expect(401);
  });

  it("refuses an unknown kind", async () => {
    const res = await request(app).put("/api/admin/branding/watermark")
      .field("scope", "global").attach("asset", png(10, 10), "x.png");
    expect(res.status).toBe(400);
  });
});

describe("drawn branding profiles", () => {
  beforeEach(async () => {
    await db.delete(brandingProfilesTable).where(inArray(brandingProfilesTable.scopeId, [0, fieldId, academyId]));
  });

  it("saves a field's look and lists it", async () => {
    const res = await request(app).put("/api/admin/branding/profile").send({
      scope: `field:${fieldId}`, nameEn: "Jordan Galaxy", nameAr: "ملاعب جوردن جلاكسي",
      primaryColor: "#f4cf1f", accentColor: "", bookingPhone: "07 9920 4098", instagram: "@jordangalaxy",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scopeType: "field", scopeId: fieldId, primaryColor: "#F4CF1F", accentColor: null, instagram: "jordangalaxy" });
    const list = await request(app).get("/api/admin/branding").expect(200);
    expect(list.body.profilesReady).toBe(true);
    expect(list.body.profiles.map((p: { scopeId: number }) => p.scopeId)).toContain(fieldId);
    expect(list.body.presets.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(["jordan-galaxy", "jufa"]));
  });

  it("refuses a look without a name or with a malformed colour", async () => {
    await request(app).put("/api/admin/branding/profile").send({ scope: "global", nameEn: "", primaryColor: "#F4CF1F" }).expect(400);
    await request(app).put("/api/admin/branding/profile").send({ scope: "global", nameEn: "X", primaryColor: "yellow" }).expect(400);
    await request(app).put("/api/admin/branding/profile").send({ scope: "academy:999999", nameEn: "X", primaryColor: "#F4CF1F" }).expect(404);
  });

  it("applies a real venue's preset with its bundled crest", async () => {
    const res = await request(app).post("/api/admin/branding/preset").send({ scope: `academy:${academyId}`, preset: "jufa" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nameEn: "JUFA", primaryColor: "#2B3DA8", crestPreset: "jufa-crest.png", showPlayerNames: false });
    const crest = await request(app).get(`/api/admin/branding/preset-crest/${res.body.crestPreset}`);
    expect(crest.status).toBe(200);
    expect(crest.headers["content-type"]).toContain("image/png");
    await request(app).get("/api/admin/branding/preset-crest/..%2F..%2Fpackage.json").expect(404);
    await request(app).post("/api/admin/branding/preset").send({ scope: "global", preset: "nope" }).expect(400);
  });

  it("removes a look", async () => {
    await request(app).post("/api/admin/branding/preset").send({ scope: "global", preset: "jordan-galaxy" }).expect(200);
    await request(app).delete("/api/admin/branding/profile?scope=global").expect(200);
    expect(await db.select().from(brandingProfilesTable).where(eq(brandingProfilesTable.scopeType, "global"))).toHaveLength(0);
  });

  it("stores an uploaded crest against the scope", async () => {
    const res = await request(app).put("/api/admin/branding/crest")
      .field("scope", `field:${fieldId}`).attach("asset", png(300, 320), "crest.png");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ crestWidth: 300, crestHeight: 320, crestPreset: null });
    expect(res.body.crestUrl).toContain(`branding/field-${fieldId}/crest-`);
    // Nothing landed in the uploaded-overlay table.
    expect(await db.select().from(brandingAssetsTable)).toHaveLength(0);
  });

  it("renders a preview of each end screen and overlay", async () => {
    await request(app).post("/api/admin/branding/preset").send({ scope: `field:${fieldId}`, preset: "jordan-galaxy" }).expect(200);
    for (const what of ["player", "match", "academy", "signOff", "cornerCrest", "broadcastBar", "academyFrame"]) {
      const res = await request(app).get(`/api/admin/branding/preview?scope=field:${fieldId}&what=${what}&aspect=9:16`)
        .buffer(true).parse((r, cb) => { const parts: Buffer[] = []; r.on("data", (c: Buffer) => parts.push(c)); r.on("end", () => cb(null, Buffer.concat(parts))); });
      expect(res.status, what).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect((res.body as Buffer).readUInt32BE(16)).toBe(608);
    }
    await request(app).get(`/api/admin/branding/preview?scope=field:${fieldId}&what=uploaded`).expect(400);
  }, 60_000);

  it("refuses a plain user", async () => {
    mockedGetLocalUserId.mockResolvedValue(plainId);
    await request(app).put("/api/admin/branding/profile").send({ scope: "global", nameEn: "X", primaryColor: "#F4CF1F" }).expect(401);
    await request(app).post("/api/admin/branding/preset").send({ scope: "global", preset: "jufa" }).expect(401);
    await request(app).get("/api/admin/branding/preview?scope=global&what=signOff").expect(401);
  });
});
