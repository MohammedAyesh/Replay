import { describe, expect, it } from "vitest";
import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";
import {
  detectedGoals,
  detectedShots,
  dribbleEvents,
  dropTeleports,
  playerMoments,
  sideOfKit,
  teamDribbles,
  type Lab,
  type Touch,
} from "./matchPlay";
import { followCrop, followPath, mergeMoments } from "./personalMoments";

const WHITE: Lab = [200, 128, 128];
const BLACK: Lab = [20, 128, 128];

// A linear pitch: x metres = px / 96, y metres = py / 27 - 20.
const manifest = {
  version: 1,
  label: "t",
  width: 3840,
  height: 1080,
  frameRate: 20,
  frameCount: 20000,
  duration: 1000,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [],
  pitchModel: {
    calibrationId: "c",
    fittedAt: "2026-09-01T00:00:00Z",
    calibratedAspectRatio: 3840 / 1080,
    pitchWidthMetres: 40,
    pitchHeightMetres: 20,
    grid: [[{ x: 0, y: -20 }, { x: 40, y: -20 }], [{ x: 0, y: 20 }, { x: 40, y: 20 }]],
  },
} as unknown as TrackingManifest;

/** A box whose feet stand at (X, Y) metres. */
const boxAt = (frame: number, X: number, Y: number) => ({ frame, x: X * 96 - 20, y: (Y + 20) * 27 - 100, w: 40, h: 100 });

function track(id: string, f0: number, f1: number, pos: (f: number) => [number, number]) {
  const boxes = [];
  for (let f = f0; f <= f1; f++) {
    const [X, Y] = pos(f);
    boxes.push(boxAt(f, X, Y));
  }
  return { id, startFrame: f0, endFrame: f1, boxes };
}

function touch(t: number, trackId: string, X: number, kit: Lab): Touch {
  return { f: Math.round(t * 20), t, segmentIndex: 0, trackId, kit, ball: [X, 10], foot: [X, 10], d: 0, reassigned: false };
}

const segment = (tracks: ReturnType<typeof track>[]) =>
  ({ segmentIndex: 0, tracks, crossings: [], inPlaySpans: [], events: [] }) as unknown as TrackingSegmentPayload;

