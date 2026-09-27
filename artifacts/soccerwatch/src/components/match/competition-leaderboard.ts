export type CompetitionMetricKey =
  | "distanceKm"
  | "topSpeedKmh"
  | "touches"
  | "passesCompleted"
  | "dribblesWon"
  | "goals";

export type CompetitionLeaderboardPlayer = {
  playerId: number;
  name: string;
} & Record<CompetitionMetricKey, number | null>;

export type PodiumPlace = 1 | 2 | 3;

export function rankCompetitionPlayers<T extends CompetitionLeaderboardPlayer>(
  players: readonly T[],
  metric: CompetitionMetricKey,
  viewerId: number | null,
) {
  const sorted = players
    .filter((player) => player[metric] !== null)
    .slice()
    .sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0));
  const ranks = new Map<number, number>();
  sorted.forEach((player, index) => {
    const previous = index > 0 ? sorted[index - 1] : null;
    ranks.set(
      player.playerId,
      previous && previous[metric] === player[metric]
        ? ranks.get(previous.playerId) ?? index + 1
        : index + 1,
    );
  });

  const viewer = sorted.find((player) => player.playerId === viewerId) ?? null;
  const viewerRank = viewer ? ranks.get(viewer.playerId) ?? null : null;
  const above = viewerRank !== null && viewerRank > 1
    ? sorted.find((player) => (ranks.get(player.playerId) ?? Number.POSITIVE_INFINITY) < viewerRank) ?? null
    : null;

  return { sorted, ranks, viewer, viewerRank, above };
}

export function podiumPlaces<T>(sorted: readonly T[]): Array<{ place: PodiumPlace; player: T | null }> {
  return [
    { place: 2, player: sorted[1] ?? null },
    { place: 1, player: sorted[0] ?? null },
    { place: 3, player: sorted[2] ?? null },
  ];
}

export function visibleLeaderboardRows<T extends { playerId: number }>(
  sorted: readonly T[],
  viewerId: number | null,
  maxRows = 8,
) {
  const topRows = sorted.slice(0, maxRows);
  const viewer = sorted.find((player) => player.playerId === viewerId) ?? null;
  const pinnedViewer = viewer && !topRows.some((player) => player.playerId === viewer.playerId)
    ? viewer
    : null;
  return { topRows, pinnedViewer };
}

export function metricDeltaDirection(
  value: number | null | undefined,
  average: number | null | undefined,
): "up" | "down" | null {
  if (value == null || average == null) return null;
  if (value > average) return "up";
  if (value < average) return "down";
  return null;
}