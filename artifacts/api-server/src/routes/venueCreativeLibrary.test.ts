import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyMembersTable,
  db,
  fieldsTable,
  footageRequestsTable,
  recordingsTable,
  userClipsTable,
  usersTable,
  venuePitchesTable,
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
import creativeRouter from "./academyCreative";
import { FIELD_STYLE, buildTemplateScene } from "@workspace/api-zod";
import studioRouter from "./academyStudio";
import { academyClip, academyRecording } from "../lib/creative/renderMedia";
import { clipOrigin } from "../lib/creative/venueLibrary";
import { rememberBall } from "../lib/creative/framing";

const tag = Date.now();
let app: Express;
let ownerId: number;
let deskId: number;
let playerId: number;
let venueId: number;
let academyId: number;
let recordingId: number;
let secondPitchRecordingId: number;
let otherRecordingId: number;
const clip: Record<string, number> = {};
const auth = (id: number) => ({ "x-test-user": String(id) });
const lib = (path: string) => `/api/academy/console/academies/${venueId}/creative/library${path}`;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", libraryRouter);
  app.use("/api", creativeRouter);
  app.use("/api", studioRouter);
  const users = await db.insert(usersTable).values([
    { name: `Field Owner ${tag}`, email: `vlib-owner-${tag}@test.local` },
    { name: `Desk ${tag}`, email: `vlib-desk-${tag}@test.local` },
    { name: `Yazan Haddad ${tag}`, email: `vlib-player-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, deskId, playerId] = users.map((u) => u.id);
  const fields = await db.insert(fieldsTable).values([
    { name: `Galaxy Lower ${tag}`, cameraId: `vlib-cam1-${tag}` },
    { name: `Galaxy Upper ${tag}`, cameraId: `vlib-cam2-${tag}` },
    { name: `Someone else ${tag}`, cameraId: `vlib-cam9-${tag}` },
  ]).returning({ id: fieldsTable.id });
  const [lower, upper, elsewhere] = fields.map((f) => f.id);
  const [venue] = await db.insert(academiesTable).values({ name: `Galaxy ${tag}`, kind: "venue", fieldId: lower }).returning({ id: academiesTable.id });
  venueId = venue.id;
  const [academy] = await db.insert(academiesTable).values({ name: `An academy ${tag}`, fieldId: lower }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([
    { academyId: venueId, userId: ownerId, role: "owner" },
    { academyId: venueId, userId: deskId, role: "coach" },
  ]);
  await db.insert(venuePitchesTable).values([
    { academyId: venueId, name: "Lower", fieldId: lower },
    { academyId: venueId, name: "Upper", fieldId: upper },
  ]);
  const recs = await db.insert(recordingsTable).values([
    { fieldId: lower, court: "1", date: "2026-11-02", timeSlot: "20:00", duration: "90 min", videoUrl: `https://vz.test/vlib-a-${tag}/playlist.m3u8` },
    { fieldId: upper, court: "2", date: "2026-11-01", timeSlot: "19:00", duration: "60 min", videoUrl: `https://vz.test/vlib-b-${tag}/playlist.m3u8` },
    { fieldId: elsewhere, court: "1", date: "2026-11-02", timeSlot: "21:00", duration: "60 min", videoUrl: `https://vz.test/vlib-x-${tag}/playlist.m3u8` },
  ] as Array<typeof recordingsTable.$inferInsert>).returning({ id: recordingsTable.id });
  [recordingId, secondPitchRecordingId, otherRecordingId] = recs.map((r) => r.id);
  const [request0] = await db.insert(footageRequestsTable).values({
    fieldId: lower, cameraId: `vlib-cam1-${tag}`, requestedBy: ownerId, startLocal: "2026-11-02 20:00", endLocal: "2026-11-02 21:00", requestedSeconds: 3600, videoId: `vlib-req-${tag}`,
  }).returning({ id: footageRequestsTable.id });
  const rows = await db.insert(userClipsTable).values([
    // A player cut this one by hand on the watch page.
    { userId: playerId, videoId: `vlib-a-${tag}`, title: "Top corner", startTime: "0.40", endTime: "0.41", sourceRecordingId: recordingId },
    // Replay made this one when he claimed the game: no source links at all.
    { userId: playerId, videoId: `vlib-a-${tag}`, title: "Your goal · 34:10", startTime: "0.37", endTime: "0.373" },
    // The other pitch, by video only.
    { userId: playerId, videoId: `VLIB-B-${tag}`, title: "Your dribble · 6 m past 1 · 12:00", startTime: "0.2", endTime: "0.21" },
    // From the owner's own share link.
    { userId: playerId, videoId: `vlib-req-${tag}`, title: "From the share", startTime: "0.1", endTime: "0.11", footageRequestId: request0.id },
    // Someone else's field.
    { userId: playerId, videoId: `vlib-x-${tag}`, title: "Not yours", startTime: "0.1", endTime: "0.11", sourceRecordingId: otherRecordingId },
    // Deleted by the player.
    { userId: playerId, videoId: `vlib-a-${tag}`, title: "Deleted", startTime: "0.5", endTime: "0.51", sourceRecordingId: recordingId, hiddenReason: "deleted", isHidden: true },
  ]).returning({ id: userClipsTable.id });
  [clip.manual, clip.auto, clip.upper, clip.share, clip.other, clip.deleted] = rows.map((r) => r.id);
});

