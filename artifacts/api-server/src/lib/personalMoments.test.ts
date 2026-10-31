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
const trackedSegments = [{
  segmentIndex: 0,
  tracks: [{
    id: "s0:me",
    boxes: Array.from({ length: 201 }, (_, index) => ({
      frame: index * 20,
      x: 900 + index / 10,
      y: 400,
      w: 40,
      h: 90,
    })),
  }],
}] as never;

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
    const moments = personalMoments(play(), parts, trackedSegments, manifest);
    expect(moments.filter((moment) => moment.kind === "long-pass").map((moment) => moment.id))
      .toEqual(["me-pass-25"]);

    // Old recordings without in-play spans continue to include both passes.
    const oldRecording = personalMoments(play({ inPlay: null }), parts, trackedSegments, manifest);
    expect(oldRecording.filter((moment) => moment.kind === "long-pass").map((moment) => moment.id))
      .toEqual(["me-pass-10"]);
  });

  it("selects only live, won short dribbles, ranked by players beaten then distance", () => {
    const dribbles = [
      dribble(30, "won", 8, 3),
      dribble(50, "won", 11, 3),
      dribble(70, "won", 9, 2),
      dribble(90, "won", 10, 2),
      dribble(110, "won", 7, 1),
      dribble(130, "won", 8, 1),
      dribble(150, "won", 11, 1),
      dribble(160, null, 8, 5),
      dribble(161, "lost", 8, 5),
      dribble(162, "won", 12.1, 5),
      dribble(163, "won", null, 5),
      dribble(10, "won", 8, 5),
    ];
    const moments = personalMoments(play({ dribbles, inPlay: [[20, 180]] }), parts, trackedSegments, manifest);
    const selected = moments
      .filter((moment) => moment.kind === "dribble")
      .map((moment) => moment.id);

    expect(PERSONAL.dribbleMaxMetres).toBe(12);
    expect(selected).toHaveLength(PERSONAL.maxDribbles);
    // Ranking prefers runs that beat more players; results are returned chronologically.
    expect(selected).toEqual([
      "me-dribble-30",
      "me-dribble-50",
      "me-dribble-70",
      "me-dribble-90",
      "me-dribble-130",
      "me-dribble-150",
    ]);
  });

  it("uses a player-framed touch spell only when no classified action exists", () => {
    const touches = [20, 22, 24].map((t) => touch(t, "s0:me", 5));
    const boxes = Array.from({ length: 401 }, (_, index) => ({
      frame: 200 + index,
      x: 900 + index / 10,
      y: 400,
      w: 40,
      h: 90,
    }));
    const segments = [{
      segmentIndex: 0,
      tracks: [{ id: "s0:me", boxes }],
    }] as never;
    const moments = personalMoments(
      play({ touches, inPlay: [[10, 80]] }),
      parts,
      segments,
      manifest,
    );
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({
      id: "me-touch-spell-20",
      kind: "touch-spell",
      momentSeconds: 22,
    });
    expect(moments[0]?.follow).toHaveLength(17);
  });

  it("fills four distinct player-framed moments from a touch-heavy claim", () => {
    const times = [
      ...Array.from({ length: 10 }, (_, i) => 10 + i * 0.4),
      ...Array.from({ length: 10 }, (_, i) => 40 + i * 0.4),
      ...Array.from({ length: 10 }, (_, i) => 70 + i * 0.4),
      ...Array.from({ length: 7 }, (_, i) => 100 + i * 0.4),
    ];
    const touches = times.map((t) => touch(t, "s0:me", 5));
    const moments = personalMoments(
      play({ touches, dribbles: [dribble(130, "lost", 6, 0)], inPlay: [[0, 180]] }),
      parts,
      trackedSegments,
      manifest,
      [],
      { topSpeedAt: 160, topSpeedKmh: 24.9 },
    );
    expect(moments).toHaveLength(4);
    expect(moments.every((moment) => moment.follow && moment.follow.length > 0)).toBe(true);
    for (let i = 1; i < moments.length; i++) {
      expect(moments[i]!.momentSeconds - moments[i - 1]!.momentSeconds).toBeGreaterThanOrEqual(16);
    }
  });
});
