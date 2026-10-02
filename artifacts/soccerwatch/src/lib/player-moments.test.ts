import { describe, expect, it } from "vitest";

import type { ReportTimeline } from "./match-report";
import {
  buildMoments,
  countByKind,
  momentAt,
  nextMoment,
  previousMoment,
  reel,
  reelJump,
  touchRuns,
} from "./player-moments";

function timeline(overrides: Partial<ReportTimeline> = {}): ReportTimeline {
  return {
    spans: [[0, 3600]],
    blocks: [],
    touchTimes: [],
    goalTimes: [],
    dribbleWonTimes: [],
    topSpeedAt: null,
    heatmap: null,
    ...overrides,
  };
}

describe("touchRuns", () => {
  it("groups touches less than six seconds apart into one run", () => {
    expect(touchRuns([100, 103, 108, 200, 30])).toEqual([
      { at: 30, endAt: 30, count: 1 },
      { at: 100, endAt: 108, count: 3 },
      { at: 200, endAt: 200, count: 1 },
    ]);
  });
});

describe("buildMoments", () => {
  it("lists a goal once: the player's own goal replaces the match goal and the shot that scored it", () => {
    const moments = buildMoments({
      report: timeline({ goalTimes: [600], shotTimes: [598, 900] }),
      matchGoals: [
        { at: 603, scorerName: "Me", colour: "#D4FF4F", byPlayer: true },
        { at: 1500, scorerName: "Omar", colour: "#FFFFFF", byPlayer: false },
      ],
      flags: [],
    });
    expect(moments.map((m) => [m.kind, m.at])).toEqual([["goal", 600], ["shot", 900], ["matchGoal", 1500]]);
    expect(moments[2].label).toBe("Omar");
  });

  it("keeps how passes and dribbles ended, and falls back to won dribbles on older servers", () => {
    const fresh = buildMoments({
      report: timeline({
        passes: [{ t: 10, completed: true }, { t: 20, completed: false }, { t: 30, completed: null }],
        dribbles: [{ t: 40, outcome: "lost" }],
      }),
      matchGoals: [],
      flags: [],
    });
    expect(fresh.map((m) => m.outcome)).toEqual(["completed", "missed", null, "lost"]);
    const old = buildMoments({ report: timeline({ dribbleWonTimes: [50] }), matchGoals: [], flags: [] });
    expect(old).toMatchObject([{ kind: "dribble", at: 50, outcome: "won" }]);
  });

  it("shows only the match's goals and flags without a player", () => {
    const moments = buildMoments({
      report: null,
      matchGoals: [{ at: 100, scorerName: null, colour: null, byPlayer: false }],
      flags: [{ at: 50, kind: "foul", note: null }, { at: -4, kind: "x", note: null }],
    });
    expect(moments.map((m) => [m.kind, m.label])).toEqual([["flag", "foul"], ["matchGoal", null]]);
  });

  it("counts touches, not runs", () => {
    const counts = countByKind(buildMoments({ report: timeline({ touchTimes: [1, 2, 3, 100] }), matchGoals: [], flags: [] }));
    expect(counts.touch).toBe(4);
    expect(counts.goal).toBe(0);
  });
});

describe("moving between moments", () => {
  const moments = buildMoments({
    report: timeline({ shotTimes: [100], touchTimes: [99, 300, 302], passes: [{ t: 500, completed: true }] }),
    matchGoals: [],
    flags: [],
  });

  it("names the moment on screen, preferring the shot over the touch that made it", () => {
    expect(momentAt(moments, 98)?.kind).toBe("shot");
    expect(momentAt(moments, 304)?.kind).toBe("touch");
    expect(momentAt(moments, 400)).toBeNull();
  });

  it("steps forward and back", () => {
    expect(nextMoment(moments, 0)?.at).toBe(99);
    expect(nextMoment(moments, 100)?.at).toBe(300);
    expect(nextMoment(moments, 501)).toBeNull();
    expect(previousMoment(moments, 400)?.at).toBe(300);
    expect(previousMoment(moments, 303)?.at).toBe(300);
    expect(previousMoment(moments, 297)?.at).toBe(100);
  });
});

describe("reel", () => {
  it("merges overlapping windows and jumps between them", () => {
    const moments = buildMoments({
      report: timeline({ shotTimes: [100, 104], passes: [{ t: 300, completed: true }] }),
      matchGoals: [],
      flags: [],
    });
    const stops = reel(moments);
    expect(stops.map((stop) => [stop.start, stop.end, stop.moments.length])).toEqual([[96, 107, 2], [296, 303, 1]]);
    expect(reelJump(stops, 0)).toBe(96);
    expect(reelJump(stops, 100)).toBeNull();
    expect(reelJump(stops, 108)).toBe(296);
    expect(reelJump(stops, 304)).toBe("end");
  });
});
