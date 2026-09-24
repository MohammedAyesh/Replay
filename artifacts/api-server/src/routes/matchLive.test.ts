import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import {
  db,
  fieldsTable,
  footageRequestsTable,
  matchRoomsTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return null;
    const { db: database, usersTable: users } = await import("@workspace/db");
    const { eq: equals } = await import("drizzle-orm");
    const [row] = await database.select().from(users).where(equals(users.id, Number(raw)));
    return row ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

vi.mock("./contabo", () => ({
  controlFetch: vi.fn(),
  controlResponse: vi.fn(),
}));

vi.mock("./userClips", () => ({
  queueUserClipExport: vi.fn(async () => "pending"),
}));

import matchLiveRouter, {
  isValidLiveClipDurationMs,
  resetMatchLiveRateLimits,
} from "./matchLive";
import { controlFetch, controlResponse } from "./contabo";
import { queueUserClipExport } from "./userClips";
import { ensureRoomForRequest } from "../lib/matchRooms";

const TAG = `live_${Date.now()}`;
let app: Express;
let userId: number;
let fieldId: number;
let requestId: number;
let matchCode: string;
const previousControlUrl = process.env.CONTABO_CONTROL_URL;
const previousControlKey = process.env.CONTABO_CONTROL_KEY;

function ammanLocalString(ms: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function clipInput(useBallPan = false) {
  const now = Math.floor(Date.now() / 1000);
  return {
    start: now - 20,
    end: now - 10,
    title: `Capture ${TAG}`,
    cropPath: [{ t: 0, x: 0, y: 0, w: 0.5, h: 1 }],
    aspectRatio: "16:9",
    useBallPan,
  };
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://control.example.test";
  process.env.CONTABO_CONTROL_KEY = "test-key";
  app = express();
  app.use(express.json());
  app.use("/api", matchLiveRouter);

  const [user] = await db.insert(usersTable).values({
    name: `Live clip user ${TAG}`,
    email: `${TAG}@test.local`,
    isGuest: false,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  userId = user.id;

  const [field] = await db.insert(fieldsTable).values({
    name: `Live clip field ${TAG}`,
    location: "Test",
    cameraId: "camera1",
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  const now = Date.now();
  const startMs = Math.floor((now - 60_000) / 60_000) * 60_000;
  const endMs = startMs + 60 * 60_000;
  const [footageRequest] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: "camera1",
    requestedBy: userId,
    startLocal: ammanLocalString(startMs),
    endLocal: ammanLocalString(endMs),
    requestedSeconds: 60 * 60,
    status: "scheduled",
  }).returning();
  requestId = footageRequest.id;

  const room = await ensureRoomForRequest(footageRequest);
  matchCode = room.code;
});

beforeEach(() => {
  resetMatchLiveRateLimits();
  vi.mocked(controlFetch).mockReset();
  vi.mocked(controlResponse).mockReset();
  vi.mocked(queueUserClipExport).mockReset().mockResolvedValue("pending");
});

afterAll(async () => {
  if (matchCode) {
    await db.delete(userClipsTable).where(eq(userClipsTable.matchCode, matchCode));
  }
  if (requestId) {
    await db.delete(matchRoomsTable).where(eq(matchRoomsTable.footageRequestId, requestId));
    await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  }
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));

  // Also remove any fixtures left behind if a previous run stopped during setup.
  const staleFields = await db.select({ id: fieldsTable.id }).from(fieldsTable)
    .where(like(fieldsTable.name, "Live clip field live_%"));
  const staleFieldIds = staleFields.map((field) => field.id);
  if (staleFieldIds.length) {
    const staleRequests = await db.select({ id: footageRequestsTable.id })
      .from(footageRequestsTable)
      .where(inArray(footageRequestsTable.fieldId, staleFieldIds));
    const staleRequestIds = staleRequests.map((row) => row.id);
    if (staleRequestIds.length) {
      const staleRooms = await db.select({ code: matchRoomsTable.code })
        .from(matchRoomsTable)
        .where(inArray(matchRoomsTable.footageRequestId, staleRequestIds));
      const staleCodes = staleRooms.map((room) => room.code);
      if (staleCodes.length) {
        await db.delete(userClipsTable).where(inArray(userClipsTable.matchCode, staleCodes));
      }
      await db.delete(matchRoomsTable).where(inArray(matchRoomsTable.footageRequestId, staleRequestIds));
      await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, staleRequestIds));
    }
    await db.delete(fieldsTable).where(inArray(fieldsTable.id, staleFieldIds));
  }
  const staleUsers = await db.select({ id: usersTable.id }).from(usersTable)
    .where(like(usersTable.email, "live_%@test.local"));
  const staleUserIds = staleUsers.map((user) => user.id);
  if (staleUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, staleUserIds));
  }
  if (previousControlUrl === undefined) delete process.env.CONTABO_CONTROL_URL;
  else process.env.CONTABO_CONTROL_URL = previousControlUrl;
  if (previousControlKey === undefined) delete process.env.CONTABO_CONTROL_KEY;
  else process.env.CONTABO_CONTROL_KEY = previousControlKey;
});

