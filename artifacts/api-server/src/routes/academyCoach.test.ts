import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyMembersTable,
  academyPlayerGuardiansTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
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

// #7 and #10 are read off shirts; p3 has no number. The video starts 1.5 s before the tracking.
const ROSTER = {
  v: 1 as const,
  players: [
    { id: "p1", name: null, number: "7", minutes: 40, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "s0:t1", fromFrame: 0, toFrame: 1000 }] },
    { id: "p2", name: null, number: "10", minutes: 38, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "s0:t2", fromFrame: 0, toFrame: 900 }] },
    { id: "p3", name: null, number: null, minutes: 30, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "s0:t3", fromFrame: 0, toFrame: 800 }] },
  ],
};
const MANIFEST = { matchRosterPath: "x", segments: [], duration: 3600, videoStartSeconds: 1.5, width: 3840, height: 1080, frameRate: 20 };
const boxesFor = (x: number) => Array.from({ length: 200 }, (_, f) => ({ frame: f * 5, x: x + f, y: 500, w: 40, h: 100 }));
const SEGMENTS = [{ tracks: [
  { id: "s0:t1", boxes: boxesFor(1000) },
  { id: "s0:t2", boxes: boxesFor(2000) },
  { id: "s0:t3", boxes: boxesFor(3000) },
] }];

vi.mock("../lib/academyMatchStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/academyMatchStats")>();
  return {
    ...actual,
    latestBundle: vi.fn(async () => ({ id: 99, manifest: MANIFEST })),
    loadMatchRoster: vi.fn(async () => ROSTER),
    goalVoteCount: vi.fn(async () => 0),
  };
});
vi.mock("./claimMatch", () => ({
  rosterInsideMatchWindow: (roster: unknown) => roster,
  rosterPlayersWithPhotos: async (_m: unknown, roster: typeof ROSTER) => roster.players.map((p) => ({ ...p, photos: [] })),
}));
vi.mock("../lib/matchPlayLoad", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/matchPlayLoad")>();
  return { ...actual, loadRecordingPlay: vi.fn(async () => ({ manifest: MANIFEST, fps: 20, segments: SEGMENTS })) };
});
vi.mock("../lib/creative/framing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/creative/framing")>();
  return { ...actual, recordingBall: vi.fn(async () => [[2, 0.5, 0.5], [3, 0.6, 0.5], [50, 0.1, 0.1]] as Array<[number, number, number]>) };
});

import coachRouter from "./academyCoach";

const tag = `ac_${Date.now()}`;
let app: Express;
let ownerId: number;
let coachId: number;
let coach2Id: number;
let parentId: number;
let strangerId: number;
let fieldId: number;
let academyId: number;
let otherAcademyId: number;
let ali: number;
let omar: number;
let foreignPlayer: number;
let sessionId: number;
let recordingId: number;

