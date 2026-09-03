import type { PublicPlayerHeatmap, PublicPlayerMatchStats } from "@workspace/api-client-react";

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