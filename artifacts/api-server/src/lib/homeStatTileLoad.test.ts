import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import {
  db,
  fieldsTable,
  footageRequestsTable,
  matchPlayerStatsCacheTable,
  matchPlayersTable,
  matchRoomsTable,
  usersTable,
  type MatchPlayerStatsCacheValue,
} from "@workspace/db";
import { ensureRoomForRequest } from "./matchRooms";
import { ammanNowLocal, loadStatTile } from "./homeStatTileLoad";

/**
 * The loader against a real database: it reads the cache, rooms and rosters
 * with the SQL it ships with, keeps other players' numbers to matches the
 * viewer may see, and hands the right rows to the scorer.
 */

const TAG = `hst_${Date.now()}`;
const users: Record<string, number> = {};
let fieldId = 0;
const requestIds: number[] = [];
const rooms: Record<string, { id: number; code: string }> = {};

function stats(partial: Partial<MatchPlayerStatsCacheValue>): MatchPlayerStatsCacheValue {
  return {
    minutes: 60, distanceKm: 3, topSpeedKmh: 21, touches: 30, passesTried: 15, passesCompleted: 10, passesReceived: 8,
    dribbles: 4, dribblesWon: 2, dribblesLost: 2, shots: 1, goals: 0, ...partial,
  };
}

/** "YYYY-MM-DD HH:MM" a whole number of days before now, Amman. */
function daysAgo(days: number, hour = "22:00"): string {
  const d = new Date(Date.now() + 3 * 3_600_000 - days * 86_400_000).toISOString().slice(0, 10);
  return `${d} ${hour}`;
}

async function match(key: string, startLocal: string, roster: Array<[string, string]>) {
  const [request] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: `cam-${TAG}`,
    requestedBy: users.me,
    startLocal,
    endLocal: startLocal.replace(/ (\d\d):/, (_, h) => ` ${String(Number(h) + 1).padStart(2, "0")}:`),
    requestedSeconds: 3600,
    status: "ready",
  }).returning();
  requestIds.push(request.id);
  const room = await ensureRoomForRequest(request);
  rooms[key] = { id: room.id, code: room.code };
  const players: Record<string, number> = {};
  for (const [who, rsvp] of roster) {
    const [row] = await db.insert(matchPlayersTable).values({
      matchId: room.id, userId: users[who], displayName: who.charAt(0).toUpperCase() + who.slice(1), rsvp, team: "A", inviteToken: `${TAG}-${room.id}-${who}`,
    }).returning({ id: matchPlayersTable.id });
    players[who] = row.id;
  }
  return { room, players };
}

async function cache(matchId: number, playerId: number, who: string, s: MatchPlayerStatsCacheValue) {
  await db.insert(matchPlayerStatsCacheTable).values({ matchId, matchPlayerId: playerId, userId: users[who], recordingIds: [], fingerprint: `${TAG}-${matchId}-${who}`, stats: s });
}

let lastVisible: number[] = [];
let waiting: { id: number; code: string; startLocal: string; players: Record<string, number> } | null = null;

