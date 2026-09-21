import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
  footageRequestsTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));

import { getLocalUserRecord } from "../lib/clerkUserBridge";
import ownerRouter from "./owner";

const mockedGetLocalUserRecord = vi.mocked(getLocalUserRecord);
const TAG = `owner_${Date.now()}`;
const oldStart = "2020-01-01 10:00";
const oldEnd = "2020-01-01 10:15";

let app: Express;
let ownerId: number;
let otherUserId: number;
let adminId: number;
let fieldAId: number;
let fieldBId: number;
let requestIds: number[] = [];
let realFetch: typeof fetch;
let availableHours = Array.from({ length: 24 }, (_, hour) => ({ hour }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://owner-control.test";
  process.env.CONTABO_CONTROL_KEY = "test-control-key";
  process.env.PUBLIC_SHARE_BASE_URL = "https://owner.example.test";

  app = express();
  app.use(express.json());
  app.use("/api", ownerRouter);

  const [owner] = await db.insert(usersTable).values({
    name: `Owner ${TAG}`,
    email: `${TAG}_owner@test.local`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  const [other] = await db.insert(usersTable).values({
    name: `Other ${TAG}`,
    email: `${TAG}_other@test.local`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  const [admin] = await db.insert(usersTable).values({
    name: `Admin ${TAG}`,
    email: `${TAG}_admin@test.local`,
    isAdmin: true,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  ownerId = owner.id;
  otherUserId = other.id;
  adminId = admin.id;

  const [fieldA] = await db.insert(fieldsTable).values({
    name: `Owner Field A ${TAG}`,
    location: "Test",
    cameraId: `owner-camera-a-${TAG}`,
  }).returning({ id: fieldsTable.id });
  const [fieldB] = await db.insert(fieldsTable).values({
    name: `Owner Field B ${TAG}`,
    location: "Test",
    cameraId: `owner-camera-b-${TAG}`,
  }).returning({ id: fieldsTable.id });
  fieldAId = fieldA.id;
  fieldBId = fieldB.id;
  await db.insert(fieldOwnersTable).values({ userId: ownerId, fieldId: fieldAId });

  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/sd/")) {
      return jsonResponse({ hours: availableHours });
    }
    if (url.includes("/record-hq/") && init?.method === "POST") {
      return jsonResponse({ jobId: "job-owner-test" });
    }
    if (url.includes("/record-hq/")) {
      return jsonResponse({
        status: "done",
        videoId: "video-owner-test",
        updatedAt: "2026-09-21T12:00:00.000Z",
      });
    }
    return realFetch(input, init);
  });
});

beforeEach(() => {
  availableHours = Array.from({ length: 24 }, (_, hour) => ({ hour }));
  mockedGetLocalUserRecord.mockResolvedValue({
    id: ownerId,
    isGuest: false,
    isAdmin: false,
  } as Awaited<ReturnType<typeof getLocalUserRecord>>);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (requestIds.length) {
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  }
  await db.delete(fieldOwnersTable).where(eq(fieldOwnersTable.userId, ownerId));
  await db.delete(fieldsTable).where(inArray(fieldsTable.id, [fieldAId, fieldBId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [ownerId, otherUserId, adminId]));
});

describe("owner access guards", () => {
  it("returns 403 when an owner tampers with the field id", async () => {
    await request(app).get(`/api/owner/fields/${fieldBId}/requests`).expect(403);
  });

  it("returns 403 for a non-owner", async () => {
    mockedGetLocalUserRecord.mockResolvedValue({
      id: otherUserId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    await request(app).get(`/api/owner/fields/${fieldAId}/requests`).expect(403);
  });

  it("allows an admin to list all camera-backed fields", async () => {
    mockedGetLocalUserRecord.mockResolvedValue({
      id: adminId,
      isGuest: false,
      isAdmin: true,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    const response = await request(app).get("/api/owner/fields").expect(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fieldAId, cameraId: `owner-camera-a-${TAG}` }),
      expect.objectContaining({ id: fieldBId, cameraId: `owner-camera-b-${TAG}` }),
    ]));
  });
});

describe("owner request validation", () => {
  it.each([
    ["more than 4 hours", "2020-01-01 00:00", "2020-01-01 04:15", "Footage requests cannot exceed 4 hours"],
    ["less than 15 minutes", "2020-01-01 00:00", "2020-01-01 00:00", "Footage requests must be at least 15 minutes"],
    ["not a 15-minute step", "2020-01-01 00:00", "2020-01-01 00:10", "Start and end must be on a 15-minute step"],
    ["a future end", "2999-01-01 10:00", "2999-01-01 10:15", "The footage window must end at least 10 minutes ago"],
  ])("rejects %s with 400", async (_name, startLocal, endLocal, message) => {
    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send({ startLocal, endLocal })
      .expect(400);
    expect(response.body.error).toBe(message);
  });

  it("rejects a request for an unavailable hour", async () => {
    availableHours = [];
    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send({ startLocal: oldStart, endLocal: oldEnd })
      .expect(400);
    expect(response.body.error).toBe("No footage on the camera for 10:00");
  });

  it("rejects a third unfinished request", async () => {
    const inserted = await db.insert(footageRequestsTable).values([
      {
        fieldId: fieldAId,
        cameraId: `owner-camera-a-${TAG}`,
        requestedBy: ownerId,
        startLocal: "2020-01-01 08:00",
        endLocal: "2020-01-01 08:15",
        requestedSeconds: 900,
        status: "queued",
        vpsJobId: "unfinished-1",
      },
      {
        fieldId: fieldAId,
        cameraId: `owner-camera-a-${TAG}`,
        requestedBy: ownerId,
        startLocal: "2020-01-01 09:00",
        endLocal: "2020-01-01 09:15",
        requestedSeconds: 900,
        status: "running",
        vpsJobId: "unfinished-2",
      },
    ]).returning({ id: footageRequestsTable.id });
    requestIds.push(...inserted.map(({ id }) => id));

    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send({ startLocal: oldStart, endLocal: oldEnd })
      .expect(400);
    expect(response.body.error).toBe("You already have 2 unfinished footage requests");
  });
});

describe("owner request status sync", () => {
  it("transitions a completed VPS request to ready with a charge and token", async () => {
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: `owner-camera-a-${TAG}`,
      requestedBy: ownerId,
      startLocal: oldStart,
      endLocal: oldEnd,
      requestedSeconds: 900,
      status: "queued",
      vpsJobId: "job-owner-test",
      rateFils: 1000,
    }).returning();
    requestIds.push(inserted.id);

    const response = await request(app)
      .get(`/api/owner/fields/${fieldAId}/requests`)
      .expect(200);
    const result = response.body.find((row: { id: number }) => row.id === inserted.id);
    expect(result).toMatchObject({
      id: inserted.id,
      status: "ready",
      billableHours: 1,
      amountFils: 1000,
    });
    expect(result.shareUrl).toMatch(/^https:\/\/owner\.example\.test\/w\/[0-9a-f]{32}$/);
    expect(result.playbackManifestUrl).toBe(
      `https://owner.example.test/w/${result.shareUrl.split("/").pop()}/manifest.m3u8`,
    );
  });
});