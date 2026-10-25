import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  academiesTable, academyRecordingsTable, academySessionsTable, db, fieldsTable,
  footageRequestsTable, recordingsTable, usersTable,
} from "@workspace/db";

vi.mock("../routes/contabo", () => ({ controlFetch: vi.fn(), controlResponse: vi.fn() }));

import { controlFetch } from "../routes/contabo";
import {
  AWAY_SESSION_NOTE,
  CAMERA_BOOKED_BY_ACADEMY_NOTE,
  CAMERA_BOOKED_ELSEWHERE_NOTE,
  PAST_SESSION_NOTE,
  academyFootageWindow,
  attachAcademyRecordingsForFootageRequest,
  bookAcademySessionFootage,
  cancelScheduledAcademyFootageForSession,
  isAwayLocation,
} from "./academyFootage";
import { getBunnyPlaybackUrl } from "./bunny";

const tag = `academy_footage_${Date.now()}`;
const cameraId = `camtest_${Date.now()}`;
const HOUR = 60 * 60_000;
let userId: number;
let fieldId: number;
let academyA: number;
let academyB: number;
const requestIds: number[] = [];
const videoIds: string[] = [];

function shiftLocal(local: string, minutes: number): string {
  const [date, time] = local.split(" ");
  const epoch = Date.parse(`${date}T${time}:00Z`) + minutes * 60_000;
  return new Date(epoch).toISOString().slice(0, 16).replace("T", " ");
}

// Each test gets its own future slot so bookings from earlier tests never overlap it.
let slot = 0;
function nextStart(): Date {
  slot += 1;
  return new Date(Math.ceil((Date.now() + (24 + slot * 6) * HOUR) / HOUR) * HOUR);
}

async function createSession(academyId: number, startsAt: Date, location = "Home pitch", endsAt = new Date(startsAt.getTime() + HOUR)) {
  const [session] = await db.insert(academySessionsTable).values({
    academyId, type: "training", startsAt, endsAt, location,
  }).returning();
  return session;
}

async function createRequest(values: Partial<typeof footageRequestsTable.$inferInsert> & { startLocal: string; endLocal: string }) {
  const [created] = await db.insert(footageRequestsTable).values({
    fieldId, cameraId, requestedBy: userId, requestedSeconds: 3600, status: "scheduled", ...values,
  }).returning();
  requestIds.push(created.id);
  return created;
}

async function sessionRow(id: number) {
  const [row] = await db.select().from(academySessionsTable).where(eq(academySessionsTable.id, id));
  return row;
}

async function requestsForCamera() {
  return db.select().from(footageRequestsTable).where(eq(footageRequestsTable.cameraId, cameraId));
}

function postedJobs() {
  return vi.mocked(controlFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
}

beforeAll(async () => {
  const [user] = await db.insert(usersTable).values({ name: `Coach ${tag}`, email: `coach-${tag}@test.local` }).returning({ id: usersTable.id });
  userId = user.id;
  const [field] = await db.insert(fieldsTable).values({ name: `Field ${tag}`, cameraId }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const academies = await db.insert(academiesTable).values([
    { name: `Academy A ${tag}`, fieldId }, { name: `Academy B ${tag}`, fieldId },
  ]).returning({ id: academiesTable.id });
  [academyA, academyB] = academies.map(({ id }) => id);
});

beforeEach(() => {
  vi.mocked(controlFetch).mockReset();
  vi.mocked(controlFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, status: 200, body: { job_id: `job-${Math.random()}`, status: "scheduled" } } as never;
    if (init?.method === "DELETE") return { ok: true, status: 200, body: { cancelled: true } } as never;
    return { ok: true, status: 200, body: { hours: [] } } as never;
  });
});

