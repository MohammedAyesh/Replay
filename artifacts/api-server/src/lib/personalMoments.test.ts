import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/db";
import type { Dribble, Lab, Touch } from "./matchPlay";
import { PERSONAL, personalMoments } from "./personalMoments";
import type { RecordingPlay } from "./matchPlayLoad";

const WHITE: Lab = [200, 128, 128];
const BLACK: Lab = [20, 128, 128];
const manifest = {
  width: 3840,
  height: 1080,
  frameRate: 20,
  duration: 200,
  pitchModel: undefined,
} as unknown as TrackingManifest;
const parts = [{ trackId: "s0:me", fromFrame: 0, toFrame: 4000 }];

function touch(t: number, trackId: string, x: number, kit: Lab = WHITE): Touch {
  return {
    f: Math.round(t * 20),
    t,
    segmentIndex: 0,
    trackId,
    kit,
    ball: [x, 10],
    foot: [x, 10],
    d: 0,
    reassigned: false,
  };
}

function dribble(
  t0: number,
  outcome: Dribble["outcome"],
  metres: number | null,
  beaten: number,
): Dribble {
  return {
    trackId: "s0:me",
    f0: Math.round(t0 * 20),
    f1: Math.round((t0 + 2) * 20),
    t0,
    t1: t0 + 2,
    from: [5, 10],
    to: [5 + (metres ?? 0), 10],
    metres,
    touches: 4,
    beaten,
    beatenTrackIds: [],
    opponentTrackId: "s0:opponent",
    outcome,
  };
}

function play(overrides: Partial<RecordingPlay> = {}): RecordingPlay {
  return {
    recordingId: 394,
    manifest,
    fps: 20,
    hasBall: true,
    hasPitch: false,
    hasKits: true,
    sidecars: [{
      v: 1,
      fps: 20,
      touches: [],
      ball: [],
      kits: {
        "s0:me": [200, 128, 128, 1],
        "s0:mate": [200, 128, 128, 1],
        "s0:opponent": [20, 128, 128, 1],
      },
    }] as unknown as RecordingPlay["sidecars"],
    touches: [
      touch(10, "s0:me", 5),
      touch(12, "s0:mate", 18),
      touch(25, "s0:me", 5),
      touch(27, "s0:mate", 18),
    ],
    rejected: { noTrack: 0, tooFar: 0 },
    kitOptions: [{ lab: WHITE, secs: 100 }, { lab: BLACK, secs: 100 }],
    segments: null,
    kits: new Map(),
    events: [],
    dribbles: [],
    teleports: 0,
    inPlay: [[20, 80]],
    phases: null,
    ...overrides,
  } as RecordingPlay;
}

describe("personal moment selection", () => {
  it("keeps long passes only when their start time is in play", () => {
    const moments = personalMoments(play(), parts, [], manifest);
    expect(moments.filter((moment) => moment.kind === "long-pass").map((moment) => moment.id))
      .toEqual(["me-pass-25"]);

    // Old recordings without in-play spans continue to include both passes.
    const oldRecording = personalMoments(play({ inPlay: null }), parts, [], manifest);
    expect(oldRecording.filter((moment) => moment.kind === "long-pass").map((moment) => moment.id))
      .toEqual(["me-pass-10", "me-pass-25"]);
  });

  it("selects only live, won short dribbles, ranked by players beaten then distance", () => {
    const dribbles = [
      dribble(30, "won", 8, 3),
      dribble(31, "won", 11, 3),
      dribble(32, "won", 9, 2),
      dribble(33, "won", 10, 2),
      dribble(34, "won", 7, 1),
      dribble(35, "won", 8, 1),
      dribble(36, "won", 11, 1),
      dribble(40, null, 8, 5),
      dribble(41, "lost", 8, 5),
      dribble(42, "won", 12.1, 5),
      dribble(43, "won", null, 5),
      dribble(10, "won", 8, 5),
    ];
    const moments = personalMoments(play({ dribbles }), parts, [], manifest);
    const selected = moments
      .filter((moment) => moment.kind === "dribble")
      .map((moment) => moment.id);

    expect(PERSONAL.dribbleMaxMetres).toBe(12);
    expect(selected).toHaveLength(PERSONAL.maxDribbles);
    // Ties on players beaten prefer longer runs; only six moments are kept.
    expect(selected).toEqual([
      "me-dribble-30",
      "me-dribble-31",
      "me-dribble-32",
      "me-dribble-33",
      "me-dribble-35",
      "me-dribble-36",
    ]);
  });
});
