/**
 * Matches route + scheduler tests.
 *
 * Two surfaces are tested:
 *  1. Route tests (admin cancel) — real DB rows + mocked auth + mocked fetch
 *  2. Scheduler unit tests — real DB rows + mocked global fetch
 *
 * controlFetch checks CONTABO_CONTROL_URL; if it is blank the function returns
 * true immediately (no-op).  We set it to a fake URL so fetch is actually
 * called, then intercept it with vi.stubGlobal.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { db, fieldsTable, matchesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ── Mock auth ──────────────────────────────────────────────────────────────────
vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_TAG = `matchtest_${Date.now()}`;
let fieldId: number;
let adminUserId: number;
let app: Express;

/** IDs of match rows created by tests — cleaned up in afterAll. */
const createdMatchIds: number[] = [];

async function buildApp(): Promise<Express> {
  // Import after mocks are set up
  const { default: matchesRouter } = await import("./matches");
  const a = express();
  a.use(cookieParser());
  a.use(express.json());
  a.use("/api", matchesRouter);
  return a;
}

function fakeAdminUser(isAdmin = true) {
  mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
  // requireAdmin queries usersTable internally; bypass by pointing the userId
  // to the real admin user we inserted in beforeAll.
  if (!isAdmin) {
    // Non-admin: still resolves userId but user.isAdmin is false
    mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
  }
}

/** Point the control fetch to a fake host so global fetch gets called. */
const FAKE_CONTROL_URL = "http://fake-vps-control.local";

function ok200() {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
}
function err500() {
  return Promise.resolve(
    new Response(JSON.stringify({ error: "oops" }), { status: 500 }),
  );
}

/** Insert a match row and track it for cleanup. */
async function insertMatch(
  opts: Partial<typeof matchesTable.$inferInsert> & {
    scheduledStart: Date;
    scheduledEnd: Date;
  },
): Promise<typeof matchesTable.$inferSelect> {
  const [row] = await db
    .insert(matchesTable)
    .values({
      fieldId,
      title: `Test match ${Date.now()}`,
      autoStartLive: true,
      ...opts,
    })
    .returning();
  createdMatchIds.push(row.id);
  return row;
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = FAKE_CONTROL_URL;

  // Insert a camera1 field
  const [f] = await db
    .insert(fieldsTable)
    .values({
      name: `Test Field ${TEST_TAG}`,
      location: "Test",
      cameraId: "camera1",
    })
    .returning({ id: fieldsTable.id });
  fieldId = f.id;

  // Insert a real admin user so requireAdmin passes
  const { usersTable } = await import("@workspace/db");
  const [u] = await db
    .insert(usersTable)
    .values({
      name: `Admin ${TEST_TAG}`,
      email: `admin_${TEST_TAG}@test.local`,
      isGuest: false,
      profileComplete: false,
      isAdmin: true,
    })
    .returning({ id: usersTable.id });
  adminUserId = u.id;

  app = await buildApp();
});

afterAll(async () => {
  const { usersTable } = await import("@workspace/db");

  if (createdMatchIds.length) {
    await db
      .delete(matchesTable)
      .where(inArray(matchesTable.id, createdMatchIds));
  }
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
  delete process.env.CONTABO_CONTROL_URL;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  // Clear fired sets and purge all match rows for the test field so
  // scheduler tests don't leak state into each other.  The scheduler loads
  // ALL non-ended/non-cancelled rows, so left-over "live" rows from a previous
  // test would appear as otherActive and suppress stop calls in the next test.
  const { firedStart, firedEnd } = await import("./matches");
  firedStart.clear();
  firedEnd.clear();
  if (fieldId) {
    await db.delete(matchesTable).where(eq(matchesTable.fieldId, fieldId));
  }
  createdMatchIds.length = 0;
});

// ── Route: GET /matches/current ────────────────────────────────────────────────

describe("GET /api/matches/current", () => {
  it("returns varEnabled=false when field has no cameraId", async () => {
    // A field without camera1 won't satisfy varEnabled
    const [noCamera] = await db
      .insert(fieldsTable)
      .values({ name: `NoCamera ${TEST_TAG}`, location: "Test" })
      .returning();
    const res = await request(app)
      .get(`/api/matches/current?collectionGuid=nonexistent-guid`)
      .expect(200);
    expect(res.body.varEnabled).toBe(false);
    await db.delete(fieldsTable).where(eq(fieldsTable.id, noCamera.id));
  });

  it("returns 400 when collectionGuid is missing", async () => {
    await request(app).get("/api/matches/current").expect(400);
  });
});

// ── Route: POST /admin/matches ─────────────────────────────────────────────────

