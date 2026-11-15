import { describe, expect, it } from "vitest";
import { EMPTY_COACH_BOARD, pitchMapper, type CoachBoard } from "@workspace/api-zod";
import type { TrackingManifest } from "@workspace/db";

import {
  boardForRoster,
  buildCoachAnalysis,
  coachPitch,
  familyRosterIds,
  playerFlags,
  trackFlagIndex,
} from "./coachAnalysis";
import type { RecordingPlay } from "./matchPlayLoad";
import type { MatchRoster } from "./matchRoster";

const grid = Array.from({ length: 5 }, (_, r) => Array.from({ length: 9 }, (_, c) => ({ x: c * 5, y: r * 5.57 })));
const pitchModel = {
  calibrationId: "cam1-test",
  fittedAt: "2026-10-04T22:00:00.000Z",
  calibratedAspectRatio: 4096 / 1152,
  pitchWidthMetres: 40,
  pitchHeightMetres: 22.28,
  grid,
};
const manifest = (extra: Partial<TrackingManifest> & Record<string, unknown> = {}) => ({
  width: 3840, height: 1080, frameRate: 20, duration: 600, videoStartSeconds: 2, segments: [], pitchModel, ...extra,
}) as unknown as TrackingManifest;

const part = (trackId: string, fromFrame: number, toFrame: number) => ({ segmentIndex: 0, segmentName: "c0", trackId, fromFrame, toFrame });
const ROSTER: MatchRoster = {
  v: 1,
  players: [
    { id: "p1", name: null, number: "7", minutes: 9, parts: [part("s0:t1", 0, 9000)] },
    { id: "p2", name: null, number: "9", minutes: 9, parts: [part("s0:t2", 0, 9000)] },
    { id: "p3", name: null, number: null, minutes: 8, parts: [part("s0:t3", 0, 8000)] },
    { id: "p4", name: null, number: null, minutes: 8, parts: [part("s0:t4", 0, 8000)] },
    { id: "coach", name: null, number: null, minutes: 10, parts: [part("s0:t5", 0, 10000)] },
  ],
};

describe("coachPitch", () => {
  it("hands the camera's grid to the coach board row by row", () => {
    const pitch = coachPitch(manifest())!;
    expect(pitch).toMatchObject({ calibrationId: "cam1-test", width: 40, height: 22.28, rows: 5, cols: 9 });
    expect(pitch.x.length).toBe(45);
    expect(pitch.x[1]).toBe(5);
    expect(pitch.y[9]).toBe(5.57);
    // and the board reads it the way the app's metrics do
    const map = pitchMapper(pitch)!;
    expect(map.toPitch(0.5, 0.5)).toEqual([20, 11.14]);
  });

  it("gives no pitch when the model was fitted for another crop or there is none", () => {
    expect(coachPitch(manifest({ width: 1920, height: 1080 }))).toBeNull();
    expect(coachPitch(manifest({ pitchModel: undefined }))).toBeNull();
  });
});

describe("training flags", () => {
  const segments = [{ tracks: [
    { id: "s0:t1", group: "yellow", adult: false, boxes: [] },
    { id: "s0:t2", group: "blue", adult: false, boxes: [] },
    { id: "s0:t5", adult: true, boxes: [] },
    { id: "s0:t6", boxes: [] },
  ] }] as never;

  it("reads group and adult off the bundle's tracks", () => {
    const index = trackFlagIndex(manifest(), segments);
    expect(index.get("s0:t1")).toEqual({ group: "yellow", adult: false });
    expect(index.get("s0:t5")).toEqual({ group: null, adult: true });
    expect(index.has("s0:t6")).toBe(false);
  });

  it("reads a per-track training map on the manifest too, by stored or raw id", () => {
    const index = trackFlagIndex(manifest({ training: { tracks: { t3: { group: "orange", adult: 0 } } } }), null);
    expect(playerFlags([part("s0:t3", 0, 100)], index)).toEqual({ group: "orange", adult: false });
  });

  it("gives a player the group and adult answer covering most of his time", () => {
    const index = new Map([
      ["s0:a", { group: "blue", adult: false }],
      ["s0:b", { group: "yellow", adult: true }],
    ]);
    expect(playerFlags([part("s0:a", 0, 300), part("s0:b", 300, 400)], index)).toEqual({ group: "blue", adult: false });
    expect(playerFlags([part("s0:a", 0, 100), part("s0:b", 100, 400)], index)).toEqual({ group: "yellow", adult: true });
  });

  it("has nothing to say without flags", () => {
    expect(playerFlags([part("s0:a", 0, 100)], new Map())).toEqual({ group: null, adult: null });
  });
});

const lab = (L: number, a: number, b: number, secs: number) => [L, a, b, secs] as [number, number, number, number];
// Two shirts: red (p1, p2) and white (p3, p4); the coach in grey.
const play = (extra: Partial<RecordingPlay> = {}): RecordingPlay => ({
  recordingId: 1,
  manifest: manifest(),
  fps: 20,
  hasBall: false,
  hasPitch: true,
  hasKits: true,
  sidecars: [{
    v: 1, fps: 20, touches: [], ball: [],
    kits: {
      "s0:t1": lab(120, 190, 160, 400), "s0:t2": lab(125, 188, 158, 400),
      "s0:t3": lab(240, 128, 128, 400), "s0:t4": lab(235, 129, 127, 400),
      "s0:t5": lab(150, 128, 128, 300),
    },
  }],
  touches: [],
  rejected: { noTrack: 0, tooFar: 0 },
  kitOptions: [],
  bib: null,
  segments: [{ tracks: [{ id: "s0:t5", adult: true, boxes: [] }, { id: "s0:t3", group: "white", boxes: [] }] }] as never,
  kits: new Map(),
  events: [],
  dribbles: [],
  teleports: 0,
  inPlay: null,
  phases: null,
  direction: null,
  ...extra,
});

