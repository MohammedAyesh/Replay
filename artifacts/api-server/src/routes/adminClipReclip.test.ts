import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { clipDownloadsTable, db, userClipsTable, usersTable } from "@workspace/db";

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

vi.mock("../lib/backupExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backupExport")>();
  return {
    ...actual,
    fetchExportObject: vi.fn(),
  };
});

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
import { fetchExportObject } from "../lib/backupExport";
import adminRouter from "./admin";

const TAG = `admin_reclip_${Date.now()}`;
const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const readiness = vi.mocked(getBunnyVideoReadiness);
const upload = vi.mocked(uploadToBunnyStorage);
const exportFetcher = vi.mocked(fetchExportObject);
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
  exportFetcher.mockReset();
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

  it("requires an admin to access exported clip playback", async () => {
    const clip = await createClip();
    mockedGetLocalUserId.mockResolvedValue(playerId);

    const response = await request(app).get(`/api/admin/clips/${clip.id}/playback`);

    expect(response.status).toBe(403);
    expect(exportFetcher).not.toHaveBeenCalled();
  });

  it("streams the export without writing a download-quota record", async () => {
    const clip = await createClip();
    exportFetcher.mockResolvedValueOnce(new Response(Buffer.from("exported"), {
      status: 200,
      headers: { "content-length": "8", "accept-ranges": "bytes" },
    }));

    const before = await db.select().from(clipDownloadsTable)
      .where(eq(clipDownloadsTable.clipId, clip.id));
    const response = await request(app)
      .get(`/api/admin/clips/${clip.id}/playback?url=${encodeURIComponent("https://attacker.invalid/video.mp4")}`);
    const after = await db.select().from(clipDownloadsTable)
      .where(eq(clipDownloadsTable.clipId, clip.id));

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-disposition"]).toBe(`inline; filename="clip-${clip.id}.mp4"`);
    expect(exportFetcher).toHaveBeenCalledWith(
      clip.exportedUrl,
      expect.objectContaining({ range: undefined }),
    );
    expect(after).toHaveLength(before.length);
    expect(after).toHaveLength(0);
  });

  it("chunk-streams a large full export without changing playback headers", async () => {
    const clip = await createClip();
    exportFetcher.mockResolvedValueOnce(new Response(Buffer.from("large export"), {
      status: 200,
      headers: {
        "content-length": String(32 * 1024 * 1024 + 1),
        "accept-ranges": "bytes",
      },
    }));

    const response = await request(app)
      .get(`/api/admin/clips/${clip.id}/playback`)
      .buffer(true)
      .parse((incoming, callback) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-disposition"]).toBe(`inline; filename="clip-${clip.id}.mp4"`);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["transfer-encoding"]).toBe("chunked");
    expect((response.body as Buffer).toString()).toBe("large export");
  });

  it("forwards Range and streams the matching 206 partial response", async () => {
    const clip = await createClip();
    exportFetcher.mockResolvedValueOnce(new Response(Buffer.from("2345"), {
      status: 206,
      headers: {
        "content-length": "4",
        "content-range": "bytes 2-5/10",
        "accept-ranges": "bytes",
      },
    }));

    const response = await request(app)
      .get(`/api/admin/clips/${clip.id}/playback`)
      .set("Range", "bytes=2-5");

    expect(response.status).toBe(206);
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.headers["content-length"]).toBe("4");
    expect(exportFetcher).toHaveBeenCalledWith(
      clip.exportedUrl,
      expect.objectContaining({ range: "bytes=2-5" }),
    );
  });

  it("returns a status-bearing 404 instead of serving an old or missing export", async () => {
    const pending = await createClip();
    await db.update(userClipsTable)
      .set({ exportStatus: "pending" })
      .where(eq(userClipsTable.id, pending.id));

    const pendingResponse = await request(app).get(`/api/admin/clips/${pending.id}/playback`);
    expect(pendingResponse.status).toBe(404);
    expect(pendingResponse.body).toMatchObject({
      error: "Export not ready",
      exportStatus: "pending",
    });

    const missing = await createClip();
    await db.update(userClipsTable)
      .set({ exportStatus: "expired", exportedUrl: null })
      .where(eq(userClipsTable.id, missing.id));

    const missingResponse = await request(app).get(`/api/admin/clips/${missing.id}/playback`);
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.body).toMatchObject({
      error: "Export not ready",
      exportStatus: "expired",
    });
    expect(exportFetcher).not.toHaveBeenCalled();
  });

  it("exposes internal render ownership states as pending in admin clip responses", async () => {
    const clip = await createClip();
    for (const internalStatus of [
      "pending_vps1_overflow",
      "pending_local_fallback",
      "pending_vps1_after_primary",
    ]) {
      await db.update(userClipsTable)
        .set({ exportStatus: internalStatus })
        .where(eq(userClipsTable.id, clip.id));

      const list = await request(app).get("/api/admin/clips").expect(200);
      const listedClip = list.body.find((row: { id: number }) => row.id === clip.id);
      expect(listedClip.exportStatus).toBe("pending");
      expect(JSON.stringify(listedClip)).not.toContain(internalStatus);

      const playback = await request(app).get(`/api/admin/clips/${clip.id}/playback`).expect(404);
      expect(playback.body.exportStatus).toBe("pending");
      expect(JSON.stringify(playback.body)).not.toContain(internalStatus);
    }
  });
});