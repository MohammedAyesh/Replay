import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  likesTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const TAG = `clip_retention_${Date.now()}`;
let app: Express;
let ownerId: number;
let adminId: number;
let clipId: number;

beforeAll(async () => {
  const [{ default: userClipsRouter }, { default: adminRouter }] = await Promise.all([
    import("./userClips"),
    import("./admin"),
  ]);
  app = express();
  app.use(express.json());
  app.use("/api", userClipsRouter);
  app.use("/api", adminRouter);

  const [owner] = await db.insert(usersTable).values({
    name: "Clip owner",
    email: `clip_owner_${TAG}@test.local`,
  }).returning({ id: usersTable.id });
  const [admin] = await db.insert(usersTable).values({
    name: "Clip admin",
    email: `clip_admin_${TAG}@test.local`,
    isAdmin: true,
  }).returning({ id: usersTable.id });
  ownerId = owner.id;
  adminId = admin.id;

  const [clip] = await db.insert(userClipsTable).values({
    userId: ownerId,
    videoId: "12345678-1234-4234-8234-123456789abc",
    title: `Retained clip ${TAG}`,
    startTime: "2",
    endTime: "7",
    cropPath: [],
    visibility: "public",
    showInPortfolio: true,
    exportStatus: "done",
    exportedUrl: "https://storage.example.test/galaxyfield/clips/123.mp4",
  }).returning({ id: userClipsTable.id });
  clipId = clip.id;
  await db.insert(likesTable).values({ userId: adminId, userClipId: clipId });
});

afterAll(async () => {
  if (clipId) {
    await db.delete(likesTable).where(eq(likesTable.userClipId, clipId));
    await db.delete(userClipsTable).where(eq(userClipsTable.id, clipId));
  }
  if (ownerId) await db.delete(usersTable).where(eq(usersTable.id, ownerId));
  if (adminId) await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("permanent user clips", () => {
  it("hides a user-deleted clip without deleting its row, export, or likes and lets an admin restore it", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);

    await request(app).delete(`/api/user-clips/${clipId}`).expect(200, { ok: true });
    await request(app).get("/api/user-clips").expect(200).then((res) => {
      expect(res.body.some((clip: { id: number }) => clip.id === clipId)).toBe(false);
    });
    await request(app).get(`/api/user-clips/${clipId}/download`).expect(404);
    await request(app).patch(`/api/user-clips/${clipId}`).send({ title: "Should not edit" }).expect(404);
    await request(app).get(`/api/user-clips/${clipId}/share-link`).expect(404);

    const [hidden] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipId));
    expect(hidden).toMatchObject({
      isHidden: true,
      hiddenReason: "deleted",
      exportStatus: "done",
      exportedUrl: "https://storage.example.test/galaxyfield/clips/123.mp4",
      showInPortfolio: true,
    });
    const [retainedLike] = await db.select().from(likesTable).where(eq(likesTable.userClipId, clipId));
    expect(retainedLike).toBeDefined();

    mockedGetLocalUserId.mockResolvedValue(adminId);
    const adminList = await request(app).get("/api/admin/clips").expect(200);
    expect(adminList.body.find((clip: { id: number }) => clip.id === clipId)).toMatchObject({
      isHidden: true,
      hiddenReason: "deleted",
      exportedUrl: "https://storage.example.test/galaxyfield/clips/123.mp4",
    });

    await request(app).patch(`/api/admin/clips/${clipId}`).send({ isHidden: false }).expect(200, {
      id: clipId,
      isHidden: false,
      hiddenReason: null,
      visibility: "public",
    });

    const [restored] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipId));
    expect(restored).toMatchObject({
      isHidden: false,
      hiddenReason: null,
      exportedUrl: "https://storage.example.test/galaxyfield/clips/123.mp4",
    });

    await request(app).delete(`/api/admin/clips/${clipId}`).expect(200, { ok: true });
    const [adminHidden] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipId));
    expect(adminHidden).toMatchObject({
      isHidden: true,
      hiddenReason: "deleted",
      exportedUrl: "https://storage.example.test/galaxyfield/clips/123.mp4",
    });
  });
});