describe("dribbleEvents", () => {
  // "me" (white) runs the ball from x=5 to x=17 over 4 s; "opp" (black) stands
  // in his path at x=11 and ends up behind him; "mate" (white) waits at x=25.
  const me = track("s0:me", 0, 200, (f) => [5 + (f / 20) * 3, 10]);
  const opp = track("s0:opp", 0, 200, () => [11, 10.5]);
  const mate = track("s0:mate", 0, 200, () => [25, 10]);
  const kits = new Map<string, Lab>([["s0:me", WHITE], ["s0:opp", BLACK], ["s0:mate", WHITE]]);
  const run = [0, 1, 2, 3, 4].map((t) => touch(t, "s0:me", 5 + t * 3, WHITE));
  const segs = [segment([me, opp, mate])];

  it("is a successful dribble when he runs past an opponent and his side has it next", () => {
    const d = dribbleEvents(manifest, segs, [...run, touch(5.5, "s0:mate", 25, WHITE)], kits, null);
    expect(d).toHaveLength(1);
    expect(d[0].outcome).toBe("won");
    expect(d[0].beaten).toBe(1);
    expect(d[0].opponentTrackId).toBe("s0:opp");
    expect(d[0].metres).toBeGreaterThanOrEqual(11);
    expect(d[0].touches).toBe(5);
  });

  it("is a failed dribble when the other side touches it next", () => {
    const d = dribbleEvents(manifest, segs, [...run, touch(4.5, "s0:opp", 17, BLACK)], kits, null);
    expect(d.map((x) => x.outcome)).toEqual(["lost"]);
    expect(teamDribbles(d, kits, { a: WHITE, b: BLACK })).toEqual({ total: [1, 0], won: [0, 0], lost: [1, 0] });
  });

  it("does not end the run or call it lost on one stray touch the carrier wins straight back", () => {
    const stray = [...run.slice(0, 3), touch(2.4, "s0:opp", 11, BLACK), ...run.slice(3), touch(5.5, "s0:mate", 25, WHITE)];
    const d = dribbleEvents(manifest, segs, stray, kits, null);
    expect(d).toHaveLength(1);
    expect(d[0].touches).toBe(6);
    expect(d[0].outcome).toBe("won");
    // the other side "touches" it 3.8 s later and the carrier has it again 0.7 s after that
    const regained = dribbleEvents(manifest, segs, [...run, touch(7.8, "s0:opp", 17, BLACK), touch(8.5, "s0:me", 17.5, WHITE)], kits, null);
    expect(regained.map((x) => x.outcome)).toEqual(["won"]);
  });

  it("is not a dribble without getting past anyone", () => {
    const wide = track("s0:opp", 0, 200, () => [11, 0]);
    expect(dribbleEvents(manifest, [segment([me, wide, mate])], run, kits, null)).toEqual([]);
    // an opponent who stays in front the whole way was never passed
    const chased = track("s0:opp", 0, 200, (f) => [8 + (f / 20) * 3, 10]);
    expect(dribbleEvents(manifest, [segment([me, chased, mate])], run, kits, null)).toEqual([]);
  });

  it("is not a dribble standing still in a 1-v-1, or with one touch, or without a pitch model", () => {
    const still = track("s0:me", 0, 200, () => [10, 10]);
    const spell = [0, 1, 2, 3].map((t) => touch(t, "s0:me", 10, WHITE));
    expect(dribbleEvents(manifest, [segment([still, opp])], spell, kits, null)).toEqual([]);
    expect(dribbleEvents(manifest, segs, [run[0], touch(3, "s0:mate", 25, WHITE)], kits, null)).toEqual([]);
    const noPitch = { ...manifest, pitchModel: undefined } as unknown as TrackingManifest;
    expect(dribbleEvents(noPitch, segs, run, kits, null)).toEqual([]);
  });

  it("belongs to the claimant whose part covers its first touch", () => {
    const d = dribbleEvents(manifest, segs, [...run, touch(5.5, "s0:mate", 25, WHITE)], kits, null);
    const mine = playerMoments([{ trackId: "s0:me", fromFrame: 0, toFrame: 100 }], d, [], []);
    expect([mine.dribbles.length, mine.dribblesWon, mine.dribblesLost]).toEqual([1, 1, 0]);
    expect(playerMoments([{ trackId: "s0:mate", fromFrame: 0, toFrame: 100 }], d, [], []).dribbles).toEqual([]);
  });
});

describe("dropTeleports", () => {
  // pitch x metres -> px = x * 96; y = 0 m -> py = 540
  const px = (x: number) => x * 96;
  const sidecar = {
    v: 1 as const,
    fps: 20,
    touches: [
      [5, 0, 0, 10, 10, px(10.2), 540, 1],
      [21, 0, 0, 10, 10, px(16), 540, 1],
      [40, 0, 0, 10, 10, px(11.4), 540, 1],
    ] as Array<[number, number, number, number, number, number, number, number]>,
    ball: [[0, px(10), 540], [5, px(10.2), 540], [10, px(10.4), 540], [15, px(10.6), 540], [20, px(16), 540], [25, px(16.1), 540], [30, px(11), 540], [35, px(11.2), 540], [40, px(11.4), 540]] as Array<[number, number, number]>,
    kits: {},
  };

  it("drops a jump onto a boot that comes straight back, and the touch it made", () => {
    const r = dropTeleports(sidecar, manifest);
    expect(r.teleports).toBe(1);
    expect(r.touchesDropped).toBe(1);
    expect(r.sidecar!.touches.map((t) => t[0])).toEqual([5, 40]);
    expect(r.sidecar!.ball.map((b) => b[0])).toEqual([0, 5, 10, 15, 30, 35, 40]);
  });

  it("keeps a ball that really flies away", () => {
    const shot = { ...sidecar, ball: [[0, px(10), 540], [5, px(10.2), 540], [10, px(14), 540], [15, px(18), 540], [20, px(22), 540], [25, px(26), 540]] as Array<[number, number, number]> };
    expect(dropTeleports(shot, manifest).teleports).toBe(0);
  });
});

