import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/db";
import { applyCuts, ballFocus, goalCardsFor, momentNumbers, notMeCut, partsFocus, trackIndex, unsureMoments, CHECK } from "./checkDeck";
import type { Lab } from "./matchPlay";
import type { PersonalMoment } from "./personalMoments";
import type { ReviewedGoal } from "./goalReview";

// A linear pitch: x metres = px / 96, y metres = py / 27 - 20 (as matchPlay.dribbles.test).
const manifest = {
  width: 3840, height: 1080, frameRate: 20,
  pitchModel: {
    calibrationId: "c", fittedAt: "2026-09-01T00:00:00Z", calibratedAspectRatio: 3840 / 1080,
    pitchWidthMetres: 40, pitchHeightMetres: 20,
    grid: [[{ x: 0, y: -20 }, { x: 40, y: -20 }], [{ x: 0, y: 20 }, { x: 40, y: 20 }]],
  },
} as unknown as TrackingManifest;
const boxAt = (frame: number, X: number, Y: number) => ({ frame, x: X * 96 - 20, y: (Y + 20) * 27 - 100, w: 40, h: 100 });
const track = (id: string, f0: number, f1: number, pos: (f: number) => [number, number]) => {
  const boxes = [];
  for (let f = f0; f <= f1; f += 2) { const [X, Y] = pos(f); boxes.push(boxAt(f, X, Y)); }
  return { id, boxes };
};
const WHITE: Lab = [200, 128, 128];
const BLACK: Lab = [20, 128, 128];
const moment = (id: string, kind: string, t: number, title = "x"): PersonalMoment => ({ id, kind, title, momentSeconds: t, status: "ready" });

describe("unsure moments: where his piece can be someone else", () => {
  // he runs along y = 10 for 100 s; a team-mate brushes past at t = 50; an
  // opponent stands next to him at t = 70
  const me = track("s0:me", 0, 2000, (f) => [5 + f / 100, 10]);
  const mate = track("s0:mate", 0, 2000, (f) => [5 + f / 100, Math.abs(f - 1000) < 30 ? 10.8 : 16]);
  const opp = track("s0:opp", 0, 2000, (f) => [5 + f / 100, Math.abs(f - 1400) < 10 ? 10.6 : 4]);
  const kits = new Map<string, Lab>([["s0:me", WHITE], ["s0:mate", WHITE], ["s0:opp", BLACK]]);
  const segments = [{ tracks: [me, mate, opp] }];
  const parts = [{ trackId: "s0:me", fromFrame: 0, toFrame: 2000 }];

  it("asks about a moment a team-mate came within 1.5 m of, not one an opponent passed at 2 m", () => {
    const u = unsureMoments([moment("me-pass-50", "long-pass", 52), moment("me-pass-20", "long-pass", 20)], parts, segments, manifest, kits);
    expect(u.map((x) => [x.moment.id, x.reasons])).toEqual([["me-pass-50", ["teammate"]]]);
  });

  it("asks about a moment with someone right next to him", () => {
    const u = unsureMoments([moment("me-shot-70", "your-shot", 70)], parts, segments, manifest, kits);
    expect(u[0].reasons).toContain("crowd");
  });

  it("asks at a stitch between two pieces and on a short piece, never about team moments", () => {
    const stitched = [{ trackId: "s0:me", fromFrame: 0, toFrame: 600 }, { trackId: "s0:mate", fromFrame: 601, toFrame: 2000 }];
    const u = unsureMoments([moment("me-dribble-30", "dribble", 29.5), moment("goal-30", "goal", 29.5)], stitched, segments, manifest, kits);
    expect(u).toHaveLength(1);
    expect(u[0].reasons).toContain("join");
    const short = unsureMoments([moment("me-pass-5", "long-pass", 5)], [{ trackId: "s0:me", fromFrame: 0, toFrame: 120 }], segments, manifest, kits);
    expect(short[0].reasons).toEqual(["short"]);
  });

  it("takes about ten seconds of that piece off the claim on 'not me', and keeps the rest", () => {
    const cut = notMeCut({ part: parts[0], frame: 1000 }, 20);
    expect(cut).toEqual({ trackId: "s0:me", fromFrame: 1000 - CHECK.cutSeconds * 20, toFrame: 1000 + CHECK.cutSeconds * 20 });
    expect(applyCuts(parts, [cut])).toEqual([
      { trackId: "s0:me", fromFrame: 0, toFrame: 899 },
      { trackId: "s0:me", fromFrame: 1101, toFrame: 2000 },
    ]);
    expect(applyCuts(parts, [{ trackId: "s0:other", fromFrame: 0, toFrame: 2000 }])).toEqual(parts);
  });

  it("follows him through the card in video seconds, as fractions of the frame", () => {
    const focus = partsFocus(parts, trackIndex(segments), manifest, 10, 11, 2);
    expect(focus[0][0]).toBe(12);
    expect(focus[focus.length - 1][0]).toBe(13);
    expect(focus[0][1]).toBeCloseTo((boxAt(200, 7, 10).x + 20) / 3840, 2);
    const ball = ballFocus([[200, 1920, 540, 1], [220, 1940, 540, 1]], manifest, 10, 11, 2);
    expect(ball[0].slice(0, 3)).toEqual([12, 0.5, 0.5]);
  });
});

describe("goal cards", () => {
  const g = (t: number, source: ReviewedGoal["source"], status: ReviewedGoal["status"] = "open"): ReviewedGoal =>
    ({ t, key: Math.round(t * 10), source, status, trackId: null, kit: null, lead: null, touchF: null, confirmedBy: [], rejectedBy: [] });

  it("puts the detector's goals first, then goals.py's, then a few shots that differ by player", () => {
    const chances = [g(100, "shot"), g(200, "goal"), g(300, "shot"), g(400, "event"), g(500, "shot"), g(600, "shot"), g(700, "goal", "confirmed")];
    const a = goalCardsFor(chances, 1, new Set());
    expect(a.map((x) => x.source).sort()).toEqual(["event", "goal", "shot"]);
    expect(a.every((x) => x.status === "open")).toBe(true);
    const shotsSeen = new Set<number>();
    for (let user = 1; user <= 12; user++) for (const c of goalCardsFor(chances, user, new Set(), 4)) if (c.source === "shot") shotsSeen.add(c.key);
    expect(shotsSeen.size).toBeGreaterThan(1);
    expect(goalCardsFor(chances, 1, new Set([2000])).some((x) => x.key === 2000)).toBe(false);
  });

  it("reads the numbers out of a moment's title", () => {
    expect(momentNumbers("Your dribble · 9 m past 2 players · 12:03")).toEqual({ metres: 9, beaten: 2 });
    expect(momentNumbers("Pass found · 18 m · 40:10")).toEqual({ metres: 18, beaten: null });
    expect(momentNumbers("Your shot on target · 4:00")).toEqual({ metres: null, beaten: null });
  });
});