afterAll(async () => {
  if (academyA || academyB) await db.delete(academiesTable).where(inArray(academiesTable.id, [academyA, academyB].filter(Boolean)));
  const all = await requestsForCamera();
  if (all.length) await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, all.map(({ id }) => id)));
  if (videoIds.length) await db.delete(recordingsTable).where(inArray(recordingsTable.videoUrl, videoIds.map(getBunnyPlaybackUrl)));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("academy session footage booking", () => {
  it("books a free camera job for an upcoming home session with no overlap", async () => {
    const session = await createSession(academyA, nextStart());
    await bookAcademySessionFootage(academyA, session.id, userId);
    const saved = await sessionRow(session.id);
    expect(saved.footageRequestId).not.toBeNull();
    const [request] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, saved.footageRequestId!));
    expect(request).toMatchObject({ academyId: academyA, rateFils: 0, cameraId });
    expect(postedJobs()).toHaveLength(1);
  });

  it("refuses a slot an unpaid player booking holds and never starts a second camera job", async () => {
    const session = await createSession(academyA, nextStart());
    const window = academyFootageWindow(session.startsAt, session.endsAt);
    const player = await createRequest({ startLocal: window.startLocal, endLocal: window.endLocal, status: "awaiting_payment", academyId: null });
    await bookAcademySessionFootage(academyA, session.id, userId);
    const saved = await sessionRow(session.id);
    expect(saved.footageRequestId).toBeNull();
    expect(saved.footageNote).toBe(CAMERA_BOOKED_ELSEWHERE_NOTE);
    expect(postedJobs()).toHaveLength(0);
    expect((await requestsForCamera()).filter((row) => row.startLocal === window.startLocal).map(({ id }) => id)).toEqual([player.id]);
  });

  it("does not reuse another academy's or a player's scheduled booking", async () => {
    for (const academyId of [academyB, null]) {
      const session = await createSession(academyA, nextStart());
      const window = academyFootageWindow(session.startsAt, session.endsAt);
      await createRequest({ startLocal: shiftLocal(window.startLocal, -30), endLocal: shiftLocal(window.endLocal, 30), academyId });
      await bookAcademySessionFootage(academyA, session.id, userId);
      const saved = await sessionRow(session.id);
      expect(saved.footageRequestId).toBeNull();
      expect(saved.footageNote).toBe(CAMERA_BOOKED_ELSEWHERE_NOTE);
    }
    expect(postedJobs()).toHaveLength(0);
  });

  it("reuses only this academy's booking that fully contains the session", async () => {
    const session = await createSession(academyA, nextStart());
    const window = academyFootageWindow(session.startsAt, session.endsAt);
    const own = await createRequest({ startLocal: shiftLocal(window.startLocal, -30), endLocal: shiftLocal(window.endLocal, 30), academyId: academyA });
    await bookAcademySessionFootage(academyA, session.id, userId);
    expect((await sessionRow(session.id)).footageRequestId).toBe(own.id);

    const partial = await createSession(academyA, nextStart());
    const partialWindow = academyFootageWindow(partial.startsAt, partial.endsAt);
    await createRequest({ startLocal: shiftLocal(partialWindow.startLocal, 30), endLocal: shiftLocal(partialWindow.endLocal, 30), academyId: academyA });
    await bookAcademySessionFootage(academyA, partial.id, userId);
    const saved = await sessionRow(partial.id);
    expect(saved.footageRequestId).toBeNull();
    expect(saved.footageNote).toBe(CAMERA_BOOKED_BY_ACADEMY_NOTE);
    expect(postedJobs()).toHaveLength(0);
  });

  it("drops a stale link to someone else's booking instead of keeping it", async () => {
    const session = await createSession(academyA, nextStart());
    const window = academyFootageWindow(session.startsAt, session.endsAt);
    const player = await createRequest({ startLocal: window.startLocal, endLocal: window.endLocal, academyId: null });
    await db.update(academySessionsTable).set({ footageRequestId: player.id }).where(eq(academySessionsTable.id, session.id));
    await bookAcademySessionFootage(academyA, session.id, userId);
    const saved = await sessionRow(session.id);
    expect(saved.footageRequestId).toBeNull();
    expect(saved.footageNote).toBe(CAMERA_BOOKED_ELSEWHERE_NOTE);
  });

  it("does not book a past session or an away match", async () => {
    const past = await createSession(academyA, new Date(Date.now() - 3 * HOUR));
    await bookAcademySessionFootage(academyA, past.id, userId);
    expect(await sessionRow(past.id)).toMatchObject({ footageRequestId: null, footageNote: PAST_SESSION_NOTE });

    const away = await createSession(academyA, nextStart(), "Away at North Academy");
    await bookAcademySessionFootage(academyA, away.id, userId);
    expect(await sessionRow(away.id)).toMatchObject({ footageRequestId: null, footageNote: AWAY_SESSION_NOTE });
    expect(postedJobs()).toHaveLength(0);
    expect(vi.mocked(controlFetch)).not.toHaveBeenCalled();
  });

  it("recognises away locations without matching ordinary place names", () => {
    expect(isAwayLocation("Away")).toBe(true);
    expect(isAwayLocation("away @ Al Wehdat")).toBe(true);
    expect(isAwayLocation("مباراة خارج الأرض")).toBe(true);
    expect(isAwayLocation("Hideaway Park")).toBe(false);
    expect(isAwayLocation("Main pitch")).toBe(false);
  });
});

