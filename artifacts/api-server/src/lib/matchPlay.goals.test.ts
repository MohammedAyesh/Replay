import { describe, expect, it } from "vitest";
import { detectedGoals, type BallPoint, type Lab, type Touch } from "./matchPlay";

// When a goal happened and who scored it, modelled on recording 392 (first
// real match, 40 x 20 m, goals at x = 0 and x = 40; times are its tracking
// seconds). goals.py dates a goal it inferred from a stoppage at the moment
// PLAY STOPPED, seconds after the ball went in, and once more at the kick-off
// wait; credited 8 s back from there, the goal went to whoever fetched the ball
// or took the kick-off.
const pitch = { length: 40, width: 20 };
const WHITE: Lab = [160, 129, 123];
const YELLOW: Lab = [146, 126, 154];
const DARK: Lab = [50, 128, 129];

function at(t: number, trackId: string, foot: [number, number], ball: [number, number] = foot, kit: Lab = WHITE): Touch {
  return { f: Math.round(t * 20), t, segmentIndex: 0, trackId, kit, ball, foot, d: 0, reassigned: false };
}
const b = (t: number, x: number, y: number): BallPoint => ({ t, p: [x, y] });
/** the ball set down on the halfway line from t0 to t1, sampled every 0.5 s */
const restart = (t0: number, t1: number, y = 5): BallPoint[] => {
  const out: BallPoint[] = [];
  for (let t = t0; t <= t1; t += 0.5) out.push(b(t, 20.5, y));
  return out;
};
const goal = (t: number) => ({ type: "goal", t });

