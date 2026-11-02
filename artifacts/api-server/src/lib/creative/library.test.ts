import { describe, expect, it } from "vitest";
import {
  ammanDate,
  ammanDayStart,
  analysisMomentWindow,
  bunnyVideoIdOf,
  libraryPlayer,
  matchMinute,
  pageOf,
  parseLibraryFilters,
  recordingSeconds,
  savedClipWindow,
} from "./library";
import { analysisMoments, filterMoments, trackPlayerLookup, type AnalysisMomentsInput } from "./libraryMoments";

describe("creative library: moment windows", () => {
  it("turns a goal's tracking time into a video window with build-up and the net", () => {
    // tracking 100 s, video starts 30 s before tracking: video 130 s
    const w = analysisMomentWindow("goal", 7, 100, 100, 30, null);
    expect(w).toEqual({ recordingId: 7, fromMs: 122_000, toMs: 134_000, atMs: 130_000 });
  });

  it("never starts before the video or runs past the recording", () => {
    const early = analysisMomentWindow("chance", 7, 2, 2, 0, null);
    expect(early.fromMs).toBe(0);
    expect(early.toMs).toBe(5_000);
    const late = analysisMomentWindow("chance", 7, 3598, 3598, 0, 3600);
    expect(late.toMs).toBe(3_600_000);
    expect(late.atMs).toBeLessThanOrEqual(late.toMs);
  });

  it("plays a dribble from just before to just after, capped, with the still half-way", () => {
    const w = analysisMomentWindow("highlight", 3, 200, 204, 10, null);
    expect(w.fromMs).toBe(208_000);
    expect(w.toMs).toBe(216_000);
    expect(w.atMs).toBe(212_000);
    const long = analysisMomentWindow("highlight", 3, 200, 260, 0, null);
    expect(long.toMs - long.fromMs).toBe(15_000);
  });

  it("keeps a saved clip's own stretch, with its chosen thumbnail", () => {
    expect(savedClipWindow(5, 61.5, 75, 70)).toEqual({ recordingId: 5, fromMs: 61_500, toMs: 75_000, atMs: 70_000 });
    expect(savedClipWindow(5, 61.5, 75, null)?.atMs).toBe(68_250);
    expect(savedClipWindow(5, 75, 61, null)).toBeNull();
    expect(savedClipWindow(5, 0, 600, null)?.toMs).toBe(60_000);
  });

  it("counts match minutes from kick-off, 1-based", () => {
    expect(matchMinute(1470, 1460)).toBe(1);
    expect(matchMinute(1460 + 60 * 12 + 5, 1460)).toBe(13);
    expect(matchMinute(100, 1460)).toBe(1);
  });
});

describe("creative library: players' names", () => {
  it("shows the shirt number only unless the academy allows names", () => {
    expect(libraryPlayer({ name: "Ahmad Saleh", number: 7, squad: "U-12" }, false)).toEqual({ number: 7, firstName: null, squad: "U-12" });
  });

  it("shows the first name only, never the family name", () => {
    expect(libraryPlayer({ name: "  Ahmad   Saleh Odeh ", number: 7 }, true)).toEqual({ number: 7, firstName: "Ahmad", squad: null });
    expect(libraryPlayer({ name: "محمد العلي", number: null }, true).firstName).toBe("محمد");
  });
});

