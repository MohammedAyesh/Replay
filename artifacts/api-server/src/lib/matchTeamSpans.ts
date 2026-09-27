export type TeamSpanTeam = "A" | "B" | "C" | null;
export type TeamSpanSource = "captain" | "self" | "claim";

export interface TeamSpanAtTime {
  id: number;
  fromOffsetSec: number;
  toOffsetSec?: number | null;
  team: TeamSpanTeam;
  source: TeamSpanSource | string;
  createdAt: Date | string | number;
}

/**
 * Resolve the answer for one instant. Manager/self assertions outrank imported
 * claims; within a tier the latest covering span wins. A null team is an
 * intentional answer (sat out), not absence of an answer.
 */
export function teamAtTime(baseTeam: TeamSpanTeam, spans: readonly TeamSpanAtTime[], offsetSec: number): TeamSpanTeam {
  const covering = spans.filter((span) =>
    span.fromOffsetSec <= offsetSec
    && (span.toOffsetSec == null || span.toOffsetSec > offsetSec));
  covering.sort((a, b) => {
    const priority = (source: string) => source === "claim" ? 0 : 1;
    return priority(b.source) - priority(a.source)
      || b.fromOffsetSec - a.fromOffsetSec
      || timeValue(b.createdAt) - timeValue(a.createdAt)
      || b.id - a.id;
  });
  return covering.length ? covering[0].team : baseTeam;
}

function timeValue(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
}