const auth = (id: number) => ({ "x-test-user": String(id) });
const base = () => `/api/academy/console/academies/${academyId}/matches/${sessionId}/coach`;
const board = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  shapes: [{ id: "a1", kind: "arrow", color: "#D4FF4F", atMs: 5000, width: 4, from: [0.2, 0.5], to: [0.4, 0.5] }],
  spotlights: [{ rosterId: "p1", color: "#2FD8C4" }, { rosterId: "nobody", color: "#FF5A3C" }],
  ...extra,
});

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", coachRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-${tag}@test.local` },
    { name: `Coach2 ${tag}`, email: `coach2-${tag}@test.local` },
    { name: `Parent ${tag}`, email: `parent-${tag}@test.local` },
    { name: `Stranger ${tag}`, email: `stranger-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, coach2Id, parentId, strangerId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `AC field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `AC Academy ${tag}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  const [other] = await db.insert(academiesTable).values({ name: `AC Other ${tag}`, fieldId }).returning({ id: academiesTable.id });
  otherAcademyId = other.id;
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U12" }).returning({ id: academySquadsTable.id });
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId, userId: coach2Id, role: "coach" },
  ]);
  const players = await db.insert(academyPlayersTable).values([
    { academyId, squadId: squad.id, name: "Ali", jerseyNumber: 7 },
    { academyId, squadId: squad.id, name: "Omar", jerseyNumber: 10 },
  ]).returning({ id: academyPlayersTable.id });
  [ali, omar] = players.map((p) => p.id);
  const [foreign] = await db.insert(academyPlayersTable).values({ academyId: otherAcademyId, name: "Elsewhere" }).returning({ id: academyPlayersTable.id });
  foreignPlayer = foreign.id;
  await db.insert(academyPlayerGuardiansTable).values({ playerId: ali, userId: parentId, addedBy: "owner" });
  const [session] = await db.insert(academySessionsTable).values({
    academyId, squadId: squad.id, type: "match", opponent: "Rivals", ownScore: 2, opponentScore: 1,
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

afterAll(async () => {
  for (const id of [academyId, otherAcademyId]) if (id) await db.delete(academiesTable).where(eq(academiesTable.id, id));
  if (recordingId) await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [ownerId, coachId, coach2Id, parentId, strangerId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("coach board (staff)", () => {
  it("gives a coach the video, every tracked player (ours named by shirt number first) and no notes yet", async () => {
    const res = await request(app).get(base()).set(auth(coachId));
    expect(res.status).toBe(200);
    expect(res.body.analysed).toBe(true);
    expect(res.body.video).toMatchObject({ recordingId, videoStartSeconds: 1.5, width: 3840, height: 1080, fps: 20, matchWindow: null });
    expect(res.body.players.map((p: { rosterId: string }) => p.rosterId)).toEqual(["p1", "p2", "p3"]);
    expect(res.body.players[0]).toMatchObject({ rosterId: "p1", playerId: ali, name: "Ali", shirtNumber: 7, number: "7" });
    expect(res.body.players[2]).toMatchObject({ rosterId: "p3", playerId: null, name: null });
    expect(res.body.notes).toEqual([]);
  });

  it("refuses someone outside the academy", async () => {
    expect((await request(app).get(base()).set(auth(strangerId))).status).toBe(403);
    expect((await request(app).get(base()).set(auth(parentId))).status).toBe(403);
  });

  it("serves players' boxes as shares on the video's clock, with the ball, for at most two minutes", async () => {
    // Tracking frame 100 (5 s at 20 fps) is video second 6.5.
    const res = await request(app).get(`${base()}/tracks?from=6&to=8`).set(auth(coachId));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.players).sort()).toEqual(["p1", "p2", "p3"]);
    const first = res.body.players.p1[0];
    expect(first[0]).toBeGreaterThanOrEqual(6);
    const at65 = res.body.players.p1.find((b: number[]) => b[0] === 6.5);
    expect(at65).toEqual([6.5, Math.round((1020 / 3840) * 10000) / 10000, Math.round((500 / 1080) * 10000) / 10000, Math.round((40 / 3840) * 10000) / 10000, Math.round((100 / 1080) * 10000) / 10000]);
    expect(res.body.ball).toEqual([]);
    const withBall = await request(app).get(`${base()}/tracks?from=1&to=4`).set(auth(coachId));
    expect(withBall.body.ball).toEqual([[2, 0.5, 0.5], [3, 0.6, 0.5]]);
    expect((await request(app).get(`${base()}/tracks?from=0&to=200`).set(auth(coachId))).status).toBe(400);
    expect((await request(app).get(`${base()}/tracks?from=0&to=10`).set(auth(strangerId))).status).toBe(403);
  });
});

describe("coach notes", () => {
  let noteId: number;

  it("saves a moment, dropping spotlights the analysis doesn't know and players of other academies", async () => {
    const res = await request(app).post(`${base()}/notes`).set(auth(coachId)).send({
      title: "Hold the line", body: "Watch Ali drop too deep here", atMs: 5000, endMs: 13000,
      board: board({ connect: true }), playerIds: [ali, foreignPlayer], shared: false,
    });
    expect(res.status).toBe(201);
    noteId = res.body.note.id;
    expect(res.body.note).toMatchObject({ title: "Hold the line", atMs: 5000, endMs: 13000, playerIds: [ali], shared: false, mine: true });
    expect(res.body.note.board.spotlights).toEqual([{ rosterId: "p1", color: "#2FD8C4" }]);
    expect(res.body.note.board.shapes).toHaveLength(1);
    const list = await request(app).get(base()).set(auth(ownerId));
    expect(list.body.notes).toHaveLength(1);
    expect(list.body.notes[0]).toMatchObject({ id: noteId, mine: false, author: `Coach ${tag}` });
  });

  it("refuses a malformed board", async () => {
    const res = await request(app).post(`${base()}/notes`).set(auth(coachId)).send({ atMs: 1000, board: { v: 1, shapes: [{ kind: "arrow" }], spotlights: [] } });
    expect(res.status).toBe(400);
  });

  it("lets its author and the owner change it, not another coach", async () => {
    expect((await request(app).patch(`${base()}/notes/${noteId}`).set(auth(coach2Id)).send({ title: "Mine now" })).status).toBe(403);
    const own = await request(app).patch(`${base()}/notes/${noteId}`).set(auth(coachId)).send({ title: "Hold the line!" });
    expect(own.status).toBe(200);
    expect(own.body.note.title).toBe("Hold the line!");
    const owner = await request(app).patch(`${base()}/notes/${noteId}`).set(auth(ownerId)).send({ endMs: 4000 });
    // An end before the moment is no end.
    expect(owner.body.note.endMs).toBeNull();
  });

  it("shows a family only shared notes about their own child, with only the spotlighted players' tracks", async () => {
    let feed = await request(app).get("/api/academy/family/coach-notes").set(auth(parentId));
    expect(feed.status).toBe(200);
    expect(feed.body.notes).toEqual([]);
    expect((await request(app).get(`/api/academy/family/coach-notes/${noteId}`).set(auth(parentId))).status).toBe(404);

    await request(app).patch(`${base()}/notes/${noteId}`).set(auth(coachId)).send({ shared: true, endMs: 13000 });
    feed = await request(app).get("/api/academy/family/coach-notes").set(auth(parentId));
    expect(feed.body.notes).toHaveLength(1);
    expect(feed.body.notes[0]).toMatchObject({ id: noteId, sessionId, players: [{ playerId: ali, name: "Ali" }] });

    const one = await request(app).get(`/api/academy/family/coach-notes/${noteId}`).set(auth(parentId));
    expect(one.status).toBe(200);
    expect(one.body.video.recordingId).toBe(recordingId);
    expect(one.body.players.map((p: { rosterId: string }) => p.rosterId)).toEqual(["p1"]);

    const tracks = await request(app).get(`/api/academy/family/coach-notes/${noteId}/tracks?from=0&to=40`).set(auth(parentId));
    expect(tracks.status).toBe(200);
    expect(Object.keys(tracks.body.players)).toEqual(["p1"]);
    // Cut to the note: 3 s before 5.0 s, to 1 s after its end at 13 s.
    const times = tracks.body.players.p1.map((b: number[]) => b[0]);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...times)).toBeLessThanOrEqual(14);
    expect(tracks.body.ball).toEqual([]);

    // A stranger, and a note about another child, stay hidden.
    expect((await request(app).get(`/api/academy/family/coach-notes/${noteId}`).set(auth(strangerId))).status).toBe(404);
    const omarNote = await request(app).post(`${base()}/notes`).set(auth(coachId)).send({ atMs: 9000, board: board(), playerIds: [omar], shared: true });
    feed = await request(app).get("/api/academy/family/coach-notes").set(auth(parentId));
    expect(feed.body.notes.map((n: { id: number }) => n.id)).toEqual([noteId]);
    expect((await request(app).get(`/api/academy/family/coach-notes/${omarNote.body.note.id}`).set(auth(parentId))).status).toBe(404);
  });

  it("deletes for its author", async () => {
    expect((await request(app).delete(`${base()}/notes/${noteId}`).set(auth(coach2Id))).status).toBe(403);
    expect((await request(app).delete(`${base()}/notes/${noteId}`).set(auth(coachId))).status).toBe(204);
    const list = await request(app).get(base()).set(auth(coachId));
    expect(list.body.notes.map((n: { id: number }) => n.id)).not.toContain(noteId);
  });
});
