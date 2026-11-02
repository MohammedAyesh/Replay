import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyMatchPlayerStatsTable,
  academyMembersTable,
  academyPlayerGuardiansTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  analysisJobsTable,
  db,
  fieldsTable,
  recordingsTable,
  usersTable,
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

// The pipeline's roster for the test video: #7 and #10 read, one player without a number.
const ROSTER = {
  v: 1 as const,
  players: [
    { id: "p1", name: null, number: "7", minutes: 40, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "s0:t1", fromFrame: 0, toFrame: 1000 }] },
    { id: "p2", name: null, number: "10", minutes: 38, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "s0:t2", fromFrame: 0, toFrame: 900 }] },
    { id: "p3", name: null, number: null, minutes: 30, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "s0:t3", fromFrame: 0, toFrame: 800 }] },
  ],
};
let analysed = false;

vi.mock("../lib/academyMatchStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/academyMatchStats")>();
  return {
    ...actual,
    latestBundle: vi.fn(async () => (analysed ? { id: 99, manifest: { matchRosterPath: "x", segments: [], duration: 3600 } } : null)),
    loadMatchRoster: vi.fn(async () => (analysed ? ROSTER : null)),
    goalVoteCount: vi.fn(async () => 0),
    computeAcademyMatchStats: vi.fn(async (_recordingId: number, _roster: unknown, bindings: Array<{ playerId: number; rosterPlayerId: string }>) => ({
      available: true,
      hasBall: true,
      hasPitch: true,
      team: null,
      players: bindings.map((b, i) => ({
        playerId: b.playerId, rosterPlayerId: b.rosterPlayerId, minutes: 40 - i, distanceKm: 3.1 + i, topSpeedKmh: 22, touches: 30 + i,
        passesTried: 10, passesCompleted: 8, passesReceived: 7, dribbles: 2, dribblesWon: 1, dribblesLost: 1, shots: 1, goals: 0,
      })),
    })),
  };
});
vi.mock("./claimMatch", () => ({
  rosterInsideMatchWindow: (roster: unknown) => roster,
  rosterPlayersWithPhotos: async (_m: unknown, roster: typeof ROSTER) => roster.players.map((p) => ({ ...p, photos: [] })),
}));

import matchesRouter from "./academyMatches";
import { resolveBindings } from "../lib/academyMatchStats";

const tag = `am_${Date.now()}`;
let app: Express;
let ownerId: number;
let coachId: number;
let parentId: number;
let strangerId: number;
let fieldId: number;
let academyId: number;
let squadId: number;
let ali: number;
let omar: number;
let zaid: number;
let sessionId: number;
let recordingId: number;

