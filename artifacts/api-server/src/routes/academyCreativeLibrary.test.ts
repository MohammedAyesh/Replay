import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  academiesTable,
  academyAdMediaTable,
  academyMembersTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  brandingProfilesTable,
  db,
  fieldsTable,
  recordingsTable,
  userClipsTable,
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

import libraryRouter from "./academyCreativeLibrary";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let outsiderId: number;
let kidUserId: number;
let academyId: number;
let otherAcademyId: number;
let sessionId: number;
let noFootageSessionId: number;
let otherSessionId: number;
let recordingId: number;
let otherRecordingId: number;
let coachClipId: number;
let kidClipId: number;
let otherClipId: number;
let mediaId: number;
let otherMediaId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (path: string, academy = academyId) => `/api/academy/console/academies/${academy}/creative/library${path}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const allowNames = async (on: boolean) => {
  await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyId)));
  if (on) await db.insert(brandingProfilesTable).values({ scopeType: "academy", scopeId: academyId, nameEn: "Library", showPlayerNames: true });
};

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", libraryRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-lib-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-lib-${tag}@test.local` },
    { name: `Out ${tag}`, email: `out-lib-${tag}@test.local` },
    { name: `Ahmad Saleh ${tag}`, email: `kid-lib-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, outsiderId, kidUserId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Library field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([
    { name: `Library Academy ${tag}`, fieldId: field.id },
    { name: `Other Library ${tag}`, fieldId: field.id },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  // The owner owns both academies: scoping must come from the URL's academy, not from who asks.
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: ownerId, role: "owner" },
  ]);
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U-12 Blue" }).returning({ id: academySquadsTable.id });
  await db.insert(academyPlayersTable).values([
    { academyId, squadId: squad.id, name: "Ahmad Saleh", jerseyNumber: 10, userId: kidUserId },
    { academyId, squadId: squad.id, name: "Omar Khaled", jerseyNumber: 7 },
  ]);
  const sessions = await db.insert(academySessionsTable).values([
    { academyId, squadId: squad.id, type: "match", startsAt: new Date("2026-10-31T15:00:00Z"), location: "Galaxy", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1 },
    { academyId, squadId: squad.id, type: "training", startsAt: new Date("2026-10-29T15:00:00Z"), location: "Galaxy" },
    { academyId: otherAcademyId, type: "match", startsAt: new Date("2026-10-30T15:00:00Z"), location: "Elsewhere", opponent: "Secret FC" },
  ]).returning({ id: academySessionsTable.id });
  [sessionId, noFootageSessionId, otherSessionId] = sessions.map((s) => s.id);
  const recs = await db.insert(recordingsTable).values([
    { fieldId: field.id, court: "1", date: "2026-10-31", timeSlot: "18:00", duration: "60 min", videoUrl: `https://vz.test/lib-${tag}/playlist.m3u8` },
    { fieldId: field.id, court: "1", date: "2026-10-30", timeSlot: "18:00", duration: "60 min", videoUrl: `https://vz.test/lib-other-${tag}/playlist.m3u8` },
  ] as Array<typeof recordingsTable.$inferInsert>).returning({ id: recordingsTable.id });
  [recordingId, otherRecordingId] = recs.map((r) => r.id);
  await db.insert(academyRecordingsTable).values([
    { academyId, recordingId, sessionId },
    { academyId: otherAcademyId, recordingId: otherRecordingId, sessionId: otherSessionId },
  ]);
  const clips = await db.insert(userClipsTable).values([
    { userId: coachId, videoId: `vid-${tag}`, title: "Ahmad's screamer", startTime: "600", endTime: "620", academyId, sourceRecordingId: recordingId },
    { userId: kidUserId, videoId: `vid-${tag}`, title: "Ahmad dribble", startTime: "1200", endTime: "1212", sourceRecordingId: recordingId },
    { userId: ownerId, videoId: `vid-other-${tag}`, title: "Other academy clip", startTime: "10", endTime: "20", academyId: otherAcademyId, sourceRecordingId: otherRecordingId },
  ]).returning({ id: userClipsTable.id });
  [coachClipId, kidClipId, otherClipId] = clips.map((c) => c.id);
  const media = await db.insert(academyAdMediaTable).values([
    { academyId, kind: "image", name: "Team photo", imageData: `data:image/png;base64,${PNG.toString("base64")}`, status: "ready" },
    { academyId: otherAcademyId, kind: "image", name: "Not yours", imageData: `data:image/png;base64,${PNG.toString("base64")}`, status: "ready" },
  ]).returning({ id: academyAdMediaTable.id });
  [mediaId, otherMediaId] = media.map((m) => m.id);
});

