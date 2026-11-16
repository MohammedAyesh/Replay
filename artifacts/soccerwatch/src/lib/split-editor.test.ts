import { describe, expect, it } from "vitest";
import { joinNext, moveEdge, relabel, removePart, startPartAt, tidy } from "@/lib/split-editor";
import type { TrainingSegment } from "@/lib/academy-training";

const parts: TrainingSegment[] = [
  { start: 0, end: 600, label: "drill" },
  { start: 600, end: 1800, label: "game" },
  { start: 2000, end: 2400, label: "team talk" },
];

describe("split editor", () => {
  it("cuts the part under the playhead to start a new one there", () => {
    expect(startPartAt(parts, 120, "warm-up", 3600).slice(0, 2)).toEqual([
      { start: 0, end: 120, label: "drill" }, { start: 120, end: 600, label: "warm-up" },
    ]);
  });
  it("relabels a part when the new one would start at its very beginning", () => {
    expect(startPartAt(parts, 600.4, "shooting / queue drill", 3600)[1]).toEqual({ start: 600, end: 1800, label: "shooting / queue drill" });
  });
  it("fills a gap up to the next part, or to the end of the video", () => {
    expect(startPartAt(parts, 1900, "break", 3600)[2]).toEqual({ start: 1900, end: 2000, label: "break" });
    expect(startPartAt(parts, 3000, "adults", 3600).at(-1)).toEqual({ start: 3000, end: 3600, label: "adults" });
    expect(startPartAt([], 10, "warm-up", 300)).toEqual([{ start: 10, end: 300, label: "warm-up" }]);
  });
  it("moves an edge and pushes the neighbour out of the way", () => {
    expect(moveEdge(parts, 1, "start", 500).slice(0, 2)).toEqual([{ start: 0, end: 500, label: "drill" }, { start: 500, end: 1800, label: "game" }]);
    expect(moveEdge(parts, 1, "end", 2100).slice(1)).toEqual([{ start: 600, end: 2100, label: "game" }, { start: 2100, end: 2400, label: "team talk" }]);
  });
  it("relabels, removes and joins", () => {
    expect(relabel(parts, 0, "warm-up")[0].label).toBe("warm-up");
    expect(removePart(parts, 1)).toHaveLength(2);
    expect(joinNext(parts, 0)).toEqual([{ start: 0, end: 1800, label: "drill" }, { start: 2000, end: 2400, label: "team talk" }]);
  });
  it("keeps parts in order, at least a second long, without overlaps", () => {
    expect(tidy([{ start: 50, end: 80, label: "game" }, { start: 0, end: 60, label: "drill" }, { start: 90, end: 90.5, label: "break" }]))
      .toEqual([{ start: 0, end: 50, label: "drill" }, { start: 50, end: 80, label: "game" }]);
  });
});
