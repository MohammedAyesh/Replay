import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { db, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";
import contaboRouter from "./contabo";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const TAG = `contabo_var_${Date.now()}`;

let app: Express;
let adminId: number;
let plainId: number;
let realFetch: typeof fetch;
let requests: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://var-control.test";
  process.env.CONTABO_CONTROL_KEY = "test-control-key";

  app = express();
  app.use(express.json());
  app.use("/api", contaboRouter);

  const [admin] = await db.insert(usersTable).values({
    name: `VAR Admin ${TAG}`,
    email: `${TAG}_admin@test.local`,
    isAdmin: true,
  }).returning({ id: usersTable.id });
  const [plain] = await db.insert(usersTable).values({
    name: `VAR User ${TAG}`,
    email: `${TAG}_plain@test.local`,
  }).returning({ id: usersTable.id });
  adminId = admin.id;
  plainId = plain.id;

  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/var/cam1/state")) {
      return jsonResponse({ cam: "cam1", supported: true, on: true, live: false });
    }
    if (url.includes("/var/cam1/start?minutes=60")) {
      return jsonResponse({ cam: "cam1", started: true });
    }
    if (url.includes("/var/cam1/schedule?")) {
      return jsonResponse({ id: "window_1", status: "scheduled" });
    }
    if (url.endsWith("/var/cam1/windows")) {
      return jsonResponse({ adminWindows: [], bookings: [] });
    }
    if (url.endsWith("/var/cam1/windows/window_1")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/livepan/status/camera1")) {
      return jsonResponse({ cam: "camera1", on: true, state: "active", gpu: "A10", usdPerHr: 0.25, usdSoFar: 0.1 });
    }
    if (url.endsWith("/livepan/start/camera1")) {
      return jsonResponse({ cam: "camera1", on: true, state: "starting" });
    }
    if (url.endsWith("/livepan/stop/camera1")) {
      return jsonResponse({ cam: "camera1", on: false, state: "off" });
    }
    if (url.endsWith("/livepan/start/camera2")) {
      return jsonResponse({ message: "Camera is reserved for a scheduled match" }, 409);
    }
    return realFetch(input, init);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, plainId]));
});

beforeEach(() => {
  requests = [];
  mockedGetLocalUserId.mockResolvedValue(adminId);
});

describe("admin VAR control authorization", () => {
  it("rejects a signed-in non-admin", async () => {
    mockedGetLocalUserId.mockResolvedValue(plainId);
    await request(app).get("/api/admin/var/camera1/state").expect(403);
    expect(requests).toHaveLength(0);
  });

  it("rejects anonymous access", async () => {
    mockedGetLocalUserId.mockResolvedValue(null);
    await request(app).post("/api/admin/var/camera1/start").expect(403);
  });

  it("rejects non-admin access to livepan controls", async () => {
    mockedGetLocalUserId.mockResolvedValue(plainId);
    await request(app).post("/api/admin/contabo/livepan/start/camera1").expect(403);
    expect(requests).toHaveLength(0);
  });
});

describe("admin VAR control proxy", () => {
  it("normalizes camera aliases and proxies state", async () => {
    const response = await request(app).get("/api/admin/var/cam1/state").expect(200);
    expect(response.body).toMatchObject({ cam: "cam1", supported: true, on: true, live: false });
    expect(requests).toContain("https://var-control.test/var/cam1/state");
  });

  it("validates and proxies start duration", async () => {
    await request(app).post("/api/admin/var/camera1/start?minutes=60").expect(200);
    expect(requests).toContain("https://var-control.test/var/cam1/start?minutes=60");
    await request(app).post("/api/admin/var/camera1/start?minutes=4").expect(400);
  });

  it("proxies schedule, list, and cancellation", async () => {
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
    const schedule = await request(app)
      .post("/api/admin/var/camera1/schedule")
      .send({ start: `${date} 10:00`, end: `${date} 11:00` })
      .expect(200);
    expect(schedule.body).toMatchObject({ id: "window_1", status: "scheduled" });
    await request(app).get("/api/admin/var/camera1/windows").expect(200);
    await request(app).delete("/api/admin/var/camera1/windows/window_1").expect(204);
    expect(requests.some((url) => url.includes("/var/cam1/schedule?start="))).toBe(true);
    expect(requests).toContain("https://var-control.test/var/cam1/windows");
    expect(requests).toContain("https://var-control.test/var/cam1/windows/window_1");
  });
});

describe("admin livepan control proxy", () => {
  it("proxies status, start, and stop to the livepan API", async () => {
    const status = await request(app).get("/api/admin/contabo/livepan/status/camera1").expect(200);
    expect(status.body).toMatchObject({ on: true, state: "active", gpu: "A10", usdPerHr: 0.25 });

    const started = await request(app).post("/api/admin/contabo/livepan/start/camera1").expect(200);
    expect(started.body).toMatchObject({ on: true, state: "starting" });
    const stopped = await request(app).post("/api/admin/contabo/livepan/stop/camera1").expect(200);
    expect(stopped.body).toMatchObject({ on: false, state: "off" });

    expect(requests).toContain("https://var-control.test/livepan/status/camera1");
    expect(requests).toContain("https://var-control.test/livepan/start/camera1");
    expect(requests).toContain("https://var-control.test/livepan/stop/camera1");
  });

  it("preserves control API 409 messages and rejects unknown cameras", async () => {
    const conflict = await request(app).post("/api/admin/contabo/livepan/start/camera2").expect(409);
    expect(conflict.body.message).toBe("Camera is reserved for a scheduled match");

    const requestsBeforeInvalidCamera = requests.length;
    await request(app).get("/api/admin/contabo/livepan/status/camera9").expect(400);
    expect(requests).toHaveLength(requestsBeforeInvalidCamera);
  });
});