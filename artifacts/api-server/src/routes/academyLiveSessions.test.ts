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

async function setBooking(startDelta: number, endDelta: number) {
  if (requestId) await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  const [booking] = await db.insert(footageRequestsTable).values({
    fieldId, academyId, cameraId: "camera1", requestedBy: memberId,
    startLocal: local(Date.now() + startDelta), endLocal: local(Date.now() + endDelta),
    requestedSeconds: 3600, status: "scheduled",
  }).returning({ id: footageRequestsTable.id });
  requestId = booking.id;
  await db.update(academySessionsTable).set({ footageRequestId: requestId }).where(eq(academySessionsTable.id, sessionId));
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
  it("hands out vps1's Bunny VAR copy when live, and nothing when the feed is stale", async () => {
    await setBooking(-30 * 60_000, 30 * 60_000);
    const cdnUrl = "https://replayjo.b-cdn.net/var/cam1/0123456789abcdef0123456789abcdef/index.m3u8";
    const vps1 = (live: boolean, url: unknown = cdnUrl) => vi.mocked(controlFetch).mockImplementation(async (path: string) => (
      String(path).endsWith("/window")
        ? { ok: true, status: 200, body: { variants: { hls: { live, newestAgeSec: live ? 2 : 3600 } } } }
        : { ok: true, status: 200, body: { cdnUrl: url } }
    ) as never);
    vps1(true);
    const live = await request(app).get(consoleStatus()).set(auth(memberId)).expect(200);
    expect(live.body.status).toBe("live");
    expect(live.body.playlistPath).toBe(cdnUrl);
    expect(JSON.stringify(live.body)).not.toContain(secret);
    const family = await request(app).get(familyStatus()).set(auth(guardianId)).expect(200);
    expect(family.body.playlistPath).toBe(cdnUrl);
    expect(vi.mocked(controlFetch).mock.calls.every(([url]) => !String(url).includes(secret))).toBe(true);

    vps1(false);
    const stale = (await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body;
    expect(stale.status).toBe("not_live");
    expect(stale.playlistPath).toBeNull();

    // Anything but the exact published Bunny shape is never handed to a browser.
    vps1(true, "http://169.58.73.17:8080/var/cam1/hls/playlist.m3u8");
    const odd = (await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body;
    expect(odd.status).toBe("not_live");
    expect(odd.playlistPath).toBeNull();
    vi.mocked(controlFetch).mockReset();
  });

  it("hands out the ball-follow view for matches only", async () => {
    await setBooking(-30 * 60_000, 30 * 60_000);
    const cdnUrl = "https://replayjo.b-cdn.net/var/cam1/0123456789abcdef0123456789abcdef/index.m3u8";
    const panCdnUrl = "https://replayjo.b-cdn.net/var/cam1/0123456789abcdef0123456789abcdef/pan/index.m3u8";
    vi.mocked(controlFetch).mockImplementation(async (path: string) => (
      String(path).endsWith("/window")
        ? { ok: true, status: 200, body: { variants: { hls: { live: true, newestAgeSec: 2 } } } }
        : { ok: true, status: 200, body: { cdnUrl, panCdnUrl } }
    ) as never);
    const training = (await request(app).get(consoleStatus()).set(auth(memberId)).expect(200)).body;
    expect(training.sessionType).toBe("training");
    expect(training.panPlaylistPath).toBeNull();
    expect(training.panAvailable).toBe(false);

    await db.update(academySessionsTable).set({ type: "match" }).where(eq(academySessionsTable.id, sessionId));
    try {
      const match = (await request(app).get(familyStatus()).set(auth(guardianId)).expect(200)).body;
      expect(match.sessionType).toBe("match");
      expect(match.playlistPath).toBe(cdnUrl);
      expect(match.panPlaylistPath).toBe(panCdnUrl);
      expect(match.panAvailable).toBe(true);
    } finally {
      await db.update(academySessionsTable).set({ type: "training" }).where(eq(academySessionsTable.id, sessionId));
      vi.mocked(controlFetch).mockReset();
    }
  });

  it("serves only segments the session's trimmed playlist lists", async () => {
    await setBooking(-30 * 60_000, 30 * 60_000);
    const [booking] = await db.select({ startLocal: footageRequestsTable.startLocal })
      .from(footageRequestsTable).where(eq(footageRequestsTable.id, requestId!));
    const startMs = Date.parse(`${booking.startLocal.replace(" ", "T")}:00+03:00`);
    const upstream = [
      "#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:10",
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs - 60_000).toISOString()}`, "#EXTINF:4,", "seg/before.ts",
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs + 60_000).toISOString()}`, "#EXTINF:4,", "seg/after.ts", "",
    ].join("\n");
    const segBase = `/api/academy/family/sessions/${sessionId}/live/seg`;
    vi.mocked(controlResponse).mockResolvedValueOnce(new Response(upstream) as never);
    await request(app).get(`${segBase}/before.ts`).set(auth(guardianId)).expect(404);
    expect(vi.mocked(controlResponse).mock.calls.some(([url]) => String(url).includes("/seg/"))).toBe(false);
    vi.mocked(controlResponse).mockResolvedValueOnce(new Response(upstream) as never);
    await request(app).get(`${segBase}/unknown.ts`).set(auth(guardianId)).expect(404);
    vi.mocked(controlResponse)
      .mockResolvedValueOnce(new Response(upstream) as never)
      .mockResolvedValueOnce(new Response("segment-bytes", { headers: { "content-type": "video/mp2t" } }) as never);
    const ok = await request(app).get(`${segBase}/after.ts`).set(auth(guardianId)).expect(200);
    expect(ok.headers["content-type"]).toContain("video/mp2t");
    expect(String(vi.mocked(controlResponse).mock.calls.at(-1)?.[0])).toBe("/var/cam1/hls/seg/after.ts");
  });

  it("returns 404 for playlist requests outside the booking window", async () => {
    await setBooking(60 * 60_000, 2 * 60 * 60_000);
    await request(app).get(`/api/academy/console/academies/${academyId}/sessions/${sessionId}/live/playlist.m3u8`)
      .set(auth(memberId)).expect(404);
  });
});
