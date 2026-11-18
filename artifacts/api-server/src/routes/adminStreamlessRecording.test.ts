import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  fieldsTable,
  footageRequestsTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));
vi.mock("../lib/uhdPlayback", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/uhdPlayback")>(),
  hasUhdPlaylist: vi.fn(async () => true),
  hasStoragePlaylist: vi.fn(async () => true),
}));

const TAG = `admin-storage-${Date.now()}`;
const GUID_SUFFIX = Date.now().toString(16).slice(-12).padStart(12, "0");
const COLLECTION_GUID = `aaaaaaaa-aaaa-4aaa-8aaa-${GUID_SUFFIX}`;
const VIDEO_GUID = `95a477cd-6639-42dd-ad06-${GUID_SUFFIX}`;
const OWNER_VIDEO_GUID = `85a477cd-6639-42dd-ad06-${GUID_SUFFIX}`;
const PARTIAL_VIDEO_GUID = `75a477cd-6639-42dd-ad06-${GUID_SUFFIX}`;
let adminId: number;
let fieldId: number;
let recordingId: number;
let ownerRequestIds: number[] = [];
let backfilledRecordingIds: number[] = [];
let app: Express;
let realFetch: typeof fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  const [admin] = await db.insert(usersTable).values({
    name: `${TAG} admin`,
    email: `${TAG}@test.local`,
    isAdmin: true,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  adminId = admin.id;
  const [field] = await db.insert(fieldsTable).values({
    name: `${TAG} field`,
    location: "Test",
    bunnyGuid: COLLECTION_GUID,
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "cam1",
    date: "2026-11-09",
    timeSlot: "22:00",
    duration: "02:00:00",
    videoUrl: `https://replayjo.b-cdn.net/vod/${VIDEO_GUID}/8k.m3u8`,
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;

  app = express();
  app.use(express.json());

  vi.stubEnv("BUNNY_API_KEY", "unit-test-key");
  vi.stubEnv("BUNNY_LIBRARY_ID", "unit-test-library");
  vi.stubEnv("BUNNY_CDN_HOSTNAME", "replayjo.b-cdn.net");
  vi.resetModules();
  const [{ default: adminRouter }, { default: recordingsRouter }, { getLocalUserId }] = await Promise.all([
    import("./admin"),
    import("./recordings"),
    import("../lib/clerkUserBridge"),
  ]);
  app.use("/api", recordingsRouter);
  app.use("/api", adminRouter);

  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "video.bunnycdn.com") return realFetch(input, init);
    if (url.pathname.endsWith("/collections")) return json([{ guid: COLLECTION_GUID }]);
    if (url.pathname.endsWith("/videos") && url.searchParams.has("collection")) return json([]);
    throw new Error(`Unexpected Bunny Stream request: ${url.pathname}`);
  });
  vi.mocked(getLocalUserId).mockResolvedValue(adminId);
}, 30_000);

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (backfilledRecordingIds.length) {
    await db.delete(recordingsTable).where(inArray(recordingsTable.id, backfilledRecordingIds));
  }
  if (ownerRequestIds.length) {
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, ownerRequestIds));
  }
  if (recordingId) await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (adminId) await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("streamless recording admin import", () => {
  it("preserves Storage-only recordings and never probes them through Bunny Stream", async () => {
    const response = await request(app).post("/api/admin/recordings/import").send({}).expect(200);

    expect(response.body.deleted).toBe(0);
    const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, recordingId));
    expect(recording?.videoUrl).toContain(`/vod/${VIDEO_GUID}/8k.m3u8`);
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => (
      String(input).includes(`/videos/${VIDEO_GUID}`)
    ))).toBe(false);
  });

  it("backfills missing ready and partial owner rows once, keeping them hidden", async () => {
    const [ready] = await db.insert(footageRequestsTable).values({
      fieldId,
      cameraId: "cam1",
      requestedBy: adminId,
      startLocal: "2026-11-16 21:30",
      endLocal: "2026-11-16 23:30",
      requestedSeconds: 7200,
      deliveredSeconds: 7200,
      status: "ready",
      videoId: OWNER_VIDEO_GUID,
      shareToken: `s-${"1".repeat(32)}`,
      rateFils: 0,
    }).returning({ id: footageRequestsTable.id });
    const [partial] = await db.insert(footageRequestsTable).values({
      fieldId,
      cameraId: "cam2",
      requestedBy: adminId,
      startLocal: "2026-11-17 18:00",
      endLocal: "2026-11-17 19:00",
      requestedSeconds: 3600,
      deliveredSeconds: 2400,
      status: "partial",
      videoId: PARTIAL_VIDEO_GUID,
      shareToken: `s-${"2".repeat(32)}`,
      rateFils: 0,
    }).returning({ id: footageRequestsTable.id });
    const [alreadyImported] = await db.insert(footageRequestsTable).values({
      fieldId,
      cameraId: "cam1",
      requestedBy: adminId,
      startLocal: "2026-11-09 22:00",
      endLocal: "2026-11-10 00:00",
      requestedSeconds: 7200,
      deliveredSeconds: 7200,
      status: "ready",
      videoId: VIDEO_GUID,
      shareToken: `s-${"3".repeat(32)}`,
      rateFils: 0,
    }).returning({ id: footageRequestsTable.id });
    ownerRequestIds = [ready.id, partial.id, alreadyImported.id];

    const response = await request(app).post("/api/admin/recordings/import").send({}).expect(200);
    expect(response.body.ownerBackfilled).toBe(2);

    const readyRows = await db.select().from(recordingsTable)
      .where(like(recordingsTable.videoUrl, `%/${OWNER_VIDEO_GUID}/%`));
    const partialRows = await db.select().from(recordingsTable)
      .where(like(recordingsTable.videoUrl, `%/${PARTIAL_VIDEO_GUID}/%`));
    expect(readyRows).toHaveLength(1);
    expect(partialRows).toHaveLength(1);
    const [existingOwnerRow] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, recordingId));
    expect(existingOwnerRow.isVisible).toBe(false);
    expect(readyRows[0]).toMatchObject({
      fieldId,
      court: "cam1",
      date: "2026-11-16",
      timeSlot: "21:30",
      isVisible: false,
    });
    expect(readyRows[0].videoUrl).toContain(`/vod/${OWNER_VIDEO_GUID}/8k.m3u8`);
    expect(partialRows[0]).toMatchObject({ court: "cam2", isVisible: false });
    backfilledRecordingIds = [readyRows[0].id, partialRows[0].id];
    const listed = await request(app).get("/api/admin/recordings").expect(200);
    expect(listed.body.find((row: { id: number }) => row.id === readyRows[0].id)).toMatchObject({
      ownerBookingTitle: `cam1_owner-${ready.id}_2026-11-16_21:30`,
      hasUhdPlayback: true,
      has8kPlayback: true,
      isVisible: false,
    });

    const repeated = await request(app).post("/api/admin/recordings/import").send({}).expect(200);
    expect(repeated.body.ownerBackfilled).toBe(0);
    expect(await db.select().from(recordingsTable)
      .where(like(recordingsTable.videoUrl, `%/${OWNER_VIDEO_GUID}/%`))).toHaveLength(1);
  });
});