describe("buildCoachAnalysis", () => {
  it("puts our players on side 0 when the line-up binds them", () => {
    const out = buildCoachAnalysis(play(), ROSTER, new Set(["p3"]));
    expect(out.oursKnown).toBe(true);
    expect(out.players.p3.side).toBe(0);
    expect(out.players.p4.side).toBe(0);
    expect(out.players.p1.side).toBe(1);
    expect(out.players.p2.side).toBe(1);
    // ours is the white shirt
    expect(parseInt(out.kits![0].slice(1, 3), 16)).toBeGreaterThan(200);
    expect(out.pitch?.calibrationId).toBe("cam1-test");
  });

  it("still splits the two shirts without a line-up, and says it does not know which is ours", () => {
    const out = buildCoachAnalysis(play(), ROSTER, new Set());
    expect(out.oursKnown).toBe(false);
    expect(out.players.p1.side).toBe(out.players.p2.side);
    expect(out.players.p3.side).toBe(out.players.p4.side);
    expect(out.players.p1.side).not.toBe(out.players.p3.side);
  });

  it("carries training flags and lists the groups", () => {
    const out = buildCoachAnalysis(play(), ROSTER, new Set());
    expect(out.hasAdults).toBe(true);
    expect(out.players.coach.adult).toBe(true);
    expect(out.players.p3.group).toBe("white");
    expect(out.groups).toEqual(["white"]);
  });

  it("samples which side attacks the far goal through the video, on the video clock", () => {
    const direction = {
      kits: [[120, 190, 160], [240, 128, 128]] as [[number, number, number], [number, number, number]],
      sideOf: () => null,
      attacking: (_x: number, t: number) => (t < 300 ? 0 : 1) as 0 | 1,
    };
    const out = buildCoachAnalysis(play({ direction }), ROSTER, new Set(["p3"]));
    // direction side 0 is the red shirt, which is our side 1
    expect(out.attackHigh).toEqual([[2, 1], [302, 0]]);
  });

  it("has no sides without shirt colours", () => {
    const out = buildCoachAnalysis(play({ hasKits: false }), ROSTER, new Set(["p3"]));
    expect(out.kits).toBeNull();
    expect(out.players.p1.side).toBeNull();
  });

  it("can be cut down to a few players", () => {
    const out = buildCoachAnalysis(play(), ROSTER, new Set(), { only: new Set(["p1"]) });
    expect(Object.keys(out.players)).toEqual(["p1"]);
  });
});

describe("boards", () => {
  const board: CoachBoard = {
    ...EMPTY_COACH_BOARD,
    spotlights: [{ rosterId: "p1", color: "#D4FF4F" }, { rosterId: "ghost", color: "#2FD8C4" }],
    offside: [{ rosterId: "p2", color: "#FF5A3C" }, { rosterId: "ghost", color: "#FFFFFF" }],
    units: [
      { id: "u1", kind: "shape", rosterIds: ["p1", "p2", "ghost"], color: "#D4FF4F" },
      { id: "u2", kind: "lanes", rosterIds: ["p3", "ghost"], color: "#D4FF4F" },
    ],
    shapes: [
      { id: "m1", kind: "move", color: "#FFFFFF", atMs: 1000, rosterId: "p4", from: [0.5, 0.5], to: [0.6, 0.5] },
      { id: "m2", kind: "move", color: "#FFFFFF", atMs: 1000, rosterId: "ghost", from: [0.5, 0.5], to: [0.6, 0.5] },
      { id: "a1", kind: "area", color: "#FFC23C", atMs: 0, a: [10, 5], b: [20, 15], pinned: true },
    ],
  };

  it("drops players the analysis does not have from every tool, and units left with one player", () => {
    const out = boardForRoster(board, { roster: ROSTER });
    expect(out.spotlights.map((s) => s.rosterId)).toEqual(["p1"]);
    expect(out.offside?.map((o) => o.rosterId)).toEqual(["p2"]);
    expect(out.units).toEqual([{ id: "u1", kind: "shape", rosterIds: ["p1", "p2"], color: "#D4FF4F" }]);
    expect(out.shapes.map((s) => s.id)).toEqual(["m1", "a1"]);
  });

  it("lets a family see the players a note points at, and the side whose lines it shows, never the hidden adults", () => {
    const clean = boardForRoster(board, { roster: ROSTER });
    expect([...familyRosterIds(clean, null)].sort()).toEqual(["p1", "p2", "p4"]);
    const sides = {
      p1: { side: 1 as const, group: null, adult: false },
      p3: { side: 0 as const, group: "white", adult: false },
      coach: { side: 0 as const, group: "white", adult: true },
    };
    expect([...familyRosterIds({ ...clean, teamLines: { side: 0 } }, sides)].sort()).toEqual(["p1", "p2", "p3", "p4"]);
    expect([...familyRosterIds({ ...clean, teamLines: { group: "white" }, showAdults: true }, sides)].sort()).toEqual(["coach", "p1", "p2", "p3", "p4"]);
  });
});
