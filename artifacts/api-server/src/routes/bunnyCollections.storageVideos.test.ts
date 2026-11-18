import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { db, fieldsTable, recordingsTable } from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(async () => null),
}));

vi.mock("../lib/bunny.js", () => ({
  BUNNY_API_KEY: "test",
  BUNNY_CDN_HOSTNAME: "cdn.test",
  BUNNY_LIBRARY_ID: "1",
  getBunnyProxiedThumbnailUrl: (videoId: string) => `/api/thumbnail/${videoId}`,
  isBunnyConfigured: () => true,
  isBunnyVideoPlayable: () => true,
  isExcludedBunnyVideoTitle: () => false,
}));

const TEST_TAG = `storage-archive-${Date.now()}`;
const COLLECTION_ID = "storage-archive-collection";
const STORAGE_VIDEO_ID = "123e4567-e89b-12d3-a456-426614174000";
let app: Express;
let fieldId: number;

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
  const [{ default: bunnyCollectionsRouter }] = await Promise.all([
    import("./bunnyCollections"),
  ]);
  app = express();
  app.use("/api", bunnyCollectionsRouter);

  const [field] = await db.insert(fieldsTable).values({
    name: `Storage archive ${TEST_TAG}`,
    bunnyGuid: COLLECTION_ID,
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  await db.insert(recordingsTable).values([
    {
      fieldId,
      court: "cam1",
      date: "2026-11-16",
      timeSlot: "21:30",
      duration: "01:00:00",
      videoUrl: `https://storage.example.test/vod/${STORAGE_VIDEO_ID}/4k.m3u8`,
      isVisible: true,
    },
    {
      fieldId,
      court: "cam1",
      date: "2026-11-16",
      timeSlot: "20:30",
      duration: "01:00:00",
      videoUrl: "https://storage.example.test/vod/123e4567-e89b-12d3-a456-426614174001/4k.m3u8",
      isVisible: false,
    },
  ]);
});

afterAll(async () => {
  if (fieldId) {
    await db.delete(recordingsTable).where(eq(recordingsTable.fieldId, fieldId));
    await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  }
  vi.unstubAllGlobals();
});

describe("field archive includes visible Storage recordings", () => {
  it("returns streamless owner footage and keeps hidden recordings out", async () => {
    const response = await request(app)
      .get(`/api/bunny/collections/${COLLECTION_ID}/videos`)
      .expect(200);

    expect(response.body).toEqual([
      {
        guid: STORAGE_VIDEO_ID,
        title: "2026-11-16_21:30",
        thumbnailUrl: `/api/hls-proxy/storage/${STORAGE_VIDEO_ID}/thumb.jpg`,
        playbackUrl: `/api/hls-proxy/uhd/${STORAGE_VIDEO_ID}.m3u8`,
        embedUrl: `/api/hls-proxy/uhd/${STORAGE_VIDEO_ID}.m3u8`,
        views: 0,
        duration: 3600,
      },
    ]);
  });
});