afterAll(async () => {
  await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), inArray(brandingProfilesTable.scopeId, [academyId, otherAcademyId])));
});

describe("creative library: access", () => {
  it("is owner only", async () => {
    for (const id of [coachId, outsiderId]) {
      for (const path of ["/matches", `/matches/${sessionId}/moments`, "/clips", "/uploads", "/players"]) {
        expect((await request(app).get(url(path)).set(auth(id))).status).toBe(403);
      }
      expect((await request(app).post(url("/uploads")).set(auth(id)).attach("file", PNG, { filename: "a.png", contentType: "image/png" })).status).toBe(403);
    }
    expect((await request(app).get(url("/matches"))).status).toBe(401);
  });
});

describe("creative library: academy scoping", () => {
  it("lists only this academy's sessions with footage", async () => {
    const res = await request(app).get(url("/matches")).set(auth(ownerId));
    expect(res.status).toBe(200);
    const ids = res.body.matches.map((m: { sessionId: number }) => m.sessionId);
    expect(ids).toEqual([sessionId]);
    expect(ids).not.toContain(noFootageSessionId);
    expect(ids).not.toContain(otherSessionId);
    expect(res.body.matches[0]).toMatchObject({
      type: "match", date: "2026-10-31", time: "18:00", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1,
      squad: { name: "U-12 Blue" }, recordingIds: [recordingId], recordingId, durationMs: 3_600_000, analysed: false,
      still: { type: "frame", recordingId, atMs: 600_000 },
    });
  });

  it("filters matches by shirt number, squad and Amman dates", async () => {
    const seven = await request(app).get(url("/matches?player=%237")).set(auth(ownerId));
    expect(seven.body.matches.map((m: { sessionId: number }) => m.sessionId)).toEqual([sessionId]);
    expect((await request(app).get(url("/matches?player=55")).set(auth(ownerId))).body.matches).toEqual([]);
    expect((await request(app).get(url("/matches?from=2026-11-01")).set(auth(ownerId))).body.matches).toEqual([]);
    expect((await request(app).get(url("/matches?from=2026-10-31&to=2026-10-31")).set(auth(ownerId))).body.total).toBe(1);
  });

  it("will not open another academy's session, even for its owner", async () => {
    expect((await request(app).get(url(`/matches/${otherSessionId}/moments`)).set(auth(ownerId))).status).toBe(404);
    expect((await request(app).get(url("/matches/abc/moments")).set(auth(ownerId))).status).toBe(400);
  });

  it("lists only this academy's clips and uploads", async () => {
    const clips = await request(app).get(url("/clips")).set(auth(ownerId));
    const clipIds = clips.body.clips.map((c: { clipId: number }) => c.clipId);
    expect(clipIds).toContain(coachClipId);
    expect(clipIds).not.toContain(otherClipId);
    const clip = clips.body.clips.find((c: { clipId: number }) => c.clipId === coachClipId);
    expect(clip).toMatchObject({
      source: { type: "clip", clipId: coachClipId },
      window: { recordingId, fromMs: 600_000, toMs: 620_000 },
      durationMs: 20_000,
      sessionId,
      thumbnailUrl: `/api/academy/console/academies/${academyId}/creative/media?src=${encodeURIComponent(JSON.stringify({ type: "clip", clipId: coachClipId }))}&want=still`,
    });
    const uploads = await request(app).get(url("/uploads")).set(auth(ownerId));
    const mediaIds = uploads.body.uploads.map((u: { mediaId: number }) => u.mediaId);
    expect(mediaIds).toContain(mediaId);
    expect(mediaIds).not.toContain(otherMediaId);
    expect(uploads.body.uploads.find((u: { mediaId: number }) => u.mediaId === mediaId)).toMatchObject({
      kind: "image", source: { type: "upload", mediaId }, thumbnailUrl: `/api/academy/console/academies/${academyId}/ads/media/${mediaId}/thumb`,
    });
  });

  it("stores an uploaded photo in the academy's media", async () => {
    const res = await request(app).post(url("/uploads")).set(auth(ownerId)).field("name", "Crest wall").field("width", "1").field("height", "1")
      .attach("file", PNG, { filename: "wall.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.upload).toMatchObject({ kind: "image", name: "Crest wall", width: 1, height: 1 });
    const [row] = await db.select().from(academyAdMediaTable).where(eq(academyAdMediaTable.id, res.body.upload.mediaId));
    expect(row.academyId).toBe(academyId);
    const bad = await request(app).post(url("/uploads")).set(auth(ownerId)).attach("file", Buffer.from("hi"), { filename: "a.txt", contentType: "text/plain" });
    expect(bad.status).toBe(400);
  });
});

describe("creative library: names", () => {
  it("shows players by shirt number only by default", async () => {
    await allowNames(false);
    const players = await request(app).get(url("/players")).set(auth(ownerId));
    expect(players.body.showNames).toBe(false);
    expect(players.body.players.map((p: { number: number; firstName: string | null }) => [p.number, p.firstName])).toEqual([[7, null], [10, null]]);
    expect(JSON.stringify(players.body)).not.toContain("Saleh");
    expect(players.body.squads.map((s: { name: string }) => s.name)).toEqual(["U-12 Blue"]);

    const moments = await request(app).get(url(`/matches/${sessionId}/moments`)).set(auth(ownerId));
    expect(moments.status).toBe(200);
    expect(moments.body.analysis).toBe("none");
    const kid = moments.body.moments.find((m: { clipId: number }) => m.clipId === kidClipId);
    expect(kid).toMatchObject({
      type: "saved",
      window: { recordingId, fromMs: 1_200_000, toMs: 1_212_000 },
      source: { type: "recording", recordingId, fromMs: 1_200_000, toMs: 1_212_000 },
      still: { type: "frame", recordingId, atMs: 1_206_000 },
      minute: 21,
      player: { number: 10, firstName: null },
      title: null,
    });
    expect(JSON.stringify(moments.body)).not.toContain("Ahmad");
    const clips = await request(app).get(url("/clips")).set(auth(ownerId));
    expect(JSON.stringify(clips.body)).not.toContain("Ahmad");
  });

  it("shows first names only once the academy allows them", async () => {
    await allowNames(true);
    try {
      const players = await request(app).get(url("/players")).set(auth(ownerId));
      expect(players.body.players.map((p: { firstName: string | null }) => p.firstName)).toEqual(["Omar", "Ahmad"]);
      expect(JSON.stringify(players.body)).not.toContain("Saleh");
      const moments = await request(app).get(url(`/matches/${sessionId}/moments`)).set(auth(ownerId));
      const kid = moments.body.moments.find((m: { clipId: number }) => m.clipId === kidClipId);
      expect(kid.player).toEqual({ number: 10, firstName: "Ahmad", squad: "U-12 Blue" });
    } finally {
      await allowNames(false);
    }
  });

  it("filters moments by type and shirt number", async () => {
    const goals = await request(app).get(url(`/matches/${sessionId}/moments?type=goal`)).set(auth(ownerId));
    expect(goals.body.moments).toEqual([]);
    expect(goals.body.counts.saved).toBe(2);
    const ten = await request(app).get(url(`/matches/${sessionId}/moments?player=10`)).set(auth(ownerId));
    expect(ten.body.moments.map((m: { clipId: number }) => m.clipId)).toEqual([kidClipId]);
  });
});