describe("POST /api/admin/matches", () => {
  it("returns 403 when not admin", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(null);
    await request(app).post("/api/admin/matches").send({}).expect(403);
  });

  it("returns 400 when field has no camera1", async () => {
    const [noCamField] = await db
      .insert(fieldsTable)
      .values({ name: `NoCam ${TEST_TAG}`, location: "Test" })
      .returning();

    mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    const res = await request(app)
      .post("/api/admin/matches")
      .send({
        fieldId: noCamField.id,
        title: "Test",
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        autoStartLive: true,
      })
      .expect(400);
    expect(res.body.error).toMatch(/camera1/i);
    await db.delete(fieldsTable).where(eq(fieldsTable.id, noCamField.id));
  });

  it("creates a match for a camera1 field", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    const res = await request(app)
      .post("/api/admin/matches")
      .send({
        fieldId,
        title: "Derby Match",
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        autoStartLive: true,
      })
      .expect(201);
    expect(res.body.title).toBe("Derby Match");
    expect(res.body.status).toBe("scheduled");
    createdMatchIds.push(res.body.id);
  });
});

// ── Route: PATCH /admin/matches/:id (cancel) ───────────────────────────────────

describe("PATCH /api/admin/matches/:id — cancel", () => {
  it("returns 409 when match is already cancelled", async () => {
    const match = await insertMatch({
      status: "cancelled",
      scheduledStart: new Date(Date.now() - 3_600_000),
      scheduledEnd: new Date(Date.now() + 3_600_000),
    });
    mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
    await request(app)
      .patch(`/api/admin/matches/${match.id}`)
      .send({ action: "cancel" })
      .expect(409);
  });

  it("cancels a future match without calling the stream stop endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const match = await insertMatch({
      scheduledStart: new Date(Date.now() + 3_600_000),
      scheduledEnd: new Date(Date.now() + 7_200_000),
    });

    mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
    const res = await request(app)
      .patch(`/api/admin/matches/${match.id}`)
      .send({ action: "cancel" })
      .expect(200);

    expect(res.body.status).toBe("cancelled");
    // Stream stop must NOT have been called — match hasn't started yet
    const stopCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/stop"),
    );
    expect(stopCall).toBeUndefined();
  });

  it("cancels an active match AND stops the stream when no other match is live", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 600_000), // started 10 min ago
      scheduledEnd: new Date(Date.now() + 600_000),   // ends in 10 min
      status: "live",
    });

    mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
    const res = await request(app)
      .patch(`/api/admin/matches/${match.id}`)
      .send({ action: "cancel" })
      .expect(200);

    expect(res.body.status).toBe("cancelled");
    // The stop control endpoint must have been called
    const stopCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/stop/camera1"),
    );
    expect(stopCall).toBeDefined();
    // And liveStoppedAt was recorded
    expect(res.body.liveStoppedAt).not.toBeNull();
  });

  it("cancels an active match but does NOT stop stream when another match is also live", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    // Primary match (being cancelled)
    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 600_000),
      scheduledEnd: new Date(Date.now() + 600_000),
      status: "live",
    });
    // Overlapping match still active
    const overlap = await insertMatch({
      scheduledStart: new Date(Date.now() - 300_000),
      scheduledEnd: new Date(Date.now() + 900_000),
      status: "live",
    });

    mockedGetLocalUserId.mockResolvedValueOnce(adminUserId);
    const res = await request(app)
      .patch(`/api/admin/matches/${match.id}`)
      .send({ action: "cancel" })
      .expect(200);

    expect(res.body.status).toBe("cancelled");
    // Stop must NOT have been called — the overlapping match is still running
    const stopCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/stop/camera1"),
    );
    expect(stopCall).toBeUndefined();

    // Cleanup overlap
    await db.delete(matchesTable).where(eq(matchesTable.id, overlap.id));
    createdMatchIds.splice(createdMatchIds.indexOf(overlap.id), 1);
  });
});

// ── Scheduler: runMatchScheduler ───────────────────────────────────────────────