describe("match live clip control contract", () => {
  it("accepts only live clip durations from one second through ten minutes", () => {
    expect(isValidLiveClipDurationMs(999)).toBe(false);
    expect(isValidLiveClipDurationMs(1_000)).toBe(true);
    expect(isValidLiveClipDurationMs(600_000)).toBe(true);
    expect(isValidLiveClipDurationMs(600_001)).toBe(false);
  });

  it("accepts the deployed job key and processes documented worker states and offsets", async () => {
    vi.mocked(controlFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { job: "cam1_ab12cd34ef", state: "queued" },
    });

    const created = await request(app)
      .post(`/api/matches/${matchCode}/live-clips`)
      .set("x-test-user", String(userId))
      .send(clipInput())
      .expect(201);

    expect(created.body.liveClipStatus).toBe("queued");
    expect(vi.mocked(controlFetch).mock.calls[0]?.[0]).toMatch(/^\/live\/clip\/camera1\?/);
    const [stored] = await db.select().from(userClipsTable)
      .where(and(eq(userClipsTable.userId, userId), eq(userClipsTable.matchCode, matchCode)));
    expect(stored.liveClipJobId).toBe("cam1_ab12cd34ef");
    await db.update(userClipsTable)
      .set({ createdAt: new Date(Date.now() - 65 * 60 * 1000) })
      .where(eq(userClipsTable.id, stored.id));

    vi.mocked(controlFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { state: "encoding", title: "liveclip_test" },
    });
    const processing = await request(app)
      .get(`/api/matches/${matchCode}/live-clips/${stored.id}/status`)
      .set("x-test-user", String(userId))
      .expect(200);
    expect(processing.body.liveClipStatus).toBe("encoding");

    const guid = "0123456789abcdef0123456789abcdef";
    vi.mocked(controlFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        state: "ready",
        guid,
        duration: 60,
        offsetStart: 10,
        offsetEnd: 20,
        title: "liveclip_test",
        length: 10,
        width: 4096,
        height: 1152,
        partial: true,
      },
    });
    const ready = await request(app)
      .get(`/api/matches/${matchCode}/live-clips/${stored.id}/status`)
      .set("x-test-user", String(userId))
      .expect(200);
    expect(ready.body.liveClipStatus).toBe("ready");
    expect(ready.body.exportStatus).toBe("pending");
    expect(ready.body.liveClipError).toBe(
      "Part of this moment wasn't recorded (camera gap) — the clip is shorter than you picked.",
    );
    expect(queueUserClipExport).toHaveBeenCalledOnce();

    const [captured] = await db.select().from(userClipsTable)
      .where(eq(userClipsTable.id, stored.id));
    expect(captured.videoId).toBe(guid);
    expect(Number(captured.startTime)).toBeCloseTo(10 / 60);
    expect(Number(captured.endTime)).toBeCloseTo(20 / 60);
  });

  it("rejects future end timestamps before calling the control service", async () => {
    const input = clipInput();
    input.end = Math.floor(Date.now() / 1000) + 10;
    await request(app)
      .post(`/api/matches/${matchCode}/live-clips`)
      .set("x-test-user", String(userId))
      .send(input)
      .expect(400);
    expect(controlFetch).not.toHaveBeenCalled();
  });

  it("rejects live clip windows outside the one-second to ten-minute limits", async () => {
    const tooShort = clipInput();
    tooShort.start = tooShort.end - 0.5;
    const shortResponse = await request(app)
      .post(`/api/matches/${matchCode}/live-clips`)
      .set("x-test-user", String(userId))
      .send(tooShort)
      .expect(400);
    expect(shortResponse.body.error).toContain("at least 1 second");

    expect(controlFetch).not.toHaveBeenCalled();
  });

  it("allows a viewer to save after 100 live playlist and segment requests", async () => {
    vi.mocked(controlResponse).mockImplementation(async (path) => (
      path.endsWith("/playlist.m3u8")
        ? new Response("#EXTM3U\n#EXTINF:4,\nseg/segment1.ts\n", { status: 200 })
        : new Response(new Uint8Array([0, 1, 2]), {
          status: 200,
          headers: { "Content-Type": "video/mp2t" },
        })
    ));

    for (let index = 0; index < 100; index += 1) {
      const response = index % 2 === 0
        ? await request(app).get(`/api/matches/${matchCode}/live/hls/playlist.m3u8`)
        : await request(app).get(`/api/matches/${matchCode}/live/hls/seg/segment1.ts`);
      expect(response.status).toBe(200);
    }

    vi.mocked(controlFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { job: `cam1_${TAG}` },
    });
    const saved = await request(app)
      .post(`/api/matches/${matchCode}/live-clips`)
      .set("x-test-user", String(userId))
      .send(clipInput())
      .expect(201);

    expect(saved.body.liveClipStatus).toBe("queued");
    expect(controlResponse).toHaveBeenCalledTimes(100);
    expect(controlFetch).toHaveBeenCalledOnce();
  });

  it("applies the live match request limit only to per-user clip saves", async () => {
    vi.mocked(controlFetch).mockResolvedValue({
      ok: true,
      status: 200,
      body: { job: `cam1_${TAG}` },
    });

    for (let index = 0; index < 20; index += 1) {
      await request(app)
        .post(`/api/matches/${matchCode}/live-clips`)
        .set("x-test-user", String(userId))
        .send(clipInput())
        .expect(201);
    }

    const limitedSave = await request(app)
      .post(`/api/matches/${matchCode}/live-clips`)
      .set("x-test-user", String(userId))
      .send(clipInput())
      .expect(429);

    expect(limitedSave.body.error).toBe("Too many live match requests");
    expect(controlFetch).toHaveBeenCalledTimes(20);
  });

  it("rejects ball-follow when the control service reports unavailable path coverage", async () => {
    vi.mocked(controlFetch)
      .mockResolvedValueOnce({ ok: true, status: 200, body: { on: true, state: "live" } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { available: false, coverage: 0 } });

    const response = await request(app)
      .post(`/api/matches/${matchCode}/live-clips`)
      .set("x-test-user", String(userId))
      .send(clipInput(true))
      .expect(409);

    expect(response.body.error).toMatch(/Ball-follow is unavailable/);
    expect(vi.mocked(controlFetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(controlFetch).mock.calls[1]?.[0]).toMatch(/^\/live\/ballpath\/camera1\?/);
  });
});