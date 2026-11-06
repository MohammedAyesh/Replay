import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/db";
import { creditGoalAt, detectedGoals, directionFromData, pitchDirection, playStretches, type BallPoint, type BallSidecar, type Lab, type PitchDirection, type Touch } from "./matchPlay";

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

describe("attacking direction as plain data (saved with the play, matchPlayLoad)", () => {
  it("rebuilds the same verdicts from its data after a JSON round trip", () => {
    const p = play([
      player("w1", 0, 1200, (t) => (t < 600 ? 8 : 32)),
      player("w2", 0, 1200, (t) => (t < 600 ? 10 : 30)),
      player("d1", 0, 1200, (t) => (t < 600 ? 32 : 8)),
      player("d2", 0, 1200, (t) => (t < 600 ? 30 : 10)),
    ], { w1: WHITE, w2: WHITE, d1: DARK, d2: DARK });
    const d = pitchDirection(p)!;
    expect(d.data).toBeDefined();
    const back = directionFromData(JSON.parse(JSON.stringify(d.data)));
    expect(back.kits).toEqual(d.kits);
    for (const kit of [WHITE, DARK, [120, 128, 128] as Lab, null]) expect(back.sideOf(kit)).toBe(d.sideOf(kit));
    for (let t = 0; t <= 1300; t += 37) {
      for (const goalX of [0, 40]) expect(back.attacking(goalX, t)).toBe(d.attacking(goalX, t));
    }
  });
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

// ------------------------------------------------- stretches and own goals (2026-11-06, recording 412)

describe("stretches of play between long breaks", () => {
  it("joins game phases across short breaks and splits them at long ones", () => {
    expect(playStretches([
      { kind: "game", start: 0, end: 3700 }, { kind: "break", start: 3700, end: 4102 },
      { kind: "game", start: 4102, end: 6339 }, { kind: "break", start: 6339, end: 6772 },
      { kind: "game", start: 6772, end: 7200 },
    ])).toEqual([[0, 3700], [4102, 6339], [6772, 7200]]);
    expect(playStretches([{ kind: "game", start: 0, end: 1000 }, { kind: "game", start: 1100, end: 2000 }])).toEqual([[0, 2000]]);
    // a short stretch joins the one before it
    expect(playStretches([{ kind: "game", start: 0, end: 1000 }, { kind: "game", start: 1400, end: 1500 }])).toEqual([[0, 1500]]);
    expect(playStretches(null)).toEqual([]);
  });

  it("reads each stretch's own shirts and ends, and keeps a stretch's ends where its windows have no verdict", () => {
    // game 1 (0-1200 s): white defends x = 0, dark x = 40. A long break, then
    // game 2 (1600-2800 s) with different shirts, RED defending x = 40.
    const RED: Lab = [120, 170, 150];
    const BLUE: Lab = [90, 140, 80];
    const tracks = [
      player("w1", 0, 1199, () => 10, 6), player("w2", 0, 1199, () => 9, 14),
      player("d1", 0, 1199, () => 30, 6), player("d2", 0, 1199, () => 31, 14),
      player("r1", 1600, 2799, () => 30, 6), player("r2", 1600, 2799, () => 31, 14),
      player("u1", 1600, 2799, () => 10, 6), player("u2", 1600, 2799, () => 9, 14),
    ];
    const p = { ...play(tracks, { w1: WHITE, w2: WHITE, d1: DARK, d2: DARK, r1: RED, r2: RED, u1: BLUE, u2: BLUE }),
      phases: [{ kind: "game", start: 0, end: 1200 }, { kind: "break", start: 1200, end: 1600 }, { kind: "game", start: 1600, end: 2800 }] };
    const d = pitchDirection(p)!;
    expect(d.data?.stretches).toHaveLength(2);
    expect(d.attacking(40, 500)).toBe(d.sideOf(WHITE, 500));
    expect(d.attacking(0, 500)).toBe(d.sideOf(DARK, 500));
    expect(d.attacking(0, 2000)).toBe(d.sideOf(RED, 2000));
    expect(d.attacking(40, 2000)).toBe(d.sideOf(BLUE, 2000));
    // survives a JSON round trip (Infinity would become null)
    const back = directionFromData(JSON.parse(JSON.stringify(d.data)));
    for (const t of [100, 900, 1400, 2000, 2700, 5000]) {
      for (const goalX of [0, 40]) expect(back.attacking(goalX, t)).toBe(d.attacking(goalX, t));
    }
  });
});

describe("own goals need no attacker's touch in the build-up", () => {
  const stretchy = (darkAttacks: 0 | 40): PitchDirection => ({ ...stub(darkAttacks), kitsAt: () => [WHITE, DARK] });

  it("credits the attacker who shot when a defender blocked it last", () => {
    // dark shoots at x = 40, a white defender touches it 0.4 s later
    const touches = [...darkShot.touches, at(4050.55, "s6:t9", [38.5, 6], WHITE)];
    const g = creditGoalAt(4051.0, touches, pitch, 40, stretchy(40));
    expect(g.ownGoal).toBeFalsy();
    expect(g).toMatchObject({ trackId: "s6:t1", kit: DARK, goalX: 40 });
  });

  it("is an own goal only when the defending side alone touched it", () => {
    const touches = [at(4049.0, "s6:t8", [30, 8], WHITE), at(4050.5, "s6:t9", [37, 8], WHITE)];
    const g = creditGoalAt(4051.0, touches, pitch, 40, stretchy(40));
    expect(g).toMatchObject({ ownGoal: true, trackId: null, kit: DARK });
  });
});
