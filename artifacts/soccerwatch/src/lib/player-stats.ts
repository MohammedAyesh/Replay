import type { PublicPlayerHeatmap, PublicPlayerMatchStats, PublicPlayerMeasuredMatch } from "@workspace/api-client-react";

export function aggregatePitchHeatmaps(
  matches: Pick<PublicPlayerMatchStats, "heatmap">[],
): PublicPlayerHeatmap | null {
  if (matches.length === 0 || matches.some((match) => match.heatmap.coordinateSpace !== "pitch")) {
    return null;
  }

  const byCell = new Map<string, { x: number; y: number; weight: number }>();
  for (const match of matches) {
    for (const cell of match.heatmap.cells) {
      const key = `${cell.x}:${cell.y}`;
      const current = byCell.get(key);
      byCell.set(key, {
        x: cell.x,
        y: cell.y,
        weight: (current?.weight ?? 0) + cell.weight,
      });
    }
  }

  const totalWeight = [...byCell.values()].reduce((sum, cell) => sum + cell.weight, 0);
  return {
    coordinateSpace: "pitch",
    cells: [...byCell.values()]
      .map((cell) => ({
        ...cell,
        weight: totalWeight > 0 ? Math.round((cell.weight / totalWeight) * 10000) / 10000 : 0,
      }))
      .sort((a, b) => b.weight - a.weight),
  };
}

export function shouldShowPerMatchHeatmaps(
  matches: Pick<PublicPlayerMatchStats, "heatmap">[],
): boolean {
  return matches.some((match) => match.heatmap.coordinateSpace === "camera");
}

export function formatDistance(value: number | null, unavailableLabel: string): string {
  return value === null ? unavailableLabel : `${Math.round(value).toLocaleString()} m`;
}

export function shouldShowEmptyStatsCta(
  profileId: number,
  viewerId: number | null | undefined,
  isGuest: boolean,
): boolean {
  return !isGuest && viewerId === profileId;
}

export type MeasuredFigures = Pick<PublicPlayerMeasuredMatch,
  "minutes" | "distanceKm" | "topSpeedKmh" | "touches" | "passesTried" | "passesCompleted" | "shots" | "goals" | "dribbles" | "dribblesWon" | "dribblesLost">;

/**
 * Puts each measured match beside the claimed recording it was measured on:
 * the newest claimed row whose recording is one of the match's. A match
 * spanning two claimed recordings is shown once, so nothing is counted twice;
 * a match with no claimed row on the page is returned in `unattached`.
 */
export function attachMeasured(
  claimRows: Pick<PublicPlayerMatchStats, "recordingId">[],
  measured: PublicPlayerMeasuredMatch[],
): { byRecording: Map<number, PublicPlayerMeasuredMatch>; unattached: PublicPlayerMeasuredMatch[] } {
  const byRecording = new Map<number, PublicPlayerMeasuredMatch>();
  const unattached: PublicPlayerMeasuredMatch[] = [];
  for (const match of measured) {
    const row = claimRows.find((claim) => match.recordingIds.includes(claim.recordingId) && !byRecording.has(claim.recordingId));
    if (row) byRecording.set(row.recordingId, match);
    else unattached.push(match);
  }
  return { byRecording, unattached };
}

export type MeasuredTile =
  | { key: "topSpeed"; value: number }
  | { key: "distance"; value: number }
  | { key: "goals"; value: number }
  | { key: "shots"; value: number }
  | { key: "passes"; value: number; tried: number | null }
  | { key: "touches"; value: number }
  | { key: "dribbles"; value: number; won: number | null; lost: number | null };

/**
 * The figures a profile can show from some measured stats, in a fixed order.
 * A figure that was not measured is left out: never shown as "Unavailable".
 */
export function measuredTiles(figures: MeasuredFigures | null | undefined, opts: { distance?: boolean } = {}): MeasuredTile[] {
  if (!figures) return [];
  const tiles: MeasuredTile[] = [];
  if (figures.topSpeedKmh !== null) tiles.push({ key: "topSpeed", value: figures.topSpeedKmh });
  if (opts.distance && figures.distanceKm !== null) tiles.push({ key: "distance", value: figures.distanceKm });
  if (figures.goals !== null) tiles.push({ key: "goals", value: figures.goals });
  if (figures.shots !== null) tiles.push({ key: "shots", value: figures.shots });
  if (figures.passesCompleted !== null) tiles.push({ key: "passes", value: figures.passesCompleted, tried: figures.passesTried });
  if (figures.touches !== null) tiles.push({ key: "touches", value: figures.touches });
  if (figures.dribbles !== null) tiles.push({ key: "dribbles", value: figures.dribbles, won: figures.dribblesWon, lost: figures.dribblesLost });
  return tiles;
}