import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  db,
  footageRequestsTable,
  matchPlayerStatsCacheTable,
  matchPlayersTable,
  matchRoomsTable,
  type MatchPlayer,
  type MatchPlayerStatsCacheValue,
} from "@workspace/db";
import type { MatchPlayerStats } from "./matchFeed";
import { logger } from "./logger";
import {
  competitionAwards,
  competitionCallouts,
  historyBeforeMatch,
  personalBestMetrics,
  playerForm,
  type CompetitionPlayer,
  type PlayerForm,
  type PlayerFormHistoryRow,
  type PlayerMetricKey,
} from "./matchStatsRules";

export type MatchStatsCacheFingerprint = {
  matchId: number;
  matchPlayerId: number;
  userId: number;
  recordingIds: number[];
  fingerprint: string;
};

export type MatchStatsCacheInput = MatchStatsCacheFingerprint & {
  stats: MatchPlayerStatsCacheValue;
};

function sortedUnique(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

export async function matchStatsCacheIsCurrent(
  matchId: number,
  expected: MatchStatsCacheFingerprint[],
): Promise<boolean> {
  const rows = await db.select({
    matchPlayerId: matchPlayerStatsCacheTable.matchPlayerId,
    userId: matchPlayerStatsCacheTable.userId,
    recordingIds: matchPlayerStatsCacheTable.recordingIds,
    fingerprint: matchPlayerStatsCacheTable.fingerprint,
  }).from(matchPlayerStatsCacheTable)
    .where(eq(matchPlayerStatsCacheTable.matchId, matchId));

  if (rows.length !== expected.length) return false;
  const actualByPlayer = new Map(rows.map((row) => [row.matchPlayerId, row]));
  return expected.every((entry) => {
    const actual = actualByPlayer.get(entry.matchPlayerId);
    return Boolean(
      actual
      && actual.userId === entry.userId
      && actual.fingerprint === entry.fingerprint
      && JSON.stringify(sortedUnique(actual.recordingIds)) === JSON.stringify(sortedUnique(entry.recordingIds)),
    );
  });
}

export async function persistMatchStatsCache(matchId: number, inputs: MatchStatsCacheInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    if (inputs.length) {
      await tx.insert(matchPlayerStatsCacheTable).values(inputs.map((input) => ({
        matchId: input.matchId,
        matchPlayerId: input.matchPlayerId,
        userId: input.userId,
        recordingIds: sortedUnique(input.recordingIds),
        fingerprint: input.fingerprint,
        stats: input.stats,
        computedAt: new Date(),
      }))).onConflictDoUpdate({
        target: [matchPlayerStatsCacheTable.matchId, matchPlayerStatsCacheTable.matchPlayerId],
        set: {
          userId: sql`excluded.user_id`,
          recordingIds: sql`excluded.recording_ids`,
          fingerprint: sql`excluded.fingerprint`,
          stats: sql`excluded.stats`,
          computedAt: new Date(),
        },
      });
      const activePlayerIds = inputs.map((input) => input.matchPlayerId);
      await tx.delete(matchPlayerStatsCacheTable).where(and(
        eq(matchPlayerStatsCacheTable.matchId, matchId),
        notInArray(matchPlayerStatsCacheTable.matchPlayerId, activePlayerIds),
      ));
    } else {
      await tx.delete(matchPlayerStatsCacheTable)
        .where(eq(matchPlayerStatsCacheTable.matchId, matchId));
    }
  });
}

export async function invalidateMatchStatsCacheForRecording(recordingId: number): Promise<void> {
  try {
    await db.delete(matchPlayerStatsCacheTable).where(
      sql`${matchPlayerStatsCacheTable.recordingIds} @> ARRAY[${recordingId}]::integer[]`,
    );
  } catch (error) {
    // The feature remains optional until its additive migration is applied.
    logger.warn({ recordingId, err: error }, "Could not invalidate match stats cache");
  }
}

type CachedHistoryRow = {
  userId: number;
  matchId: number;
  code: string;
  startLocal: string;
  stats: MatchPlayerStatsCacheValue;
};

