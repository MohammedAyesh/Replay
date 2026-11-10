import { describe, expect, it } from "vitest";
import { coachBoardSchema, coachBoxAt, coachShapeVisible, type CoachBox } from "@workspace/api-zod";
import {
  WHOLE,
  ballAt,
  boxesAt,
  emptyTrackStore,
  frameRect,
  hitPlayer,
  mergeTracks,
  missingWindow,
  nextSpotColor,
  panBy,
  playerLabel,
  thinStroke,
  toScreen,
  toShare,
  zoomAt,
} from "./coach-board";

const A = 32 / 9;

describe("coach board view", () => {
  it("fits the whole panorama in the stage and centres it", () => {
    const r = frameRect(1600, 900, A, WHOLE);
    expect(r.width).toBe(1600);
    expect(r.height).toBeCloseTo(450);
    expect(r.top).toBeCloseTo(225);
    expect(r.left).toBe(0);
  });

  it("zooms around the pointer and keeps the frame covering the stage", () => {
    const v = zoomAt(WHOLE, 1600, 900, A, 400, 450, 3);
    expect(v.zoom).toBe(3);
    const r = frameRect(1600, 900, A, v);
    // The point under the pointer stays under it.
    const before = toShare(frameRect(1600, 900, A, WHOLE), 400, 450);
    const [x] = toScreen(r, before);
    expect(x).toBeCloseTo(400, 0);
    expect(r.left).toBeLessThanOrEqual(0);
    expect(r.left + r.width).toBeGreaterThanOrEqual(1600);
    // Zoom stays within its limits.
    expect(zoomAt(WHOLE, 1600, 900, A, 0, 0, 0.1).zoom).toBe(1);
    expect(zoomAt(WHOLE, 1600, 900, A, 0, 0, 100).zoom).toBe(6);
  });

  it("pans without leaving the frame", () => {
    const zoomed = zoomAt(WHOLE, 1600, 900, A, 800, 450, 2);
    const far = panBy(zoomed, 1600, 900, A, 99999, 0);
    const r = frameRect(1600, 900, A, far);
    expect(r.left).toBe(0);
    // At zoom 1 there's nothing to pan.
    expect(panBy(WHOLE, 1600, 900, A, 300, 300)).toEqual({ zoom: 1, cx: 0.5, cy: 0.5 });
  });
});

describe("tracks", () => {
  const boxes: CoachBox[] = [[10, 0.1, 0.5, 0.01, 0.05], [10.2, 0.12, 0.5, 0.01, 0.05], [13, 0.3, 0.5, 0.01, 0.05]];

  it("moves a box in a straight line between samples, not across long gaps", () => {
    expect(coachBoxAt(boxes, 10.1)![0]).toBeCloseTo(0.11);
    expect(coachBoxAt(boxes, 10)).toEqual([0.1, 0.5, 0.01, 0.05]);
    expect(coachBoxAt(boxes, 11.5)).toBeNull();
    expect(coachBoxAt(boxes, 9)).toBeNull();
    expect(coachBoxAt(boxes, 13.1)).toEqual([0.3, 0.5, 0.01, 0.05]);
    expect(coachBoxAt([], 1)).toBeNull();
  });

  it("merges loaded windows and asks only for what is missing", () => {
    let store = emptyTrackStore();
    expect(missingWindow(store, 100)).toEqual([95, 155]);
    store = mergeTracks(store, { from: 95, to: 155, players: { p1: boxes }, ball: [[96, 0.5, 0.5]] });
    expect(missingWindow(store, 100)).toBeNull();
    expect(missingWindow(store, 130)).toEqual([155, 215]);
    store = mergeTracks(store, { from: 155, to: 215, players: { p1: [[160, 0.4, 0.5, 0.01, 0.05]] }, ball: [[96, 0.5, 0.5], [170, 0.1, 0.1]] });
    expect(store.covered).toEqual([[95, 215]]);
    expect(store.players.get("p1")!.map((b) => b[0])).toEqual([10, 10.2, 13, 160]);
    expect(store.ball.map((b) => b[0])).toEqual([96, 170]);
  });

  it("finds the tapped player, nearest first, with room around small boxes", () => {
    const store = mergeTracks(emptyTrackStore(), { from: 0, to: 60, players: {
      a: [[10, 0.5, 0.4, 0.01, 0.1]],
      b: [[10, 0.52, 0.4, 0.01, 0.1]],
    }, ball: [] });
    const at = boxesAt(store, 10);
    expect(hitPlayer(at, [0.505, 0.45])).toBe("a");
    expect(hitPlayer(at, [0.5255, 0.45])).toBe("b");
    expect(hitPlayer(at, [0.498, 0.45])).toBe("a");
    expect(hitPlayer(at, [0.9, 0.9])).toBeNull();
    expect(boxesAt(store, 10, new Set(["b"])).size).toBe(1);
  });

  it("puts the ball where it was seen and its last second behind it", () => {
    const ball: Array<[number, number, number]> = [[9, 0.1, 0.1], [9.5, 0.2, 0.2], [10, 0.3, 0.3], [12, 0.9, 0.9]];
    expect(ballAt(ball, 10.1)).toEqual({ at: [0.3, 0.3], trail: [[0.2, 0.2], [0.3, 0.3]] });
    expect(ballAt(ball, 11).at).toBeNull();
  });
});

