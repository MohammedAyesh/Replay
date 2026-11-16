import type { TrainingSegment, TrainingSegmentLabel } from "@/lib/academy-training";

/**
 * Editing a training's parts: pure steps on a list of parts in time order. The coach plays to
 * a moment and starts a part there, moves an edge to "now", relabels, removes or joins parts.
 * Every step returns a new list, still in order and without overlaps.
 */

export function segmentColor(label: TrainingSegmentLabel): string {
  switch (label) {
    case "game": return "#36B89A";
    case "multi-ball drill": return "#3E8BC9";
    case "shooting / queue drill": return "#D4883A";
    case "warm-up": return "#8B78D9";
    case "team talk": return "#607080";
    case "break": return "#65666E";
    case "empty": return "#343943";
    case "drill": return "#CA5B7B";
    default: return "#737780";
  }
}

/** The labels a coach picks from, most used first. */
export const EDITABLE_LABELS: TrainingSegmentLabel[] = ["warm-up", "multi-ball drill", "shooting / queue drill", "drill", "game", "team talk", "break", "adults", "empty"];

const round = (n: number) => Math.round(n * 10) / 10;

export function tidy(parts: ReadonlyArray<TrainingSegment>): TrainingSegment[] {
  const sorted = parts.map((p) => ({ ...p, start: round(p.start), end: round(p.end) })).filter((p) => p.end - p.start >= 1).sort((a, b) => a.start - b.start);
  const out: TrainingSegment[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.start < last.end) last.end = p.start;
    if (last && last.end - last.start < 1) out.pop();
    out.push({ ...p });
  }
  return out;
}

/** Start a part at `t`: the part under it is cut there; otherwise the new part runs to the next one (or `end`). */
export function startPartAt(parts: ReadonlyArray<TrainingSegment>, t: number, label: TrainingSegmentLabel, end: number): TrainingSegment[] {
  const list = tidy(parts);
  const i = list.findIndex((p) => p.start <= t && t < p.end);
  if (i >= 0) {
    const cut = list[i];
    if (t - cut.start < 1) return tidy(list.map((p, j) => (j === i ? { ...p, label } : p)));
    return tidy([...list.slice(0, i), { ...cut, end: t }, { start: t, end: cut.end, label }, ...list.slice(i + 1)]);
  }
  const next = list.find((p) => p.start > t);
  return tidy([...list, { start: t, end: next ? next.start : end, label }]);
}

/** Move one edge of part `i` to `t`, pushing the neighbour's edge out of the way. */
export function moveEdge(parts: ReadonlyArray<TrainingSegment>, i: number, edge: "start" | "end", t: number): TrainingSegment[] {
  const list = tidy(parts).map((p) => ({ ...p }));
  const p = list[i];
  if (!p) return list;
  if (edge === "start") {
    p.start = Math.min(t, p.end - 1);
    for (let j = i - 1; j >= 0; j--) if (list[j].end > p.start) list[j].end = p.start;
  } else {
    p.end = Math.max(t, p.start + 1);
    for (let j = i + 1; j < list.length; j++) if (list[j].start < p.end) list[j].start = p.end;
  }
  return tidy(list);
}

export function relabel(parts: ReadonlyArray<TrainingSegment>, i: number, label: TrainingSegmentLabel): TrainingSegment[] {
  return tidy(parts).map((p, j) => (j === i ? { ...p, label } : p));
}

export function removePart(parts: ReadonlyArray<TrainingSegment>, i: number): TrainingSegment[] {
  return tidy(parts).filter((_, j) => j !== i);
}

/** Join part `i` with the next one: it keeps its label and runs to the next one's end. */
export function joinNext(parts: ReadonlyArray<TrainingSegment>, i: number): TrainingSegment[] {
  const list = tidy(parts);
  if (!list[i] || !list[i + 1]) return list;
  return tidy([...list.slice(0, i), { ...list[i], end: list[i + 1].end }, ...list.slice(i + 2)]);
}