describe("runMatchScheduler", () => {
  it("starts a match when now is within scheduled window and autoStartLive=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const { runMatchScheduler, firedStart } = await import("./matches");
    firedStart.clear();

    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 60_000),
      scheduledEnd: new Date(Date.now() + 3_600_000),
      status: "scheduled",
      autoStartLive: true,
    });

    await runMatchScheduler(new Date());

    const [updated] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.id, match.id));
    expect(updated.status).toBe("live");
    expect(updated.liveStartedAt).not.toBeNull();
    expect(firedStart.has(match.id)).toBe(true);
  });

  it("does NOT mark match started when control call fails — allows next tick to retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(err500());
    vi.stubGlobal("fetch", fetchMock);
    const { runMatchScheduler, firedStart } = await import("./matches");
    firedStart.clear();

    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 60_000),
      scheduledEnd: new Date(Date.now() + 3_600_000),
      status: "scheduled",
      autoStartLive: true,
    });

    await runMatchScheduler(new Date());

    const [updated] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.id, match.id));
    // DB must not have been updated — status stays 'scheduled' so next tick retries
    expect(updated.status).toBe("scheduled");
    expect(firedStart.has(match.id)).toBe(false);
  });

  it("ends a match and stops the stream when scheduledEnd has passed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const { runMatchScheduler, firedEnd } = await import("./matches");
    firedEnd.clear();

    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 7_200_000),
      scheduledEnd: new Date(Date.now() - 60_000), // ended 1 min ago
      status: "live",
      autoStartLive: true,
    });

    await runMatchScheduler(new Date());

    const [updated] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.id, match.id));
    expect(updated.status).toBe("ended");
    expect(updated.liveStoppedAt).not.toBeNull();
    expect(firedEnd.has(match.id)).toBe(true);

    const stopCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/stop/camera1"),
    );
    expect(stopCall).toBeDefined();
  });

  it("does NOT stop stream at end when another match is still live (overlap)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const { runMatchScheduler, firedEnd } = await import("./matches");
    firedEnd.clear();

    const endedMatch = await insertMatch({
      scheduledStart: new Date(Date.now() - 7_200_000),
      scheduledEnd: new Date(Date.now() - 60_000),
      status: "live",
    });
    const activeMatch = await insertMatch({
      scheduledStart: new Date(Date.now() - 60_000),
      scheduledEnd: new Date(Date.now() + 3_600_000),
      status: "live",
    });

    await runMatchScheduler(new Date());

    // endedMatch should be marked ended in the DB
    const [updated] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.id, endedMatch.id));
    expect(updated.status).toBe("ended");

    // But stop must NOT have been called
    const stopCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/stop/camera1"),
    );
    expect(stopCall).toBeUndefined();

    // Cleanup
    await db.delete(matchesTable).where(eq(matchesTable.id, activeMatch.id));
    createdMatchIds.splice(createdMatchIds.indexOf(activeMatch.id), 1);
  });

  it("does NOT retry when match is already in firedStart (no double-start)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const { runMatchScheduler, firedStart } = await import("./matches");
    firedStart.clear();

    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 60_000),
      scheduledEnd: new Date(Date.now() + 3_600_000),
      status: "live",
    });
    firedStart.add(match.id); // Simulate already fired

    await runMatchScheduler(new Date());

    // fetch must not have been called for this match
    const startCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/start/camera1"),
    );
    expect(startCall).toBeUndefined();
  });

  it("does NOT call stream stop when autoStartLive=false match ends (manual match)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const { runMatchScheduler, firedEnd } = await import("./matches");
    firedEnd.clear();

    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 7_200_000),
      scheduledEnd: new Date(Date.now() - 60_000),
      status: "live",
      autoStartLive: false, // manual match — stream was not auto-started
    });

    await runMatchScheduler(new Date());

    const [updated] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.id, match.id));
    // Match should still be marked ended
    expect(updated.status).toBe("ended");
    // But the stream stop endpoint must NOT have been called
    const stopCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/stop/camera1"),
    );
    expect(stopCall).toBeUndefined();
  });

  it("stops stream when auto-started match ends even if a manual match is also in window", async () => {
    // A manual match (autoStartLive=false) should not block the scheduler
    // from stopping the stream when an auto-started match ends.
    const fetchMock = vi.fn().mockResolvedValue(ok200());
    vi.stubGlobal("fetch", fetchMock);
    const { runMatchScheduler, firedEnd } = await import("./matches");
    firedEnd.clear();

    const autoMatch = await insertMatch({
      scheduledStart: new Date(Date.now() - 7_200_000),
      scheduledEnd: new Date(Date.now() - 60_000),
      status: "live",
      autoStartLive: true,
    });
    // Manual match overlapping — should NOT block stop
    const manualMatch = await insertMatch({
      scheduledStart: new Date(Date.now() - 300_000),
      scheduledEnd: new Date(Date.now() + 3_600_000),
      status: "live",
      autoStartLive: false,
    });

    await runMatchScheduler(new Date());

    const [updated] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.id, autoMatch.id));
    expect(updated.status).toBe("ended");

    // Stream stop MUST have been called despite the manual match in window
    const stopCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
      ([url]) => String(url).includes("/live/stop/camera1"),
    );
    expect(stopCall).toBeDefined();
  });

  it("skips cancelled matches entirely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok200()));
    const { runMatchScheduler, firedStart, firedEnd } = await import(
      "./matches"
    );
    firedStart.clear();
    firedEnd.clear();

    const match = await insertMatch({
      scheduledStart: new Date(Date.now() - 60_000),
      scheduledEnd: new Date(Date.now() + 3_600_000),
      status: "cancelled",
    });

    await runMatchScheduler(new Date());

    // DB unchanged
    const [updated] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.id, match.id));
    expect(updated.status).toBe("cancelled");
    expect(firedStart.has(match.id)).toBe(false);
  });
});