beforeAll(async () => {
  for (const key of ["me", "laith", "omar", "yazan", "blocked"]) {
    const [u] = await db.insert(usersTable).values({ name: `${key} ${TAG}`, email: `${TAG}_${key}@test.local`, profileComplete: true }).returning({ id: usersTable.id });
    users[key] = u.id;
  }
  const [field] = await db.insert(fieldsTable).values({ name: `Galaxy ${TAG}`, location: "Test", cameraId: `cam-${TAG}` }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  // Four claimed matches (a personal best needs three earlier ones); the newest has the player's fastest run yet.
  const everyone: Array<[string, string]> = [["me", "in"], ["laith", "in"], ["omar", "in"], ["yazan", "in"], ["blocked", "in"]];
  const speeds = [24.3, 22.1, 21.4, 20.9];
  for (const [i, days] of [5, 9, 13, 17].entries()) {
    const { room, players } = await match(`m${i}`, daysAgo(days), everyone);
    await cache(room.id, players.me, "me", stats({ topSpeedKmh: speeds[i], distanceKm: 3.4 }));
    await cache(room.id, players.laith, "laith", stats({ topSpeedKmh: 25, distanceKm: 3 }));
    await cache(room.id, players.omar, "omar", stats({ topSpeedKmh: 20, distanceKm: 2.8 }));
    await cache(room.id, players.blocked, "blocked", stats({ topSpeedKmh: 30, distanceKm: 6 }));
    if (i === 0) lastVisible = Object.values(players);
  }
  // A newer match the player was in but hasn't claimed; two friends have.
  const newer = daysAgo(1, "21:00");
  const { room, players } = await match("waiting", newer, [["me", "in"], ["laith", "in"], ["omar", "in"]]);
  await cache(room.id, players.laith, "laith", stats({ distanceKm: 5.4, topSpeedKmh: 24 }));
  await cache(room.id, players.omar, "omar", stats({ distanceKm: 4.9, topSpeedKmh: 22.8 }));
  waiting = { id: room.id, code: room.code, startLocal: newer, players };
});

afterAll(async () => {
  const matchIds = Object.values(rooms).map((r) => r.id);
  if (matchIds.length) {
    await db.delete(matchPlayerStatsCacheTable).where(inArray(matchPlayerStatsCacheTable.matchId, matchIds));
    await db.delete(matchPlayersTable).where(inArray(matchPlayersTable.matchId, matchIds));
    await db.delete(matchRoomsTable).where(inArray(matchRoomsTable.id, matchIds));
  }
  if (requestIds.length) await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  if (fieldId) await db.delete(fieldsTable).where(inArray(fieldsTable.id, [fieldId]));
  await db.delete(usersTable).where(inArray(usersTable.id, Object.values(users)));
});

describe("loadStatTile", () => {
  it("writes Amman time", () => {
    expect(ammanNowLocal(Date.UTC(2026, 9, 1, 21, 30))).toBe("2026-10-02 00:30");
  });

  it("puts a waiting match first, with the friends' numbers the viewer may see", async () => {
    const tile = await loadStatTile({
      userId: users.me,
      recent: [{ code: waiting!.code, phase: "ready", startLocal: waiting!.startLocal, myRsvp: "in", findRecordingId: 4242 }],
      upcoming: null,
      visiblePlayerIdsByMatch: new Map([[waiting!.id, Object.values(waiting!.players)], [rooms.m0.id, lastVisible]]),
      blockedIds: new Set([users.blocked]),
    });
    expect(tile).toMatchObject({ kind: "friends", findRecordingId: 4242, found: 2, match: { code: waiting!.code, players: 3 } });
    expect(tile && tile.kind === "friends" ? tile.peers.map((p) => p.name) : []).toEqual(["Laith", "Omar"]);
  });

  it("without a waiting match, the newest personal best, and the field count leaves out nobody faster", async () => {
    const tile = await loadStatTile({
      userId: users.me,
      recent: [],
      upcoming: null,
      visiblePlayerIdsByMatch: new Map([[rooms.m0.id, lastVisible]]),
      blockedIds: new Set([users.blocked]),
    });
    expect(tile).toMatchObject({ kind: "personalBest", metric: "topSpeedKmh", value: 24.3, previousBest: 22.1, match: { code: rooms.m0.code, players: 5 } });
    // Laith (25) and the blocked player (30) have both gone faster at this field.
    expect(tile && tile.kind === "personalBest" ? tile.fasterAtField : null).toBe(2);
  });

  it("a match the player only said maybe to is not one to claim", async () => {
    const tile = await loadStatTile({
      userId: users.me,
      recent: [{ code: waiting!.code, phase: "ready", startLocal: waiting!.startLocal, myRsvp: "maybe", findRecordingId: 4242 }],
      upcoming: null,
      visiblePlayerIdsByMatch: new Map(),
      blockedIds: null,
    });
    expect(tile?.kind).not.toBe("friends");
  });
});