describe("drawings", () => {
  it("shows a drawing only around its moment", () => {
    expect(coachShapeVisible({ atMs: 5000 }, 5000)).toBe(true);
    expect(coachShapeVisible({ atMs: 5000 }, 5800)).toBe(true);
    expect(coachShapeVisible({ atMs: 5000 }, 6500)).toBe(false);
  });

  it("thins a freehand stroke but keeps its end", () => {
    expect(thinStroke([[0, 0], [1, 0], [2, 0], [5, 0], [6, 0]], 3)).toEqual([[0, 0], [5, 0], [6, 0]]);
  });

  it("validates a saved board and refuses junk", () => {
    expect(coachBoardSchema.safeParse({ v: 1, shapes: [{ id: "x", kind: "zone", color: "#FFFFFF", atMs: 1, points: [[0, 0], [1, 0], [1, 1]] }], spotlights: [] }).success).toBe(true);
    expect(coachBoardSchema.safeParse({ v: 1, shapes: [{ id: "x", kind: "zone", color: "red", atMs: 1, points: [[0, 0]] }], spotlights: [] }).success).toBe(false);
    expect(coachBoardSchema.safeParse({ v: 1, shapes: [], spotlights: Array.from({ length: 7 }, (_, i) => ({ rosterId: `p${i}`, color: "#FFFFFF" })) }).success).toBe(false);
  });

  it("labels players and picks spotlight colours in turn", () => {
    expect(playerLabel({ number: "7", name: "Ali Hassan", shirtNumber: 9 })).toBe("#9 Ali");
    expect(playerLabel({ number: "7", name: null, shirtNumber: null })).toBe("#7");
    expect(playerLabel({ number: null, name: null, shirtNumber: null })).toBe("");
    expect(nextSpotColor(["#A", "#B"], ["#A", "#B", "#C"])).toBe("#C");
    expect(nextSpotColor(["#A", "#B", "#C"], ["#A", "#B", "#C"])).toBe("#A");
  });
});

describe("saved moments", () => {
  it("open on the drawings, not on wherever the video was played to", async () => {
    const { noteMoment } = await import("./coach-board");
    const shape = { id: "a", kind: "arrow" as const, color: "#FFFFFF", width: 4, from: [0, 0] as [number, number], to: [1, 1] as [number, number] };
    expect(noteMoment({ shapes: [] }, 9000)).toBe(9000);
    expect(noteMoment({ shapes: [{ ...shape, atMs: 8700 }] }, 9000)).toBe(9000);
    expect(noteMoment({ shapes: [{ ...shape, atMs: 4000 }, { ...shape, atMs: 6000 }] }, 9000)).toBe(6000);
  });
});
