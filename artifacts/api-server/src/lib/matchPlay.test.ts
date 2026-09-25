import { describe, expect, it } from "vitest";
import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";
import {
  kitOfParts,
  kitOptions,
  parseBallSidecar,
  passEvents,
  playerPlay,
  resolveTouches,
  seedTeams,
  teamStats,
  type BallSidecar,
  type Lab,
  type Touch,
} from "./matchPlay";
import { durationSeconds, recordingWindow } from "./matchFeed";
import { parsePeopleSidecar } from "./peopleSidecar";

const WHITE: Lab = [200, 128, 128];
const BLACK: Lab = [20, 128, 128];

function touch(t: number, trackId: string, x: number, kit: Lab | null = WHITE): Touch {
  return { f: Math.round(t * 20), t, segmentIndex: 0, trackId, kit, ball: [x, 10], foot: [x, 10], d: 0, reassigned: false };
}

describe("passEvents", () => {
  it("grades only balls of 6 m or more, and completes them on the same shirt", () => {
    const T = [
      touch(0, "a", 0),            // a -> a: carry
      touch(1, "a", 1),            // a -> b, 3 m: contested
      touch(2, "b", 4, BLACK),     // b -> c, 10 m, same black: completed pass
      touch(3, "c", 14, BLACK),    // c -> d, 8 m, white: not completed
      touch(4, "d", 22),           // gap of 10 s: not linked
      touch(14, "e", 30),
    ];
    const pick = { a: WHITE, b: BLACK };
    const ev = passEvents(T, pick);
    expect(ev.map((e) => e?.kind ?? null)).toEqual(["carry", "contest", "pass", "pass", null]);
    expect(ev[2]!.sameTeam).toBe(true);
    expect(ev[3]!.sameTeam).toBe(false);
    const s = teamStats(T, ev, pick);
    expect(s.passesTried).toEqual([0, 2]);
    expect(s.passesCompleted).toEqual([0, 1]);
    expect(s.contested).toBe(1);
    expect(s.carries).toBe(1);
    expect(s.touches).toEqual([4, 2]);
  });

  it("gives a player the passes they played and received", () => {
    const T = [touch(0, "s0:t1", 0), touch(1, "s0:t2", 9), touch(2, "s0:t1", 20)];
    const ev = passEvents(T, { a: WHITE, b: BLACK });
    const me = playerPlay(T, ev, [{ trackId: "s0:t1", fromFrame: 0, toFrame: 100 }], true);
    expect(me.touches).toHaveLength(2);
    expect(me.passesTried).toBe(1);
    expect(me.passesCompleted).toBe(1);
    expect(me.passesReceived).toBe(1);
    expect(me.passes.map((p) => [p.give, p.otherTrackId])).toEqual([[true, "s0:t2"], [false, "s0:t2"]]);
  });
});

describe("sidecars", () => {
  it("namespaces kits and drops malformed rows", () => {
    const sc = parseBallSidecar({ touches: [[10, 0, 0, 5, 10, 2, 9, 3], [1, 2]], ball: [[10, 2, 9], ["x"]], kits: { t4: [100, 128, 128, 30] } }, 2)!;
    expect(sc.touches).toHaveLength(1);
    expect(sc.ball).toHaveLength(1);
    expect(Object.keys(sc.kits)).toEqual(["s2:t4"]);
  });

  it("namespaces the pipeline's groups", () => {
    const p = parsePeopleSidecar({
      pieces: { t1: { to: [1, 2, 3], sh: [0, 0, 0], hi: new Array(32).fill(1 / 32), hr: 1, nr: 40, kit: 1 } },
      groups: [{ cid: "t1", dur: 90, team: "light", torso: [1, 2, 3], members: ["t1", "t2"], junctions: [{ a: "t1", b: "t2", gap: 1, dm: 2, d: 0.5, ask: false }], nb: [[1.2, "t9", []]] }],
    }, 3)!;
    expect(Object.keys(p.pieces)).toEqual(["s3:t1"]);
    expect(p.groups[0].members).toEqual(["s3:t1", "s3:t2"]);
    expect(p.groups[0].junctions[0].b).toBe("s3:t2");
    expect(p.groups[0].nb).toEqual([[1.2, "s3:t9"]]);
  });

  it("offers the kits on the pitch and seeds yours against the most contrasting", () => {
    const sc: BallSidecar = { v: 1, fps: 20, touches: [], ball: [], kits: { "s0:t1": [200, 128, 128, 400], "s0:t2": [20, 128, 128, 300], "s0:t3": [100, 150, 128, 70] } };
    const options = kitOptions([sc]);
    expect(options.map((o) => o.secs)).toEqual([400, 300, 70]);
    const own = kitOfParts([{ trackId: "s0:t1", fromFrame: 0, toFrame: 200 }], [sc], 20);
    expect(own).toEqual([200, 128, 128]);
    expect(seedTeams(own, options)!.b).toEqual([20, 128, 128]);
  });
});

describe("resolveTouches", () => {
  it("names the track under the ball tracker's box and drops a ball that was in the air", () => {
    const manifest = {
      width: 3840, height: 1080, frameRate: 20,
      pitchModel: { calibrationId: "c", fittedAt: "2026-09-01T00:00:00Z", calibratedAspectRatio: 3840 / 1080, pitchWidthMetres: 40, pitchHeightMetres: 20,
        grid: [[{ x: 0, y: -20 }, { x: 40, y: -20 }], [{ x: 0, y: 20 }, { x: 40, y: 20 }]] },
    } as unknown as TrackingManifest;
    const box = (frame: number, x: number) => ({ frame, x, y: 800, w: 40, h: 150 });
    const segment = { segmentIndex: 0, tracks: [{ id: "s0:t1", boxes: [box(100, 1000), box(200, 1000)] }] } as unknown as TrackingSegmentPayload;
    const sc: BallSidecar = {
      v: 1, fps: 20, kits: {}, ball: [],
      touches: [
        [100, 1000, 800, 1040, 950, 1020, 948, 5], // ball at the feet
        [200, 1000, 800, 1040, 950, 1020, 300, 5], // ball projects 10+ m away: in the air
      ],
    };
    const r = resolveTouches(manifest, [segment], [sc]);
    expect(r.touches.map((t) => t.trackId)).toEqual(["s0:t1"]);
    expect(r.rejected.tooFar).toBe(1);
  });
});

describe("match windows", () => {
  it("reads durations and places the tracked footage in Amman time", () => {
    expect(durationSeconds("60:00")).toBe(3600);
    expect(durationSeconds("1:59:57")).toBe(7197);
    expect(durationSeconds("60")).toBe(3600);
    const w = recordingWindow({ date: "2026-09-19", timeSlot: "00:00", duration: "119:57" }, { videoStartSeconds: 1293, duration: 5904 });
    expect(new Date(w.startMs).toISOString()).toBe("2026-09-18T21:21:33.000Z");
    expect((w.endMs - w.startMs) / 1000).toBe(5904);
  });
});
