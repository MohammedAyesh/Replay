import { describe, expect, it } from "vitest";
import { materializeRosterParts, chainParts } from "./parts";
import { Y, type Ctx } from "./claim";

function makeContext(loaded: boolean): Ctx {
  const chunk = {
    k: 1,
    start: 5,
    dur: 10,
    pieces: {
      "s1:t7": {
        id: "s1:t7",
        t0: 0,
        t1: 4,
        a: [1, 2],
        b: [3, 4],
        h0: 50,
        h1: 50,
        img: null,
        s: null,
        e: null,
        nr: 1,
        feat: null,
      },
    },
    ov: {},
    ovb: {},
    crops: {},
    groups: [],
    byCid: {},
    gOf: {},
    crossings: [],
  };
  return {
    game: { frameRate: 20 },
    CH: loaded ? { 1: chunk } : {},
    S: { you: {} },
  } as unknown as Ctx;
}

describe("roster-seeded claim parts", () => {
  it("sends exact roster frames while a chunk has not loaded", () => {
    const ctx = makeContext(false);
    Y(ctx, 1).rosterParts = [{ trackId: "s1:t7", fromFrame: 105, toFrame: 140 }];

    expect(chainParts(ctx)).toEqual([
      { trackId: "s1:t7", fromFrame: 105, toFrame: 140 },
    ]);
  });

  it("materializes exact ranges for review and respects a later removal", () => {
    const ctx = makeContext(true);
    Y(ctx, 1).rosterParts = [{ trackId: "s1:t7", fromFrame: 105, toFrame: 140 }];

    materializeRosterParts(ctx, 1);

    expect(Y(ctx, 1).rosterParts).toEqual([]);
    expect(chainParts(ctx)).toEqual([
      { trackId: "s1:t7", fromFrame: 105, toFrame: 140 },
    ]);

    Y(ctx, 1).out.push("roster:s1:t7:105:140");
    expect(chainParts(ctx)).toEqual([]);
  });
});