import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { db, usersTable, userClipsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";
import { getBufferedWindow } from "../lib/ffmpegExport";
import { normalizeExportWindow, selectExportSource, ExportSourceUnavailableError } from "./userClips";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);

async function buildApp(): Promise<Express> {
  const { default: userClipsRouter } = await import("./userClips");
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", userClipsRouter);
  return app;
}

const TEST_TAG = `test_${Date.now()}`;
let userAId: number;
let userBId: number;
let app: Express;

beforeAll(async () => {
  app = await buildApp();

  const [userA] = await db
    .insert(usersTable)
    .values({
      name: "Test User A",
      email: `userA_${TEST_TAG}@test.local`,
      isGuest: false,
      profileComplete: false,
    })
    .returning({ id: usersTable.id });

  const [userB] = await db
    .insert(usersTable)
    .values({
      name: "Test User B",
      email: `userB_${TEST_TAG}@test.local`,
      isGuest: false,
      profileComplete: false,
    })
    .returning({ id: usersTable.id });

  userAId = userA.id;
  userBId = userB.id;
});

afterAll(async () => {
  await db
    .delete(userClipsTable)
    .where(inArray(userClipsTable.userId, [userAId, userBId]));

  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [userAId, userBId]));
});

const SAMPLE_CLIP_BODY = {
  videoId: "test-video-abc123",
  title: "My highlight",
  startTime: 12.345678,
  endTime: 45.678901,
  cropPath: [{ t: 0, x: 0.1, y: 0.1, w: 0.8, h: 0.8 }],
};

describe("POST /api/user-clips", () => {
  it("returns 401 when not authenticated", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(null);

    const res = await request(app).post("/api/user-clips").send(SAMPLE_CLIP_BODY);

    expect(res.status).toBe(401);
  });

  it("creates a clip owned by the authenticated user", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);

    const res = await request(app)
      .post("/api/user-clips")
      .send(SAMPLE_CLIP_BODY);

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(userAId);
    expect(res.body.videoId).toBe(SAMPLE_CLIP_BODY.videoId);
    expect(res.body.title).toBe(SAMPLE_CLIP_BODY.title);
    expect(typeof res.body.id).toBe("number");
  });

  it("round-trips startTime and endTime as numeric fractions", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);

    const res = await request(app)
      .post("/api/user-clips")
      .send({ ...SAMPLE_CLIP_BODY, startTime: 0.123456, endTime: 99.999999 });

    expect(res.status).toBe(201);
    expect(res.body.startTime).toBeCloseTo(0.123456, 5);
    expect(res.body.endTime).toBeCloseTo(99.999999, 5);
  });

  it("ignores userId in the request body and uses the session user", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);

    const res = await request(app)
      .post("/api/user-clips")
      .send({ ...SAMPLE_CLIP_BODY, userId: userBId });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(userAId);
  });
});

