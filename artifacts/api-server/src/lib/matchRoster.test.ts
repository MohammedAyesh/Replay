import { describe, expect, it } from "vitest";
import type { TrackingSegmentPayload } from "@workspace/db";
import { parseMatchRoster, summarizeMatchRoster } from "./matchRoster";

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