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
};

export type CompetitionAward = {
  key: "motm" | "distance" | "speed" | "touches" | "passes" | "dribbles" | "goals";
  playerIds: number[];
  value: number | null;
};

export type CompetitionCallout = {
  metric: PlayerMetricKey;
  leaderId: number;
  runnerUpId: number;
  leaderValue: number;
  runnerUpValue: number;
  gap: number;
};

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
}> = [
  { key: "distance", metric: "distanceKm" },
  { key: "speed", metric: "topSpeedKmh" },
  { key: "touches", metric: "touches" },
  { key: "passes", metric: "passesCompleted" },
  { key: "dribbles", metric: "dribblesWon" },
  { key: "goals", metric: "goals" },
];

function roundFormAverage(metric: keyof PlayerMetricValues, value: number): number {
  return Math.round(value * (metric === "distanceKm" ? 100 : 10)) / (metric === "distanceKm" ? 100 : 10);
}

export function personalBestMetrics(
  current: PlayerMetricValues,
  previous: PlayerMetricValues[],
): PlayerMetricKey[] {
  return BEST_METRICS.filter((metric) => {
    const value = current[metric];
    if (value === null || value <= 0) return false;
    const historical = previous
      .map((stats) => stats[metric])
      .filter((candidate): candidate is number => candidate !== null);
    return historical.length === 0 || value >= Math.max(...historical);
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
  const awards: CompetitionAward[] = [];
  const motmWinners = Array.from(new Set(motmPlayerIds)).filter((id) => eligibleIds.has(id));
  if (motmWinners.length) awards.push({ key: "motm", playerIds: motmWinners, value: null });

  for (const { key, metric } of AWARD_METRICS) {
    const available = eligible
      .map((player) => ({ playerId: player.playerId, value: player[metric] }))
      .filter((row): row is { playerId: number; value: number } => row.value !== null);
    if (!available.length) continue;
    const top = Math.max(...available.map((row) => row.value));
    if (top <= 0) continue;
    const playerIds = available.filter((row) => row.value === top).map((row) => row.playerId);
    awards.push({ key, playerIds, value: top });
  }
  return awards;
}

export function competitionCallouts(players: CompetitionPlayer[]): CompetitionCallout[] {
  const callouts: Array<CompetitionCallout & { relativeGap: number }> = [];
  for (const metric of BEST_METRICS) {
    const sorted = players
      .filter((player) => player.claimed && player[metric] !== null)
      .map((player) => ({ playerId: player.playerId, value: player[metric]! }))
      .sort((a, b) => b.value - a.value);
    if (sorted.length < 2 || sorted[0].value === sorted[1].value) continue;
    const gap = sorted[0].value - sorted[1].value;
    if (gap <= 0) continue;
    const precision = metric === "distanceKm" ? 100 : metric === "topSpeedKmh" ? 10 : 1;
    const roundedGap = Math.round(gap * precision) / precision;
    if (roundedGap <= 0) continue;
    callouts.push({
      metric,
      leaderId: sorted[0].playerId,
      runnerUpId: sorted[1].playerId,
      leaderValue: sorted[0].value,
      runnerUpValue: sorted[1].value,
      gap: roundedGap,
      relativeGap: gap / Math.max(Math.abs(sorted[0].value), metric === "distanceKm" ? 0.1 : 1),
    });
  }
  return callouts
    .sort((a, b) => b.relativeGap - a.relativeGap)
    .slice(0, 3)
    .map(({ relativeGap: _relativeGap, ...callout }) => callout);
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