import { describe, expect, it } from "vitest";

import {
  cameraGaps,
  compareHalves,
  defaultRival,
  fiveMinuteRows,
  foldBlocks,
  foldHeat,
  formLine,
  isLevel,
  isPersonalBest,
  levelWith,
  rivalRows,
  standOut,
  standings,
  tally,
  type ReportPlayer,
} from "./match-report";

function player(playerId: number, patch: Partial<ReportPlayer> = {}): ReportPlayer {
  return {
    playerId,
    name: `P${playerId}`,
    team: "A",
    claimed: true,
    minutes: 60,
    distanceKm: null,
    topSpeedKmh: null,
    touches: null,
    passesTried: null,
    passesCompleted: null,
    dribblesWon: null,
    goals: null,
    ...patch,
  };
}

describe("levels and ranks", () => {
  it("treats a gap inside the margin as level", () => {
    expect(isLevel("distanceRate", 0.82, 0.81)).toBe(true);
    expect(isLevel("distanceRate", 0.94, 0.82)).toBe(false);
    expect(isLevel("topSpeed", 27, 28.4)).toBe(true);
    expect(isLevel("topSpeed", 27, 29)).toBe(false);
  });

  it("shares a rank between level players and counts only clear leads ahead", () => {
    // per 10 min over 60 min: 0.94, 0.88, 0.82, 0.81, 0.70
    const players = [
      player(1, { distanceKm: 5.64 }),
      player(2, { distanceKm: 5.28 }),
      player(3, { distanceKm: 4.92 }),
      player(4, { distanceKm: 4.86 }),
      player(5, { distanceKm: 4.2 }),
    ];
    const table = standings(players, "distanceRate");
    const me = table.find((entry) => entry.player.playerId === 3)!;
    expect(me.rank).toBe(3);
    expect(me.shared).toBe(true);
    expect(table.find((entry) => entry.player.playerId === 4)!.rank).toBe(3);
    expect(levelWith(players, "distanceRate", 3).map((p) => p.playerId)).toEqual([4]);
  });

  it("lists players under ten minutes without ranking them", () => {
    const players = [player(1, { distanceKm: 5 }), player(2, { distanceKm: 1, minutes: 8 })];
    const table = standings(players, "distanceRate");
    const short = table.find((entry) => entry.player.playerId === 2)!;
    expect(short.ranked).toBe(false);
    expect(short.rank).toBe(0);
    expect(table.find((entry) => entry.player.playerId === 1)!.shared).toBe(false);
  });

  it("names every level leader instead of one on a decimal, and only says clear when it is", () => {
    const players = [player(1, { topSpeedKmh: 29 }), player(2, { topSpeedKmh: 28.2 }), player(3, { topSpeedKmh: 25 })];
    const out = standOut(players, "topSpeed")!;
    expect(out.winners.map((p) => p.playerId)).toEqual([1, 2]);
    expect(out.clearBy).toBeNull();
    const clear = standOut([player(1, { topSpeedKmh: 29 }), player(2, { topSpeedKmh: 27 })], "topSpeed")!;
    expect(clear.clearBy).toBe(2);
  });
});

