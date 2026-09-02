import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  completionSurvivesConcurrentProgress,
  deriveClaimState,
  resolveClaimIdentity,
  shouldKeepClaimCompleted,
  isAcceptedClaimAnswer,
  knownClaimTrackIds,
  parseUploadedBundleDetailed,
  parseZipBundleDetailed,
  summarizeTrackingSegments,
} from "./claimMatch";

const manifest = {
  version: 1,
  label: "test",
  width: 1920,
  height: 1080,
  frameRate: 1,
  frameCount: 100,
  duration: 100,
  matchOffset: 0,
  segmentCount: 2,
  segments: [
    { index: 0, name: "first", startFrame: 0, endFrame: 59, startSeconds: 0, endSeconds: 60 },
    { index: 1, name: "second", startFrame: 40, endFrame: 99, startSeconds: 40, endSeconds: 100 },
  ],
} as never;

const segments = [
  {
    segmentIndex: 0,
    name: "first",
    startFrame: 0,
    endFrame: 59,
    startSeconds: 0,
    endSeconds: 60,
    version: 1,
    tracks: [{ id: "player-1", startFrame: 0, endFrame: 59, boxes: [] }],
    crossings: [],
    inPlaySpans: [],
    events: [],
  },
  {
    segmentIndex: 1,
    name: "second",
    startFrame: 40,
    endFrame: 99,
    startSeconds: 40,
    endSeconds: 100,
    version: 1,
    tracks: [{ id: "player-1", startFrame: 40, endFrame: 99, boxes: [] }],
    crossings: [],
    inPlaySpans: [],
    events: [],
  },
] as never;

