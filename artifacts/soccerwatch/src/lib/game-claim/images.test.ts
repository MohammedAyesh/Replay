import { describe, expect, it } from "vitest";
import { newState, nextIllustratedJoin, type Ctx } from "./claim";
import type { Chunk, Game, Junction, Piece } from "./model";
import { pictureForPiece } from "./images";

function piece(id: string, t0: number, t1: number): Piece {
  return {
    id,
    t0,
    t1,
    a: [0, 0],
    b: [1, 1],
    h0: 1,
    h1: 1,
    img: null,
    s: null,
    e: null,
    nr: 0,
    feat: null,
  };
}

function game(): Game {
  return {
    chunks: [{ k: 0, start: 0, dur: 20 }],
    total: 20,
    srcW: 1920,
    srcH: 1080,
    frameRate: 10,
    videoStartSeconds: 0,
    matchOffset: 0,
    outOfPlay: [],
    inplay: [[0, 20]],
    pitch: null,
  };
}

function chunk(crops: Record<string, string>): Chunk {
  const a = piece("track-a", 1, 3);
  const b = piece("track-b", 5, 7);
  const junction: Junction = { a: a.id, b: b.id, gap: 2, dm: 1, d: 0.5, ask: true };
  const group = {
    cid: "group-a",
    dur: 4,
    team: null,
    members: [a.id, b.id],
    junctions: [junction],
    nb: [],
  };
  return {
    k: 0,
    start: 0,
    dur: 20,
    pieces: { [a.id]: a, [b.id]: b },
    ov: {},
    ovb: {},
    crops,
    groups: [group],
    byCid: { [group.cid]: group },
    gOf: { [a.id]: group.cid, [b.id]: group.cid },
    crossings: [],
  };
}

describe("claim track pictures", () => {
  it("uses the nearest crop from the same track and marks it as nearby", () => {
    const data = chunk({
      "track-a#40": "before",
      "track-a#90": "after",
      "track-b#70": "another track",
    });
    const selection = pictureForPiece(data, data.pieces["track-a"], 2.9, 10);

    expect(selection).toEqual({ key: "track-a#40", localTime: 4, nearby: true });
  });

  it("returns nothing when the track has no pictures", () => {
    const data = chunk({ "track-b#60": "other track only" });

    expect(pictureForPiece(data, data.pieces["track-a"], 2, 10)).toBeNull();
  });

  it("skips a comparison when either track cannot provide a picture", () => {
    const data = chunk({ "track-a#20": "inside track a" });
    const g = game();
    const state = newState(g);
    state.you["0"] = {
      cid: "group-a",
      out: [],
      added: [],
      dropped: [],
      extra: [],
      seen: [],
      manual: [],
      skipped: false,
    };
    const ctx: Ctx = { game: g, CH: { 0: data }, S: state };

    expect(nextIllustratedJoin(ctx, 0, 0)).toEqual({
      index: 1,
      skipped: 1,
      junction: null,
      prompt: null,
    });
  });
});
