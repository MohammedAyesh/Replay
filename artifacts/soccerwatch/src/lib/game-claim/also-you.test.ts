import { describe, expect, it } from "vitest";
import { seedRosterParts } from "./parts";
import { notYetYours, wrappedFrom, Y, type Ctx } from "./claim";
import type { Group } from "./model";

const piece = (id: string, t0: number, t1: number) => ({
  id, t0, t1, a: [1, 2], b: [3, 4], h0: 50, h1: 50, img: null, s: null, e: null, nr: 1, feat: null,
});

function makeContext(): Ctx {
  const chunk = {
    k: 1,
    start: 5,
    dur: 10,
    pieces: { "s1:t7": piece("s1:t7", 0, 4), "s1:t9": piece("s1:t9", 5, 9) },
    ov: {},
    ovb: {},
    crops: {},
    groups: [],
    byCid: {},
    gOf: {},
    crossings: [],
  };
  return {
    game: { frameRate: 20, chunks: [{ k: 1, start: 5, dur: 10 }] },
    CH: { 1: chunk },
    S: { you: {}, order: [], oi: 0 },
  } as unknown as Ctx;
}

const group = (cid: string, members: string[]): Group => ({ cid, dur: 4, team: null, members, junctions: [], nb: [] });

describe("Also you? never offers what is already yours", () => {
  it("drops a group made of the track the squad list already picked (rec 410, 50:07–59:55)", () => {
    const ctx = makeContext();
    seedRosterParts(ctx, 1, [{ trackId: "s1:t7", fromFrame: 105, toFrame: 180 }]);
    expect(Y(ctx, 1).manual.length).toBe(1);
    expect(notYetYours(ctx, 1, group("g7", ["s1:t7"]))).toEqual([]);
  });

  it("keeps the part of a group that is not yours yet", () => {
    const ctx = makeContext();
    seedRosterParts(ctx, 1, [{ trackId: "s1:t7", fromFrame: 105, toFrame: 180 }]);
    expect(notYetYours(ctx, 1, group("g79", ["s1:t7", "s1:t9"]))).toEqual(["s1:t9"]);
  });

  it("counts a picked group's own pieces as yours", () => {
    const ctx = makeContext();
    (ctx.CH[1] as { byCid: Record<string, Group> }).byCid.g7 = group("g7", ["s1:t7"]);
    Y(ctx, 1).cid = "g7";
    expect(notYetYours(ctx, 1, group("other", ["s1:t7"]))).toEqual([]);
    expect(notYetYours(ctx, 1, group("other", ["s1:t9"]))).toEqual(["s1:t9"]);
  });
});

describe("going back to the start of the match", () => {
  it("names the block the visit began with on the first block after the wrap, and only there", () => {
    const ctx = makeContext();
    // began at 50:00 (block 5), ran to the end, then wrapped to 10:00 (block 1)
    ctx.S.order = [5, 6, 7, 8, 1, 2, 3, 4];
    const at = (oi: number) => { ctx.S.oi = oi; return wrappedFrom(ctx); };
    expect(at(0)).toBeNull();
    expect(at(3)).toBeNull();
    expect(at(4)).toBe(5);
    expect(at(5)).toBeNull();
    expect(at(8)).toBeNull();
  });

  it("says nothing when the visit began at the start", () => {
    const ctx = makeContext();
    ctx.S.order = [1, 2, 3, 4];
    for (let oi = 0; oi < 4; oi++) {
      ctx.S.oi = oi;
      expect(wrappedFrom(ctx)).toBeNull();
    }
  });
});