describe("creative library: analysis moments", () => {
  const roster = {
    players: [
      { id: "p1", parts: [{ trackId: "s0:t4", fromFrame: 0, toFrame: 5000 }] },
      { id: "p2", parts: [{ trackId: "s0:t9", fromFrame: 0, toFrame: 9000 }] },
    ],
  };
  const bound = new Map([["p1", libraryPlayer({ name: "Ahmad Saleh", number: 10, squad: "U-12" }, false)]]);
  const base = (over: Partial<AnalysisMomentsInput> = {}): AnalysisMomentsInput => ({
    recordingId: 9,
    videoStartSeconds: 20,
    durationSec: 3600,
    kickOffSeconds: 60,
    window: { fromSeconds: 60, toSeconds: 3000 },
    fps: 20,
    chances: [],
    dribbles: [],
    playerAt: trackPlayerLookup(roster, bound),
    ...over,
  });

  it("makes confirmed chances goals and drops the chances that were part of them", () => {
    const moments = analysisMoments(base({
      chances: [
        { t: 300, status: "confirmed", trackId: "s0:t4", touchF: 4000 },
        { t: 305, status: "open", trackId: "s0:t4", touchF: 4100 },
        { t: 900, status: "open", trackId: "s0:t9", touchF: 8000 },
        { t: 901, status: "rejected", trackId: "s0:t9", touchF: 8010 },
        { t: 10, status: "open", trackId: null, touchF: null },
      ],
    }));
    expect(moments.map((m) => [m.type, m.minute])).toEqual([["goal", 5], ["chance", 15]]);
    const goal = moments[0];
    expect(goal.window).toEqual({ recordingId: 9, fromMs: 312_000, toMs: 324_000 });
    expect(goal.source).toEqual({ type: "recording", recordingId: 9, fromMs: 312_000, toMs: 324_000 });
    expect(goal.still).toEqual({ type: "frame", recordingId: 9, atMs: 320_000 });
    expect(goal.player).toEqual({ number: 10, firstName: null, squad: "U-12" });
    expect(goal.ours).toBe(true);
    // p2 is not bound to an academy player: nobody, not a guess
    expect(moments[1].player).toBeNull();
    expect(moments[1].ours).toBeNull();
  });

  it("gives an own goal no scorer", () => {
    const [m] = analysisMoments(base({ chances: [{ t: 400, status: "confirmed", trackId: "s0:t4", touchF: 100, ownGoal: true }] }));
    expect(m.type).toBe("goal");
    expect(m.ownGoal).toBe(true);
    expect(m.player).toBeNull();
  });

  it("keeps only dribbles that beat someone and kept the ball, inside the match", () => {
    const moments = analysisMoments(base({
      dribbles: [
        { trackId: "s0:t4", t0: 500, t1: 503, f0: 1000, beaten: 1, outcome: "won" },
        { trackId: "s0:t4", t0: 600, t1: 603, f0: 1200, beaten: 1, outcome: "lost" },
        { trackId: "s0:t4", t0: 700, t1: 703, f0: 1400, beaten: 0, outcome: "won" },
        { trackId: "s0:t4", t0: 3100, t1: 3103, f0: 1400, beaten: 2, outcome: "won" },
      ],
    }));
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ type: "highlight", minute: 8, player: { number: 10 } });
    expect(moments[0].window).toEqual({ recordingId: 9, fromMs: 518_000, toMs: 525_000 });
  });

  it("filters by type and shirt number", () => {
    const moments = analysisMoments(base({
      chances: [{ t: 300, status: "confirmed", trackId: "s0:t4", touchF: 10 }, { t: 900, status: "open", trackId: "s0:t9", touchF: 10 }],
      dribbles: [{ trackId: "s0:t4", t0: 500, t1: 503, f0: 1000, beaten: 1, outcome: "won" }],
    }));
    expect(filterMoments(moments, { types: ["goal"], playerNumber: null }).map((m) => m.type)).toEqual(["goal"]);
    expect(filterMoments(moments, { types: [], playerNumber: 10 }).map((m) => m.type)).toEqual(["goal", "highlight"]);
    expect(filterMoments(moments, { types: ["chance"], playerNumber: 10 })).toEqual([]);
  });

  it("finds the player whose part holds the track at that frame", () => {
    const lookup = trackPlayerLookup({
      players: [
        { id: "a", parts: [{ trackId: "t1", fromFrame: 0, toFrame: 100 }] },
        { id: "b", parts: [{ trackId: "t1", fromFrame: 101, toFrame: 200 }] },
      ],
    }, new Map([["a", libraryPlayer({ name: "A", number: 1 }, false)], ["b", libraryPlayer({ name: "B", number: 2 }, false)]]));
    expect(lookup("t1", 50)?.number).toBe(1);
    expect(lookup("t1", 150)?.number).toBe(2);
    expect(lookup("t1", 500)).toBeNull();
    expect(lookup("t2", 50)).toBeNull();
    expect(trackPlayerLookup(null, new Map())("t1", 1)).toBeNull();
  });
});

describe("creative library: filters, paging, recordings", () => {
  it("reads filters from the query and ignores junk", () => {
    const f = parseLibraryFilters({ squadId: "4", player: "#7", type: "goal,nope,saved", from: "2026-10-01", to: "2026-10-31", kind: "video", offset: "24", limit: "999" });
    expect(f).toMatchObject({ squadId: 4, playerNumber: 7, types: ["goal", "saved"], kind: "video", offset: 24, limit: 60 });
    expect(f.from?.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(f.until?.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    const junk = parseLibraryFilters({ squadId: "x", player: "120", from: "yesterday", limit: "-3" });
    expect(junk).toMatchObject({ squadId: null, playerNumber: null, from: null, limit: 24, offset: 0 });
  });

  it("pages a list", () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    expect(pageOf(items, { offset: 0, limit: 2 })).toEqual({ items: [0, 1], total: 5, nextOffset: 2 });
    expect(pageOf(items, { offset: 4, limit: 2 })).toEqual({ items: [4], total: 5, nextOffset: null });
  });

  it("reads Amman days and recording lengths", () => {
    expect(ammanDate(new Date("2026-10-31T22:30:00Z"))).toBe("2026-11-01");
    expect(ammanDayStart("2026-11-01")?.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(recordingSeconds("60 min")).toBe(3600);
    expect(recordingSeconds("1:59:57")).toBe(7197);
    expect(recordingSeconds("3600")).toBe(3600);
    expect(recordingSeconds("")).toBeNull();
    expect(bunnyVideoIdOf("https://vz.test/0f9d1e1f-8d72-68b2-a7c8-2c82371dcf01/playlist.m3u8")).toBe("0f9d1e1f-8d72-68b2-a7c8-2c82371dcf01");
    expect(bunnyVideoIdOf("https://vz.test/studio/playlist.m3u8")).toBeNull();
  });
});
