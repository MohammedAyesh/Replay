/**
 * The player's end screen (2026-10-25): which card goes after his clip and
 * which numbers are on it, among what the venue has switched on.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, userClipsTable, settingsDefaultsTable, brandingProfilesTable } from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));
import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);

const TAG = `es_${Date.now()}`;
const KEYS = ["branding.endScreenEnabled", "branding.endScreen.match", "branding.endScreen.signOff", "branding.endScreen.player", "branding.endScreen.academy"];
let app: Express;
let ownerId: number;
let otherId: number;
let clipId: number;
let profileId: number;

beforeAll(async () => {
  const { default: router } = await import("./userClips");
  app = express();
  app.use(express.json());
  app.use("/api", router);
  const [owner] = await db.insert(usersTable).values({ name: "Owner", email: `owner_${TAG}@test.local` }).returning({ id: usersTable.id });
  const [other] = await db.insert(usersTable).values({ name: "Other", email: `other_${TAG}@test.local` }).returning({ id: usersTable.id });
  ownerId = owner.id; otherId = other.id;
  const [clip] = await db.insert(userClipsTable).values({
    userId: ownerId, videoId: "00000000-0000-0000-0000-00000000e5e5", title: "Goal",
    startTime: "0.1", endTime: "0.2", aspectRatio: "9:16",
  }).returning({ id: userClipsTable.id });
  clipId = clip.id;
  const [profile] = await db.insert(brandingProfilesTable).values({
    scopeType: "global", scopeId: 0, nameEn: "JORDAN GALAXY", primaryColor: "#F4CF1F",
    crestUrl: "preset:jordan-galaxy-crest.png",
  }).returning({ id: brandingProfilesTable.id });
  profileId = profile.id;
});

afterAll(async () => {
  await db.delete(settingsDefaultsTable).where(inArray(settingsDefaultsTable.key, KEYS));
  await db.delete(brandingProfilesTable).where(eq(brandingProfilesTable.id, profileId));
  await db.delete(userClipsTable).where(eq(userClipsTable.id, clipId));
  await db.delete(usersTable).where(inArray(usersTable.id, [ownerId, otherId]));
});

async function setEndScreen(on: boolean) {
  const { invalidateSettingsCache } = await import("../lib/settings");
  await db.delete(settingsDefaultsTable).where(inArray(settingsDefaultsTable.key, KEYS));
  await db.insert(settingsDefaultsTable).values([
    { key: KEYS[0], value: on },
    { key: KEYS[1], value: true },
    { key: KEYS[2], value: true },
    { key: KEYS[3], value: false },
    { key: KEYS[4], value: false },
  ]);
  invalidateSettingsCache();
}

beforeEach(async () => {
  mockedGetLocalUserId.mockResolvedValue(ownerId);
  await setEndScreen(true);
});

describe("GET /user-clips/:id/end-screen", () => {
  it("lists the cards the venue has on, and which have something to show", async () => {
    const res = await request(app).get(`/api/user-clips/${clipId}/end-screen`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.current).toBe("signOff");
    // No match room behind this clip: no score to show.
    expect(res.body.cards).toEqual(expect.arrayContaining([
      { kind: "match", available: false },
      { kind: "signOff", available: true },
    ]));
    // Cards the venue switched off are not offered at all.
    expect(res.body.cards.map((c: { kind: string }) => c.kind)).not.toContain("player");
  });

  it("says so when the venue has no end screen", async () => {
    await setEndScreen(false);
    const res = await request(app).get(`/api/user-clips/${clipId}/end-screen`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it("is the owner's alone", async () => {
    mockedGetLocalUserId.mockResolvedValue(otherId);
    expect((await request(app).get(`/api/user-clips/${clipId}/end-screen`)).status).toBe(404);
    mockedGetLocalUserId.mockResolvedValue(null as unknown as number);
    expect((await request(app).get(`/api/user-clips/${clipId}/end-screen`)).status).toBe(401);
  });
});

describe("PUT /user-clips/:id/end-screen", () => {
  it("saves the choice; a clip never exported picks it up on its first export", async () => {
    const res = await request(app).put(`/api/user-clips/${clipId}/end-screen`)
      .send({ card: "signOff", stats: ["goals", "shotsOnTarget"] });
    expect(res.status).toBe(200);
    expect(res.body.rerender).toBe("unchanged");
    const [row] = await db.select({ endScreen: userClipsTable.endScreen }).from(userClipsTable).where(eq(userClipsTable.id, clipId));
    expect(row.endScreen).toEqual({ card: "signOff", stats: ["goals", "shotsOnTarget"] });
  });

  it("goes back to automatic", async () => {
    const res = await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({});
    expect(res.status).toBe(200);
    const [row] = await db.select({ endScreen: userClipsTable.endScreen }).from(userClipsTable).where(eq(userClipsTable.id, clipId));
    expect(row.endScreen).toBeNull();
  });

  it("refuses an unknown card, an unknown number and more than four numbers", async () => {
    expect((await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({ card: "poster" })).status).toBe(400);
    expect((await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({ stats: ["touches"] })).status).toBe(400);
    expect((await request(app).put(`/api/user-clips/${clipId}/end-screen`)
      .send({ stats: ["goals", "shotsOnTarget", "topSpeed", "distance", "passes"] })).status).toBe(400);
  });

  it("is the owner's alone", async () => {
    mockedGetLocalUserId.mockResolvedValue(otherId);
    expect((await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({ card: "signOff" })).status).toBe(404);
  });

  it("remembers a change made while the clip is rendering, durably, for a re-render after it", async () => {
    await db.update(userClipsTable).set({ exportStatus: "pending", endScreen: null, endScreenPending: false }).where(eq(userClipsTable.id, clipId));
    try {
      const res = await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({ card: "signOff" });
      expect(res.body.rerender).toBe("queued");
      const [row] = await db.select({ pending: userClipsTable.endScreenPending }).from(userClipsTable).where(eq(userClipsTable.id, clipId));
      expect(row.pending).toBe(true);
    } finally {
      await db.update(userClipsTable).set({ exportStatus: null, endScreen: null, endScreenPending: false }).where(eq(userClipsTable.id, clipId));
    }
  });

  it("does not re-render when the venue has no end screen, and treats auto/empty as no choice", async () => {
    await setEndScreen(false);
    await db.update(userClipsTable).set({ exportStatus: "done" }).where(eq(userClipsTable.id, clipId));
    try {
      const res = await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({ card: "signOff" });
      expect(res.body.rerender).toBe("unchanged");
      const auto = await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({ card: "auto", stats: [] });
      expect(auto.status).toBe(200);
      const [row] = await db.select({ endScreen: userClipsTable.endScreen }).from(userClipsTable).where(eq(userClipsTable.id, clipId));
      expect(row.endScreen).toBeNull();
      expect((await request(app).put(`/api/user-clips/${clipId}/end-screen`).send({ card: null })).status).toBe(200);
    } finally {
      await db.update(userClipsTable).set({ exportStatus: null, endScreen: null }).where(eq(userClipsTable.id, clipId));
    }
  });
});

describe("GET /user-clips/:id/end-screen/preview.png", () => {
  it("draws the player's real card at the clip's shape", async () => {
    const res = await request(app).get(`/api/user-clips/${clipId}/end-screen/preview.png?card=signOff`)
      .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    const { loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(res.body as Buffer);
    expect([img.width, img.height]).toEqual([608, 1080]);
  }, 30_000);

  it("answers 404 when the venue has no end screen", async () => {
    await setEndScreen(false);
    expect((await request(app).get(`/api/user-clips/${clipId}/end-screen/preview.png`)).status).toBe(404);
  });
});