const auth = (id: number) => ({ "x-test-user": String(id) });
const base = () => `/api/academy/console/academies/${academyId}/matches/${sessionId}`;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", matchesRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-${tag}@test.local` },
    { name: `Parent ${tag}`, email: `parent-${tag}@test.local` },
    { name: `Stranger ${tag}`, email: `stranger-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, parentId, strangerId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `AM field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `AM Academy ${tag}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U12" }).returning({ id: academySquadsTable.id });
  squadId = squad.id;
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
  const players = await db.insert(academyPlayersTable).values([
    { academyId, squadId, name: "Ali", jerseyNumber: 7 },
    { academyId, squadId, name: "Omar", jerseyNumber: 10 },
    { academyId, squadId, name: "Zaid" },
  ]).returning({ id: academyPlayersTable.id });
  [ali, omar, zaid] = players.map((p) => p.id);
  await db.insert(academyPlayerGuardiansTable).values({ playerId: ali, userId: parentId, addedBy: "owner" });
  const [session] = await db.insert(academySessionsTable).values({
    academyId, squadId, type: "match", opponent: "Rivals", ownScore: 3, opponentScore: 1,
    startsAt: new Date(Date.now() - 86_400_000), location: "Pitch 1",
  }).returning({ id: academySessionsTable.id });
  sessionId = session.id;
  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "Pitch 1", date: "2026-11-01", timeSlot: "17:00–18:00", duration: "60 min",
    videoUrl: "https://vz-test.b-cdn.net/12345678-1234-1234-1234-123456789012/playlist.m3u8", isVisible: false,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(academyRecordingsTable).values({ academyId, recordingId, sessionId });
});

beforeEach(() => { analysed = false; });

afterAll(async () => {
  if (recordingId) await db.delete(analysisJobsTable).where(eq(analysisJobsTable.recordingId, recordingId));
  if (academyId) await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  if (recordingId) await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [ownerId, coachId, parentId, strangerId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("resolveBindings", () => {
  const row = (playerId: number, shirtNumber: number | null, extra: Partial<{ inSquad: boolean; rosterPlayerId: string | null; boundBy: string | null }> = {}) =>
    ({ playerId, shirtNumber, inSquad: true, rosterPlayerId: null, boundBy: null, ...extra });

  it("matches shirt numbers, lets a hand pick win, and leaves duplicates for the owner", () => {
    expect(resolveBindings([row(1, 7), row(2, 10), row(3, null)], ROSTER).map((b) => [b.playerId, b.rosterPlayerId, b.how]))
      .toEqual([[1, "p1", "number"], [2, "p2", "number"]]);
    // Owner says player 3 is p1: player 1 no longer gets p1 by number.
    expect(resolveBindings([row(1, 7), row(3, null, { rosterPlayerId: "p1", boundBy: "owner" })], ROSTER).map((b) => [b.playerId, b.rosterPlayerId]))
      .toEqual([[3, "p1"]]);
    // Owner says player 1 isn't in the video.
    expect(resolveBindings([row(1, 7, { boundBy: "owner" })], ROSTER)).toEqual([]);
    // Two squad players wearing 7: nobody is guessed.
    expect(resolveBindings([row(1, 7), row(2, 7)], ROSTER)).toEqual([]);
    // Benched players are not matched by number.
    expect(resolveBindings([row(1, 7, { inSquad: false })], ROSTER)).toEqual([]);
  });
});

describe("academy matches", () => {
  it("lists the match for members only", async () => {
    await request(app).get(`/api/academy/console/academies/${academyId}/matches`).set(auth(strangerId)).expect(403);
    const list = await request(app).get(`/api/academy/console/academies/${academyId}/matches`).set(auth(coachId)).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: sessionId, hasVideo: true, opponent: "Rivals", published: false })]);
  });

  it("starts the lineup from the squad and usual numbers, and saves match numbers", async () => {
    const detail = await request(app).get(base()).set(auth(coachId)).expect(200);
    expect(detail.body.lineup.map((p: { name: string; shirtNumber: number | null }) => [p.name, p.shirtNumber]))
      .toEqual([["Ali", 7], ["Omar", 10], ["Zaid", null]]);
    expect(detail.body.analysis).toMatchObject({ hasVideo: true, analysed: false });

    await request(app).put(`${base()}/lineup`).set(auth(coachId))
      .send({ players: [{ playerId: ali, shirtNumber: 9, inSquad: true }, { playerId: zaid, shirtNumber: 9, inSquad: true }] }).expect(400);
    await request(app).put(`${base()}/lineup`).set(auth(coachId)).send({
      rememberNumbers: true,
      players: [{ playerId: ali, shirtNumber: 7, inSquad: true }, { playerId: omar, shirtNumber: 10, inSquad: true }, { playerId: zaid, shirtNumber: 4, inSquad: true }],
    }).expect(200);
    const [z] = await db.select().from(academyPlayersTable).where(eq(academyPlayersTable.id, zaid));
    expect(z.jerseyNumber).toBe(4);
  });

  it("queues analysis for the owner only, once, with the lineup as hints", async () => {
    await request(app).post(`${base()}/analyse`).set(auth(coachId)).expect(403);
    const queued = await request(app).post(`${base()}/analyse`).set(auth(ownerId)).send({}).expect(201);
    const [job] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.id, queued.body.jobId));
    expect(job).toMatchObject({ recordingId, status: "queued" });
    const hints = (job.params as { rosterHints: { teams: Array<{ shirtNumbers: number[]; name: string | null }> } }).rosterHints;
    expect(hints.teams[0].shirtNumbers).toEqual([4, 7, 10]);
    expect(hints.teams[1].name).toBe("Rivals");
    await request(app).post(`${base()}/analyse`).set(auth(ownerId)).send({}).expect(409);
    await db.update(analysisJobsTable).set({ status: "succeeded" }).where(eq(analysisJobsTable.id, job.id));
  });

  it("matches detected players by number, takes hand picks, and keeps per-player stats", async () => {
    analysed = true;
    const detail = await request(app).get(base()).set(auth(ownerId)).expect(200);
    expect(detail.body.detected.map((d: { id: string }) => d.id)).toEqual(["p1", "p2", "p3"]);
    const bound = Object.fromEntries(detail.body.lineup.map((p: { name: string; boundTo: string | null }) => [p.name, p.boundTo]));
    expect(bound).toEqual({ Ali: "p1", Omar: "p2", Zaid: null });
    expect(detail.body.stats.players).toHaveLength(2);

    await request(app).put(`${base()}/players/${zaid}/binding`).set(auth(coachId)).send({ rosterPlayerId: "p3" }).expect(200);
    const again = await request(app).get(base()).set(auth(ownerId)).expect(200);
    expect(again.body.stats.players.map((p: { playerId: number }) => p.playerId).sort()).toEqual([ali, omar, zaid].sort());
    const rows = await db.select().from(academyMatchPlayerStatsTable).where(eq(academyMatchPlayerStatsTable.sessionId, sessionId));
    expect(rows).toHaveLength(3);

    const compare = await request(app).get(`/api/academy/console/academies/${academyId}/player-stats`).set(auth(coachId)).expect(200);
    expect(compare.body.filter((r: { playerId: number }) => r.playerId === zaid)[0].stats).toMatchObject({ rosterPlayerId: "p3" });
  });

  it("shows parents the page only once published, and only their academy's families", async () => {
    analysed = true;
    await request(app).get(`/api/academy/family/matches/${sessionId}`).set(auth(parentId)).expect(404);
    await request(app).put(base()).set(auth(coachId)).send({ published: true }).expect(403);
    await request(app).put(base()).set(auth(ownerId)).send({ published: true }).expect(200);
    const page = await request(app).get(`/api/academy/family/matches/${sessionId}`).set(auth(parentId)).expect(200);
    expect(page.body.session).toMatchObject({ opponent: "Rivals", ownScore: 3 });
    expect(page.body.players.find((p: { playerId: number }) => p.playerId === ali)).toMatchObject({ mine: true, shirtNumber: 7 });
    expect(page.body.players.find((p: { playerId: number }) => p.playerId === ali).stats).toMatchObject({ distanceKm: expect.any(Number) });
    await request(app).get(`/api/academy/family/matches/${sessionId}`).set(auth(strangerId)).expect(404);

    const list = await request(app).get("/api/academy/family/matches").set(auth(parentId)).expect(200);
    expect(list.body.map((m: { id: number }) => m.id)).toEqual([sessionId]);
    const child = await request(app).get(`/api/academy/family/players/${ali}/match-stats`).set(auth(parentId)).expect(200);
    expect(child.body.matches).toHaveLength(1);
    expect(child.body.matches[0].squad).toHaveLength(3);
    await request(app).get(`/api/academy/family/players/${omar}/match-stats`).set(auth(parentId)).expect(404);
  });
});
