import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/api-client-react";
import { buildChunk, splitAtColourJumps, type BundleTrack } from "./game-claim/build";
import {
  chunkPercent,
  isSure,
  newState,
  questions,
  subtract,
  tapSpan,
  timeline,
  Y,
  type Ctx,
} from "./game-claim/claim";
import { gameFromManifest } from "./game-claim/load";
import type { Chunk, Game, Group } from "./game-claim/model";
import { complement, union } from "./game-claim/model";
import { benchSpansOut, chainParts } from "./game-claim/parts";

const FPS = 20;

/** A track walking in a straight line: one box per frame, 100 px tall. */
function walk(id: string, t0: number, t1: number, x0: number, vx: number): BundleTrack {
  const boxes = [];
  for (let f = Math.round(t0 * FPS); f <= Math.round(t1 * FPS); f++) {
    boxes.push({ frame: f, x: x0 + vx * (f / FPS - t0), y: 400, w: 40, h: 100 });
  }
  return { id, boxes };
}

function game(dur = 60): Game {
  return {
    chunks: [{ k: 0, start: 0, dur }],
    total: dur,
    srcW: 4096,
    srcH: 1152,
    frameRate: FPS,
    videoStartSeconds: 0,
    matchOffset: 0,
    outOfPlay: [],
    inplay: [[0, dur]],
    pitch: null,
  };
}

function group(cid: string, members: string[], chunk: Chunk, extra: Partial<Group> = {}): Group {
  const g: Group = {
    cid,
    dur: members.reduce((s, m) => s + chunk.pieces[m].t1 - chunk.pieces[m].t0, 0),
    team: null,
    members,
    junctions: [],
    nb: [],
    ...extra,
  };
  chunk.groups.push(g);
  chunk.byCid[cid] = g;
  for (const m of members) chunk.gOf[m] = cid;
  return g;
}

/**
 * A: 0-20 s, walks right; B: 22-40 s, starts where A ended (a 2 s handover the
 * bridge closes); C: 45-60 s, 3000 px away (someone else).
 */
function fixture(): Ctx {
  const chunk = buildChunk({
    k: 0,
    start: 0,
    dur: 60,
    frameRate: FPS,
    tracks: [walk("A", 0, 20, 100, 20), walk("B", 22, 40, 500, 20), walk("C", 45, 60, 3500, 0)],
    crossings: [],
    sprites: {},
  });
  group("g1", ["A", "B"], chunk, { junctions: [{ a: "A", b: "B", gap: 2, dm: 0, d: 0.3, ask: true }] });
  group("g2", ["C"], chunk);
  const g = game();
  const ctx: Ctx = { game: g, CH: { 0: chunk }, S: newState(g) };
  Y(ctx, 0).cid = "g1";
  return ctx;
}

describe("spans", () => {
  it("unions and complements", () => {
    expect(union([[5, 10], [0, 3], [8, 12]])).toEqual([[0, 3], [5, 12]]);
    expect(complement([[5, 10], [20, 30]], 40)).toEqual([[0, 5], [10, 20], [30, 40]]);
  });

  it("subtracts off ranges from a hole", () => {
    const r = subtract({ t0: 40, t1: 60, a: null, b: null }, [[45, 50, "play"], [55, 70, "cam"]]);
    expect(r.open.map((h) => [h.t0, h.t1])).toEqual([[40, 45], [50, 55]]);
    expect(r.off).toEqual([[45, 50, "play"], [55, 60, "cam"]]);
  });
});

describe("buildChunk", () => {
  it("samples boxes every half second and makes one piece per track", () => {
    const ctx = fixture();
    const c = ctx.CH[0];
    expect(Object.keys(c.pieces).sort()).toEqual(["A", "B", "C"]);
    expect(c.pieces.A.t0).toBe(0);
    expect(c.pieces.A.t1).toBe(20);
    expect(c.ov.A.length).toBe(41);
    // foot point: bottom centre of the box
    expect(c.pieces.A.a).toEqual([120, 500]);
  });
});

describe("timeline", () => {
  it("bridges a short reachable handover and leaves the rest as a hole", () => {
    const ctx = fixture();
    const t = timeline(ctx, 0);
    expect(t.found).toEqual([[0, 20], [22, 40]]);
    expect(t.br).toEqual([[20, 22]]);
    expect(t.holes.map((h) => [h.t0, h.t1])).toEqual([[40, 60]]);
    expect(t.fs).toBe(38);
    expect(t.bs).toBe(2);
  });

  it("counts overlapping out-of-play ranges once (never above 100%)", () => {
    const ctx = fixture();
    ctx.S.off = [[38, 55, "play"], [50, 60, "play"]];
    const t = timeline(ctx, 0);
    expect(t.inplay).toBe(38);
    expect(t.holes).toEqual([]);
    expect(t.fs).toBe(36);
    expect(chunkPercent(t)).toBe(100);
  });

  it("counts off-camera time only inside play", () => {
    const ctx = fixture();
    ctx.S.off = [[40, 50, "play"], [45, 60, "cam"]];
    const t = timeline(ctx, 0);
    expect(t.os).toBe(10);
  });
});

