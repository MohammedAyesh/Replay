export type PlayerMetricKey =
  | "distanceKm"
  | "topSpeedKmh"
  | "touches"
  | "passesCompleted"
  | "dribblesWon"
  | "goals";

export type PlayerMetricValues = {
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  passesReceived: number | null;
  dribbles: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
  shots: number | null;
  goals: number | null;
};

export type CompetitionPlayer = PlayerMetricValues & {
  playerId: number;
  name: string;
  team: string | null;
  claimed: boolean;
  personalBestMetrics?: PlayerMetricKey[];
};

export type CompetitionAward = {
  key: "motm" | "distance" | "speed" | "touches" | "passes" | "dribbles" | "goals";
  playerIds: number[];
  value: number | null;
  personalBest: boolean;
};

export type CompetitionCallout =
  | { kind: "outran"; outran: number; total: number }
  | { kind: "speed-beaten"; otherPlayerId: number; gap: number }
  | { kind: "team-dribbles-lead" };

export type PlayerFormHistoryRow = {
  matchId: number;
  code: string;
  startLocal: string;
  stats: PlayerMetricValues;
};

export type PlayerForm = {
  matchesUsed: number;
  averages: PlayerMetricValues;
  bests: PlayerMetricValues;
  lastFive: PlayerFormHistoryRow[];
};

export function historyBeforeMatch(
  history: PlayerFormHistoryRow[],
  matchStartLocal: string,
): PlayerFormHistoryRow[] {
  return history.filter((row) => row.startLocal < matchStartLocal);
}

export function canViewMatchPlayerRows(input: {
  viewer: { id: number; isAdmin: boolean; isGuest: boolean } | null;
  captainUserId: number | null;
  isFieldOwner: boolean;
  roster: Array<{ userId: number | null; rsvp: string }>;
}): boolean {
  const { viewer, captainUserId, isFieldOwner, roster } = input;
  if (!viewer || viewer.isGuest) return false;
  return viewer.isAdmin
    || captainUserId === viewer.id
    || isFieldOwner
    || roster.some((player) => player.userId === viewer.id && player.rsvp === "in");
}

const FORM_METRICS: Array<keyof PlayerMetricValues> = [
  "minutes",
  "distanceKm",
  "topSpeedKmh",
  "touches",
  "passesTried",
  "passesCompleted",
  "passesReceived",
  "dribbles",
  "dribblesWon",
  "dribblesLost",
  "shots",
  "goals",
];

const BEST_METRICS: PlayerMetricKey[] = [
  "distanceKm",
  "topSpeedKmh",
  "touches",
  "passesCompleted",
  "dribblesWon",
  "goals",
];

const AWARD_METRICS: Array<{
  key: Exclude<CompetitionAward["key"], "motm">;
  metric: PlayerMetricKey;
  minimum?: number;
}> = [
  { key: "distance", metric: "distanceKm" },
  { key: "speed", metric: "topSpeedKmh" },
  { key: "touches", metric: "touches" },
  { key: "passes", metric: "passesCompleted" },
  { key: "dribbles", metric: "dribblesWon", minimum: 3 },
  { key: "goals", metric: "goals" },
];

function roundFormAverage(metric: keyof PlayerMetricValues, value: number): number {
  return Math.round(value * (metric === "distanceKm" ? 100 : 10)) / (metric === "distanceKm" ? 100 : 10);
}

export function personalBestMetrics(
  current: PlayerMetricValues,
  previous: PlayerMetricValues[],
): PlayerMetricKey[] {
  if (!previous.length) return [];
  return BEST_METRICS.filter((metric) => {
    const value = current[metric];
    if (value === null || value <= 0) return false;
    const historical = previous
      .map((stats) => stats[metric])
      .filter((candidate): candidate is number => candidate !== null);
    return historical.length > 0 && value >= Math.max(...historical);
  });
}

