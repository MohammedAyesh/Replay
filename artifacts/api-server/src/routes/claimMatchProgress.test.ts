import { describe, expect, it } from "vitest";
import {
  completionSurvivesConcurrentProgress,
  deriveClaimState,
  isAcceptedClaimAnswer,
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
      coveragePercent: 100,
      answeredMoments: 1,
      acceptedMoments: 1,
      trackedSegments: 2,
      totalSegments: 2,
      matchedEvents: 2,
    });
  });

  it("does not let an older progress save clear a completed claim", () => {
    expect(completionSurvivesConcurrentProgress(true, false)).toBe(true);
    expect(completionSurvivesConcurrentProgress(false, true)).toBe(true);
    expect(completionSurvivesConcurrentProgress(false, false)).toBe(false);
  });
});