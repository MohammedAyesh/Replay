import { describe, expect, it } from "vitest";
import type { PlayerForm, PlayerMetricValues } from "@/lib/match-api";
import type { ReportPlayer } from "@/lib/match-report";
import { barShare, boardRows, matchReelPicks, myStanding, pickHeadline, resolveReportLayout } from "./report-layout";

function player(id: number, name: string, values: Partial<ReportPlayer> = {}): ReportPlayer {
  return {
    playerId: id,
    name,
    team: "A",
    claimed: true,
    minutes: 90,
    distanceKm: 6,
    topSpeedKmh: 25,
    touches: 200,
    passesTried: 40,
    passesCompleted: 20,
    dribblesWon: 1,
    goals: 0,
    ...values,
  };
}

// The real 22 Oct match (#SNLEJH), as far as the report showed it.
const you = player(1, "Mohammed Ayesh", { distanceKm: 7.9, topSpeedKmh: 30, touches: 234, passesTried: 65, passesCompleted: 31, dribblesWon: 2 });
const pitch = [
  you,
  player(2, "Mohammed", { distanceKm: 8.1, topSpeedKmh: 31, touches: 342, passesCompleted: 29, dribblesWon: 2 }),
  player(3, "محمد", { distanceKm: 7.6, topSpeedKmh: 31, touches: 300, passesCompleted: 25, dribblesWon: 2 }),
  player(4, "Ali", { distanceKm: 5.5, topSpeedKmh: 28, touches: 270, passesCompleted: 22, dribblesWon: 3 }),
  player(5, "Player", { distanceKm: 6.0, topSpeedKmh: 27, touches: 280, passesCompleted: 18, dribblesWon: 2 }),
];

const values = (v: Partial<PlayerMetricValues>): PlayerMetricValues => ({
  minutes: 90, distanceKm: null, topSpeedKmh: null, touches: null, passesTried: null, passesCompleted: null, dribblesWon: null, goals: null,
  ...v,
} as PlayerMetricValues);

function form(bests: Partial<PlayerMetricValues>, matchesUsed = 4): PlayerForm {
  return { matchesUsed, averages: values({ distanceKm: 6, topSpeedKmh: 26, touches: 230 }), bests: values(bests), lastFive: [] };
}

describe("resolveReportLayout", () => {
  it("ships the long report and accepts the two new layouts from the setting", () => {
    expect(resolveReportLayout(undefined, null)).toBe("full");
    expect(resolveReportLayout("compact", null)).toBe("compact");
    expect(resolveReportLayout("sheet", "")).toBe("sheet");
    expect(resolveReportLayout("sofa", null)).toBe("sofa");
    expect(resolveReportLayout("nonsense", null)).toBe("full");
  });

  it("lets ?view= on the link override the setting, ignoring anything it doesn't know", () => {
    expect(resolveReportLayout("full", "Compact")).toBe("compact");
    expect(resolveReportLayout("compact", "full")).toBe("full");
    expect(resolveReportLayout("sheet", "tabs")).toBe("sheet");
  });
});

describe("myStanding", () => {
  it("shares first place inside the measuring margin and names who holds the top", () => {
    const speed = myStanding(pitch, "topSpeed", 1)!;
    expect(speed).toMatchObject({ rank: 1, shared: true, of: 5, ranked: true, value: 30 });
    expect(speed.top?.value).toBe(31);
    expect(speed.top?.names).toEqual(expect.arrayContaining(["Mohammed", "محمد"]));
  });

  it("is null for a stat the player wasn't measured on", () => {
    expect(myStanding([player(1, "A", { topSpeedKmh: null }), player(2, "B")], "topSpeed", 1)).toBeNull();
  });
});

