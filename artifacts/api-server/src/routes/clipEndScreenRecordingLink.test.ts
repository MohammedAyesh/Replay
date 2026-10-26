/**
 * A clip cut from Find Yourself, a moment or the recording carries no match
 * code. Its end screen must still find the match through the recording, so
 * the player gets his own stats card and the numbers to pick from
 * (2026-10-26: every one of Mohammed's recording-401 clips offered only the
 * venue card, and no numbers at all).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db, usersTable, fieldsTable, recordingsTable, footageRequestsTable, matchRoomsTable, matchPlayersTable,
  matchPlayerStatsCacheTable, userClipsTable, settingsDefaultsTable, brandingProfilesTable,
} from "@workspace/db";

const link = vi.hoisted(() => ({ roomId: 0, fromRecording: 0 }));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any) => { res.status(401).json({ error: "Unauthenticated" }); }),
}));
// The booking-window overlap is matchFeed's own (tested there); here it is a given.
vi.mock("../lib/matchFeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/matchFeed")>();
  return {
    ...actual,
    roomsForRecording: vi.fn(async (recordingId: number) => {
      link.fromRecording = recordingId;
      const [room] = await db.select().from(matchRoomsTable).where(eq(matchRoomsTable.id, link.roomId));
      return room ? [{ room, fromSeconds: 0, toSeconds: 3600 }] : [];
    }),
  };
});
import { getLocalUserId } from "../lib/clerkUserBridge";

const TAG = `esl_${Date.now()}`;
const VIDEO = "11111111-2222-3333-4444-555555555555";
const KEYS = [
  "branding.endScreenEnabled", "branding.endScreen.player", "branding.endScreen.match",
  "branding.endScreen.academy", "branding.endScreen.signOff", "stats.enabled",
];
let app: Express;
const ids = { user: 0, field: 0, recording: 0, request: 0, room: 0, player: 0, clip: 0, profile: 0 };

beforeAll(async () => {
  const { default: router } = await import("./userClips");
  app = express();
  app.use(express.json());
  app.use("/api", router);
  const [user] = await db.insert(usersTable).values({ name: "Mohammed Ayesh", email: `p_${TAG}@test.local` }).returning({ id: usersTable.id });
  ids.user = user.id;
  vi.mocked(getLocalUserId).mockResolvedValue(user.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Galaxy ${TAG}`, location: "Test" }).returning({ id: fieldsTable.id });
  ids.field = field.id;
  const [recording] = await db.insert(recordingsTable).values({
    fieldId: field.id, court: "1", date: "2026-10-22", timeSlot: "22:00", duration: "01:30:00",
    videoUrl: `https://vz-test.b-cdn.net/${VIDEO}/playlist.m3u8`,
  }).returning({ id: recordingsTable.id });
  ids.recording = recording.id;
  const [footage] = await db.insert(footageRequestsTable).values({
    fieldId: field.id, cameraId: `cam-${TAG}`, requestedBy: user.id,
    startLocal: "2026-10-22 22:30", endLocal: "2026-10-23 00:00", requestedSeconds: 5400,
  }).returning({ id: footageRequestsTable.id });
  ids.request = footage.id;
  const [room] = await db.insert(matchRoomsTable).values({
    footageRequestId: footage.id, fieldId: field.id, code: `L${TAG.slice(-7)}`.toUpperCase(), captainToken: `t-${TAG}`,
  }).returning({ id: matchRoomsTable.id });
  ids.room = room.id;
  link.roomId = room.id;
  const [player] = await db.insert(matchPlayersTable).values({
    matchId: room.id, userId: user.id, displayName: "Mohammed", rsvp: "in", inviteToken: `i-${TAG}`,
  }).returning({ id: matchPlayersTable.id });
  ids.player = player.id;
  await db.insert(matchPlayerStatsCacheTable).values({
    matchId: room.id, matchPlayerId: player.id, userId: user.id, fingerprint: "test",
    stats: {
      minutes: 80, distanceKm: 6.2, topSpeedKmh: 27.4, touches: 61, passesTried: 30, passesCompleted: 24,
      passesReceived: 20, dribbles: 5, dribblesWon: 3, dribblesLost: 2, shots: 4, goals: 1,
    },
  });
  // A clip from the recording: no match code, no footage request.
  const [clip] = await db.insert(userClipsTable).values({
    userId: user.id, videoId: VIDEO, title: "Your goal · 54:36", startTime: "0.6", endTime: "0.603", aspectRatio: "9:16",
  }).returning({ id: userClipsTable.id });
  ids.clip = clip.id;
  const [profile] = await db.insert(brandingProfilesTable).values({
    scopeType: "global", scopeId: 0, nameEn: "JORDAN GALAXY", primaryColor: "#F4CF1F", crestUrl: "preset:jordan-galaxy-crest.png",
  }).returning({ id: brandingProfilesTable.id });
  ids.profile = profile.id;
  await db.insert(settingsDefaultsTable).values(KEYS.map((key) => ({ key, value: key !== "branding.endScreen.academy" })));
  (await import("../lib/settings")).invalidateSettingsCache();
});

afterAll(async () => {
  await db.delete(settingsDefaultsTable).where(inArray(settingsDefaultsTable.key, KEYS));
  (await import("../lib/settings")).invalidateSettingsCache();
  await db.delete(brandingProfilesTable).where(eq(brandingProfilesTable.id, ids.profile));
  await db.delete(userClipsTable).where(eq(userClipsTable.id, ids.clip));
  await db.delete(matchRoomsTable).where(eq(matchRoomsTable.id, ids.room));
  await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, ids.request));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, ids.recording));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, ids.field));
  await db.delete(usersTable).where(eq(usersTable.id, ids.user));
});

describe("a clip with no match code", () => {
  it("finds its match through the recording and offers his own stats card and numbers", async () => {
    const res = await request(app).get(`/api/user-clips/${ids.clip}/end-screen`);
    expect(res.status).toBe(200);
    expect(link.fromRecording).toBe(ids.recording);
    expect(res.body.current).toBe("player");
    expect(res.body.cards).toEqual(expect.arrayContaining([{ kind: "player", available: true }]));
    const values = Object.fromEntries(res.body.stats.map((s: { key: string; value: number | null }) => [s.key, s.value]));
    expect(values).toMatchObject({ goals: 1, shotsOnTarget: 4, topSpeed: 27.4, distance: 6.2, passes: 24, dribbles: 3 });
  });

  it("puts exactly the numbers he picks on the card", async () => {
    const { endScreenFor } = await import("../lib/clipBranding/plan");
    const card = await endScreenFor(
      { id: ids.clip, userId: ids.user, academyId: null, matchCode: null, footageRequestId: null, videoId: VIDEO,
        endScreen: { card: "player", stats: ["shotsOnTarget", "dribbles"] } },
      ids.field, { userId: ids.user, academyId: null, fieldId: ids.field }, [],
    );
    expect(card?.spec.kind).toBe("player");
    const lines = card?.spec.kind === "player" ? card.spec.stats.map((l) => [l.labelAr, l.value]) : [];
    expect(lines).toEqual([["تسديدة على المرمى", 4], ["مراوغة ناجحة", 3]]);
  });

  it("gives no stats card from a match he was not in", async () => {
    await db.update(matchPlayersTable).set({ userId: null }).where(eq(matchPlayersTable.id, ids.player));
    await db.delete(matchPlayerStatsCacheTable).where(eq(matchPlayerStatsCacheTable.matchId, ids.room));
    const res = await request(app).get(`/api/user-clips/${ids.clip}/end-screen`);
    expect(res.body.current).toBe("signOff");
    expect(res.body.stats).toEqual([]);
  });
});
