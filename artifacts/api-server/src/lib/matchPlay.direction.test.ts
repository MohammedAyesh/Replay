import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/db";
import { detectedGoals, pitchDirection, type BallPoint, type BallSidecar, type Lab, type PitchDirection, type Touch } from "./matchPlay";

// Which end each side attacks, from the minimap, and own goals: a goal whose
// last touch was by the side defending that end is nobody's goal. Modelled on
// recording 392 (40 x 20 m): the dark side attacked x = 0 all match, and its
// false 53:05 "goal" was a white player's touch into the white side's own goal.
const WHITE: Lab = [160, 129, 123];
const DARK: Lab = [50, 128, 129];
const pitch = { length: 40, width: 20 };

const manifest = {
  version: 1, label: "t", width: 3840, height: 1080, frameRate: 20, frameCount: 40000, duration: 2000,
  matchOffset: 0, videoStartSeconds: 0, segmentCount: 1, segments: [],
  pitchModel: {
    calibrationId: "c", fittedAt: "2026-09-01T00:00:00Z", calibratedAspectRatio: 3840 / 1080,
    pitchWidthMetres: 40, pitchHeightMetres: 20,
    grid: [[{ x: 0, y: -20 }, { x: 40, y: -20 }], [{ x: 0, y: 20 }, { x: 40, y: 20 }]],
  },
} as unknown as TrackingManifest;

/** a box whose feet stand at (X, Y) metres */
const boxAt = (frame: number, X: number, Y: number) => ({ frame, x: X * 96 - 20, y: (Y + 20) * 27 - 100, w: 40, h: 100 });

/** a player sampled every half second from t0 to t1, standing at x(t) */
function player(id: string, t0: number, t1: number, x: (t: number) => number, y = 10) {
  const boxes = [];
  for (let f = t0 * 20; f <= t1 * 20; f += 10) boxes.push(boxAt(f, x(f / 20), y));
  return { id, boxes };
}

function play(tracks: Array<{ id: string; boxes: ReturnType<typeof boxAt>[] }>, kitOf: Record<string, Lab>) {
  const kits = new Map(Object.entries(kitOf));
  const sidecar: BallSidecar = { v: 1, fps: 20, touches: [], ball: [], kits: {} };
  for (const [id, lab] of Object.entries(kitOf)) sidecar.kits[id] = [lab[0], lab[1], lab[2], 300];
  return { manifest, sidecars: [sidecar], segments: [{ tracks }], kits, bib: null, inPlay: null };
}

describe("attacking direction from the minimap", () => {
  it("reads which side defends each end, window by window, and follows a change of ends", () => {
    // first 600 s: white near x = 10, dark near x = 30; then they change ends
    const whiteX = (t: number) => (t < 600 ? 10 : 30) + Math.sin(t) * 3;
    const darkX = (t: number) => (t < 600 ? 30 : 10) + Math.cos(t) * 3;
    const p = play(
      [player("w1", 0, 1199, whiteX, 6), player("w2", 0, 1199, whiteX, 14), player("d1", 0, 1199, darkX, 6), player("d2", 0, 1199, darkX, 14)],
      { w1: WHITE, w2: WHITE, d1: DARK, d2: DARK },
    );
    const d = pitchDirection(p)!;
    expect(d).not.toBeNull();
    const white = d.sideOf(WHITE)!, dark = d.sideOf(DARK)!;
    expect(white).not.toBe(dark);
    expect(d.attacking(0, 100)).toBe(dark);
    expect(d.attacking(40, 100)).toBe(white);
    expect(d.attacking(0, 900)).toBe(white);
    expect(d.attacking(40, 900)).toBe(dark);
  });

  it("gives no verdict when the two sides stand level", () => {
    const p = play(
      [player("w1", 0, 599, () => 20, 6), player("d1", 0, 599, () => 20.5, 14), player("w2", 0, 599, () => 19.5, 4), player("d2", 0, 599, () => 20, 16)],
      { w1: WHITE, w2: WHITE, d1: DARK, d2: DARK },
    );
    expect(pitchDirection(p)).toBeNull();
  });

  it("ignores a thin warm-up window that points the other way (recording 394, 10-15 min)", () => {
    // a 60 s warm-up with the sides the wrong way round, then 900 s of match
    const whiteX = (t: number) => (t < 300 ? 30 : 10);
    const darkX = (t: number) => (t < 300 ? 10 : 30);
    const p = play(
      [
        player("w1", 240, 1199, whiteX, 6), player("w2", 240, 1199, whiteX, 14),
        player("d1", 240, 1199, darkX, 6), player("d2", 240, 1199, darkX, 14),
      ],
      { w1: WHITE, w2: WHITE, d1: DARK, d2: DARK },
    );
    const d = pitchDirection(p)!;
    // the warm-up window borrows the match's verdict: white defends x = 0
    expect(d.attacking(0, 250)).toBe(d.sideOf(DARK));
    expect(d.attacking(0, 700)).toBe(d.sideOf(DARK));
  });
});