function correction(
  id: string,
  method: string,
  chosenTrackId: string,
  momentSeconds: number,
) {
  return {
    id: Number(id),
    userId: 1,
    recordingId: 1,
    clientId: id,
    momentSeconds,
    rejectedTrackId: null,
    chosenTrackId,
    answerMethod: method,
    questionCount: 1,
    undone: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("claim match server-derived progress", () => {
  it("canonicalizes calibration aliases and guards JSON and ZIP framing", () => {
    const segment = {
      index: 0,
      name: "only",
      startFrame: 0,
      endFrame: 1,
      startSeconds: 0,
      endSeconds: 0.08,
      file: "segments/only.json",
    };
    const model = {
      calibrationIdentifier: "calibration-alias",
      fitDate: "2026-02-03T04:05:06.000Z",
      aspectRatio: 16 / 9,
      pitchWidthMetres: 105,
      pitchHeightMetres: 68,
      grid: [
        [{ x: 0, y: 0 }, { x: 105, y: 0 }],
        [{ x: 0, y: 68 }, { x: 105, y: 68 }],
      ],
    };
    const manifestInput = {
      version: 1,
      label: "framing test",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 2,
      duration: 0.08,
      matchOffset: 0,
      segmentCount: 1,
      pitchModel: model,
      segments: [segment],
    };
    const segmentInput = { tracks: [], crossings: [], inPlaySpans: [], events: [] };
    const json = parseUploadedBundleDetailed({ ...manifestInput, segments: [{ ...segment, ...segmentInput }] });
    expect(json.error).toBeNull();
    expect(json.upload?.manifest.pitchModel).toMatchObject({
      calibrationId: "calibration-alias",
      fittedAt: "2026-02-03T04:05:06.000Z",
      calibratedAspectRatio: 16 / 9,
    });
    const zip = parseZipBundleDetailed(Buffer.from(zipSync({
      "manifest.json": strToU8(JSON.stringify(manifestInput)),
      "segments/only.json": strToU8(JSON.stringify(segmentInput)),
    })));
    expect(zip.error).toBeNull();
    expect(zip.upload?.manifest.pitchModel?.calibrationId).toBe("calibration-alias");

    const mismatch = parseUploadedBundleDetailed({
      ...manifestInput,
      pitchModel: { ...model, aspectRatio: 2 },
      segments: [{ ...segment, ...segmentInput }],
    });
    expect(mismatch.error).toMatch(/aspect ratio/i);
  });

  it("accepts canonical identity ids when validating browser corrections", () => {
    const identityManifest = {
      ...(manifest as object),
      identities: [{
        id: "mohammed",
        name: "Mohammed",
        parts: [{ trackId: "player-1", fromFrame: 0, toFrame: 99 }],
      }],
    } as never;

    expect(knownClaimTrackIds(identityManifest, segments).has("player-1")).toBe(true);
    expect(knownClaimTrackIds(identityManifest, segments).has("mohammed")).toBe(true);
  });

  it("merges overlapping accepted track spans and reaches completion from coverage", () => {
    const result = deriveClaimState(manifest, segments, [
      correction("1", "anchor-yes", "player-1", 10),
      correction("2", "anchor-yes", "player-1", 50),
      correction("3", "anchor-yes", "player-1", 90),
    ] as never);

    expect(result.coverageSeconds).toBe(100);
    expect(result.coveragePercent).toBe(100);
    expect(result.acceptedAnchorCount).toBe(3);
    expect(result.completed).toBe(true);
    expect(result.completionReason).toBe("coverage-threshold");
  });

  it("derives the same state from the compact bundle summary", () => {
    const summarySegments = summarizeTrackingSegments(segments as never);
    const fromSummary = deriveClaimState(manifest, summarySegments.segments, [
      correction("summary-1", "anchor-yes", "player-1", 10),
      correction("summary-2", "anchor-yes", "player-1", 50),
      correction("summary-3", "anchor-yes", "player-1", 90),
    ] as never);
    expect(fromSummary.coveragePercent).toBe(100);
    expect(fromSummary.completed).toBe(true);
    expect(fromSummary.playerStats.totalSegments).toBe(2);
  });

  it("attributes coverage to one best-supported person and exposes other people as conflicts", () => {
    const threePeople = [
      { segmentIndex: 0, name: "first", startFrame: 0, endFrame: 59, startSeconds: 0, endSeconds: 60, version: 1, tracks: [{ id: "player-1", startFrame: 0, endFrame: 59, boxes: [] }, { id: "player-2", startFrame: 0, endFrame: 59, boxes: [] }], crossings: [], inPlaySpans: [], events: [] },
      { segmentIndex: 1, name: "second", startFrame: 40, endFrame: 99, startSeconds: 40, endSeconds: 100, version: 1, tracks: [{ id: "player-1", startFrame: 40, endFrame: 99, boxes: [] }, { id: "player-3", startFrame: 40, endFrame: 99, boxes: [] }], crossings: [], inPlaySpans: [], events: [] },
    ];
    const result = deriveClaimState(manifest, threePeople as never, [
      correction("three-1", "anchor-yes", "player-1", 10),
      correction("three-2", "anchor-yes", "player-1", 50),
      correction("three-3", "anchor-yes", "player-2", 90),
    ] as never);
    expect(result.identityResolution?.personId).toBe("player-1");
    expect(result.identityResolution?.resolutionMethod).toBe("track-fallback");
    expect(result.coveragePercent).toBe(100);
    expect(result.conflictMoments).toEqual([90]);
    expect(result.acceptedAnchorCount).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.completionReason).toBe("identity-conflicts");
  });

  it("blocks completion for an identity conflict even after the winning person clears every threshold", () => {
    const longManifest = {
      version: 1, label: "long test", width: 1920, height: 1080, frameRate: 1,
      frameCount: 180, duration: 180, matchOffset: 0, segmentCount: 2,
      segments: [
        { index: 0, name: "first", startFrame: 0, endFrame: 89, startSeconds: 0, endSeconds: 90 },
        { index: 1, name: "second", startFrame: 90, endFrame: 179, startSeconds: 90, endSeconds: 180 },
      ],
    } as never;
    const longSegments = [
      { segmentIndex: 0, name: "first", startFrame: 0, endFrame: 89, startSeconds: 0, endSeconds: 90, tracks: [{ id: "winner", startFrame: 0, endFrame: 89, boxes: [] }, { id: "other", startFrame: 0, endFrame: 89, boxes: [] }], crossings: [], inPlaySpans: [], events: [] },
      { segmentIndex: 1, name: "second", startFrame: 90, endFrame: 179, startSeconds: 90, endSeconds: 180, tracks: [{ id: "winner", startFrame: 90, endFrame: 179, boxes: [] }, { id: "other", startFrame: 90, endFrame: 179, boxes: [] }], crossings: [], inPlaySpans: [], events: [] },
    ];
    const result = deriveClaimState(longManifest, longSegments as never, [
      correction("isolated-1", "anchor-yes", "winner", 10),
      correction("isolated-2", "anchor-yes", "winner", 50),
      correction("isolated-3", "anchor-yes", "winner", 100),
      correction("isolated-4", "anchor-yes", "other", 150),
    ] as never);
    expect(result.coveragePercent).toBe(100);
    expect(result.acceptedAnchorCount).toBe(3);
    expect(result.identityResolution?.acceptedAnswerCount).toBe(3);
    expect(result.completed).toBe(false);
    expect(result.completionReason).toBe("identity-conflicts");
  });

  it("resolves track parts to a valid identity map", () => {
    const identityManifest = {
      version: 1,
      label: "test",
      width: 1920,
      height: 1080,
      frameRate: 1,
      frameCount: 100,
      duration: 100,
      matchOffset: 0,
      segmentCount: 2,
      segments: [],
      provenance: { bundleFingerprint: "bundle-a", identityMapBundleFingerprint: "bundle-a" },
      identities: [{
        id: "person-a",
        parts: [{ trackId: "player-1", fromFrame: 0, toFrame: 99 }],
      }],
    } as never;
    const result = resolveClaimIdentity(identityManifest, segments, [
      correction("map-1", "anchor-yes", "player-1", 10),
      correction("map-2", "anchor-yes", "person-a", 50),
    ] as never);
    expect(result).toMatchObject({
      personId: "person-a",
      resolutionMethod: "identity-map",
      supportCount: 2,
      acceptedAnswerCount: 2,
    });
  });

  it("ignores an identity map whose fingerprint does not match the bundle", () => {
    const staleManifest = {
      version: 1, label: "stale map", width: 1920, height: 1080, frameRate: 1,
      frameCount: 100, duration: 100, matchOffset: 0, segmentCount: 2, segments: [],
      provenance: { bundleFingerprint: "bundle-new", identityMapBundleFingerprint: "bundle-old" },
      identities: [{ id: "person-a", parts: [{ trackId: "player-1", fromFrame: 0, toFrame: 99 }] }],
    } as never;
    expect(resolveClaimIdentity(staleManifest, segments, [
      correction("stale-map", "anchor-yes", "player-1", 10),
    ] as never)).toMatchObject({
      personId: "player-1",
      resolutionMethod: "track-fallback",
    });
  });

  it("persists no and skip answers without treating them as accepted coverage", () => {
    const no = correction("4", "anchor-no", "__none__", 20);
    const skip = correction("5", "anchor-skip", "__none__", 80);
    expect(isAcceptedClaimAnswer(no as never)).toBe(false);
    expect(isAcceptedClaimAnswer(skip as never)).toBe(false);

    const result = deriveClaimState(manifest, segments, [no, skip] as never);
    expect(result.answeredAnchorCount).toBe(2);
    expect(result.acceptedAnchorCount).toBe(0);
    expect(result.coverageSeconds).toBe(0);
    expect(result.unresolvedMoments).toEqual([20, 80]);
    expect(result.completed).toBe(false);
  });

  it("ignores undone answers when recalculating progress", () => {
    const undone = { ...correction("6", "anchor-yes", "player-1", 10), undone: true };
    const result = deriveClaimState(manifest, segments, [undone] as never);
    expect(result.correctionCount).toBe(0);
    expect(result.acceptedAnchorCount).toBe(0);
    expect(result.coverageSeconds).toBe(0);
  });

  it("uses the latest answer when an unresolved moment is revisited", () => {
    const first = correction("7", "anchor-no", "__none__", 25);
    const second = {
      ...correction("8", "anchor-yes", "player-1", 25),
      createdAt: new Date(first.createdAt.getTime() + 1000),
    };
    const result = deriveClaimState(manifest, segments, [first, second] as never);
    expect(result.answeredAnchorCount).toBe(1);
    expect(result.unresolvedMoments).toEqual([]);
    expect(result.acceptedAnchorCount).toBe(1);
    expect(result.coverageSeconds).toBe(100);
  });

  it("keeps a completed claim completed while surfacing a later identity conflict", () => {
    const conflictSegments = (segments as unknown as Array<{
      startFrame: number;
      endFrame: number;
      tracks: Array<Record<string, unknown>>;
    }>).map((segment) => ({
      ...segment,
      tracks: [
        ...segment.tracks,
        { id: "player-2", startFrame: segment.startFrame, endFrame: segment.endFrame, boxes: [] },
      ],
    }));
    const result = deriveClaimState(manifest, conflictSegments as never, [
      correction("complete-1", "anchor-yes", "player-1", 10),
      correction("complete-2", "anchor-yes", "player-1", 50),
      correction("complete-3", "anchor-yes", "player-1", 90),
      correction("late-conflict", "anchor-yes", "player-2", 80),
    ] as never);
    expect(result.completed).toBe(false);
    expect(result.completionReason).toBe("identity-conflicts");
    expect(result.conflictMoments).toEqual([80]);
    expect(completionSurvivesConcurrentProgress(true, result.completed)).toBe(true);
    expect(shouldKeepClaimCompleted(true, false, "pending")).toBe(true);
    expect(shouldKeepClaimCompleted(true, false, "disputed")).toBe(false);
    expect(shouldKeepClaimCompleted(true, false, "needs_resolution")).toBe(false);
  });

  it("reports supported player results from accepted tracking intervals", () => {
    const firstSegment = segments[0] as unknown as Record<string, unknown>;
    const result = deriveClaimState(manifest, [
      {
        ...firstSegment,
        events: [
          { type: "goal", time: 30 },
          { type: "shot", time: 75 },
        ],
      },
      segments[1],
    ] as never, [
      correction("8", "anchor-yes", "player-1", 10),
    ] as never);

    expect(result.playerStats).toEqual({
      confirmedSeconds: 100,
      minutesPlayed: 1.67,
      coveragePercent: 100,
      answeredMoments: 1,
      acceptedMoments: 1,
      trackedSegments: 2,
      totalSegments: 2,
      matchedEvents: 2,
      heatmap: { coordinateSpace: "camera", cells: [] },
      distanceMetres: null,
      averageSpeedMetresPerSecond: null,
      touches: {
        value: null,
        available: false,
        unavailableReason: "ball_tracking_and_possession_attribution_unavailable",
      },
      passes: {
        value: null,
        available: false,
        unavailableReason: "ball_tracking_and_possession_attribution_unavailable",
      },
      shots: {
        value: null,
        available: false,
        unavailableReason: "ball_tracking_and_possession_attribution_unavailable",
      },
      dribbles: {
        value: null,
        available: false,
        unavailableReason: "ball_tracking_and_possession_attribution_unavailable",
      },
    });
  });

  it("uses the bottom centre and pitch interpolation for completed player metrics", () => {
    const pitchManifest = {
      ...(manifest as object),
      width: 100,
      height: 100,
      duration: 4,
      frameCount: 4,
      segmentCount: 1,
      segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 3, startSeconds: 0, endSeconds: 4 }],
      pitchModel: {
        calibrationId: "test-calibration",
        fittedAt: "2026-01-01T00:00:00.000Z",
        calibratedAspectRatio: 1,
        pitchWidthMetres: 10,
        pitchHeightMetres: 10,
        grid: [
          [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          [{ x: 0, y: 10 }, { x: 10, y: 10 }],
        ],
      },
    } as never;
    const summarySegment = {
      segmentIndex: 0,
      name: "only",
      startFrame: 0,
      endFrame: 3,
      startSeconds: 0,
      endSeconds: 4,
      tracks: [{ id: "player-1", startFrame: 0, endFrame: 3 }],
      events: [],
    };
    const summary = [summarySegment] as never;
    const full = [{
      ...summarySegment,
      version: 1,
      tracks: [{
        id: "player-1",
        startFrame: 0,
        endFrame: 3,
        boxes: [
          { frame: 0, x: 0, y: 90, w: 1, h: 10 },
          { frame: 1, x: 49.5, y: 90, w: 1, h: 10 },
          { frame: 2, x: 99, y: 90, w: 1, h: 10 },
        ],
      }],
      crossings: [],
      inPlaySpans: [],
    }] as never;
    const result = deriveClaimState(pitchManifest, summary, [
      correction("pitch-1", "anchor-yes", "player-1", 1),
    ] as never, full);

    expect(result.playerStats.minutesPlayed).toBeCloseTo(4 / 60, 2);
    expect(result.playerStats.distanceMetres).toBeGreaterThan(0);
    expect(result.playerStats.heatmap.coordinateSpace).toBe("pitch");
    expect(result.playerStats.heatmap.cells.some((cell) => cell.y > 0.8)).toBe(true);
  });

  it("uses confirmed time for average speed and keeps top speed admin-only and guarded", () => {
    const speedManifest = {
      ...(manifest as object),
      width: 100,
      height: 100,
      frameRate: 10,
      frameCount: 30,
      duration: 3,
      segmentCount: 1,
      segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 29, startSeconds: 0, endSeconds: 3 }],
      pitchModel: {
        calibrationId: "speed-calibration",
        fittedAt: "2026-02-03T04:05:06.000Z",
        calibratedAspectRatio: 1,
        pitchWidthMetres: 20,
        pitchHeightMetres: 10,
        grid: [
          [{ x: 0, y: 0 }, { x: 20, y: 0 }],
          [{ x: 0, y: 10 }, { x: 20, y: 10 }],
        ],
      },
    } as never;
    const speedSummarySegment = {
      segmentIndex: 0,
      name: "only",
      startFrame: 0,
      endFrame: 29,
      startSeconds: 0,
      endSeconds: 3,
      tracks: [{ id: "player-1", startFrame: 0, endFrame: 29 }],
      events: [],
    };
    const summary = [speedSummarySegment] as never;
    const full = [{
      ...speedSummarySegment,
      version: 1,
      tracks: [{
        id: "player-1",
        startFrame: 0,
        endFrame: 29,
        boxes: Array.from({ length: 30 }, (_, frame) => ({
          frame,
          x: 10 + frame * 2.5,
          y: 70,
          w: 1,
          h: 20,
        })),
      }],
      crossings: [],
      inPlaySpans: [],
    }] as never;
    const result = deriveClaimState(speedManifest, summary, [
      correction("speed-1", "anchor-yes", "player-1", 1),
    ] as never, full);

    expect(result.playerStats.averageSpeedMetresPerSecond).toBeCloseTo(
      (result.playerStats.distanceMetres ?? 0) / result.playerStats.confirmedSeconds,
      2,
    );
    expect(result.playerStats).not.toHaveProperty("topSpeedMetresPerSecond");
    expect(result.adminPlayerStats.topSpeedMetresPerSecond).toBeCloseTo(5, 0);
    expect(result.adminPlayerStats.topSpeedUsableTimeFraction).toBeGreaterThan(0.9);
  });

  it("does not let an older progress save clear a completed claim", () => {
    expect(completionSurvivesConcurrentProgress(true, false)).toBe(true);
    expect(completionSurvivesConcurrentProgress(false, true)).toBe(true);
    expect(completionSurvivesConcurrentProgress(false, false)).toBe(false);
  });
});