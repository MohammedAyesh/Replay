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
  type PlayerMetricValues,
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

export async function playerMatchForm(
  userId: number,
): Promise<(PlayerForm & { previousAverages: PlayerMetricValues | null; previousMatchesUsed: number }) | null> {
  const history = await historyForUsers([userId]);
  const rows = asFormHistory(history.get(userId) ?? []);
  const form = playerForm(rows);
  if (!form) return null;
  const priorForm = playerForm(rows.slice(1, 6));
  return {
    ...form,
    previousAverages: priorForm?.averages ?? null,
    previousMatchesUsed: priorForm?.matchesUsed ?? 0,
  };
}

export type CachedMatchCompetitionSummary = {
  awardKeys: Array<Exclude<ReturnType<typeof competitionAwards>[number]["key"], "motm">>;
  bestRank: { metric: PlayerMetricKey; rank: number } | null;
};

const CACHED_RANK_METRICS: PlayerMetricKey[] = [
  "distanceKm",
  "topSpeedKmh",
  "touches",
  "passesCompleted",
  "dribblesWon",
  "goals",
];

/** Derive a viewer's match badges strictly from already-computed cache rows. */
export async function cachedCompetitionSummariesForUser(
  userId: number,
  visiblePlayerIdsByMatch: ReadonlyMap<number, number[]>,
): Promise<Map<number, CachedMatchCompetitionSummary>> {
  const uniqueMatchIds = sortedUnique(Array.from(visiblePlayerIdsByMatch.keys()));
  const summaries = new Map<number, CachedMatchCompetitionSummary>();
  if (!uniqueMatchIds.length) return summaries;

  const rows = await db.select({
    matchId: matchPlayerStatsCacheTable.matchId,
    matchPlayerId: matchPlayerStatsCacheTable.matchPlayerId,
    userId: matchPlayerStatsCacheTable.userId,
    team: matchPlayersTable.team,
    stats: matchPlayerStatsCacheTable.stats,
  }).from(matchPlayerStatsCacheTable)
    .innerJoin(matchPlayersTable, and(
      eq(matchPlayersTable.id, matchPlayerStatsCacheTable.matchPlayerId),
      eq(matchPlayersTable.userId, matchPlayerStatsCacheTable.userId),
    ))
    .where(inArray(matchPlayerStatsCacheTable.matchId, uniqueMatchIds));

  const rowsByMatch = new Map<number, typeof rows>();
  for (const row of rows) {
    const matchRows = rowsByMatch.get(row.matchId) ?? [];
    matchRows.push(row);
    rowsByMatch.set(row.matchId, matchRows);
  }

  for (const [matchId, matchRows] of rowsByMatch) {
    const visibleIds = new Set(visiblePlayerIdsByMatch.get(matchId) ?? []);
    const visibleRows = matchRows.filter((row) => visibleIds.has(row.matchPlayerId));
    const players: CompetitionPlayer[] = visibleRows.map((row) => ({
      ...row.stats,
      playerId: row.matchPlayerId,
      name: "",
      team: row.team,
      claimed: true,
    }));
    const viewer = visibleRows.find((row) => row.userId === userId);
    if (!viewer) continue;

    const awardKeys = competitionAwards(players)
      .filter((award) => award.key !== "motm" && award.playerIds.includes(viewer.matchPlayerId))
      .map((award) => award.key as CachedMatchCompetitionSummary["awardKeys"][number]);
    const viewerStats = players.find((player) => player.playerId === viewer.matchPlayerId)!;
    const rankCandidates = CACHED_RANK_METRICS.flatMap((metric) => {
      const value = viewerStats[metric];
      if (value === null) return [];
      const rank = 1 + players.filter((player) => player[metric] !== null && player[metric]! > value).length;
      return [{ metric, rank }];
    }).sort((a, b) =>
      a.rank - b.rank || CACHED_RANK_METRICS.indexOf(a.metric) - CACHED_RANK_METRICS.indexOf(b.metric),
    );

    summaries.set(matchId, {
      awardKeys,
      bestRank: rankCandidates[0] ?? null,
    });
  }
  return summaries;
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