describe("academy session deletion", () => {
  it("cancels this academy's running camera job on vps1", async () => {
    for (const status of ["queued", "running", "recording", "scheduled"]) {
      const session = await createSession(academyA, nextStart());
      const window = academyFootageWindow(session.startsAt, session.endsAt);
      const own = await createRequest({ startLocal: window.startLocal, endLocal: window.endLocal, academyId: academyA, status, vpsJobId: `job-${status}` });
      await db.update(academySessionsTable).set({ footageRequestId: own.id }).where(eq(academySessionsTable.id, session.id));
      await cancelScheduledAcademyFootageForSession(academyA, session.id);
      const [after] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, own.id));
      expect(after.status).toBe("cancelled");
      expect(vi.mocked(controlFetch)).toHaveBeenCalledWith(
        `/record-hq/${cameraId}/job-${status}`, { method: "DELETE" }, 30_000,
      );
    }
  });

  it("leaves a booking that belongs to someone else or is shared with another session", async () => {
    const session = await createSession(academyA, nextStart());
    const window = academyFootageWindow(session.startsAt, session.endsAt);
    const foreign = await createRequest({ startLocal: window.startLocal, endLocal: window.endLocal, academyId: null, status: "running", vpsJobId: "job-foreign" });
    await db.update(academySessionsTable).set({ footageRequestId: foreign.id }).where(eq(academySessionsTable.id, session.id));
    await cancelScheduledAcademyFootageForSession(academyA, session.id);

    const shared = await createRequest({ startLocal: shiftLocal(window.startLocal, 120), endLocal: shiftLocal(window.endLocal, 120), academyId: academyA, status: "recording", vpsJobId: "job-shared" });
    const first = await createSession(academyA, nextStart());
    const second = await createSession(academyA, nextStart());
    await db.update(academySessionsTable).set({ footageRequestId: shared.id }).where(inArray(academySessionsTable.id, [first.id, second.id]));
    await cancelScheduledAcademyFootageForSession(academyA, first.id);

    const rows = await db.select().from(footageRequestsTable).where(inArray(footageRequestsTable.id, [foreign.id, shared.id]));
    expect(rows.map(({ status }) => status).sort()).toEqual(["recording", "running"]);
    expect(vi.mocked(controlFetch)).not.toHaveBeenCalled();
  });
});

describe("attachAcademyRecordingsForFootageRequest", () => {
  it("attaches only to sessions of the request's own academy", async () => {
    const start = nextStart();
    const window = academyFootageWindow(start, new Date(start.getTime() + HOUR));
    const own = await createRequest({ startLocal: window.startLocal, endLocal: window.endLocal, academyId: academyA, status: "ready" });
    const sessionA = await createSession(academyA, start);
    const sessionB = await createSession(academyB, start);
    await db.update(academySessionsTable).set({ footageRequestId: own.id }).where(inArray(academySessionsTable.id, [sessionA.id, sessionB.id]));
    const videoId = `video-own-${tag}`;
    videoIds.push(videoId);
    await attachAcademyRecordingsForFootageRequest(own, videoId, 3600);
    const links = await db.select().from(academyRecordingsTable)
      .where(inArray(academyRecordingsTable.sessionId, [sessionA.id, sessionB.id]));
    expect(links.map(({ academyId, sessionId }) => ({ academyId, sessionId }))).toEqual([{ academyId: academyA, sessionId: sessionA.id }]);
  });

  it("never attaches a player's or owner's booking to any academy", async () => {
    const start = nextStart();
    const window = academyFootageWindow(start, new Date(start.getTime() + HOUR));
    const player = await createRequest({ startLocal: window.startLocal, endLocal: window.endLocal, academyId: null, status: "ready" });
    const session = await createSession(academyA, start);
    await db.update(academySessionsTable).set({ footageRequestId: player.id }).where(eq(academySessionsTable.id, session.id));
    const videoId = `video-player-${tag}`;
    videoIds.push(videoId);
    await attachAcademyRecordingsForFootageRequest(player, videoId, 3600);
    expect(await db.select().from(academyRecordingsTable).where(eq(academyRecordingsTable.sessionId, session.id))).toEqual([]);
    expect(await db.select().from(recordingsTable).where(eq(recordingsTable.videoUrl, getBunnyPlaybackUrl(videoId)))).toEqual([]);
  });
});
