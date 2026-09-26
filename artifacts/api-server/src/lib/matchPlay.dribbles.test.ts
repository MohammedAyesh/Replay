import { describe, expect, it } from "vitest";
import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";
import {
  detectedGoals,
  detectedShots,
  dribbleEvents,
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
  // "me" (white) runs the ball from x=10 to x=16 over 2 s; "opp" (black) stands at x=13.
  const me = track("s0:me", 0, 200, (f) => [10 + (f / 40) * 3, 10]);
  const opp = track("s0:opp", 0, 200, () => [13, 10.5]);
  const mate = track("s0:mate", 0, 200, () => [25, 10]);
  const kits = new Map<string, Lab>([["s0:me", WHITE], ["s0:opp", BLACK], ["s0:mate", WHITE]]);
  const spell = [touch(0, "s0:me", 10, WHITE), touch(1, "s0:me", 11.5, WHITE), touch(2, "s0:me", 13, WHITE)];

  it("is a take-on won when his side touches it next", () => {
    const T = [...spell, touch(3.5, "s0:mate", 25, WHITE)];
    const d = dribbleEvents(manifest, [segment([me, opp, mate])], T, kits, null);
    expect(d).toHaveLength(1);
    expect(d[0].outcome).toBe("won");
    expect(d[0].opponentTrackId).toBe("s0:opp");
    expect(d[0].closestMetres).toBeLessThanOrEqual(1.8);
    expect(d[0].touches).toBe(3);
  });

  it("is lost when the other side touches it next", () => {
    const T = [...spell, touch(2.6, "s0:opp", 13, BLACK)];
    const d = dribbleEvents(manifest, [segment([me, opp, mate])], T, kits, null);
    expect(d.map((x) => x.outcome)).toEqual(["lost"]);
    expect(teamDribbles(d, kits, { a: WHITE, b: BLACK })).toEqual({ won: [0, 0], lost: [1, 0] });
  });

  it("is not a dribble with nobody near, and not graded with nobody after", () => {
    const far = track("s0:opp", 0, 200, () => [30, 0]);
    expect(dribbleEvents(manifest, [segment([me, far])], [...spell, touch(3, "s0:mate", 25, WHITE)], kits, null)).toEqual([]);
    const lonely = dribbleEvents(manifest, [segment([me, opp])], spell, kits, null);
    expect(lonely.map((x) => x.outcome)).toEqual([null]);
  });

  it("does not count a single touch, and needs a pitch model", () => {
    expect(dribbleEvents(manifest, [segment([me, opp])], [spell[0], touch(9, "s0:opp", 13, BLACK)], kits, null)).toEqual([]);
    const noPitch = { ...manifest, pitchModel: undefined } as unknown as TrackingManifest;
    expect(dribbleEvents(noPitch, [segment([me, opp])], spell, kits, null)).toEqual([]);
  });

  it("belongs to the claimant whose part covers its first touch", () => {
    const d = dribbleEvents(manifest, [segment([me, opp, mate])], [...spell, touch(3.5, "s0:mate", 25, WHITE)], kits, null);
    const mine = playerMoments([{ trackId: "s0:me", fromFrame: 0, toFrame: 100 }], d, [], []);
    expect([mine.dribblesWon, mine.dribblesLost]).toEqual([1, 0]);
    expect(playerMoments([{ trackId: "s0:mate", fromFrame: 0, toFrame: 100 }], d, [], []).dribbles).toEqual([]);
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
