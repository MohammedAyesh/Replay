/**
 * Loads what the Home stat tile is chosen from (lib/homeStatTile.ts), all of
 * it from rows already computed: the per-match stats cache, the rooms and
 * their rosters. Nothing here recomputes a match.
 *
 * Who sees what:
 *   - the player's own numbers, always (as the personal form already does);
 *   - other players' numbers from a match only where the viewer may see that
 *     match's player rows (visiblePlayerIdsByMatch, built by /me/matches from
 *     the stats access and roster rules), never from blocked players;
 *   - the field's monthly distance board only for people the player has
 *     shared a match with, as totals, never per match.
 */

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import {
  claimMatchProgressTable,
  db,
  fieldsTable,
  footageRequestsTable,
  matchPlayerStatsCacheTable,
  matchPlayersTable,
  matchRoomsTable,
  usersTable,
} from "@workspace/db";
import { pickStatTiles, type HomeTileInput, type StatTile, type TileMatchRef, type TilePeer } from "./homeStatTile";

type RecentItem = {
  code: string;
  phase: string;
  startLocal: string;
  myRsvp?: string | null;
  findRecordingId?: number | null;
};

const HISTORY_LIMIT = 60;

/** "YYYY-MM-DD HH:MM" now in Amman (UTC+3, no DST). */
export function ammanNowLocal(now = Date.now()): string {
  return new Date(now + 3 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

function watchFor(request: { status: string; shareToken: string | null; shareRevoked: boolean; shareExpiresAt: Date | null }, code: string): string | null {
  const active = (request.status === "ready" || request.status === "partial")
    && Boolean(request.shareToken) && !request.shareRevoked
    && Boolean(request.shareExpiresAt) && request.shareExpiresAt!.getTime() > Date.now();
  return active ? `/w/${request.shareToken}?m=${code}` : null;
}

async function inCounts(matchIds: number[]): Promise<Map<number, number>> {
  if (!matchIds.length) return new Map();
  const rows = await db.select({ matchId: matchPlayersTable.matchId, n: sql<number>`count(*)::int` })
    .from(matchPlayersTable)
    .where(and(inArray(matchPlayersTable.matchId, matchIds), eq(matchPlayersTable.rsvp, "in")))
    .groupBy(matchPlayersTable.matchId);
  return new Map(rows.map((row) => [row.matchId, Number(row.n)]));
}

async function peersOf(matchId: number, viewerId: number, visibleIds: number[], blocked: Set<number>): Promise<TilePeer[]> {
  if (!visibleIds.length) return [];
  const rows = await db.select({
    matchPlayerId: matchPlayerStatsCacheTable.matchPlayerId,
    userId: matchPlayerStatsCacheTable.userId,
    stats: matchPlayerStatsCacheTable.stats,
    name: matchPlayersTable.displayName,
    team: matchPlayersTable.team,
  }).from(matchPlayerStatsCacheTable)
    .innerJoin(matchPlayersTable, eq(matchPlayersTable.id, matchPlayerStatsCacheTable.matchPlayerId))
    .where(and(eq(matchPlayerStatsCacheTable.matchId, matchId), inArray(matchPlayerStatsCacheTable.matchPlayerId, visibleIds)));
  return rows
    .filter((row) => row.userId === viewerId || !blocked.has(row.userId))
    .map((row) => ({ ...row, me: row.userId === viewerId }));
}

type StatTileLoadInput = {
  userId: number;
  recent: RecentItem[];
  upcoming: { code: string; startLocal: string; field: { name: string } } | null;
  visiblePlayerIdsByMatch: ReadonlyMap<number, number[]>;
  blockedIds: Set<number> | null;
};

/** The single most impressive tile (the first slide of the carousel). */
export async function loadStatTile(input: StatTileLoadInput): Promise<StatTile | null> {
  return (await loadStatTiles(input, 1))[0] ?? null;
}

/** Home's stats carousel: up to `limit` tiles, best first, one per topic. */
export async function loadStatTiles(input: StatTileLoadInput, limit = 5): Promise<StatTile[]> {
  const { userId, recent, visiblePlayerIdsByMatch } = input;
  const blocked = input.blockedIds ?? new Set<number>();
  const nowLocal = ammanNowLocal();

  // The player's own matches, newest first.
  const mine = await db.select({
    matchId: matchPlayerStatsCacheTable.matchId,
    stats: matchPlayerStatsCacheTable.stats,
    code: matchRoomsTable.code,
    fieldId: matchRoomsTable.fieldId,
    fieldName: fieldsTable.name,
    startLocal: footageRequestsTable.startLocal,
    status: footageRequestsTable.status,
    shareToken: footageRequestsTable.shareToken,
    shareRevoked: footageRequestsTable.shareRevoked,
    shareExpiresAt: footageRequestsTable.shareExpiresAt,
  }).from(matchPlayerStatsCacheTable)
    .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayerStatsCacheTable.matchId))
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
    .where(eq(matchPlayerStatsCacheTable.userId, userId))
    .orderBy(desc(footageRequestsTable.startLocal))
    .limit(HISTORY_LIMIT);

  // Matches the player was in but has no numbers for yet, newest first.
  const claimedCodes = new Set(mine.map((row) => row.code));
  const waiting = recent
    .filter((item) => ["ready", "processing", "expired"].includes(item.phase) && item.myRsvp === "in" && item.findRecordingId && !claimedCodes.has(item.code))
    .sort((a, b) => b.startLocal.localeCompare(a.startLocal))
    .slice(0, 3);
  // A claim in progress (or one whose numbers are still being worked out) isn't a match to claim.
  const started = waiting.length
    ? await db.select({ recordingId: claimMatchProgressTable.recordingId })
      .from(claimMatchProgressTable)
      .where(and(
        eq(claimMatchProgressTable.userId, userId),
        inArray(claimMatchProgressTable.recordingId, waiting.map((item) => item.findRecordingId!)),
        sql`(${claimMatchProgressTable.completed} or ${claimMatchProgressTable.claimedPercent} >= 50)`,
      ))
    : [];
  const startedIds = new Set(started.map((row) => row.recordingId));
  const waitingRooms = waiting.length
    ? await db.select({
      matchId: matchRoomsTable.id,
      code: matchRoomsTable.code,
      fieldId: matchRoomsTable.fieldId,
      fieldName: fieldsTable.name,
      startLocal: footageRequestsTable.startLocal,
      status: footageRequestsTable.status,
      shareToken: footageRequestsTable.shareToken,
      shareRevoked: footageRequestsTable.shareRevoked,
      shareExpiresAt: footageRequestsTable.shareExpiresAt,
    }).from(matchRoomsTable)
      .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
      .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
      .where(inArray(matchRoomsTable.code, waiting.map((item) => item.code)))
    : [];

  const counts = await inCounts([...new Set([...mine.map((row) => row.matchId), ...waitingRooms.map((row) => row.matchId)])]);
  const ref = (row: { matchId: number; code: string; startLocal: string; fieldId: number; fieldName: string; status: string; shareToken: string | null; shareRevoked: boolean; shareExpiresAt: Date | null }): TileMatchRef => ({
    matchId: row.matchId,
    code: row.code,
    startLocal: row.startLocal,
    fieldId: row.fieldId,
    fieldName: row.fieldName,
    players: counts.get(row.matchId) ?? 0,
    watch: watchFor(row, row.code),
  });

  const history = mine.map((row) => ({ match: ref(row), stats: row.stats }));
  const newest = history[0] ?? null;

  const lastPeers = newest && visiblePlayerIdsByMatch.has(newest.match.matchId)
    ? await peersOf(newest.match.matchId, userId, visiblePlayerIdsByMatch.get(newest.match.matchId) ?? [], blocked)
    : null;

  // How many players at the field have ever gone faster than the newest top speed.
  let fieldFaster: number | null = null;
  const top = newest?.stats.topSpeedKmh;
  if (newest && typeof top === "number") {
    const [row] = await db.select({ n: sql<number>`count(distinct ${matchPlayerStatsCacheTable.userId})::int` })
      .from(matchPlayerStatsCacheTable)
      .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayerStatsCacheTable.matchId))
      .where(and(
        eq(matchRoomsTable.fieldId, newest.match.fieldId),
        sql`${matchPlayerStatsCacheTable.userId} <> ${userId}`,
        sql`(${matchPlayerStatsCacheTable.stats}->>'topSpeedKmh')::float > ${top}`,
      ));
    fieldFaster = Number(row?.n ?? 0);
  }

  // This month's distance at the newest field, for the people the player has played with.
  let fieldMonth: HomeTileInput["fieldMonth"] = null;
  const month = nowLocal.slice(0, 7);
  if (newest && newest.match.startLocal.slice(0, 7) === month) {
    const sharedMatchIds = mine.map((row) => row.matchId);
    const coPlayers = await db.selectDistinct({ userId: matchPlayerStatsCacheTable.userId })
      .from(matchPlayerStatsCacheTable)
      .where(inArray(matchPlayerStatsCacheTable.matchId, sharedMatchIds));
    const people = coPlayers.map((row) => row.userId).filter((id) => id === userId || !blocked.has(id));
    if (people.length >= 3) {
      const totals = await db.select({
        userId: matchPlayerStatsCacheTable.userId,
        km: sql<number>`sum(coalesce((${matchPlayerStatsCacheTable.stats}->>'distanceKm')::float, 0))`,
        name: usersTable.name,
      }).from(matchPlayerStatsCacheTable)
        .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayerStatsCacheTable.matchId))
        .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
        .innerJoin(usersTable, eq(usersTable.id, matchPlayerStatsCacheTable.userId))
        .where(and(
          eq(matchRoomsTable.fieldId, newest.match.fieldId),
          like(footageRequestsTable.startLocal, `${month}-%`),
          inArray(matchPlayerStatsCacheTable.userId, people),
        ))
        .groupBy(matchPlayerStatsCacheTable.userId, usersTable.name);
      fieldMonth = {
        fieldName: newest.match.fieldName,
        month,
        rows: totals
          .filter((row) => Number(row.km) > 0)
          .map((row) => ({ userId: row.userId, name: (row.name ?? "").trim().split(/\s+/)[0] || "Player", distanceKm: Number(row.km), me: row.userId === userId })),
      };
    }
  }

  const unclaimed: HomeTileInput["unclaimed"] = [];
  for (const item of waiting) {
    if (startedIds.has(item.findRecordingId!)) continue;
    const room = waitingRooms.find((row) => row.code === item.code);
    if (!room) continue;
    const [claimedRow] = await db.select({ n: sql<number>`count(*)::int` })
      .from(matchPlayerStatsCacheTable)
      .where(eq(matchPlayerStatsCacheTable.matchId, room.matchId));
    const visible = visiblePlayerIdsByMatch.get(room.matchId);
    unclaimed.push({
      match: ref(room),
      findRecordingId: item.findRecordingId!,
      claimed: Number(claimedRow?.n ?? 0),
      peers: visible ? await peersOf(room.matchId, userId, visible, blocked) : null,
    });
  }

  return pickStatTiles({
    nowLocal,
    history,
    lastPeers,
    fieldMonth,
    fieldFaster,
    unclaimed,
    upcoming: input.upcoming ? { code: input.upcoming.code, startLocal: input.upcoming.startLocal, fieldName: input.upcoming.field.name } : null,
  }, limit);
}
