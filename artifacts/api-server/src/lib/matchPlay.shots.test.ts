import { describe, expect, it } from "vitest";
import { detectedGoals, detectedShots, type Lab, type Touch } from "./matchPlay";

// Shot and goal credit, modelled on the touches of recording 392 (first real
// match, 2026-10-04; 40 x 20 m, goals at x = 0 and x = 40).
const pitch = { length: 40, width: 20 };
const WHITE: Lab = [160, 129, 123];
const YELLOW: Lab = [146, 126, 154];
const DARK: Lab = [50, 128, 129];

function at(t: number, trackId: string, foot: [number, number], ball: [number, number] = foot, kit: Lab = WHITE): Touch {
  return { f: Math.round(t * 20), t, segmentIndex: 0, trackId, kit, ball, foot, d: 0, reassigned: false };
}

describe("shot credit", () => {
  it("credits the shot from 9 m, not the keeper it reached 1.6 m off the line (rec 392, 56:56)", () => {
    const play = [
      at(98.8, "s0:white", [31.7, 17.9], [32.4, 16.6]),
      at(99.4, "s0:white", [31.3, 16.9], [31.8, 16.8]),
      at(100.0, "s0:white", [30.6, 16.6], [31, 16.5]),
      at(100.6, "s0:keeper", [38.4, 9.7], [40.6, 8.5], YELLOW),
      at(101.0, "s0:keeper", [38.4, 9.7], [38.2, 9.8], YELLOW),
      at(101.5, "s0:keeper", [38.5, 9.7], [40.7, 8.7], YELLOW),
    ];
    const s = detectedShots([{ type: "shot", t: 101.4 }], play, pitch);
    expect(s[0].trackId).toBe("s0:white");
    expect(s[0].kit).toEqual(WHITE);
    // the same shot as a goal
    expect(detectedGoals([{ type: "goal", t: 101.4 }], play, pitch)[0].trackId).toBe("s0:white");
  });

  it("drops the kick-off after a goal that goals.py read as a shot (rec 392, 68:24)", () => {
    const play = [
      at(98.0, "s0:a", [8.6, 4.3], [8.4, 3.9]),
      at(101.4, "s0:b", [15, 8.8], [13.9, 8.2]),
      at(101.9, "s0:c", [21.4, 10.4], [22.2, 10]), // the kick-off, at the centre spot
      at(103.9, "s0:b", [20, 7.6], [19.3, 7.3]),
      at(104.3, "s0:keeper", [40.3, 9.3], [40.3, 9], DARK), // a spare ball lying in the other goal
    ];
    const events = [{ type: "goal", t: 60 }, { type: "shot", t: 104.3 }];
    expect(detectedShots(events, play, pitch)).toEqual([]);
    // the same moment with no goal before it is still a shot, but nobody can have struck it:
    // the ball would have flown 21 m in 0.4 s
    const s = detectedShots([{ type: "shot", t: 104.3 }], play, pitch);
    expect(s).toHaveLength(1);
    expect(s[0].trackId).toBe(null);
  });

  it("never credits a rush goalie standing 3 m out, known by his spell in goal (rec 392, 91:31)", () => {
    const keeper = (t: number, foot: [number, number]) => at(t, "s0:sohaib", foot, foot, WHITE);
    const spell = [keeper(50, [24, 6]), keeper(52, [28, 5]), keeper(76, [3, 16]), keeper(79, [2, 16]), keeper(83, [3, 15]), keeper(84, [4, 15])];
    const play = [
      ...spell,
      at(96.0, "s0:attacker", [10.2, 11.7], [10.4, 10.7], DARK),
      keeper(98.1, [3.2, 13.6]),
      keeper(102, [4, 14]),
      keeper(128, [1, 9]),
    ];
    expect(detectedShots([{ type: "shot", t: 100 }], play, pitch)[0].trackId).toBe(null);
    // a strike from outside the area just before his save is still credited
    const shot = [...spell, at(98.4, "s0:attacker", [12, 10], [12, 10], DARK), keeper(99.3, [3, 14]), keeper(102, [4, 14]), keeper(128, [1, 9])];
    expect(detectedShots([{ type: "shot", t: 99.5 }], shot, pitch)[0].trackId).toBe("s0:attacker");
  });

  it("credits nobody in a goalmouth scramble", () => {
    const play = [
      at(97.0, "s0:a", [10, 10], [10, 10], DARK),
      at(97.8, "s0:b", [1.9, 7.9], [0.6, 7.2], DARK),
      at(98.5, "s0:c", [3.4, 8.8], [2.3, 10.4], DARK),
    ];
    expect(detectedShots([{ type: "shot", t: 100 }], play, pitch)[0].trackId).toBe(null);
  });

  it("credits a close-range finish of a pass from outside the area (rec 392, 119:02)", () => {
    const play = [
      at(97.4, "s0:passer", [7.6, 14.8], [7.1, 14.6], DARK),
      at(98.0, "s0:finisher", [4.9, 11.4], [4, 9.9], YELLOW),
      at(98.4, "s0:finisher", [4, 11.4], [1.9, 10.9], YELLOW),
    ];
    expect(detectedShots([{ type: "shot", t: 100 }], play, pitch)[0].trackId).toBe("s0:finisher");
  });

  it("credits a rebound off the keeper to the player who put it back in", () => {
    const play = [
      at(97.0, "s0:shooter", [30, 10], [30, 10], DARK),
      at(97.6, "s0:keeper", [39.4, 10], [39.4, 10], WHITE),
      at(98.4, "s0:rebound", [36.5, 9], [36.5, 9], DARK),
    ];
    expect(detectedShots([{ type: "shot", t: 98.9 }], play, pitch)[0].trackId).toBe("s0:rebound");
  });
});
