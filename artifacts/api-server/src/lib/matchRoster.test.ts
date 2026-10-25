import { describe, expect, it } from "vitest";
import type { TrackingSegmentPayload } from "@workspace/db";
import { parseMatchRoster, summarizeMatchRoster, voteMatchRosterShirtNumber } from "./matchRoster";

const segments = [
  {
    segmentIndex: 0,
    name: "first-half",
    startFrame: 100,
    endFrame: 199,
    tracks: [{ id: "s0:t1", startFrame: 110, endFrame: 180, boxes: [] }],
  },
  {
    segmentIndex: 1,
    name: "second-half",
    startFrame: 200,
    endFrame: 299,
    tracks: [{ id: "s1:t41", startFrame: 208, endFrame: 224, boxes: [] }],
  },
] as unknown as TrackingSegmentPayload[];

describe("parseMatchRoster", () => {
  it("resolves segment/local-track pairs to the referenced track's exact stored frame bounds", () => {
    const roster = parseMatchRoster({
      players: [{
        player_id: "player-7",
        name: "  Sam  ",
        number: "07",
        minutes: 51.5,
        parts: [["second-half", "t41"]],
      }],
    }, segments);

    expect(roster).toEqual({
      v: 1,
      players: [{
        id: "player-7",
        name: "Sam",
        number: "07",
        minutes: 51.5,
        parts: [{
          segmentIndex: 1,
          segmentName: "second-half",
          trackId: "s1:t41",
          fromFrame: 208,
          toFrame: 224,
        }],
      }],
    });
    expect(summarizeMatchRoster(roster!)).toEqual({
      playerCount: 1,
      numberedPlayerCount: 1,
      playerMinutes: 51.5,
    });
  });

  it("accepts the pipeline's pid alias for older roster bundles", () => {
    const roster = parseMatchRoster({
      players: [{
        pid: "legacy-player-9",
        name: "Legacy player",
        parts: [["first-half", "t1"]],
      }],
    }, segments);

    expect(roster?.players[0]).toMatchObject({
      id: "legacy-player-9",
      name: "Legacy player",
      parts: [{
        segmentName: "first-half",
        trackId: "s0:t1",
        fromFrame: 110,
        toFrame: 180,
      }],
    });
  });

  it("discards invalid entries without requiring a roster to exist", () => {
    expect(parseMatchRoster(null, segments)).toBeNull();
    expect(parseMatchRoster({ players: "not an array" }, segments)).toBeNull();
    expect(parseMatchRoster({
      players: [{
        id: "bad-player",
        parts: [{ segment: "first-half", track_id: "t1" }],
      }],
    }, segments)).toBeNull();
  });

  it("filters tracks not present in a supplied segment payload", () => {
    const roster = parseMatchRoster({
      players: [{
        id: "player-1",
        parts: [["first-half", "t404"]],
      }],
    }, segments);

    expect(roster).toBeNull();
  });
});

describe("voteMatchRosterShirtNumber", () => {
  it("folds a partial single-digit read into the matching two-digit shirt with more frames", () => {
    expect(voteMatchRosterShirtNumber("25", [
      { number: "1", seenFrames: 13 },
      { number: "11", seenFrames: 8 },
      { number: "17", seenFrames: 3 },
    ])).toBe("11");
  });

  it("corrects a truncated match-roster number from a strong per-track read", () => {
    expect(voteMatchRosterShirtNumber("4", [
      { number: "44", seenFrames: 128 },
    ])).toBe("44");
  });

  it("accepts a clear single-digit vote", () => {
    expect(voteMatchRosterShirtNumber("6", [
      { number: "6", seenFrames: 77 },
    ])).toBe("6");
  });

  it("keeps the match-roster number when there are no reads", () => {
    expect(voteMatchRosterShirtNumber("12", [])).toBe("12");
  });

  it("keeps the match-roster number when the vote has fewer than eight frames", () => {
    expect(voteMatchRosterShirtNumber("25", [
      { number: "9", seenFrames: 4 },
    ])).toBe("25");
  });

  // Per-track reads from recordings 394, 396, 401 and 402, each checked by eye on the
  // frames that produced them (2026-10-25).
  const tracks = (number: string, ...frames: number[]) => frames.map((seenFrames) => ({ number, seenFrames }));

  it("keeps a white 8 when one track read the arm beside it as 18 (rec 394)", () => {
    expect(voteMatchRosterShirtNumber("8", [
      ...tracks("8", 22, 4, 12, 6, 15, 23, 6, 11, 13), ...tracks("18", 9), ...tracks("0", 7),
    ], "8")).toBe("8");
  });

  it("does not rename a front-print 10 to 70 on a first-digit misread (rec 394)", () => {
    expect(voteMatchRosterShirtNumber(null, [...tracks("10", 4), ...tracks("70", 9)])).toBeNull();
  });

  it("does not number a plain shirt from one track of 0 reads (rec 396)", () => {
    expect(voteMatchRosterShirtNumber(null, tracks("0", 15))).toBeNull();
    expect(voteMatchRosterShirtNumber(null, tracks("0", 10), "2")).toBeNull();
  });

  it("does not number a man in a jacket from one track that read 44 (rec 401)", () => {
    expect(voteMatchRosterShirtNumber(null, tracks("44", 9), "1")).toBeNull();
  });

  it("names the purple 11 the pipeline left blank (rec 401, rec 402)", () => {
    expect(voteMatchRosterShirtNumber(null, [...tracks("1", 8, 5), ...tracks("17", 3), ...tracks("11", 8)], "11")).toBe("11");
    expect(voteMatchRosterShirtNumber(null, [...tracks("11", 9, 3, 6), ...tracks("17", 4)], "11")).toBe("11");
  });

  it("names red 44 where the pipeline kept the half-read 4 (rec 401, rec 402)", () => {
    expect(voteMatchRosterShirtNumber("4", tracks("44", 5, 24, 40, 13, 4, 8, 20, 14), "4")).toBe("44");
    expect(voteMatchRosterShirtNumber("4", [...tracks("44", 3, 20, 38), ...tracks("4", 13)], "4")).toBe("44");
  });

  it("names a single digit only when it is the pipeline's own candidate", () => {
    expect(voteMatchRosterShirtNumber(null, tracks("0", 4, 10), "1")).toBeNull();
    expect(voteMatchRosterShirtNumber(null, tracks("1", 7, 11), "1")).toBe("1");
  });

  it("parses the pipeline's number candidate when the bundle has one", () => {
    const roster = parseMatchRoster({
      players: [{ player_id: "p1", number: null, number_cand: "11", minutes: 60, parts: [["second-half", "t41"]] }],
    }, segments);
    expect(roster?.players[0].numberCandidate).toBe("11");
  });
});
