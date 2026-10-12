import { describe, expect, it } from "vitest";
import { firstRosterChunk, materializeRosterParts, seedRosterParts, chainParts } from "./parts";
import { clearPick, newState, pick, Y, type Ctx } from "./claim";

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

  it("materializes roster ranges immediately for already loaded chunks", () => {
    const ctx = makeContext(true);

    seedRosterParts(ctx, 1, [{ trackId: "s1:t7", fromFrame: 105, toFrame: 140 }]);

    expect(Y(ctx, 1).rosterParts).toEqual([]);
    expect(Y(ctx, 1).manual.map((piece) => piece.id)).toEqual(["roster:s1:t7:105:140"]);
  });

  it("retains roster ranges for later chunks until they load, then materializes them", () => {
    const ctx = makeContext(false);
    ctx.game.frameRate = 20;
    ctx.game.chunks = [{ k: 2, start: 15, dur: 10 }];
    const part = { trackId: "s1:t7", fromFrame: 305, toFrame: 340 };

    seedRosterParts(ctx, 2, [part]);
    expect(Y(ctx, 2).rosterParts).toEqual([part]);

    const loadedChunk = makeContext(true).CH[1];
    ctx.CH[2] = { ...loadedChunk!, k: 2, start: 15 };
    materializeRosterParts(ctx, 2);

    expect(Y(ctx, 2).rosterParts).toEqual([]);
    expect(Y(ctx, 2).manual.map((piece) => piece.id)).toEqual(["roster:s1:t7:305:340"]);
  });

  it("starts at the first chunk with 30 in-play roster seconds, excluding warm-up", () => {
    const ctx = makeContext(false);
    ctx.game.frameRate = 20;
    ctx.game.chunks = [
      { k: 1, start: 0, dur: 600 },
      { k: 2, start: 600, dur: 600 },
    ];
    ctx.S.off = [[0, 60, "play"]];
    const byChunk = new Map([
      [1, [{ trackId: "s1:t7", fromFrame: 0, toFrame: 1200 }]],
      [2, [{ trackId: "s1:t7", fromFrame: 12000, toFrame: 24000 }]],
    ]);

    expect(firstRosterChunk(ctx, byChunk)).toBe(2);
  });

  it("uses the highest in-play roster score when no chunk reaches 30 seconds", () => {
    const ctx = makeContext(false);
    ctx.game.frameRate = 20;
    ctx.game.chunks = [
      { k: 1, start: 0, dur: 60 },
      { k: 2, start: 60, dur: 60 },
      { k: 3, start: 120, dur: 60 },
    ];
    ctx.S.off = [[0, 60, "play"]];
    const byChunk = new Map([
      [1, [{ trackId: "s1:t7", fromFrame: 0, toFrame: 1200 }]],
      [2, [{ trackId: "s1:t7", fromFrame: 1200, toFrame: 1360 }]],
      [3, [{ trackId: "s1:t7", fromFrame: 2400, toFrame: 2600 }]],
    ]);

    expect(firstRosterChunk(ctx, byChunk)).toBe(3);
  });

  it("returns null when every playable roster score is zero", () => {
    const ctx = makeContext(false);
    ctx.game.frameRate = 20;
    ctx.game.chunks = [{ k: 1, start: 0, dur: 60 }];
    ctx.S.off = [[0, 5, "play"]];
    const byChunk = new Map([
      [1, [{ trackId: "s1:t7", fromFrame: 0, toFrame: 100 }]],
    ]);

    expect(firstRosterChunk(ctx, byChunk)).toBeNull();
  });

  it("does not choose an unplayable best chunk over a playable fallback", () => {
    const ctx = makeContext(false);
    ctx.game.frameRate = 20;
    ctx.game.chunks = [
      { k: 1, start: 0, dur: 60 },
      { k: 2, start: 60, dur: 60 },
    ];
    ctx.S.off = [[0, 60, "play"]];
    const byChunk = new Map([
      [1, [{ trackId: "s1:t7", fromFrame: 0, toFrame: 1200 }]],
      [2, [{ trackId: "s1:t7", fromFrame: 1200, toFrame: 1400 }]],
    ]);

    expect(firstRosterChunk(ctx, byChunk)).toBe(2);
  });

  it("preserves unresolved roster ranges through a shirt-identity pick for chainParts", () => {
    const ctx = makeContext(true);
    ctx.game.chunks = [{ k: 1, start: 0, dur: 10 }];
    ctx.game.outOfPlay = [];
    ctx.S = newState(ctx.game);
    ctx.S.order = [1];
    ctx.S.oi = 0;
    ctx.S.k = 1;
    ctx.S.step = "review";
    const part = { trackId: "unloaded-track", fromFrame: 100, toFrame: 120 };
    Y(ctx, 1).rosterParts = [part];

    pick(ctx, 1, "shirt-group", 0);

    expect(Y(ctx, 1).rosterParts).toEqual([part]);
    expect(chainParts(ctx)).toEqual([part]);
  });
});

describe("Not me", () => {
  it("drops the rejected person from the saved parts, picked group and roster alike", () => {
    const ctx = makeContext(true);
    const chunk = ctx.CH[1] as unknown as { groups: unknown[]; byCid: Record<string, unknown> };
    const group = { cid: "g7", members: ["s1:t7"], nb: [], dur: 4 };
    chunk.groups = [group];
    chunk.byCid = { g7: group };
    Object.assign(Y(ctx, 1), { cid: "g7", added: ["g7"], extra: ["s1:t7"] });
    Y(ctx, 1).rosterParts = [{ trackId: "s1:t9", fromFrame: 300, toFrame: 320 }];
    ctx.S.qi = 3;
    expect(chainParts(ctx).map((part) => part.trackId)).toEqual(["s1:t7", "s1:t9"]);

    clearPick(ctx, 1);

    expect(Y(ctx, 1).cid).toBeNull();
    expect(Y(ctx, 1).skipped).toBe(false);
    expect(ctx.S.qi).toBe(0);
    expect(chainParts(ctx)).toEqual([]);
  });
});