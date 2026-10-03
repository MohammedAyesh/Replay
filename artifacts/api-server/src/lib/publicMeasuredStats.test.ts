import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.mock("./claimMatchStorage", () => ({
  readClaimSegment: vi.fn(async () => {
    throw new Error("the profile must not read tracking from storage");
  }),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
  deleteClaimSegment: vi.fn(),
}));

import {
  db,
  fieldsTable,
  footageRequestsTable,
  matchPlayerStatsCacheTable,
  matchPlayersTable,
  matchRoomsTable,
  recordingsTable,
  usersTable,
  type MatchPlayerStatsCacheValue,
} from "@workspace/db";
import { readClaimSegment } from "./claimMatchStorage";
import { ensureRoomForRequest } from "./matchRooms";
import { loadPublicMeasured, measuredMatch, measuredTotals } from "./publicMeasuredStats";

const TAG = `pms_${Date.now()}`;

function stats(partial: Partial<MatchPlayerStatsCacheValue>): MatchPlayerStatsCacheValue {
  return {
    minutes: 60, distanceKm: 3, topSpeedKmh: 21, touches: 30, passesTried: 15, passesCompleted: 10, passesReceived: 8,
    dribbles: 4, dribblesWon: 2, dribblesLost: 2, shots: 1, goals: 0, ...partial,
  };
}

describe("measured totals", () => {
  const row = (matchId: number, s: Partial<MatchPlayerStatsCacheValue>) =>
    measuredMatch({ matchId, startLocal: "2026-09-30 22:00", fieldName: "Galaxy", stats: stats(s) });

  it("sums what was measured, keeps the best top speed, and leaves unmeasured figures null", () => {
    const totals = measuredTotals([
      row(1, { topSpeedKmh: 24.34, goals: 2, shots: 3, touches: 40, passesCompleted: 12, passesTried: 16, distanceKm: 3.456 }),
      row(2, { topSpeedKmh: 22, goals: 1, shots: null, touches: 30, passesCompleted: 8, passesTried: 10, distanceKm: 2.5 }),
    ]);
    expect(totals).toMatchObject({
      matches: 2, topSpeedKmh: 24.3, goals: 3, shots: 3, touches: 70, passesCompleted: 20, passesTried: 26, distanceKm: 5.96,
    });
    expect(measuredTotals([row(1, { shots: null })]).shots).toBeNull();
  });

  it("drops the 'of tried' when a match counted completions but not tries", () => {
    const totals = measuredTotals([row(1, { passesCompleted: 5, passesTried: 8 }), row(2, { passesCompleted: 4, passesTried: null })]);
    expect(totals.passesCompleted).toBe(9);
    expect(totals.passesTried).toBeNull();
  });

  it("is all null for nobody's matches", () => {
    expect(measuredTotals([])).toMatchObject({ matches: 0, topSpeedKmh: null, goals: null, touches: null });
  });
});

describe("loadPublicMeasured", () => {
  let userId = 0;
  let fieldId = 0;
  const recordingIds: number[] = [];
  const requestIds: number[] = [];
  const roomIds: number[] = [];

  async function matchWith(startLocal: string, recordingId: number, s: MatchPlayerStatsCacheValue) {
    const [request] = await db.insert(footageRequestsTable).values({
      fieldId,
      cameraId: `cam-${TAG}`,
      requestedBy: userId,
      startLocal,
      endLocal: startLocal.replace(/ (\d\d):/, (_, h) => ` ${String(Number(h) + 1).padStart(2, "0")}:`),
      requestedSeconds: 3600,
      status: "ready",
    }).returning();
    requestIds.push(request.id);
    const room = await ensureRoomForRequest(request);
    roomIds.push(room.id);
    const [player] = await db.insert(matchPlayersTable).values({
      matchId: room.id, userId, displayName: "Me", rsvp: "in", team: "A", inviteToken: `${TAG}-${room.id}`,
    }).returning({ id: matchPlayersTable.id });
    await db.insert(matchPlayerStatsCacheTable).values({
      matchId: room.id, matchPlayerId: player.id, userId, recordingIds: [recordingId], fingerprint: `${TAG}-${room.id}`, stats: s,
    });
  }

  async function recording(court: string, isVisible: boolean) {
    const [row] = await db.insert(recordingsTable).values({
      fieldId, court, date: "2026-09-20", timeSlot: "22:00", duration: "01:00:00", videoUrl: `https://example.test/${TAG}-${court}.m3u8`, isVisible,
    }).returning({ id: recordingsTable.id });
    recordingIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    const [user] = await db.insert(usersTable).values({ name: `Measured ${TAG}`, email: `${TAG}@test.local`, profileComplete: true }).returning({ id: usersTable.id });
    userId = user.id;
    const [field] = await db.insert(fieldsTable).values({ name: `Galaxy ${TAG}`, location: "Test", cameraId: `cam-${TAG}` }).returning({ id: fieldsTable.id });
    fieldId = field.id;
    const shown = await recording("1", true);
    const hidden = await recording("2", false);
    await matchWith("2026-09-20 22:00", shown, stats({ topSpeedKmh: 24.3, goals: 2, shots: 4, touches: 41, passesCompleted: 12, passesTried: 16 }));
    await matchWith("2026-09-27 22:00", hidden, stats({ topSpeedKmh: 30, goals: 9 }));
  });

  afterAll(async () => {
    await db.delete(matchPlayerStatsCacheTable).where(inArray(matchPlayerStatsCacheTable.matchId, roomIds));
    await db.delete(matchPlayersTable).where(inArray(matchPlayersTable.matchId, roomIds));
    await db.delete(matchRoomsTable).where(inArray(matchRoomsTable.id, roomIds));
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
    await db.delete(recordingsTable).where(inArray(recordingsTable.id, recordingIds));
    await db.delete(usersTable).where(inArray(usersTable.id, [userId]));
    await db.delete(fieldsTable).where(inArray(fieldsTable.id, [fieldId]));
  });

  it("reads the match report's cached figures, only for matches the public can see, without touching storage", async () => {
    vi.mocked(readClaimSegment).mockClear();
    const measured = await loadPublicMeasured(userId);
    expect(measured?.matches).toHaveLength(1);
    expect(measured?.matches[0]).toMatchObject({ date: "2026-09-20", fieldName: `Galaxy ${TAG}`, topSpeedKmh: 24.3, goals: 2, shots: 4, touches: 41, passesCompleted: 12, passesTried: 16 });
    expect(measured?.matches[0].recordingIds).toEqual([recordingIds[0]]);
    expect(measured?.totals).toMatchObject({ matches: 1, topSpeedKmh: 24.3, goals: 2 });
    expect(readClaimSegment).not.toHaveBeenCalled();
  });
});
