import { describe, expect, it } from "vitest";
import type { TrackingSegment } from "@workspace/api-client-react";
import { applyClaimIdentities, identityMapMatchesBundle } from "./claim-match-identities";

function segment(overrides: Partial<TrackingSegment> = {}): TrackingSegment {
  return {
    version: 1,
    segmentIndex: 0,
    name: "segment-0",
    startFrame: 0,
    endFrame: 9,
    startSeconds: 0,
    endSeconds: 1,
    tracks: [
      {
        id: "t1",
        label: null,
        startFrame: 0,
        endFrame: 9,
        boxes: Array.from({ length: 10 }, (_, frame) => ({ frame, x: frame, y: 0, w: 10, h: 10 })),
      },
      {
        id: "t2",
        label: null,
        startFrame: 0,
        endFrame: 9,
        boxes: Array.from({ length: 10 }, (_, frame) => ({ frame, x: 20 + frame, y: 0, w: 10, h: 10 })),
      },
    ],
    crossings: [{ frame: 3, trackId: "t1", otherTrackId: "t2", confidence: 0.9 }],
    inPlaySpans: [{ start: 0, end: 1 }],
    events: [],
    ...overrides,
  };
}

describe("applyClaimIdentities", () => {
  it("partitions one source track by identity frame ranges and preserves the unassigned tail", () => {
    const result = applyClaimIdentities(segment(), [
      { id: "alice", name: "Alice", parts: [{ trackId: "t1", fromFrame: 0, toFrame: 4 }] },
    ]);

    expect(result.tracks.map((track) => track.id)).toEqual(["alice", "t2", "unclaimed:0:t1:5"]);
    expect(result.tracks.find((track) => track.id === "alice")?.boxes.map((box) => box.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(result.tracks.find((track) => track.id.startsWith("unclaimed:"))?.boxes.map((box) => box.frame)).toEqual([5, 6, 7, 8, 9]);
  });

  it("resolves crossings at their frame instead of using the last global mapping", () => {
    const result = applyClaimIdentities(segment(), [
      { id: "alice", parts: [{ trackId: "t1", fromFrame: 0, toFrame: 2 }] },
      { id: "bob", parts: [{ trackId: "t1", fromFrame: 5, toFrame: 8 }] },
      { id: "other", parts: [{ trackId: "t2", fromFrame: 0, toFrame: 9 }] },
    ]);

    expect(result.crossings).toEqual([
      { frame: 3, trackId: "unclaimed:0:t1:3", otherTrackId: "other", confidence: 0.9 },
    ]);
  });

  it("skips tracks without boxes and removes only true frame-aware self crossings", () => {
    const emptyTrack = { id: "empty", label: null, startFrame: 0, endFrame: 9, boxes: [] };
    const result = applyClaimIdentities(segment({ tracks: [...segment().tracks, emptyTrack] }), [
      { id: "same", parts: [{ trackId: "t1", fromFrame: 0, toFrame: 9 }] },
      { id: "same", parts: [{ trackId: "t2", fromFrame: 0, toFrame: 2 }] },
    ]);

    expect(result.tracks.some((track) => track.id === "empty")).toBe(false);
    expect(result.crossings).toHaveLength(1);
    expect(result.crossings[0].trackId).toBe("same");
    expect(result.crossings[0].otherTrackId).toBe("unclaimed:0:t2:3");
  });
});

describe("identityMapMatchesBundle", () => {
  it("rejects maps without a matching bundle fingerprint", () => {
    expect(identityMapMatchesBundle({
      identities: [{ id: "alice", parts: [{ trackId: "t1", fromFrame: 0, toFrame: 1 }] }],
      provenance: { bundleFingerprint: "new", identityMapBundleFingerprint: "old" },
    })).toBe(false);
    expect(identityMapMatchesBundle({ identities: [] })).toBe(true);
  });
});