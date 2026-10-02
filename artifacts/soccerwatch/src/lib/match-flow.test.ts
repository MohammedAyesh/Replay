import { describe, expect, it } from "vitest";

import { deadAt, deadStretches, flowMarks, flowSummary, skipTarget, type MatchFlowData } from "./match-flow";
import { buildMoments, reel } from "./player-moments";

const flow: MatchFlowData = {
  phases: [
    { kind: "before", from: 0, to: 300 },
    { kind: "game", from: 300, to: 1500 },
    { kind: "break", from: 1500, to: 1620 },
    { kind: "game", from: 1620, to: 3000 },
    { kind: "after", from: 3000, to: 3600 },
  ],
  inPlay: [[305, 600], [604, 900], [930, 1500], [1625, 2990]],
};

describe("deadStretches", () => {
  it("lists the phases outside the game and the long stoppages inside it", () => {
    expect(deadStretches(flow, 3600)).toEqual([
      { kind: "before", from: 0, to: 300 },
      { kind: "outOfPlay", from: 900, to: 930 },
      { kind: "break", from: 1500, to: 1620 },
      { kind: "outOfPlay", from: 2990, to: 3000 },
      { kind: "after", from: 3000, to: 3600 },
    ]);
  });

  it("uses only the phases without in-play data, and only in-play without phases", () => {
    expect(deadStretches({ phases: flow.phases, inPlay: null }, 3600).map((s) => s.kind)).toEqual(["before", "break", "after"]);
    expect(deadStretches({ phases: null, inPlay: [[20, 100], [200, 300]] }, 400)).toEqual([
      { kind: "outOfPlay", from: 0, to: 20 },
      { kind: "outOfPlay", from: 100, to: 200 },
      { kind: "outOfPlay", from: 300, to: 400 },
    ]);
    expect(deadStretches(null, 100)).toEqual([]);
  });
});

describe("skipTarget", () => {
  const stretches = deadStretches(flow, 3600);
  it("jumps to just before play resumes, once", () => {
    expect(skipTarget(stretches, 10, 3600)).toBe(298);
    expect(skipTarget(stretches, 298, 3600)).toBeNull();
    expect(skipTarget(stretches, 1501, 3600)).toBe(1618);
    expect(skipTarget(stretches, 700, 3600)).toBeNull();
  });

  it("never skips the stretch that runs to the end", () => {
    expect(skipTarget(stretches, 3100, 3600)).toBeNull();
    expect(deadAt(stretches, 3100)?.kind).toBe("after");
  });
});

describe("flowSummary and flowMarks", () => {
  it("counts game time and ball-in-play time inside it", () => {
    expect(flowSummary(flow, 3600)).toEqual({ gameSeconds: 2580, inPlaySeconds: 295 + 296 + 570 + 1365 });
    expect(flowSummary({ phases: flow.phases, inPlay: null }, 3600).inPlaySeconds).toBeNull();
  });

  it("marks kick-off, the break, the restart and full time; the reel leaves them out", () => {
    expect(flowMarks(flow)).toEqual([
      { at: 300, mark: "kickoff" },
      { at: 1500, mark: "break" },
      { at: 1620, mark: "restart" },
      { at: 3000, mark: "fullTime" },
    ]);
    const moments = buildMoments({ report: null, matchGoals: [{ at: 700, scorerName: null, colour: null, byPlayer: false }], flags: [], flow });
    expect(moments.filter((m) => m.kind === "phase").map((m) => m.label)).toEqual(["kickoff", "break", "restart", "fullTime"]);
    expect(reel(moments).map((stop) => stop.start)).toEqual([696]);
  });
});