describe("goal timing", () => {
  it("dates a goal at the ball's entry into the mouth and credits the striker, not the player fetching it (67:31, reported 67:40)", () => {
    const touches = [
      at(4049.3, "s6:t1", [34.8, 1.8], [34.8, 1.8], DARK),
      at(4050.15, "s6:t1", [36.0, 2.7], [36.0, 2.7], DARK), // the shot
      at(4051.1, "s6:keeper", [39.9, 9.7], [39.9, 9.7], YELLOW), // beaten on his line
      at(4057.1, "s6:keeper", [36.9, 15.9], [36.9, 15.9], YELLOW), // fetching it
      at(4058.3, "s6:keeper", [36.6, 15.8], [36.6, 15.8], YELLOW),
      at(4060.55, "s6:keeper", [36.3, 15.7], [36.3, 15.7], YELLOW),
    ];
    const ball = [
      b(4049.5, 35, 2), b(4050.5, 37.5, 5), b(4051.0, 39.9, 9.7), b(4051.25, 40.0, 9.7), b(4051.5, 40.2, 9.8),
      b(4052.0, 39.8, 10.9), b(4053.0, 39.2, 13.2), b(4054.0, 38.6, 15.2),
      ...restart(4069, 4073.5),
    ];
    const g = detectedGoals([goal(4060)], touches, pitch, { ball });
    expect(g).toHaveLength(1);
    expect(g[0].t).toBe(4051.0);
    expect(g[0].trackId).toBe("s6:t1");
  });

  it("makes one goal of every goals.py goal one restart answers, and never credits the kick-off taker (30:55.7, reported 30:43, 30:55.7 and 31:10)", () => {
    const touches = [
      at(1851.95, "s3:taker", [38.1, 7.6]), // sets the ball down and takes the penalty
      at(1855.7, "s3:keeper", [40.2, 9.2], [40.2, 9.2], DARK),
      at(1858.6, "s3:keeper", [40.3, 9.2], [40.3, 9.2], DARK),
      at(1870.2, "s3:kickoff", [20.4, 5.7], [20.4, 5.7], DARK),
      at(1879.95, "s3:kickoff", [20.8, 4.9], [20.8, 4.9], DARK),
    ];
    const ball = [
      b(1837.0, 38.2, 3.6), b(1837.5, 39.0, 4.0), // into the corner, beside the goal: no goal
      b(1852.0, 38.1, 7.6), b(1853.5, 37.7, 7.6), b(1855.0, 37.7, 7.6),
      b(1855.75, 40.2, 9.2), b(1856.5, 40.2, 9.2), b(1857.5, 40.2, 9.2), b(1858.5, 40.3, 9.1), // in the net
      b(1862.75, 39.7, 8.1), b(1863.0, 41.0, 6.8), b(1864.0, 39.4, 7.6), // fetched out of it
      b(1866.5, 33.2, 11.3), b(1868.5, 26.2, 7.3),
      ...restart(1870.25, 1879.75, 4.8),
    ];
    const g = detectedGoals([goal(1843), goal(1855.7), goal(1870)], touches, pitch, { ball });
    expect(g.map((x) => x.t)).toEqual([1855.7]);
    expect(g[0].trackId).toBe("s3:taker");
  });

  it("keeps two goals 40 s apart that have a restart each (64:24.8 and 65:05; the 75 s merge kept neither)", () => {
    const touches = [
      at(3862.8, "s6:t10", [33.4, 6.1]),
      at(3863.1, "s6:t10", [34.1, 6.3]),
      at(3864.75, "s6:keeper", [39.4, 9.1], [39.4, 9.1], YELLOW),
      at(3890.05, "s6:t9", [19.9, 4.8], [19.9, 4.8], DARK),
      at(3902.55, "s6:t11", [6.7, 12.1], [6.7, 12.1], DARK),
      at(3903.8, "s6:t11", [4.4, 13.1], [4.4, 13.1], DARK),
      at(3904.45, "s6:t11", [2.5, 13.9], [2.5, 13.9], DARK),
    ];
    const ball = [
      b(3863.5, 35.4, 7.2), b(3864.0, 36.5, 7.9), b(3864.5, 37.5, 8.8), b(3864.75, 39.4, 9.1), b(3866.0, 39.8, 9.1), b(3869.0, 39.6, 9.4),
      ...restart(3890, 3891.75),
      b(3905.0, 1.5, 13.4),
      ...restart(3920.75, 3925.75),
    ];
    const g = detectedGoals([goal(3869), goal(3907)], touches, pitch, { ball });
    expect(g.map((x) => [x.t, x.trackId])).toEqual([[3864.75, "s6:t10"], [3905.0, "s6:t11"]]);
  });

  it("drops a goal that no restart from the halfway line answers (53:06 a scramble, 53:19 the keeper walking out)", () => {
    const touches = [at(3184.05, "s5:t4", [5.7, 14.4], [5.7, 14.4], DARK), at(3186.2, "s5:keeper", [1.2, 8.3])];
    const ball = [b(3185.2, 1.4, 7.6), b(3186.2, 1.2, 8.3), b(3199.55, 0.9, 9.0), b(3207.2, 19.1, 5.5), b(3208.2, 19.2, 5.5)];
    expect(detectedGoals([goal(3186), goal(3199.55)], touches, pitch, { ball })).toEqual([]);
  });

  it("drops a goal whose ball was never seen in a mouth (93:10, play in midfield)", () => {
    const touches = [at(5588.05, "s9:t3", [22, 6]), at(5589.1, "s9:t4", [19, 7], [19, 7], DARK)];
    const ball = [b(5588.5, 21, 6), b(5589.7, 15, 1.5), ...restart(5627.5, 5630)];
    expect(detectedGoals([goal(5590)], touches, pitch, { ball })).toEqual([]);
  });

  it("does not take a save at one end for the goal when the ball then went to the other goal (115:32)", () => {
    const touches = [at(6933.0, "s11:keeper", [39.4, 10.8]), at(6933.55, "s11:t7", [31, 8], [31, 8], DARK), at(6939.2, "s11:t17", [4.5, 14.8])];
    const ball = [b(6932.15, 39.8, 11.2), b(6932.9, 39.4, 10.8), b(6936.0, 21, 10), ...restart(6969.5, 6987)];
    expect(detectedGoals([goal(6942)], touches, pitch, { ball })).toEqual([]);
  });

  it("lets the end of the game answer the last goal", () => {
    const touches = [at(7140.5, "s11:t1", [30, 8], [30, 8], DARK), at(7141.4, "s11:keeper", [39.6, 9.5])];
    const ball = [b(7141.2, 39.8, 9.6), b(7142.0, 40.4, 9.6)];
    const g = detectedGoals([goal(7150)], touches, pitch, { ball, ends: [7198] });
    expect(g.map((x) => [x.t, x.trackId])).toEqual([[7141.2, "s11:t1"]]);
    expect(detectedGoals([goal(7150)], touches, pitch, { ball })).toEqual([]);
  });

  it("never looks back past the restart that answered the previous goal", () => {
    const touches = [at(99, "s0:a", [36, 8]), at(130, "s0:b", [25, 10], [25, 10], DARK)];
    const ball = [b(100, 39.8, 9.8), ...restart(110, 113), b(131, 30, 10), ...restart(150, 153)];
    // the second "goal" (at 118, after the restart at 110) has only the first goal's ball to find
    const g = detectedGoals([goal(104), goal(118)], touches, pitch, { ball });
    expect(g.map((x) => x.t)).toEqual([100]);
  });
});