async function historyForUsers(
  userIds: number[],
  excludeMatchId?: number,
): Promise<Map<number, CachedHistoryRow[]>> {
  const uniqueUserIds = sortedUnique(userIds);
  const byUser = new Map<number, CachedHistoryRow[]>();
  if (!uniqueUserIds.length) return byUser;
  const conditions = [inArray(matchPlayerStatsCacheTable.userId, uniqueUserIds)];
  if (excludeMatchId !== undefined) {
    conditions.push(ne(matchPlayerStatsCacheTable.matchId, excludeMatchId));
  }
  const rows = await db.select({
    userId: matchPlayerStatsCacheTable.userId,
    matchId: matchPlayerStatsCacheTable.matchId,
    code: matchRoomsTable.code,
    startLocal: footageRequestsTable.startLocal,
    stats: matchPlayerStatsCacheTable.stats,
  }).from(matchPlayerStatsCacheTable)
    .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayerStatsCacheTable.matchId))
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .where(and(...conditions))
    .orderBy(desc(footageRequestsTable.startLocal), desc(matchPlayerStatsCacheTable.computedAt));
  for (const row of rows) {
    const entries = byUser.get(row.userId) ?? [];
    entries.push(row);
    byUser.set(row.userId, entries);
  }
  return byUser;
}

function asFormHistory(rows: CachedHistoryRow[]): PlayerFormHistoryRow[] {
  return rows.map(({ matchId, code, startLocal, stats }) => ({
    matchId,
    code,
    startLocal,
    stats,
  }));
}

export async function playerMatchForm(userId: number): Promise<PlayerForm | null> {
  const history = await historyForUsers([userId]);
  return playerForm(asFormHistory(history.get(userId) ?? []));
}

export type MatchCompetition = {
  viewerPlayerId: number | null;
  awards: ReturnType<typeof competitionAwards>;
  callouts: ReturnType<typeof competitionCallouts>;
  personalForm: PlayerForm | null;
};

export async function buildMatchCompetition(input: {
  matchId: number;
  matchStartLocal: string;
  players: MatchPlayerStats[];
  roster: MatchPlayer[];
  viewerId: number;
  motmPlayerIds: number[];
}): Promise<{ players: Array<MatchPlayerStats & { personalBestMetrics: PlayerMetricKey[] }>; competition: MatchCompetition }> {
  const { matchId, matchStartLocal, players, roster, viewerId, motmPlayerIds } = input;
  const userByPlayerId = new Map(roster.map((player) => [player.id, player.userId]));
  const userIds = sortedUnique([
    viewerId,
    ...players
      .filter((player) => player.claimed)
      .map((player) => userByPlayerId.get(player.playerId))
      .filter((userId): userId is number => userId !== null && userId !== undefined),
  ]);
  let history = new Map<number, CachedHistoryRow[]>();
  try {
    history = await historyForUsers(userIds, matchId);
  } catch (error) {
    logger.error({ matchId, err: error }, "Could not read player match stats history");
  }

  const enriched = players.map((player) => {
    const userId = userByPlayerId.get(player.playerId);
    const previousRows = userId
      ? historyBeforeMatch(asFormHistory(history.get(userId) ?? []), matchStartLocal)
      : [];
    const previous = previousRows.map((row) => row.stats);
    const snapshot: CompetitionPlayer = player;
    return {
      ...player,
      personalBestMetrics: userId && player.claimed
        ? personalBestMetrics(snapshot, previous)
        : [],
    };
  });
  const visibleCompetitionPlayers: CompetitionPlayer[] = enriched;
  const viewerRosterPlayer = roster.find((player) => player.userId === viewerId);
  const viewerHistory = historyBeforeMatch(asFormHistory(history.get(viewerId) ?? []), matchStartLocal);
  return {
    players: enriched,
    competition: {
      viewerPlayerId: viewerRosterPlayer?.id ?? null,
      awards: competitionAwards(visibleCompetitionPlayers, motmPlayerIds),
      callouts: competitionCallouts(visibleCompetitionPlayers, viewerRosterPlayer?.id ?? null),
      personalForm: playerForm(viewerHistory),
    },
  };
}
