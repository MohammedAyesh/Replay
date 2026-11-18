import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
  footageRequestsTable,
  usersTable,
} from "@workspace/db";

const mocks = vi.hoisted(() => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: mocks.getLocalUserId,
  getLocalUserRecord: mocks.getLocalUserRecord,
  unauthenticatedResponse: vi.fn(),
}));

import adminRecordingsRouter from "./recordings";
import fieldsRouter from "./fields";
import hlsProxyRouter from "./hlsProxy";
import ownerRouter from "./owner";

const TAG = `admin-owner-recordings-${Date.now()}`;
const HEX_BASE = BigInt(Date.now());
const videoIdFor = (suffix: number) =>
  `95a477cd-6639-42dd-ad06-${(HEX_BASE + BigInt(suffix)).toString(16).padStart(12, "0").slice(-12)}`;
const tokenFor = (suffix: number) =>
  `s-${(HEX_BASE + BigInt(suffix)).toString(16).padStart(32, "0").slice(-32)}`;
const streamToken = (HEX_BASE + 20n).toString(16).padStart(32, "0").slice(-32);

let app: Express;
let adminId: number;
let ownerId: number;
let otherUserId: number;
let fieldId: number;
let requestIds: number[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

const ownerViewer = { id: 0, isAdmin: false, isGuest: false, isDisabled: false };
const otherViewer = { id: 0, isAdmin: false, isGuest: false, isDisabled: false };

beforeAll(async () => {
  const [admin] = await db.insert(usersTable).values({
    name: `${TAG} admin`,
    email: `${TAG}-admin@test.local`,
    isAdmin: true,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  adminId = admin.id;
  const [owner] = await db.insert(usersTable).values({
    name: `${TAG} owner`,
    email: `${TAG}-owner@test.local`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  ownerId = owner.id;
  const [other] = await db.insert(usersTable).values({
    name: `${TAG} other`,
    email: `${TAG}-other@test.local`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  otherUserId = other.id;
  ownerViewer.id = ownerId;
  otherViewer.id = otherUserId;

  const [field] = await db.insert(fieldsTable).values({
    name: `${TAG} field`,
    location: "Test",
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  await db.insert(fieldOwnersTable).values({ fieldId, userId: ownerId });

  const readyAt = new Date();
  const shareExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const rows = await db.insert(footageRequestsTable).values([
    {
      fieldId,
      cameraId: "camera1",
      requestedBy: ownerId,
      startLocal: "2026-11-16 21:30",
      endLocal: "2026-11-16 21:45",
      requestedSeconds: 900,
      status: "ready",
      progress: 100,
      videoId: videoIdFor(1),
      shareToken: tokenFor(1),
      shareExpiresAt,
      readyAt,
    },
    {
      fieldId,
      cameraId: "camera1",
      requestedBy: ownerId,
      startLocal: "2026-11-16 22:00",
      endLocal: "2026-11-16 22:15",
      requestedSeconds: 900,
      status: "ready",
      progress: 100,
      videoId: videoIdFor(2),
      shareToken: tokenFor(2),
      shareExpiresAt: new Date(Date.now() - 60_000),
      shareRevoked: true,
      readyAt,
    },
    {
      fieldId,
      cameraId: "camera1",
      requestedBy: ownerId,
      startLocal: "2026-11-16 22:30",
      endLocal: "2026-11-16 22:45",
      requestedSeconds: 900,
      status: "ready",
      progress: 100,
      videoId: videoIdFor(3),
      shareToken: streamToken,
      shareExpiresAt,
      readyAt,
    },
    {
      fieldId,
      cameraId: "camera1",
      requestedBy: ownerId,
      startLocal: "2026-11-16 23:00",
      endLocal: "2026-11-16 23:15",
      requestedSeconds: 900,
      status: "queued",
      progress: 0,
      videoId: videoIdFor(4),
      shareToken: tokenFor(4),
      shareExpiresAt,
    },
  ]).returning({ id: footageRequestsTable.id });
  requestIds = rows.map((row) => row.id);

  vi.stubEnv("PUBLIC_SHARE_BASE_URL", "https://owner.example.test");
  app = express();
  app.use(express.json());
  app.use("/api", adminRecordingsRouter);
  app.use("/api", fieldsRouter);
  app.use("/api", hlsProxyRouter);
  app.use("/api", ownerRouter);

  fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/h264.m3u8") || String(input).endsWith("/4k.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response("thumbnail-bytes", {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (requestIds.length) {
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  }
  if (fieldId) {
    await db.delete(fieldOwnersTable).where(inArray(fieldOwnersTable.fieldId, [fieldId]));
    await db.delete(fieldsTable).where(inArray(fieldsTable.id, [fieldId]));
  }
  const userIds = [adminId, ownerId, otherUserId].filter(Boolean);
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe("private ready owner Storage recordings", () => {
  it("lists ready streamless owner footage only for admins with protected media paths", async () => {
    mocks.getLocalUserId.mockResolvedValue(adminId);
    const response = await request(app).get("/api/admin/owner-recordings").expect(200);

    expect(response.body).toHaveLength(2);
    expect(response.body.map((row: { id: number }) => row.id)).toEqual(requestIds.slice(0, 2));
    expect(response.body[0]).toMatchObject({
      fieldId,
      fieldName: `${TAG} field`,
      videoId: videoIdFor(1),
      thumbnailUrl: `/api/hls-proxy/storage/${videoIdFor(1)}/thumb.jpg`,
    });
    expect(response.body[0].playbackUrl).toMatch(
      new RegExp(`^https://[^/]+\\.b-cdn\\.net/vod/${videoIdFor(1)}/h264\\.m3u8$`),
    );
    expect(response.body[0]).not.toHaveProperty("shareToken");
    expect(response.body[0]).not.toHaveProperty("shareUrl");
  });

  it("keeps the owner API playable and public field lists unchanged", async () => {
    mocks.getLocalUserRecord.mockResolvedValue(ownerViewer);
    const ownerResponse = await request(app)
      .get(`/api/owner/fields/${fieldId}/requests`)
      .expect(200);
    const streamlessRequest = ownerResponse.body.find((row: { id: number }) => row.id === requestIds[0]);
    expect(streamlessRequest).toMatchObject({
      streamless: true,
      storageVideoId: videoIdFor(1),
      thumbnailUrl: `/api/hls-proxy/storage/${videoIdFor(1)}/thumb.jpg`,
    });

    mocks.getLocalUserRecord.mockResolvedValue(null);
    const publicResponse = await request(app).get(`/api/fields/${fieldId}/recordings`).expect(200);
    expect(publicResponse.body).toEqual([]);
  });

  it("authorizes Storage thumbnails only for the assigned field owner or admins", async () => {
    fetchMock.mockClear();
    mocks.getLocalUserRecord.mockResolvedValue(ownerViewer);
    const ownerResponse = await request(app)
      .get(`/api/hls-proxy/storage/${videoIdFor(1)}/thumb.jpg`)
      .redirects(0)
      .expect(302);
    expect(ownerResponse.headers.location).toMatch(
      new RegExp(`^https://[^/]+\\.b-cdn\\.net/vod/${videoIdFor(1)}/thumb\\.jpg$`),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    mocks.getLocalUserRecord.mockResolvedValue(otherViewer);
    await request(app)
      .get(`/api/hls-proxy/storage/${videoIdFor(1)}/thumb.jpg`)
      .expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose private owner footage to a non-admin list caller", async () => {
    mocks.getLocalUserId.mockResolvedValue(ownerId);
    await request(app).get("/api/admin/owner-recordings").expect(403);
  });
});