describe("detected goals and shots", () => {
  const T = [touch(100, "s0:a", 30, WHITE), touch(398, "s0:b", 5, BLACK), touch(500, "s0:c", 35, WHITE)];

  it("merges goals one kick-off answers, keeping the last, and credits the last touch", () => {
    const g = detectedGoals([{ type: "goal", t: 400 }, { type: "goal", t: 440 }, { type: "goal", t: 102 }, { type: "shot", t: 101 }], T);
    expect(g.map((x) => x.t)).toEqual([102, 440]);
    expect(g[0].trackId).toBe("s0:a");
    expect(g[1].trackId).toBe(null); // 42 s after the last touch: nobody is credited
    expect(sideOfKit(g[0].kit, { a: WHITE, b: BLACK })).toBe(0);
  });

  it("never credits the goalkeeper with the goal or the shot", () => {
    const pitch = { length: 40, width: 20 };
    // the keeper came out to 35 m first, then was beaten from 1.8 m out and picked it out of the net
    const play = [touch(99, "s0:keeper", 35, WHITE), touch(100, "s0:passer", 30, BLACK), touch(101, "s0:striker", 38.2, BLACK), touch(101.6, "s0:keeper", 39, WHITE)];
    const g = detectedGoals([{ type: "goal", t: 102 }], play, pitch);
    expect(g[0].trackId).toBe("s0:striker");
    expect(detectedGoals([{ type: "goal", t: 102 }], play)[0].trackId).toBe("s0:keeper"); // no pitch: the old rule
    const s = detectedShots([{ type: "shot", t: 101.6 }], play, pitch);
    expect(s[0].trackId).toBe("s0:striker");
    // only the keeper touched it: nobody is credited rather than him
    expect(detectedShots([{ type: "shot", t: 101.6 }], [play[3]], pitch)[0].trackId).toBe(null);
  });

  it("credits a shot to a touch just before it", () => {
    const s = detectedShots([{ type: "shot", t: 399 }, { type: "shot", t: 450 }], T);
    expect(s.map((x) => x.trackId)).toEqual(["s0:b", null]);
  });
});

describe("personal moments", () => {
  it("follows the claimant through the clip and frames them", () => {
    const me = track("s0:me", 0, 400, (f) => [10 + f / 20, 5]);
    const path = followPath([{ trackId: "s0:me", fromFrame: 0, toFrame: 400 }], [segment([me])], manifest, 10);
    expect(path).toHaveLength(17);
    expect(path![8][0]).toBe(10);
    const crop = followCrop(path, 0, 2, 18, 3840 / 1080);
    expect(crop).toHaveLength(17);
    expect(crop[0].t).toBe(0);
    expect(crop[16].t).toBe(1);
    // the player moves right, so the frame does
    expect(crop[16].x).toBeGreaterThan(crop[0].x);
    for (const k of crop) expect(k.x).toBeGreaterThanOrEqual(0);
  });

  it("keeps the goals you were on for and drops other people's shots", () => {
    const events = [
      { id: "claim-goal-100", title: "Goal", momentSeconds: 100, kind: "goal", status: "ready" },
      { id: "claim-shot-200", title: "Shot", momentSeconds: 200, kind: "shot", status: "ready" },
      { id: "claim-goal-300", title: "Goal", momentSeconds: 300, kind: "goal", status: "ready" },
    ];
    const mine = [{ id: "me-goal-301", title: "Your goal", momentSeconds: 301, kind: "your-goal", status: "ready" }];
    expect(mergeMoments(events, mine).map((m) => m.id)).toEqual(["claim-goal-100", "me-goal-301"]);
    expect(mergeMoments(events, [])).toBe(events);
  });
});
