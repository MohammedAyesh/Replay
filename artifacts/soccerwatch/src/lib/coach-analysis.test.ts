import { describe, expect, it } from "vitest";
import { coachBoardSchema, pitchMapper, type CoachAnalysis, type CoachBoard, type CoachPitch } from "@workspace/api-zod";
import { aroundCentre, drawAnalysis, drawArea, drawMove, formationOf, sidePlayers, sideShapeAt, unitEdges, type Rect } from "./coach-analysis";
import { drawBoard, emptyTrackStore, mergeTracks, noteMoment, shapeShows } from "./coach-board";

/** The same panorama-like camera as coach-pitch.test.ts. */
function syntheticPitch(rows = 65, cols = 193): CoachPitch {
  const x: number[] = [];
  const y: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const az = (c / (cols - 1) - 0.5) * Math.PI * 0.92;
      const d = 2.6 / (0.06 + (r / (rows - 1)) * 0.95);
      x.push(20 + d * Math.sin(az));
      y.push(23.5 - d * Math.cos(az));
    }
  }
  return { calibrationId: "test", width: 40, height: 22.28, rows, cols, x, y };
}
const pitch = syntheticPitch();
const map = pitchMapper(pitch)!;

/** A box (shares) whose feet stand at pitch (X, Y). */
function boxAt(X: number, Y: number): [number, number, number, number] {
  const [u, v] = map.toImage(X, Y)!;
  return [u - 0.005, v - 0.08, 0.01, 0.08];
}

/** A 2D context that records every path drawn, in canvas pixels. */
function recorder() {
  const paths: Array<Array<[number, number]>> = [];
  const texts: string[] = [];
  let cur: Array<[number, number]> = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "beginPath") return () => { cur = []; paths.push(cur); };
      if (prop === "moveTo" || prop === "lineTo") return (x: number, y: number) => cur.push([x, y]);
      if (prop === "fillText") return (t: string) => texts.push(t);
      if (prop === "measureText") return (t: string) => ({ width: t.length * 7 });
      if (prop === "createRadialGradient") return () => ({ addColorStop: () => undefined });
      if (prop === "canvas") return { width: 1600, height: 450 };
      return () => undefined;
    },
    set(target, prop, value) { target[prop as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, paths, texts };
}

const rect: Rect = { left: 0, top: 0, width: 1600, height: 450 };
const back = (pts: Array<[number, number]>) => pts.map(([x, y]) => map.toPitch(x / rect.width, y / rect.height));
const copy = { offside: "Offside", width: "Width", depth: "Depth", keeper: "GK", lines: { back: "Back", mid: "Middle", front: "Front" } };
const board = (extra: Partial<CoachBoard> = {}): CoachBoard => ({ v: 1, shapes: [], spotlights: [], ...extra });

const analysis: CoachAnalysis = {
  pitch,
  kits: ["#ffffff", "#cc0000"],
  oursKnown: true,
  attackHigh: [[0, 0]],
  players: {
    gk: { side: 0, kit: "#ffffff", group: null, adult: false },
    d1: { side: 0, kit: "#ffffff", group: null, adult: false },
    d2: { side: 0, kit: "#ffffff", group: null, adult: false },
    m1: { side: 0, kit: "#ffffff", group: null, adult: false },
    f1: { side: 0, kit: "#ffffff", group: null, adult: false },
    x1: { side: 1, kit: "#cc0000", group: null, adult: false },
    coach: { side: 0, kit: "#ffffff", group: null, adult: true },
  },
  groups: [],
  groupDetails: [],
  isTraining: true,
  hasAdults: true,
};
const boxes = new Map([
  ["gk", boxAt(3, 11)],
  ["d1", boxAt(10, 6)], ["d2", boxAt(11, 16)],
  ["m1", boxAt(18, 11)],
  ["f1", boxAt(27, 10)],
  ["x1", boxAt(25, 12)],
  ["coach", boxAt(14, 21)],
]);
const notAdult = (id: string) => !analysis.players[id]?.adult;

