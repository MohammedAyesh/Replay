import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, userClipsTable, usersTable } from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));

vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    isBunnyConfigured: () => true,
    isBunnyStorageConfigured: () => true,
    getBunnyVideoReadiness: vi.fn(),
    getBunnyVideoInfo: vi.fn(async () => ({
      duration: 60,
      hasMP4Fallback: true,
      availableResolutions: "1080p",
    })),
    uploadToBunnyStorage: vi.fn(async (_path: string, clipId: number, revision?: string) =>
      `https://storage.test/clips/${clipId}-${revision ?? "original"}.mp4`,
    ),
  };
});

vi.mock("../lib/ffmpegExport", () => ({
  renderClip: vi.fn(async () => "/tmp/admin-reclip-output.mp4"),
  cleanupTempFile: vi.fn(),
  bufferRemoteClip: vi.fn(async () => ({
    bufferPath: "/tmp/admin-reclip-buffer.mp4",
    bufferedDuration: 60,
    adjustedOffsetSec: 0,
  })),
}));

vi.mock("../lib/exportSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exportSource")>();
  return {
    ...actual,
    selectExportSource: vi.fn(async () => ({
      url: "https://source.test/ready.m3u8",
      path: "1080p/video.m3u8",
      width: 3840,
      height: 1080,
      renditionLabel: "1080p",
    })),
  };
});

vi.mock("../lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/settings")>();
  return {
    ...actual,
    getAllSettings: vi.fn(async () => ({
      "render.maxConcurrent": 1,
      "render.yieldToArchive": false,
      "render.yieldCeilingSeconds": 1,
    })),
    getSettingValue: vi.fn(async () => false),
  };
});

import { getLocalUserId } from "../lib/clerkUserBridge";
import {
  BunnyVideoNotFoundError,
  getBunnyVideoReadiness,
  uploadToBunnyStorage,
} from "../lib/bunny";
import adminRouter from "./admin";

const TAG = `admin_reclip_${Date.now()}`;
const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const readiness = vi.mocked(getBunnyVideoReadiness);
const upload = vi.mocked(uploadToBunnyStorage);
let app: Express;
let adminId: number;
let playerId: number;
const clipIds: number[] = [];
let sequence = 0;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", adminRouter);

  const [admin] = await db.insert(usersTable).values({
    name: `Admin ${TAG}`,
    email: `admin_${TAG}@test.local`,
    isAdmin: true,
    isGuest: false,
  }).returning({ id: usersTable.id });
  const [player] = await db.insert(usersTable).values({
    name: `Player ${TAG}`,
    email: `player_${TAG}@test.local`,
    isGuest: false,
  }).returning({ id: usersTable.id });
  adminId = admin.id;
  playerId = player.id;
});

afterAll(async () => {
  if (clipIds.length) await db.delete(userClipsTable).where(inArray(userClipsTable.id, clipIds));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, playerId]));
});

beforeEach(() => {
  mockedGetLocalUserId.mockResolvedValue(adminId);
  readiness.mockReset();
  readiness.mockResolvedValue({ ready: true, status: 4 });
  upload.mockClear();
});

async function createClip(videoId?: string) {
  sequence += 1;
  const [clip] = await db.insert(userClipsTable).values({
    userId: playerId,
    videoId: videoId ?? `video-${TAG}-${sequence}`,
    title: `Re-clip test ${sequence}`,
    startTime: "0.2",
    endTime: "0.8",
    cropPath: [{ t: 0, x: 0.1, y: 0, w: 0.8, h: 1 }],
    aspectRatio: "16:9",
    visibility: "private",
    exportStatus: "done",
    exportedUrl: `https://storage.test/old-${sequence}.mp4`,
  }).returning();
  clipIds.push(clip.id);
  return clip;
}

async function waitForStatus(id: number, wanted: string) {
  for (let i = 0; i < 150; i += 1) {
    const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, id));
    if (clip?.exportStatus === wanted) return clip;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Clip ${id} did not reach ${wanted}`);
}

describe("admin clip re-clipping", () => {
  it("rejects both signed-out and non-admin callers", async () => {
    const clip = await createClip();
    mockedGetLocalUserId.mockResolvedValue(null as never);
    expect((await request(app).post(`/api/admin/clips/${clip.id}/reclip`)).status).toBe(403);

    mockedGetLocalUserId.mockResolvedValue(playerId);
    expect((await request(app).post(`/api/admin/clips/${clip.id}/source-check`)).status).toBe(403);
  });

  it("marks a missing Bunny source expired without changing clip metadata", async () => {
    const clip = await createClip();
    readiness.mockRejectedValueOnce(new BunnyVideoNotFoundError(clip.videoId));

    const response = await request(app).post(`/api/admin/clips/${clip.id}/reclip`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sourceStatus: "expired", state: "skipped" });
    const [after] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clip.id));
    expect(after).toMatchObject({
      id: clip.id,
      userId: clip.userId,
      videoId: clip.videoId,
      title: clip.title,
      startTime: clip.startTime,
      endTime: clip.endTime,
      cropPath: clip.cropPath,
      visibility: clip.visibility,
      exportedUrl: clip.exportedUrl,
      exportStatus: "expired",
    });
  });

  it("marks a source that is still processing expired", async () => {
    const clip = await createClip();
    readiness.mockResolvedValueOnce({ ready: false, status: 1 });

    const response = await request(app).post(`/api/admin/clips/${clip.id}/source-check`);
    expect(response.body).toMatchObject({ sourceStatus: "expired", sourceStatusCode: 1 });
    const [after] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clip.id));
    expect(after.exportStatus).toBe("expired");
  });

  it("refuses synthetic live sources without querying Bunny or changing the row", async () => {
    const clip = await createClip("live:camera2");

    const response = await request(app).post(`/api/admin/clips/${clip.id}/reclip`);
    expect(response.body).toMatchObject({ sourceStatus: "live", state: "skipped" });
    expect(readiness).not.toHaveBeenCalled();
    const [after] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clip.id));
    expect(after).toMatchObject({ exportStatus: "done", exportedUrl: clip.exportedUrl });
  });

  it("updates only the existing row after a successful versioned re-clip", async () => {
    const clip = await createClip();

    const response = await request(app).post(`/api/admin/clips/${clip.id}/reclip`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sourceStatus: "ready", state: "queued" });
    const after = await waitForStatus(clip.id, "done");

    expect(after.id).toBe(clip.id);
    expect(after).toMatchObject({
      userId: clip.userId,
      videoId: clip.videoId,
      title: clip.title,
      startTime: clip.startTime,
      endTime: clip.endTime,
      cropPath: clip.cropPath,
      aspectRatio: clip.aspectRatio,
      visibility: clip.visibility,
      exportStatus: "done",
    });
    expect(after.exportedUrl).not.toBe(clip.exportedUrl);
    expect(after.exportedUrl).toMatch(new RegExp(`/${clip.id}-[a-f0-9]{32}\\.mp4$`));
    expect(upload).toHaveBeenCalledWith(
      "/tmp/admin-reclip-output.mp4",
      clip.id,
      expect.stringMatching(/^[a-f0-9]{32}$/),
    );
    const rows = await db.select().from(userClipsTable)
      .where(and(eq(userClipsTable.id, clip.id), eq(userClipsTable.userId, playerId)));
    expect(rows).toHaveLength(1);
  });
});