describe("questions", () => {
  it("asks about a join between two kept pieces, and not once one is dropped", () => {
    const ctx = fixture();
    expect(questions(ctx, 0).map((j) => `${j.a}-${j.b}`)).toEqual(["A-B"]);
    Y(ctx, 0).out.push("B");
    expect(questions(ctx, 0)).toEqual([]);
  });
});

describe("tapSpan", () => {
  it("walks out from the tap until the track jumps further than a body can move", () => {
    const chunk = buildChunk({
      k: 0,
      start: 0,
      dur: 60,
      frameRate: FPS,
      tracks: [{
        id: "T",
        // steady 0-10 s, then an ID switch: the box jumps 2000 px at 10.5 s
        boxes: Array.from({ length: 401 }, (_, f) => ({ frame: f, x: f <= 200 ? 100 : 2100, y: 400, w: 40, h: 100 })),
      }],
      crossings: [],
      sprites: {},
    });
    const g = game();
    const ctx: Ctx = { game: g, CH: { 0: chunk }, S: newState(g) };
    expect(tapSpan(ctx, 0, "T", 5, { t0: 0, t1: 60, a: null, b: null })).toEqual([0, 10]);
    expect(tapSpan(ctx, 0, "T", 15, { t0: 12, t1: 60, a: null, b: null })).toEqual([12, 20]);
  });
});

describe("isSure", () => {
  it("needs a clear lead over the runner-up", () => {
    expect(isSure([{ d: -1.2 }, { d: 0.1 }])).toBe(true);
    expect(isSure([{ d: -1.2 }, { d: -0.8 }])).toBe(false);
    expect(isSure([{ d: 0.4 }, { d: 3 }])).toBe(false);
    expect(isSure([{ d: -0.5 }])).toBe(true);
    expect(isSure([{ d: null }])).toBe(false);
  });
});

describe("chainParts", () => {
  it("turns kept pieces into identity parts in absolute frames", () => {
    const ctx = fixture();
    expect(chainParts(ctx)).toEqual([
      { trackId: "A", fromFrame: 0, toFrame: 400 },
      { trackId: "B", fromFrame: 440, toFrame: 800 },
    ]);
    Y(ctx, 0).out.push("A");
    expect(chainParts(ctx).map((p) => p.trackId)).toEqual(["B"]);
  });

  it("keeps a tap as the stretch of the track it landed on", () => {
    const ctx = fixture();
    Y(ctx, 0).manual.push({ id: "m1", manual: true, t0: 50, t1: 55, a: [0, 0], b: [0, 0], h0: 100, h1: 100, img: null, src: "C" });
    expect(chainParts(ctx)).toContainEqual({ trackId: "C", fromFrame: 1000, toFrame: 1100 });
  });

  it("reports bench time as off-pitch spans", () => {
    const ctx = fixture();
    ctx.S.off = [[0, 5, "play"], [100, 200, "bench"], [150, 250, "bench"]];
    expect(benchSpansOut(ctx)).toEqual([{ fromSeconds: 100, toSeconds: 250 }]);
  });
});

describe("gameFromManifest", () => {
  const manifest = {
    duration: 1200,
    width: 4096,
    height: 1152,
    frameRate: 20,
    videoStartSeconds: 30,
    matchOffset: 5,
    segments: [
      { index: 1, startSeconds: 600, endSeconds: 1200 },
      { index: 0, startSeconds: 0, endSeconds: 600 },
    ],
  } as unknown as TrackingManifest;

  it("orders chunks and marks the gaps between in-play spans as out of play", () => {
    const g = gameFromManifest(manifest, [[10, 300], [302, 900], [1000, 1150]]);
    expect(g.chunks.map((c) => c.k)).toEqual([0, 1]);
    expect(g.total).toBe(1200);
    // the 2 s gap is too short to mark
    expect(g.outOfPlay).toEqual([[0, 10], [900, 1000], [1150, 1200]]);
    expect(g.pitch).toBeNull();
  });

  it("marks nothing out of play when the bundle has no in-play spans", () => {
    const g = gameFromManifest(manifest, []);
    expect(g.outOfPlay).toEqual([]);
    expect(g.inplay).toEqual([[0, 1200]]);
  });
});

describe("splitAtColourJumps", () => {
  it("cuts a chain where a piece without pictures bridged two different shirts", () => {
    const ctx = fixture();
    const c = ctx.CH[0];
    const red = { to: [120, 190, 170] as [number, number, number], sh: [30, 128, 128] as [number, number, number], hi: new Array(32).fill(1 / 32), hr: 1 };
    const blue = { ...red, to: [80, 170, 55] as [number, number, number] };
    c.pieces.A.feat = red;
    c.pieces.B.feat = null;
    c.pieces.C.feat = blue;
    const out = splitAtColourJumps(c, { members: ["A", "B", "C"], junctions: [{ a: "A", b: "B", gap: 2, dm: 0, d: 1.4, ask: true }, { a: "B", b: "C", gap: 5, dm: 3, d: 1.4, ask: true }] }, 2.2);
    expect(out.map((x) => x.members)).toEqual([["A", "B"], ["C"]]);
    expect(out[0].junctions.map((j) => j.b)).toEqual(["B"]);
    c.pieces.C.feat = { ...red, to: [118, 189, 171] };
    expect(splitAtColourJumps(c, { members: ["A", "B", "C"], junctions: [] }, 2.2).length).toBe(1);
  });
});