describe("board schema", () => {
  it("accepts the new tools and refuses a unit of one", () => {
    const ok = coachBoardSchema.safeParse(board({
      offside: [{ rosterId: "d1", color: "#FF5A3C" }],
      units: [{ id: "u", kind: "lanes", rosterIds: ["d1", "m1"], color: "#D4FF4F" }],
      teamLines: { side: 0, keeper: false },
      group: "yellow",
      showAdults: true,
      shapes: [
        { id: "m", kind: "move", color: "#FFFFFF", atMs: 10, rosterId: "d1", from: [0.3, 0.6], to: [0.35, 0.62] },
        { id: "a", kind: "area", color: "#FFC23C", atMs: 10, a: [10, 4], b: [22, 14], pinned: true },
      ],
    }));
    expect(ok.success).toBe(true);
    expect(coachBoardSchema.safeParse(board({ units: [{ id: "u", kind: "shape", rosterIds: ["d1"], color: "#D4FF4F" }] })).success).toBe(false);
  });
});

describe("units", () => {
  it("closes a shape around its players and fans lanes out from the first", () => {
    expect(unitEdges("shape", ["a", "b", "c"])).toEqual([["a", "b"], ["b", "c"], ["c", "a"]]);
    expect(unitEdges("lanes", ["a", "b", "c"])).toEqual([["a", "b"], ["a", "c"]]);
    expect(unitEdges("shape", ["a", "b"])).toEqual([["a", "b"]]);
  });

  it("orders four players round their middle so the shape never crosses itself", () => {
    const pts = [{ id: "a", at: [0, 0] }, { id: "c", at: [10, 10] }, { id: "b", at: [10, 0] }, { id: "d", at: [0, 10] }] as Array<{ id: string; at: [number, number] }>;
    const ids = aroundCentre(pts).map((p) => p.id);
    const i = ids.indexOf("a");
    const loop = [...ids.slice(i), ...ids.slice(0, i)];
    expect([["a", "b", "c", "d"], ["a", "d", "c", "b"]]).toContainEqual(loop);
  });

  it("labels every side of a triangle with its length in metres", () => {
    const { ctx, texts } = recorder();
    drawAnalysis(ctx, { rect, dpr: 1, t: 0, board: board({ units: [{ id: "u", kind: "shape", rosterIds: ["d1", "d2", "m1"], color: "#D4FF4F" }] }), boxes, map, analysis, visible: () => true, label: () => "", copy });
    const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const expected = [d([10, 6], [11, 16]), d([11, 16], [18, 11]), d([18, 11], [10, 6])].map((m) => `${m < 10 ? m.toFixed(1) : Math.round(m)} m`).sort();
    expect(texts.filter((t) => t.endsWith(" m")).sort()).toEqual(expected);
  });
});

describe("offside line", () => {
  it("runs across the whole pitch at the player's distance along it, following him", () => {
    const { ctx, paths, texts } = recorder();
    drawAnalysis(ctx, { rect, dpr: 1, t: 0, board: board({ offside: [{ rosterId: "d2", color: "#FF5A3C" }] }), boxes, map, analysis, visible: () => true, label: () => "#4", copy });
    const longest = paths.reduce((a, b) => (b.length > a.length ? b : a));
    const metres = back(longest);
    for (const m of metres) expect(m[0]).toBeCloseTo(11, 0);
    expect(Math.max(...metres.map((m) => m[1])) - Math.min(...metres.map((m) => m[1]))).toBeGreaterThan(21);
    expect(texts).toContain("Offside · #4");
  });

  it("is not drawn without a pitch model", () => {
    const { ctx, paths } = recorder();
    drawAnalysis(ctx, { rect, dpr: 1, t: 0, board: board({ offside: [{ rosterId: "d2", color: "#FF5A3C" }] }), boxes, map: null, analysis, visible: () => true, label: () => "", copy });
    expect(paths).toHaveLength(0);
  });
});

