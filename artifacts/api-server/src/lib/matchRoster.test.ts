import { describe, expect, it } from "vitest";
import { parseMatchRoster, summarizeMatchRoster } from "./matchRoster";

const segments = [
  { index: 0, name: "first-half", startFrame: 100, endFrame: 199 },
  { index: 1, name: "second-half", startFrame: 200, endFrame: 299 },
];

describe("parseMatchRoster", () => {
  it("keeps valid names, shirt numbers, minutes, and absolute namespaced parts", () => {
    const roster = parseMatchRoster({
      players: [{
        player_id: "player-7",
        name: "  Sam  ",
        number: "07",
        minutes: 51.5,
        parts: [
          { segment_name: "second-half", track_id: "t41", from_frame: 8, to_frame: 24, segment_start_frame: 200 },
        ],
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
          fromFrame: 8,
          toFrame: 24,
          segmentStartFrame: 200,
          absoluteFromFrame: 208,
          absoluteToFrame: 224,
        }],
      }],
    });
    expect(summarizeMatchRoster(roster!)).toEqual({
      playerCount: 1,
      numberedPlayerCount: 1,
      playerMinutes: 51.5,
    });
  });

  it("discards invalid entries without requiring a roster to exist", () => {
    expect(parseMatchRoster(null, segments)).toBeNull();
    expect(parseMatchRoster({ players: "not an array" }, segments)).toBeNull();
    expect(parseMatchRoster({
      players: [{
        id: "bad-player",
        parts: [{ segment: "first-half", track_id: "t1", from_frame: 120, to_frame: 130, segment_start_frame: 100 }],
      }],
    }, segments)).toBeNull();
  });

  it("filters tracks not present in a supplied segment payload", () => {
    const roster = parseMatchRoster({
      players: [{
        id: "player-1",
        parts: [{ segment: "first-half", track_id: "t404", from_frame: 0, to_frame: 10, segment_start_frame: 100 }],
      }],
    }, segments, [{
      segmentIndex: 0,
      tracks: [{ id: "s0:t1" }],
    } as never]);

    expect(roster).toBeNull();
  });
});