describe("time", () => {
  it("folds five-minute blocks into ten and greys blocks the camera barely saw", () => {
    const folded = foldBlocks([
      { index: 0, seconds: 300, metres: 400, touches: 5 },
      { index: 1, seconds: 300, metres: 380, touches: 2 },
      { index: 2, seconds: 60, metres: 50, touches: 0 },
    ], 1800);
    expect(folded).toHaveLength(3);
    expect(folded[0].metres).toBe(780);
    expect(folded[0].metresPerMinute).toBeCloseTo(78);
    expect(folded[1].onCamera).toBe(false);
    expect(folded[1].metresPerMinute).toBeNull();
    expect(folded[2].seconds).toBe(0);
  });

  it("compares the halves per minute on camera, and calls a small change level", () => {
    const blocks = [
      { index: 0, seconds: 300, metres: 450, touches: null },
      { index: 1, seconds: 300, metres: 450, touches: null },
      { index: 2, seconds: 300, metres: 350, touches: null },
      { index: 3, seconds: 300, metres: 350, touches: null },
    ];
    const halves = compareHalves(blocks, 1200)!;
    expect(halves.change).toBeCloseTo(-0.222, 2);
    expect(halves.level).toBe(false);
    const flat = compareHalves(blocks.map((b) => ({ ...b, metres: 400 })), 1200)!;
    expect(flat.level).toBe(true);
    expect(compareHalves(blocks.slice(0, 2), 1200)).toBeNull();
  });

  it("finds the stretches the camera lost the player", () => {
    expect(cameraGaps([[0, 2400], [3000, 5400]], 5400)).toEqual([[2400, 3000]]);
    expect(cameraGaps([[0, 5300]], 5400)).toEqual([]);
    expect(cameraGaps([[0, 1000]], 5400)).toEqual([[1000, 5400]]);
  });

  it("puts each touch, goal and the fastest run in its five-minute row", () => {
    const rows = fiveMinuteRows({
      spans: [[0, 600]],
      blocks: [{ index: 0, seconds: 300, metres: 400, touches: 2 }, { index: 1, seconds: 290, metres: 380, touches: 1 }],
      touchTimes: [10, 200, 350],
      goalTimes: [340],
      dribbleWonTimes: [],
      topSpeedAt: 120,
      heatmap: null,
    }, 900);
    expect(rows).toHaveLength(3);
    expect(rows[0].touchTimes).toEqual([10, 200]);
    expect(rows[0].fastest).toBe(true);
    expect(rows[1].goals).toEqual([340]);
    expect(rows[2].onCamera).toBe(false);
  });
});

describe("comparisons", () => {
  it("fills a rival row only by the lead beyond the margin and tallies level rows apart", () => {
    const me = player(1, { distanceKm: 4.92, topSpeedKmh: 27, touches: 63, passesCompleted: 41, dribblesWon: 4 });
    const rival = player(2, { distanceKm: 5.64, topSpeedKmh: 27.5, touches: 40, passesCompleted: 40, dribblesWon: 1 });
    const rows = rivalRows(me, rival);
    expect(rows.map((row) => row.outcome)).toEqual(["them", "level", "you", "level", "you"]);
    expect(rows[1].beyond).toBe(0);
    expect(tally(rows)).toEqual({ you: 2, level: 2, them: 1 });
  });

  it("picks the nearest player clearly ahead as the default rival", () => {
    const players = [player(1, { distanceKm: 4.9 }), player(2, { distanceKm: 5.6 }), player(3, { distanceKm: 5.3 }), player(4, { distanceKm: 4 })];
    expect(defaultRival(players, 1)?.playerId).toBe(3);
    expect(defaultRival([player(1, { distanceKm: 6 }), player(2, { distanceKm: 4 })], 1)?.playerId).toBe(2);
  });

  it("compares against earlier form per ten minutes", () => {
    const me = player(1, { distanceKm: 5.4, topSpeedKmh: 27, touches: 40 });
    const line = formLine(me, { minutes: 60, distanceKm: 4.8, topSpeedKmh: 26.5, touches: 55 }, 5)!;
    expect(line).toEqual({ distance: "more", speed: "level", touches: "less", matches: 5 });
    expect(formLine(me, null, 0)).toBeNull();
  });

  it("claims a personal best only with three earlier matches and a clear margin", () => {
    expect(isPersonalBest("topSpeed", 29, 27, 3)).toBe(true);
    expect(isPersonalBest("topSpeed", 28, 27, 3)).toBe(false);
    expect(isPersonalBest("topSpeed", 29, 27, 2)).toBe(false);
  });

  it("folds the 12 x 8 heat grid without losing weight", () => {
    const weights = new Array(96).fill(1 / 96);
    const folded = foldHeat(weights);
    expect(folded).toHaveLength(24);
    expect(folded.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});
