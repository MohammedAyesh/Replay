import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, fieldOwnersTable, fieldsTable, usersTable } from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: (res: { status: (status: number) => { json: (body: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthorized" });
  },
}));
vi.mock("../lib/matchRooms", () => ({
  loadRoomByCode: vi.fn(),
}));

import { getLocalUserRecord } from "../lib/clerkUserBridge";
import { loadRoomByCode } from "../lib/matchRooms";
import streamingRouter from "./streaming";

const mockedGetLocalUserRecord = vi.mocked(getLocalUserRecord);
const mockedLoadRoomByCode = vi.mocked(loadRoomByCode);
const TAG = `social_stream_${Date.now()}`;

let app: Express;
let adminId: number;
let ownerId: number;
let otherId: number;
let captainId: number;
let fieldId: number;
let realFetch: typeof fetch;
let requests: Array<{ url: string; body?: string }> = [];
let currentUser: { id: number; isAdmin: boolean; isGuest: boolean } | null = null;
const TEST_STREAM_KEY = "test-secret-stream-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://stream-control.test";
  process.env.CONTABO_CONTROL_KEY = "test-control-key";

  const [admin] = await db.insert(usersTable).values({
    name: `Stream Admin ${TAG}`,
    email: `${TAG}_admin@test.local`,
    isAdmin: true,
  }).returning({ id: usersTable.id });
  const [owner] = await db.insert(usersTable).values({
    name: `Stream Owner ${TAG}`,
    email: `${TAG}_owner@test.local`,
  }).returning({ id: usersTable.id });
  const [other] = await db.insert(usersTable).values({
    name: `Stream Other ${TAG}`,
    email: `${TAG}_other@test.local`,
  }).returning({ id: usersTable.id });
  const [captain] = await db.insert(usersTable).values({
    name: `Stream Captain ${TAG}`,
    email: `${TAG}_captain@test.local`,
  }).returning({ id: usersTable.id });
  const [field] = await db.insert(fieldsTable).values({
    name: `Stream Field ${TAG}`,
    cameraId: "camera1",
  }).returning({ id: fieldsTable.id });
  await db.insert(fieldOwnersTable).values({ userId: owner.id, fieldId: field.id });

  adminId = admin.id;
  ownerId = owner.id;
  otherId = other.id;
  captainId = captain.id;
  fieldId = field.id;

  app = express();
  app.use(express.json());
  app.use("/api", streamingRouter);
  mockedGetLocalUserRecord.mockImplementation(async () => currentUser as never);
  mockedLoadRoomByCode.mockResolvedValue({
    room: { captainUserId: captainId, fieldId },
    field: { cameraId: "camera1" },
  } as never);

  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, body });
    if (url.endsWith("/streaming/status/camera1")) {
      return jsonResponse({ state: "live", live: true, platform: "youtube", stream_key: TEST_STREAM_KEY });
    }
    if (url.endsWith("/streaming/start/camera1")) {
      if (body?.includes('"platform":"facebook"')) {
        return jsonResponse({ detail: `Rejected ${TEST_STREAM_KEY}` }, 409);
      }
      return jsonResponse({ state: "starting", message: `Accepted ${TEST_STREAM_KEY}`, streamKey: TEST_STREAM_KEY });
    }
    if (url.endsWith("/streaming/stop/camera1")) {
      return jsonResponse({ state: "offline", live: false, stream_key: TEST_STREAM_KEY });
    }
    return realFetch(input, init);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(fieldOwnersTable).where(eq(fieldOwnersTable.fieldId, fieldId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, ownerId, otherId, captainId]));
});

beforeEach(() => {
  requests = [];
  currentUser = { id: adminId, isAdmin: true, isGuest: false };
});

describe("social streaming access", () => {
  it("limits direct camera control to admins", async () => {
    currentUser = { id: otherId, isAdmin: false, isGuest: false };
    await request(app).get("/api/streaming/status?camera=camera1").expect(403);
    expect(requests).toHaveLength(0);
  });

  it("allows a field owner and rejects another user", async () => {
    currentUser = { id: ownerId, isAdmin: false, isGuest: false };
    const ownerResponse = await request(app)
      .get(`/api/streaming/status?fieldId=${fieldId}`)
      .expect(200);
    expect(ownerResponse.body).toMatchObject({ state: "live", live: true, platform: "youtube" });

    currentUser = { id: otherId, isAdmin: false, isGuest: false };
    await request(app).get(`/api/streaming/status?fieldId=${fieldId}`).expect(403);
    expect(requests).toHaveLength(1);
  });

  it("allows the match captain without granting access to other players", async () => {
    currentUser = { id: captainId, isAdmin: false, isGuest: false };
    await request(app).get("/api/streaming/status?matchCode=ABC123").expect(200);

    currentUser = { id: otherId, isAdmin: false, isGuest: false };
    await request(app).get("/api/streaming/status?matchCode=ABC123").expect(403);
    expect(requests).toHaveLength(1);
  });
});

describe("social streaming proxy", () => {
  it("does not expose stream keys in status responses", async () => {
    const response = await request(app)
      .get("/api/streaming/status?camera=camera1")
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain(TEST_STREAM_KEY);
    expect(requests.map((entry) => entry.url)).toContain("https://stream-control.test/streaming/status/camera1");
  });

  it("sends a stream key only to the upstream start call and omits it from responses", async () => {
    const response = await request(app)
      .post("/api/streaming/start")
      .send({ camera: "camera1", platform: "youtube", streamKey: TEST_STREAM_KEY })
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain(TEST_STREAM_KEY);
    const upstream = requests.find((entry) => entry.url.endsWith("/streaming/start/camera1"));
    expect(upstream?.body).toBe(JSON.stringify({ platform: "youtube", stream_key: TEST_STREAM_KEY }));
  });

  it("proxies stop without a key and returns sanitized state", async () => {
    const response = await request(app)
      .post("/api/streaming/stop")
      .send({ camera: "camera1" })
      .expect(200);
    expect(response.body).toMatchObject({ state: "offline", live: false });
    expect(JSON.stringify(response.body)).not.toContain(TEST_STREAM_KEY);
    expect(requests[0]?.body).toBeUndefined();
  });

  it("does not echo a rejected stream key in an upstream error", async () => {
    const response = await request(app)
      .post("/api/streaming/start")
      .send({ camera: "camera1", platform: "facebook", streamKey: TEST_STREAM_KEY })
      .expect(409);
    expect(JSON.stringify(response.body)).not.toContain(TEST_STREAM_KEY);
  });
});