describe("pickHeadline", () => {
  it("leads with both personal bests when the match beat both", () => {
    expect(pickHeadline(you, pitch, form({ distanceKm: 7.0, topSpeedKmh: 27 }))).toMatchObject({ kind: "twoBests", topSpeedKmh: 30, distanceKm: 7.9, topOfPitch: true });
  });

  it("leads with a single personal best and says whether it topped the pitch", () => {
    expect(pickHeadline(you, pitch, form({ distanceKm: 9, topSpeedKmh: 27 }))).toMatchObject({ kind: "best", metric: "topSpeed", value: 30, topOfPitch: true, sharedTop: true });
  });

  it("never calls a personal best with fewer than three earlier matches", () => {
    const headline = pickHeadline(you, pitch, form({ distanceKm: 1, topSpeedKmh: 1 }, 2));
    expect(headline?.kind).not.toBe("twoBests");
    expect(headline?.kind).not.toBe("best");
  });

  it("prefers a clear first place over a shared one", () => {
    const clearPasser = player(1, "Me", { passesCompleted: 60, topSpeedKmh: 30 });
    const others = [player(2, "B", { topSpeedKmh: 30, passesCompleted: 20 }), player(3, "C", { topSpeedKmh: 25, passesCompleted: 20 })];
    expect(pickHeadline(clearPasser, [clearPasser, ...others], null)).toMatchObject({ kind: "top", metric: "passes", shared: false });
  });

  it("never leads with last place", () => {
    const last = player(1, "Me", { topSpeedKmh: 20, distanceKm: 3, touches: 50, passesCompleted: 1, dribblesWon: 0 });
    const others = [
      player(2, "B", { topSpeedKmh: 32, distanceKm: 9, touches: 400, passesCompleted: 40, dribblesWon: 5 }),
      player(3, "C", { topSpeedKmh: 28, distanceKm: 7, touches: 250, passesCompleted: 30, dribblesWon: 4 }),
    ];
    expect(pickHeadline(last, [last, ...others], null)).toEqual({ kind: "total", distanceKm: 3 });
  });

  it("falls back to a podium rank, then to the distance", () => {
    const third = player(1, "Me", { topSpeedKmh: 24, distanceKm: 5, touches: 100, passesCompleted: 1, dribblesWon: 0 });
    const ahead = [
      player(4, "D", { topSpeedKmh: 18, distanceKm: 3, touches: 60, passesCompleted: 0, dribblesWon: 0 }),
      player(2, "B", { topSpeedKmh: 32, distanceKm: 9, touches: 400, passesCompleted: 40, dribblesWon: 5 }),
      player(3, "C", { topSpeedKmh: 28, distanceKm: 7, touches: 250, passesCompleted: 30, dribblesWon: 4 }),
    ];
    expect(pickHeadline(third, [third, ...ahead], null)).toMatchObject({ kind: "rank", rank: 3 });
    const alone = player(1, "Me", { distanceKm: 4.2 });
    expect(pickHeadline(alone, [alone], null)).toEqual({ kind: "total", distanceKm: 4.2 });
  });
});

describe("boardRows", () => {
  it("lists the top five and pins the viewer when he is below them", () => {
    const many = [
      ...[2, 3, 4, 5, 6].map((id) => player(id, `P${id}`, { topSpeedKmh: 20 + id * 3 })),
      player(1, "Me", { topSpeedKmh: 18 }),
    ];
    const board = boardRows(many, "topSpeed", 1, 5);
    expect(board.rows).toHaveLength(5);
    expect(board.rows.some((row) => row.isMe)).toBe(false);
    expect(board.pinned).toMatchObject({ playerId: 1, isMe: true });
  });

  it("leaves players under ten minutes off the board", () => {
    const board = boardRows([player(1, "Me"), player(2, "Sub", { minutes: 6 })], "topSpeed", 1);
    expect(board.rows.map((row) => row.playerId)).toEqual([1]);
  });

  it("counts how many share the top", () => {
    expect(boardRows(pitch, "topSpeed", 1).topShared).toBe(3);
  });
});

describe("barShare", () => {
  it("draws a stub for tiny values and caps at the best", () => {
    expect(barShare(0, 10)).toBeCloseTo(0.04);
    expect(barShare(12, 10)).toBe(1);
    expect(barShare(5, 0)).toBe(0);
  });
});

describe("matchReelPicks", () => {
  const clip = (id: number, startTime: number, aspectRatio = "16:9", isHidden = false) => ({ id, startTime, aspectRatio, isHidden, createdAt: `2026-10-22T20:${String(id).padStart(2, "0")}:00Z` });

  it("takes only this match's visible clips, in match order, in the shape most of them share", () => {
    const clips = [clip(1, 500), clip(2, 100, "9:16"), clip(3, 50), clip(4, 900, "16:9", true), clip(5, 300), clip(9, 10)];
    expect(matchReelPicks(clips, new Set([1, 2, 3, 4, 5]), 10)).toEqual([3, 5, 1]);
  });

  it("stops at the reel's clip limit", () => {
    const clips = Array.from({ length: 14 }, (_, i) => clip(i + 1, i * 10));
    expect(matchReelPicks(clips, new Set(clips.map((c) => c.id)), 10)).toHaveLength(10);
  });

  it("is empty when the player has no clips from the match", () => {
    expect(matchReelPicks([clip(1, 0)], new Set([2]), 10)).toEqual([]);
  });
});