describe("a field's creative library", () => {
  it("lists every recording at the field's pitches as a match, and none of another field's", async () => {
    const res = await request(app).get(lib("/matches")).set(auth(ownerId)).expect(200);
    const ids = res.body.matches.map((m: { sessionId: number }) => m.sessionId);
    expect(ids).toEqual([recordingId, secondPitchRecordingId]);
    expect(res.body.matches[0]).toMatchObject({ recordingId, type: "match", date: "2026-11-02", time: "20:00", wholeMatch: false });
  });

  it("lists every clip of its footage, players' and Replay's, and filters by who made it", async () => {
    const all = await request(app).get(lib("/clips")).set(auth(ownerId)).expect(200);
    const byId = new Map(all.body.clips.map((c: { clipId: number }) => [c.clipId, c]));
    expect([...byId.keys()].sort()).toEqual([clip.manual, clip.auto, clip.upper, clip.share].sort());
    expect(byId.get(clip.manual)).toMatchObject({ origin: "player", madeBy: "Yazan", title: "Top corner", sessionId: recordingId });
    expect(byId.get(clip.auto)).toMatchObject({ origin: "auto", madeBy: null, title: "Your goal · 34:10", sessionId: recordingId });
    expect(byId.get(clip.upper)).toMatchObject({ origin: "auto", sessionId: secondPitchRecordingId });
    expect(all.body.counts).toEqual({ all: 4, auto: 2, player: 2 });
    const auto = await request(app).get(lib("/clips?origin=auto")).set(auth(ownerId)).expect(200);
    expect(auto.body.clips.map((c: { clipId: number }) => c.clipId).sort()).toEqual([clip.auto, clip.upper].sort());
    expect(auto.body.counts.all).toBe(4);
  });

  it("sorts clips by match: newest game first, in match order inside it", async () => {
    const res = await request(app).get(lib("/clips?sort=match")).set(auth(ownerId)).expect(200);
    const order = res.body.clips.map((c: { clipId: number }) => c.clipId);
    // 2 Nov 20:00 on Lower: the share (20:00 booking) and the recording; Replay's goal (0.37) before the hand-cut one (0.40); then 1 Nov.
    expect(order.indexOf(clip.auto)).toBeLessThan(order.indexOf(clip.manual));
    expect(order[order.length - 1]).toBe(clip.upper);
    const manual = res.body.clips.find((c: { clipId: number }) => c.clipId === clip.manual);
    expect(manual.match).toMatchObject({ key: `rec:${recordingId}`, recordingId, date: "2026-11-02", time: "20:00", pitch: "Lower" });
    const share = res.body.clips.find((c: { clipId: number }) => c.clipId === clip.share);
    expect(share.match).toMatchObject({ recordingId: null, date: "2026-11-02", time: "20:00", pitch: "Lower" });
    expect(res.body.groupSizes[`rec:${recordingId}`]).toBe(2);
  });

  it("sorts clips by player, with Replay's clips under the player they were made for", async () => {
    const [other] = await db.insert(usersTable).values({ name: `Ahmad K ${tag}`, email: `vlib-p2-${tag}@test.local` }).returning({ id: usersTable.id });
    const [extra] = await db.insert(userClipsTable).values({ userId: other.id, videoId: `vlib-a-${tag}`, title: "Ahmad's volley", startTime: "0.6", endTime: "0.61", sourceRecordingId: recordingId }).returning({ id: userClipsTable.id });
    const res = await request(app).get(lib("/clips?sort=player")).set(auth(ownerId)).expect(200);
    const names = res.body.clips.map((c: { player: { name: string } }) => c.player.name);
    expect(names[0]).toBe("Ahmad");
    expect(names.slice(1).every((n: string) => n === "Yazan")).toBe(true);
    const auto = res.body.clips.find((c: { clipId: number }) => c.clipId === clip.auto);
    expect(auto).toMatchObject({ origin: "auto", madeBy: null, player: { name: "Yazan" } });
    expect(res.body.groupSizes[`u:${playerId}`]).toBe(4);
    await db.delete(userClipsTable).where(eq(userClipsTable.id, extra.id));
  });

  it("shows a recording's saved clips as moments", async () => {
    const res = await request(app).get(lib(`/matches/${recordingId}/moments`)).set(auth(ownerId)).expect(200);
    expect(res.body.analysis).toBe("none");
    expect(res.body.moments.map((m: { clipId: number }) => m.clipId).sort()).toEqual([clip.manual, clip.auto].sort());
    await request(app).get(lib(`/matches/${otherRecordingId}/moments`)).set(auth(ownerId)).expect(404);
  });

  it("lets designs use the field's clips and recordings, and nothing else", async () => {
    expect((await academyClip(venueId, clip.auto))?.id).toBe(clip.auto);
    expect((await academyClip(venueId, clip.share))?.id).toBe(clip.share);
    expect(await academyClip(venueId, clip.other)).toBeNull();
    expect(await academyClip(venueId, clip.deleted)).toBeNull();
    expect((await academyRecording(venueId, secondPitchRecordingId))?.id).toBe(secondPitchRecordingId);
    expect(await academyRecording(venueId, otherRecordingId)).toBeNull();
    // An academy at the same field doesn't get the field's footage this way.
    expect(await academyClip(academyId, clip.auto)).toBeNull();
    expect(await academyRecording(academyId, recordingId)).toBeNull();
  });

  it("shows every clip in Studio with who made it", async () => {
    const res = await request(app).get(`/api/academy/console/academies/${venueId}/studio/clips`).set(auth(ownerId)).expect(200);
    const auto = res.body.clips.find((c: { id: number }) => c.id === clip.auto);
    const manual = res.body.clips.find((c: { id: number }) => c.id === clip.manual);
    expect(auto).toMatchObject({ origin: "auto", creator: { name: "Replay", role: "replay" } });
    expect(manual).toMatchObject({ origin: "player", creator: { name: "Yazan", role: "player" } });
    expect(res.body.clips.some((c: { id: number }) => c.id === clip.other)).toBe(false);
  });

  it("follows the ball through a clip or a moment, and says where a clip sits in its recording", async () => {
    // Clip "Top corner" is 0.40–0.41 of a 90-minute video: 2160–2214 s. The ball crosses the pitch meanwhile.
    rememberBall(recordingId, Array.from({ length: 300 }, (_, i) => [2150 + i * 0.25, 0.1 + (0.8 * i) / 300, 0.55] as [number, number, number]));
    const fromClip = await request(app).post(lib("/framing")).set(auth(ownerId)).send({ src: { type: "clip", clipId: clip.manual } }).expect(200);
    expect(fromClip.body).toMatchObject({ source: "ball", window: { recordingId, fromMs: 2_160_000, toMs: 2_214_000 } });
    expect(fromClip.body.framing.keys[0][0]).toBe(0);
    expect(fromClip.body.framing.keys.at(-1)[0]).toBe(54_000);
    const fromMoment = await request(app).post(lib("/framing")).set(auth(ownerId))
      .send({ src: { type: "recording", recordingId, fromMs: 2_150_000, toMs: 2_170_000 } }).expect(200);
    expect(fromMoment.body.source).toBe("ball");
    expect(fromMoment.body.framing.keys[0][1]).toBeLessThan(0.2);
    // No ball data: the middle of the pitch.
    const plain = await request(app).post(lib("/framing")).set(auth(ownerId))
      .send({ src: { type: "recording", recordingId: secondPitchRecordingId, fromMs: 0, toMs: 10_000 } }).expect(200);
    expect(plain.body.source).toBe("centre");
    await request(app).post(lib("/framing")).set(auth(ownerId)).send({ src: { type: "recording", recordingId: otherRecordingId, fromMs: 0, toMs: 10_000 } }).expect(404);
    await request(app).post(lib("/framing")).set(auth(ownerId)).send({ src: { type: "clip", clipId: clip.other } }).expect(404);
    // The clip list gives the clip's real length (54 s), not its share of the video.
    const list = await request(app).get(lib("/clips")).set(auth(ownerId)).expect(200);
    expect(list.body.clips.find((c: { clipId: number }) => c.clipId === clip.manual)).toMatchObject({ durationMs: 54_000, window: { recordingId, fromMs: 2_160_000, toMs: 2_214_000 } });
  });

  it("keeps it to the field's owner", async () => {
    expect((await request(app).get(lib("/clips")).set(auth(deskId))).status).toBe(403);
  });
});

describe("clipOrigin", () => {
  it("calls a clip with no source link Replay's", () => {
    expect(clipOrigin({ sourceRecordingId: null, footageRequestId: null, matchCode: null, academyId: null })).toBe("auto");
    expect(clipOrigin({ sourceRecordingId: 3, footageRequestId: null, matchCode: null, academyId: null })).toBe("player");
    expect(clipOrigin({ sourceRecordingId: null, footageRequestId: null, matchCode: "ABC123", academyId: null })).toBe("player");
  });
});

describe("field pack projects", () => {
  const body = (title: string) => ({ title, templateKey: "field-booking-clip", style: FIELD_STYLE, scene: buildTemplateScene("field-booking-clip", FIELD_STYLE, "story", "ar"), data: { media: { type: "clip", clipId: 1 } } });
  it("a field saves a field pack design from a clip", async () => {
    const res = await request(app).post(`/api/academy/console/academies/${venueId}/creative/projects`).set(auth(ownerId)).send(body("Booking clip"));
    expect(res.status).toBe(201);
    expect(res.body.style ?? res.body.project?.style).toBe(FIELD_STYLE);
  });
});
