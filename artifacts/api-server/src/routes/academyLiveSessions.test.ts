import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academyMembersTable, academyPlayerGuardiansTable, academyPlayersTable, academySessionsTable,
  academySquadsTable, academiesTable, db, fieldsTable, footageRequestsTable, usersTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }),
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));
vi.mock("./contabo", () => ({ controlFetch: vi.fn(), controlResponse: vi.fn() }));

import liveRouter from "./academyLiveSessions";
import { controlFetch, controlResponse } from "./contabo";

const tag = `academy_live_${Date.now()}`;
const secret = "private-control-key";
let app: Express;
let memberId: number;
let guardianId: number;
let otherGuardianId: number;
let fieldId: number;
let academyId: number;
let unrelatedAcademyId: number;
let squadId: number;
let otherSquadId: number;
let sessionId: number;
let requestId: number | null = null;

function local(ms: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function auth(id: number) { return { "x-test-user": String(id) }; }
const consoleStatus = () => `/api/academy/console/academies/${academyId}/sessions/${sessionId}/live/status`;
const familyStatus = () => `/api/academy/family/sessions/${sessionId}/live/status`;

async function setBooking(startDelta: number, endDelta: number, bookingAcademyId: number | null = academyId) {
  if (requestId) await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  const [booking] = await db.insert(footageRequestsTable).values({
    fieldId, academyId: bookingAcademyId, cameraId: "camera1", requestedBy: memberId,
    startLocal: local(Date.now() + startDelta), endLocal: local(Date.now() + endDelta),
    requestedSeconds: 3600, status: "scheduled",
  }).returning({ id: footageRequestsTable.id });
  requestId = booking.id;
  await db.update(academySessionsTable).set({
    startsAt: new Date(Date.now() + startDelta),
    endsAt: new Date(Date.now() + endDelta),
    footageRequestId: requestId,
  }).where(eq(academySessionsTable.id, sessionId));
}

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", liveRouter);
  const users = await db.insert(usersTable).values([
    { name: `Member ${tag}`, email: `member-${tag}@test.local` },
    { name: `Guardian ${tag}`, email: `guardian-${tag}@test.local` },
    { name: `Other guardian ${tag}`, email: `other-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [memberId, guardianId, otherGuardianId] = users.map(({ id }) => id);
  const [field] = await db.insert(fieldsTable).values({ name: `Live field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `Live academy ${tag}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  const [unrelatedAcademy] = await db.insert(academiesTable).values({ name: `Other live academy ${tag}`, fieldId }).returning({ id: academiesTable.id });
  unrelatedAcademyId = unrelatedAcademy.id;
  const squads = await db.insert(academySquadsTable).values([
    { academyId, name: `Squad A ${tag}` }, { academyId, name: `Squad B ${tag}` },
  ]).returning({ id: academySquadsTable.id });
  [squadId, otherSquadId] = squads.map(({ id }) => id);
  await db.insert(academyMembersTable).values({ academyId, userId: memberId, role: "owner" });
  const players = await db.insert(academyPlayersTable).values([
    { academyId, squadId, name: `Player A ${tag}` },
    { academyId, squadId: otherSquadId, name: `Player B ${tag}` },
  ]).returning({ id: academyPlayersTable.id });
  await db.insert(academyPlayerGuardiansTable).values([
    { playerId: players[0].id, userId: guardianId, addedBy: "owner" },
    { playerId: players[1].id, userId: otherGuardianId, addedBy: "owner" },
  ]);
  const [session] = await db.insert(academySessionsTable).values({
    academyId, squadId, type: "training", startsAt: new Date(), endsAt: new Date(Date.now() + 60 * 60_000), location: "Test pitch",
  }).returning({ id: academySessionsTable.id });
  sessionId = session.id;
});

beforeEach(() => {
  vi.mocked(controlFetch).mockReset();
  vi.mocked(controlResponse).mockReset();
});

afterAll(async () => {
  if (requestId) await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  if (academyId) await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  if (unrelatedAcademyId) await db.delete(academiesTable).where(eq(academiesTable.id, unrelatedAcademyId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [memberId, guardianId, otherGuardianId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("academy live session access and status", () => {
  it("allows an academy member and reports a session without a booking", async () => {
    const response = await request(app).get(consoleStatus()).set(auth(memberId)).expect(200);
    expect(response.body.status).toBe("no_booking");
  });
  it("allows a guardian in the session squad and hides another squad's session", async () => {
    await request(app).get(familyStatus()).set(auth(guardianId)).expect(200);
    await request(app).get(familyStatus()).set(auth(otherGuardianId)).expect(404);
  });
  it("returns an authentication failure when signed out", async () => {
    const response = await request(app).get(familyStatus());
    expect([401, 404]).toContain(response.status);
  });
  it("reports upcoming and ended booking windows", async () => {
    await setBooking(60 * 60_000, 2 * 60 * 60_000);
    expect((await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body.status).toBe("upcoming");
    await setBooking(-3 * 60 * 60_000, -2 * 60 * 60_000);
    expect((await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body.status).toBe("ended");
  });
  it("does not expose an unrelated player or academy booking as this session's live feed", async () => {
    await setBooking(-30 * 60_000, 30 * 60_000, null);
    expect((await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body.status).toBe("no_booking");
    await setBooking(-30 * 60_000, 30 * 60_000, unrelatedAcademyId);
    expect((await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body.status).toBe("no_booking");
  });
  it("distinguishes a fresh live playlist from a stale one without exposing control credentials", async () => {
    await setBooking(-30 * 60_000, 30 * 60_000);
    const playlist = (pdt: string) => `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PROGRAM-DATE-TIME:${pdt}\n#EXTINF:4,\nseg/a.ts\n`;
    vi.mocked(controlFetch).mockResolvedValueOnce({ ok: true, status: 200, body: playlist(new Date().toISOString()) } as never);
    const live = await request(app).get(consoleStatus()).set(auth(memberId)).expect(200);
    expect(live.body.status).toBe("live");
    expect(live.body.playlistPath).toBe(`/api/academy/console/academies/${academyId}/sessions/${sessionId}/live/playlist.m3u8`);
    expect(JSON.stringify(live.body)).not.toContain(secret);
    expect(live.body.playlistPath).not.toContain(secret);
    vi.mocked(controlFetch).mockResolvedValueOnce({ ok: true, status: 200, body: playlist(new Date(Date.now() - 60 * 60_000).toISOString()) } as never);
    expect((await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body.status).toBe("not_live");
    expect(vi.mocked(controlFetch).mock.calls.every(([url]) => !String(url).includes(secret))).toBe(true);
  });
  it("rewrites the academy playlist segment URI to the matching API proxy", async () => {
    await setBooking(-30 * 60_000, 30 * 60_000);
    vi.mocked(controlResponse).mockResolvedValueOnce({
      ok: true,
      text: async () => `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}\n#EXTINF:4,\nseg/a.ts\n`,
    } as never);
    const response = await request(app)
      .get(`/api/academy/console/academies/${academyId}/sessions/${sessionId}/live/playlist.m3u8`)
      .set(auth(memberId)).expect(200);
    expect(response.text).toContain(`/api/academy/console/academies/${academyId}/sessions/${sessionId}/live/seg/a.ts`);
    expect(response.text).not.toContain(":academyId");
    expect(response.text).not.toContain(":sessionId");
  });
  it("returns 404 for playlist requests outside the booking window", async () => {
    await setBooking(60 * 60_000, 2 * 60 * 60_000);
    await request(app).get(`/api/academy/console/academies/${academyId}/sessions/${sessionId}/live/playlist.m3u8`)
      .set(auth(memberId)).expect(404);
  });
});
