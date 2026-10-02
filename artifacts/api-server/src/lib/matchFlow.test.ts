import { describe, expect, it } from "vitest";

import { matchFlow, mergeSpans, phasesFromProvenance } from "./matchFlow";

describe("phasesFromProvenance", () => {
  it("reads phases.py's block and drops malformed entries", () => {
    expect(phasesFromProvenance({
      phases: { version: 1, phases: [
        { kind: "before", start: 0, end: 897 },
        { kind: "game", start: 897, end: 5043 },
        { kind: "game", start: 10, end: 5 },
        { kind: 3, start: 1, end: 2 },
      ] },
    })).toEqual([{ kind: "before", start: 0, end: 897 }, { kind: "game", start: 897, end: 5043 }]);
    expect(phasesFromProvenance({ chain: "x" })).toBeNull();
    expect(phasesFromProvenance(undefined)).toBeNull();
  });
});

describe("mergeSpans", () => {
  it("joins overlapping and near-touching spans", () => {
    expect(mergeSpans([[10, 20], [5, 8], [20.3, 25], [40, 41]], 0.5)).toEqual([[5, 8], [10, 25], [40, 41]]);
  });
});

describe("matchFlow", () => {
  it("clips one recording to the booking window and moves it onto the booking clock", () => {
    const flow = matchFlow([{
      fromSeconds: 600,
      toSeconds: 4200,
      offsetSec: -600,
      phases: [
        { kind: "after", start: 0, end: 300 },
        { kind: "before", start: 300, end: 900 },
        { kind: "game", start: 900, end: 3000 },
        { kind: "break", start: 3000, end: 3120 },
        { kind: "game", start: 3120, end: 7200 },
      ],
      inPlay: [[100, 200], [950, 1200], [1205, 1500], [4100, 4300]],
    }]);
    expect(flow.phases).toEqual([
      { kind: "before", from: 0, to: 300 },
      { kind: "game", from: 300, to: 2400 },
      { kind: "break", from: 2400, to: 2520 },
      { kind: "game", from: 2520, to: 3600 },
    ]);
    expect(flow.inPlay).toEqual([[350, 600], [605, 900], [3500, 3600]]);
  });

  it("joins two recordings that meet mid-game: their after/before become one break", () => {
    const flow = matchFlow([
      { fromSeconds: 1800, toSeconds: 3600, offsetSec: -1800, phases: [{ kind: "game", start: 0, end: 3500 }, { kind: "after", start: 3500, end: 3600 }], inPlay: null },
      { fromSeconds: 0, toSeconds: 1800, offsetSec: 1800, phases: [{ kind: "before", start: 0, end: 60 }, { kind: "game", start: 60, end: 1800 }], inPlay: null },
    ]);
    expect(flow.phases).toEqual([
      { kind: "game", from: 0, to: 1700 },
      { kind: "break", from: 1700, to: 1860 },
      { kind: "game", from: 1860, to: 3600 },
    ]);
    expect(flow.inPlay).toBeNull();
  });

  it("says nothing when no recording carried the data", () => {
    expect(matchFlow([{ fromSeconds: 0, toSeconds: 10, offsetSec: 0, phases: null, inPlay: null }])).toEqual({ phases: null, inPlay: null });
  });
});
