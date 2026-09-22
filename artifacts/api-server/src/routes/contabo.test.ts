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