// ------------------------------------------------------------- own goals

function at(t: number, trackId: string, foot: [number, number], kit: Lab): Touch {
  return { f: Math.round(t * 20), t, segmentIndex: 0, trackId, kit, ball: foot, foot, d: 0, reassigned: false };
}
const b = (t: number, x: number, y: number): BallPoint => ({ t, p: [x, y] });
const restart = (t0: number, t1: number): BallPoint[] => {
  const out: BallPoint[] = [];
  for (let t = t0; t <= t1; t += 0.5) out.push(b(t, 20.5, 5));
  return out;
};

/** dark shoots from (36, 2.7) into the goal at x = 40 (recording 392, 67:31) */
const darkShot = {
  touches: [at(4049.3, "s6:t1", [34.8, 1.8], DARK), at(4050.15, "s6:t1", [36.0, 2.7], DARK)],
  ball: [b(4049.5, 35, 2), b(4050.5, 37.5, 5), b(4051.0, 39.9, 9.7), b(4051.25, 40.0, 9.7), b(4051.5, 40.2, 9.8), b(4052.0, 39.8, 10.9), ...restart(4069, 4073.5)],
};

/** a stub: side 0 is white, side 1 dark; `darkAttacks` is the end dark attacks */
const stub = (darkAttacks: 0 | 40 | null): PitchDirection => ({
  kits: [WHITE, DARK],
  sideOf: (kit) => (kit ? (kit[0] > 100 ? 0 : 1) : null),
  attacking: (goalX) => (darkAttacks === null ? null : goalX === darkAttacks ? 1 : 0),
});

describe("own goals", () => {
  it("keeps the scorer when he put it into the end his side attacks", () => {
    const g = detectedGoals([{ type: "goal", t: 4060 }], darkShot.touches, pitch, { ball: darkShot.ball, direction: stub(40) });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ trackId: "s6:t1", kit: DARK, goalX: 40 });
    expect(g[0].ownGoal).toBeFalsy();
  });

  it("makes it an own goal, for the other side and nobody's goal, when he put it into his own side's end (392, 53:05)", () => {
    const g = detectedGoals([{ type: "goal", t: 4060 }], darkShot.touches, pitch, { ball: darkShot.ball, direction: stub(0) });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ trackId: null, touchF: null, kit: WHITE, goalX: 40, ownGoal: true, ownGoalTrackId: "s6:t1" });
  });

  it("changes nothing when the minimap cannot say who attacks that end", () => {
    const g = detectedGoals([{ type: "goal", t: 4060 }], darkShot.touches, pitch, { ball: darkShot.ball, direction: stub(null) });
    expect(g[0]).toMatchObject({ trackId: "s6:t1", kit: DARK });
    expect(g[0].ownGoal).toBeFalsy();
    const none = detectedGoals([{ type: "goal", t: 4060 }], darkShot.touches, pitch, { ball: darkShot.ball });
    expect(none[0]).toMatchObject({ trackId: "s6:t1", kit: DARK });
  });

  it("gives a goal nobody is credited with to the side attacking that end", () => {
    const g = detectedGoals([{ type: "goal", t: 4060 }], [], pitch, { ball: darkShot.ball, direction: stub(40) });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ trackId: null, kit: DARK, goalX: 40 });
  });
});