export function competitionAwards(
  players: CompetitionPlayer[],
  motmPlayerIds: number[] = [],
): CompetitionAward[] {
  const claimed = players.filter((player) => player.claimed);
  if (claimed.length < 2) return [];

  const eligible = claimed.filter((player) => player.minutes !== null && player.minutes >= 10);
  if (!eligible.length) return [];
  const eligibleIds = new Set(eligible.map((player) => player.playerId));
  const byPlayerId = new Map(eligible.map((player) => [player.playerId, player]));
  const awards: CompetitionAward[] = [];
  const motmWinners = Array.from(new Set(motmPlayerIds)).filter((id) => eligibleIds.has(id));
  if (motmWinners.length) awards.push({ key: "motm", playerIds: motmWinners, value: null, personalBest: false });

  for (const { key, metric, minimum = 0 } of AWARD_METRICS) {
    const available = eligible
      .map((player) => ({ playerId: player.playerId, value: player[metric] }))
      .filter((row): row is { playerId: number; value: number } => row.value !== null && row.value >= minimum);
    if (!available.length) continue;
    const top = Math.max(...available.map((row) => row.value));
    if (top <= 0) continue;
    const playerIds = available.filter((row) => row.value === top).map((row) => row.playerId);
    awards.push({
      key,
      playerIds,
      value: top,
      personalBest: playerIds.some((id) => byPlayerId.get(id)?.personalBestMetrics?.includes(metric) ?? false),
    });
  }
  return awards;
}

export function competitionCallouts(
  players: CompetitionPlayer[],
  viewerPlayerId: number | null,
): CompetitionCallout[] {
  if (viewerPlayerId === null) return [];
  const claimed = players.filter((player) => player.claimed);
  const viewer = claimed.find((player) => player.playerId === viewerPlayerId);
  if (!viewer) return [];

  const ranked: Array<{ callout: CompetitionCallout; margin: number }> = [];
  const distancePeers = claimed.filter((player) => player.playerId !== viewer.playerId && player.distanceKm !== null);
  if (viewer.distanceKm !== null && viewer.distanceKm > 0 && distancePeers.length > 0) {
    const outrun = distancePeers.filter((player) => player.distanceKm! < viewer.distanceKm!);
    if (outrun.length > 0) {
      const nearestPassed = Math.max(...outrun.map((player) => player.distanceKm!));
      ranked.push({
        callout: { kind: "outran", outran: outrun.length, total: distancePeers.length },
        margin: (viewer.distanceKm - nearestPassed) / Math.max(viewer.distanceKm, 0.1),
      });
    }
  }

  if (viewer.topSpeedKmh !== null && viewer.topSpeedKmh > 0) {
    const faster = claimed
      .filter((player) => player.playerId !== viewer.playerId && player.topSpeedKmh !== null && player.topSpeedKmh > viewer.topSpeedKmh!)
      .sort((a, b) => (b.topSpeedKmh ?? 0) - (a.topSpeedKmh ?? 0));
    const fastest = faster[0];
    if (fastest?.topSpeedKmh !== null && fastest?.topSpeedKmh !== undefined) {
      const gap = Math.round((fastest.topSpeedKmh - viewer.topSpeedKmh) * 10) / 10;
      if (gap > 0) {
        ranked.push({
          callout: { kind: "speed-beaten", otherPlayerId: fastest.playerId, gap },
          margin: gap / Math.max(fastest.topSpeedKmh, 1),
        });
      }
    }
  }

  if (viewer.team !== null && viewer.dribblesWon !== null && viewer.dribblesWon > 0) {
    const teammates = claimed.filter((player) =>
      player.playerId !== viewer.playerId && player.team === viewer.team,
    );
    if (teammates.length > 0 && teammates.every((player) => player.dribblesWon !== null)) {
      const bestTeammate = Math.max(...teammates.map((player) => player.dribblesWon!));
      if (viewer.dribblesWon >= bestTeammate) {
        ranked.push({
          callout: { kind: "team-dribbles-lead" },
          margin: (viewer.dribblesWon - bestTeammate) / Math.max(viewer.dribblesWon, 1),
        });
      }
    }
  }

  return ranked
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 3)
    .map(({ callout }) => callout);
}

export function playerForm(history: PlayerFormHistoryRow[]): PlayerForm | null {
  if (!history.length) return null;
  const lastFive = history.slice(0, 5);
  const averages = {} as PlayerMetricValues;
  const bests = {} as PlayerMetricValues;
  for (const metric of FORM_METRICS) {
    const recentValues = lastFive
      .map((row) => row.stats[metric])
      .filter((value): value is number => value !== null);
    const allValues = history
      .map((row) => row.stats[metric])
      .filter((value): value is number => value !== null);
    averages[metric] = recentValues.length
      ? roundFormAverage(metric, recentValues.reduce((sum, value) => sum + value, 0) / recentValues.length)
      : null;
    bests[metric] = allValues.length ? Math.max(...allValues) : null;
  }
  return { matchesUsed: lastFive.length, averages, bests, lastFive };
}