describe("team lines", () => {
  it("takes one side's players, leaves out hidden adults, and finds keeper, lines, width and depth", () => {
    expect(sidePlayers(analysis, { side: 0 }, notAdult).sort()).toEqual(["d1", "d2", "f1", "gk", "m1"]);
    const shape = sideShapeAt(map, analysis, { side: 0 }, boxes, 5, notAdult)!;
    // side 0 attacks the high end, so it defends X = 0
    expect(shape.defends).toBe("low");
    expect(shape.keeper).toBe("gk");
    expect(shape.lines).toEqual([["d1", "d2"], ["m1"], ["f1"]]);
    expect(formationOf(shape)).toBe("2-1-1");
    expect(shape.width).toBeCloseTo(10, 0);
    expect(shape.depth).toBeCloseTo(17, 0);
  });

  it("draws the lines and reports the shape for the read-out", () => {
    const { ctx, texts } = recorder();
    const out = drawAnalysis(ctx, { rect, dpr: 1, t: 5, board: board({ teamLines: { side: 0 } }), boxes, map, analysis, visible: notAdult, label: () => "", copy });
    expect(out.shape?.formation).toBe("2-1-1");
    expect(texts).toEqual(expect.arrayContaining(["Back", "Middle", "Front", "GK"]));
  });

  it("filters by training group", () => {
    const training: CoachAnalysis = { ...analysis, players: { ...analysis.players, d1: { ...analysis.players.d1, group: "yellow" }, m1: { ...analysis.players.m1, group: "yellow" } } };
    expect(sidePlayers(training, { group: "yellow" }, () => true).sort()).toEqual(["d1", "m1"]);
  });
});

describe("moves and drill areas", () => {
  it("draws a moved player's ghost smaller when he should have been further away, with the distance", () => {
    const from = map.toImage(12, 18)!;
    const to = map.toImage(12, 6)!;
    const { ctx, texts } = recorder();
    drawMove(ctx, { id: "m", kind: "move", color: "#FFFFFF", atMs: 0, rosterId: "d1", from, to, size: [0.01, 0.1] }, rect, 1, map, "#4");
    expect(texts).toEqual(["#4 · 12 m"]);
  });

  it("draws a drill area in perspective with its size in metres", () => {
    const { ctx, paths, texts } = recorder();
    drawArea(ctx, { id: "a", kind: "area", color: "#FFC23C", atMs: 0, a: [22, 14], b: [10, 4], pinned: true }, rect, 1, map);
    const metres = back(paths.reduce((a, b) => (b.length > a.length ? b : a)));
    expect(Math.min(...metres.map((m) => m[0]))).toBeCloseTo(10, 0);
    expect(Math.max(...metres.map((m) => m[1]))).toBeCloseTo(14, 0);
    expect(texts).toEqual(["12 × 10 m"]);
  });

  it("keeps a pinned drill area on screen through the video, and saves a note on the drawings, not the area", () => {
    const area = { id: "a", kind: "area" as const, color: "#FFC23C", atMs: 1000, a: [10, 4] as [number, number], b: [22, 14] as [number, number] };
    expect(shapeShows(area, 600_000)).toBe(true);
    expect(shapeShows({ ...area, pinned: false }, 600_000)).toBe(false);
    const arrow = { id: "b", kind: "arrow" as const, color: "#FFFFFF", atMs: 50_000, width: 4, from: [0.1, 0.1] as [number, number], to: [0.2, 0.2] as [number, number] };
    expect(noteMoment({ shapes: [area, arrow] }, 90_000)).toBe(50_000);
    expect(noteMoment({ shapes: [area] }, 90_000)).toBe(90_000);
  });
});

describe("drawBoard", () => {
  it("draws the analysis layer only for players that are shown, and returns the side's shape", () => {
    let store = emptyTrackStore();
    store = mergeTracks(store, {
      from: 0, to: 10, ball: [],
      players: Object.fromEntries([...boxes].map(([id, b]) => [id, Array.from({ length: 21 }, (_, i) => [i / 2, ...b])])) as never,
    });
    const { ctx } = recorder();
    const out = drawBoard(ctx, { rect, dpr: 1, t: 5, paused: true, board: board({ teamLines: { side: 0 } }), store, label: () => "", map, analysis, visible: notAdult });
    expect(out.shape?.formation).toBe("2-1-1");
    const withCoach = drawBoard(ctx, { rect, dpr: 1, t: 5, paused: true, board: board({ teamLines: { side: 0, keeper: false } }), store, label: () => "", map, analysis, visible: () => true });
    expect(withCoach.shape?.keeper).toBeNull();
  });
});
