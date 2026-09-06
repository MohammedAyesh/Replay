/**
 * The identity board's parked and deleted pieces, on the server side.
 *
 * identityDecisions has been written by the board, validated on every save and
 * stored on the manifest since the day it was introduced -- and read by
 * nothing. A player removed on the board stayed fully present in the video, in
 * every candidate list, and kept earning claim coverage exactly as if the
 * board had never been touched. This file pins the coverage half; the picker
 * half is in soccerwatch's claim-match-identities.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(),
  getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));

import type { TrackingManifest } from "@workspace/db";
import { trackIntervalsForId } from "./claimMatch";

const FINGERPRINT = "same-bundle";

/** 100 frames at 10fps = 10 seconds, so a frame is a clean 0.1s. */
function manifestWith(overrides: Partial<TrackingManifest> = {}): TrackingManifest {
  return {
    version: 1,
    label: "decisions",
    width: 100,
    height: 100,
    frameRate: 10,
    frameCount: 100,
    duration: 10,
    matchOffset: 0,
    segmentCount: 1,
    segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 99, startSeconds: 0, endSeconds: 10 }],
    provenance: { bundleFingerprint: FINGERPRINT, identityMapBundleFingerprint: FINGERPRINT },
    ...overrides,
  } as TrackingManifest;
}

const segments = [{
  segmentIndex: 0,
  startFrame: 0,
  endFrame: 99,
  startSeconds: 0,
  endSeconds: 10,
  tracks: [
    { id: "t1", startFrame: 0, endFrame: 99 },
    { id: "t2", startFrame: 0, endFrame: 99 },
  ],
  events: [],
}] as never;

describe("trackIntervalsForId honours the board's decisions", () => {
  it("gives a whole track its whole span when nothing is struck off", () => {
    expect(trackIntervalsForId(manifestWith(), segments, "t1"))
      .toEqual([{ startSeconds: 0, endSeconds: 10 }]);
  });

  it("earns nothing for a track the board deleted", () => {
    const manifest = manifestWith({
      identityDecisions: [{ trackId: "t1", fromFrame: 0, toFrame: 99, action: "deleted" }],
    } as Partial<TrackingManifest>);
    expect(trackIntervalsForId(manifest, segments, "t1")).toEqual([]);
  });

  it("splits around a struck-off middle rather than swallowing it", () => {
    const manifest = manifestWith({
      identityDecisions: [{ trackId: "t1", fromFrame: 40, toFrame: 59, action: "parked" }],
    } as Partial<TrackingManifest>);
    expect(trackIntervalsForId(manifest, segments, "t1")).toEqual([
      { startSeconds: 0, endSeconds: 4 },
      { startSeconds: 6, endSeconds: 10 },
    ]);
  });

  it("strikes off a piece of an identity without touching its other pieces", () => {
    const manifest = manifestWith({
      identities: [{
        id: "person-1",
        parts: [
          { trackId: "t1", fromFrame: 0, toFrame: 49 },
          { trackId: "t2", fromFrame: 50, toFrame: 99 },
        ],
      }],
      identityDecisions: [{ trackId: "t1", fromFrame: 0, toFrame: 49, action: "deleted" }],
    } as Partial<TrackingManifest>);
    // Only the t2 half survives: a decision is scoped to one track's frames,
    // never to the person as a whole.
    expect(trackIntervalsForId(manifest, segments, "person-1"))
      .toEqual([{ startSeconds: 5, endSeconds: 10 }]);
  });

  it("earns nothing for an unclaimed piece the board has struck off", () => {
    // An "unclaimed:" candidate is selectable in the picker, so it is exactly
    // the path a stale client would use to claim a deleted stretch.
    const manifest = manifestWith({
      identityDecisions: [{ trackId: "t1", fromFrame: 0, toFrame: 99, action: "deleted" }],
    } as Partial<TrackingManifest>);
    expect(trackIntervalsForId(manifest, segments, "unclaimed:0:t1:0")).toEqual([]);
  });

  it("leaves a decision on a different track alone", () => {
    const manifest = manifestWith({
      identityDecisions: [{ trackId: "t2", fromFrame: 0, toFrame: 99, action: "deleted" }],
    } as Partial<TrackingManifest>);
    expect(trackIntervalsForId(manifest, segments, "t1"))
      .toEqual([{ startSeconds: 0, endSeconds: 10 }]);
  });
});