describe("clip export window and source selection", () => {
  it("clamps out-of-range stored fractions before calculating the buffer window", () => {
    expect(normalizeExportWindow(0.25, 99.999999, 100)).toEqual({
      startSec: 25,
      endSec: 100,
      clipDuration: 75,
    });
  });

  it("keeps a near-end selection ordered and within the recording", () => {
    expect(normalizeExportWindow(0.99, 1.2, 100)).toEqual({
      startSec: 99,
      endSec: 100,
      clipDuration: 1,
    });
  });

  it("rejects a selection whose start is already past the recording", () => {
    expect(normalizeExportWindow(1.2, 2, 100)).toEqual({
      startSec: 100,
      endSec: 100,
      clipDuration: 0,
    });
  });

  it("rejects a zero-length selection", () => {
    expect(normalizeExportWindow(0.5, 0.5, 100)).toEqual({
      startSec: 50,
      endSec: 50,
      clipDuration: 0,
    });
  });

  it("caps the buffered request at the remaining source duration", () => {
    expect(getBufferedWindow({
      startSec: 95,
      clipDuration: 10,
      totalDuration: 100,
    })).toEqual({
      availableDuration: 5,
      requestedWindow: 5,
    });
    expect(getBufferedWindow({
      startSec: 10,
      clipDuration: 10,
      totalDuration: 100,
    })).toEqual({
      availableDuration: 90,
      requestedWindow: 15,
    });
  });

  // Source-rendition pinning moved to lib/exportSource.ts and is covered in
  // depth by src/lib/exportSource.test.ts, which drives it with the real master
  // playlists recorded from library 694315. The cases below only assert the
  // contract this module depends on: a resolution-matched variant, and a throw
  // rather than a fallback.
  const MASTER_TWO_RUNGS = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    '#EXT-X-STREAM-INF:BANDWIDTH=7749701,CODECS="avc1.640020",RESOLUTION=1920x540',
    "1080p/video.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=27036736,CODECS="avc1.640032",RESOLUTION=3840x1080',
    "2160p/video.m3u8",
    "",
  ].join("\n");

  function mockCdn(routes: Record<string, { status?: number; body: string }>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      for (const [suffix, r] of Object.entries(routes)) {
        if (url.endsWith(suffix)) return new Response(r.body, { status: r.status ?? 200 });
      }
      return new Response("not found", { status: 404 });
    }) as any);
  }

  it("resolves the variant that declares 3840x1080, not the first one listed", async () => {
    const fetchSpy = mockCdn({
      "/playlist.m3u8": { body: MASTER_TWO_RUNGS },
      "/2160p/video.m3u8": { body: "#EXTM3U\n#EXT-X-TARGETDURATION:4\n" },
    });
    try {
      const source = await selectExportSource({
        videoId: "video-id",
        hasMP4Fallback: false,
        availableResolutions: "1080p,2160p",
        referer: "https://cdn.example/",
      });
      expect(source.url).toContain("/video-id/2160p/video.m3u8");
      expect([source.width, source.height]).toEqual([3840, 1080]);
      expect(source.path).toBe("resolution-matched HLS variant");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("throws rather than falling back to the master playlist", async () => {
    const fetchSpy = mockCdn({ "/playlist.m3u8": { body: MASTER_TWO_RUNGS } });
    try {
      await expect(
        selectExportSource({
          videoId: "video-id",
          hasMP4Fallback: false,
          availableResolutions: "1080p,2160p",
          referer: "https://cdn.example/",
        }),
      ).rejects.toBeInstanceOf(ExportSourceUnavailableError);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("GET /api/user-clips", () => {
  it("returns 401 when not authenticated", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/user-clips");

    expect(res.status).toBe(401);
  });

  it("returns only clips belonging to the authenticated user", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    await request(app).post("/api/user-clips").send({ ...SAMPLE_CLIP_BODY, title: "Clip A" });

    mockedGetLocalUserId.mockResolvedValueOnce(userBId);
    await request(app).post("/api/user-clips").send({ ...SAMPLE_CLIP_BODY, title: "Clip B" });

    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    const res = await request(app).get("/api/user-clips");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const allBelongToA = res.body.every((c: { userId: number }) => c.userId === userAId);
    expect(allBelongToA).toBe(true);
    const hasClipB = res.body.some((c: { title: string }) => c.title === "Clip B");
    expect(hasClipB).toBe(false);
  });

  it("returns an empty array for a new user with no clips", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userBId);
    const cleanupRes = await request(app).get("/api/user-clips");

    await Promise.all(
      cleanupRes.body
        .filter((c: { userId: number }) => c.userId === userBId)
        .map((c: { id: number }) => {
          mockedGetLocalUserId.mockResolvedValueOnce(userBId);
          return request(app).delete(`/api/user-clips/${c.id}`);
        })
    );

    const [freshUser] = await db
      .insert(usersTable)
      .values({
        name: "Empty User",
        email: `empty_${TEST_TAG}@test.local`,
        isGuest: false,
        profileComplete: false,
      })
      .returning({ id: usersTable.id });

    mockedGetLocalUserId.mockResolvedValueOnce(freshUser.id);
    const res = await request(app).get("/api/user-clips");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);

    await db.delete(usersTable).where(eq(usersTable.id, freshUser.id));
  });
});

describe("DELETE /api/user-clips/:id", () => {
  it("returns 401 when not authenticated", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    const createRes = await request(app).post("/api/user-clips").send(SAMPLE_CLIP_BODY);
    const clipId: number = createRes.body.id;

    mockedGetLocalUserId.mockResolvedValueOnce(null);
    const res = await request(app).delete(`/api/user-clips/${clipId}`);

    expect(res.status).toBe(401);

    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    await request(app).delete(`/api/user-clips/${clipId}`);
  });

  it("returns 403 when a different user tries to delete", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    const createRes = await request(app).post("/api/user-clips").send(SAMPLE_CLIP_BODY);
    const clipId: number = createRes.body.id;

    mockedGetLocalUserId.mockResolvedValueOnce(userBId);
    const res = await request(app).delete(`/api/user-clips/${clipId}`);

    expect(res.status).toBe(403);

    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    await request(app).delete(`/api/user-clips/${clipId}`);
  });

  it("allows the owner to delete their own clip", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    const createRes = await request(app).post("/api/user-clips").send(SAMPLE_CLIP_BODY);
    const clipId: number = createRes.body.id;

    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    const res = await request(app).delete(`/api/user-clips/${clipId}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 for a clip that does not exist", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(userAId);
    const res = await request(app).delete(`/api/user-clips/999999999`);

    expect(res.status).toBe(404);
  });
});
