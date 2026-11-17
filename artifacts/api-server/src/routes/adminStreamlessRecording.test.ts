import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, fieldsTable, recordingsTable, usersTable } from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));

const TAG = `admin-storage-${Date.now()}`;
const GUID_SUFFIX = Date.now().toString(16).slice(-12).padStart(12, "0");
const COLLECTION_GUID = `aaaaaaaa-aaaa-4aaa-8aaa-${GUID_SUFFIX}`;
const VIDEO_GUID = `95a477cd-6639-42dd-ad06-${GUID_SUFFIX}`;
let adminId: number;
let fieldId: number;
let recordingId: number;
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
  const [{ default: adminRouter }, { getLocalUserId }] = await Promise.all([
    import("./admin"),
    import("../lib/clerkUserBridge"),
  ]);
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
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
});
