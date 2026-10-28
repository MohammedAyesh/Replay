import { describe, expect, it } from "vitest";
import { radarFor, radarPoints, rateMatch, ratingBand, type RatablePlayer } from "./replay-rating";

function player(id: number, values: Partial<RatablePlayer> = {}): RatablePlayer {
  return {
    playerId: id,
    name: `P${id}`,
    team: "A",
    claimed: true,
    minutes: 90,
    distanceKm: 6,
    topSpeedKmh: 26,
    touches: 250,
    passesTried: 60,
    passesCompleted: 30,
    dribblesWon: 1,
    goals: 0,
    shots: 1,
    ...values,
  };
}

// #SNLEJH, 22 Oct, as the stats endpoint returned it (the duplicate claim left out).
const snlejh = [
  player(33, { minutes: 89.8, distanceKm: 7.86, topSpeedKmh: 29.7, touches: 231, passesTried: 65, passesCompleted: 31, dribblesWon: 2, shots: 2 }),
  player(31, { minutes: 85, distanceKm: 7.68, topSpeedKmh: 31, touches: 323, passesTried: 72, passesCompleted: 29, dribblesWon: 2, shots: 2 }),
  player(32, { minutes: 85.9, distanceKm: 5.25, topSpeedKmh: 28.3, touches: 265, passesTried: 59, passesCompleted: 30, dribblesWon: 2, shots: 0 }),
  player(35, { minutes: 89.6, distanceKm: 5.96, topSpeedKmh: 27.4, touches: 316, passesTried: 77, passesCompleted: 32, dribblesWon: 3, shots: 3 }),
];

describe("rateMatch", () => {
  it("rates every ranked player between 3 and 10, at one decimal", () => {
    const ratings = rateMatch(snlejh);
    expect(ratings.size).toBe(4);
    for (const { rating } of ratings.values()) {
      expect(rating).toBeGreaterThanOrEqual(3);
      expect(rating).toBeLessThanOrEqual(10);
      expect(Math.round(rating * 10) / 10).toBe(rating);
    }
  });

  it("puts the player who ran, sprinted and finished more above the one who did least", () => {
    const ratings = rateMatch(snlejh);
    expect(ratings.get(31)!.rating).toBeGreaterThan(ratings.get(32)!.rating);
    expect(ratings.get(33)!.rating).toBeGreaterThan(ratings.get(32)!.rating);
  });

  it("gives nobody a rating with fewer than three ranked players", () => {
    expect(rateMatch(snlejh.slice(0, 2)).size).toBe(0);
    expect(rateMatch([...snlejh.slice(0, 2), player(9, { minutes: 6 })]).size).toBe(0);
  });

  it("scores players inside the measuring margin the same", () => {
    const twins = [player(1, { topSpeedKmh: 30 }), player(2, { topSpeedKmh: 30.5 }), player(3, { topSpeedKmh: 20 })];
    const ratings = rateMatch(twins);
    expect(ratings.get(1)!.parts.speed).toBe(ratings.get(2)!.parts.speed);
  });

  it("adds a capped bonus for goals", () => {
    const base = [player(1), player(2), player(3)];
    const scorer = rateMatch([player(1, { goals: 1 }), player(2), player(3)]).get(1)!.rating;
    const hatTrick = rateMatch([player(1, { goals: 5 }), player(2), player(3)]).get(1)!.rating;
    const none = rateMatch(base).get(1)!.rating;
    expect(scorer).toBeCloseTo(none + 0.5, 5);
    expect(hatTrick).toBeCloseTo(none + 1.2, 5);
  });

  it("leaves out a stat nobody was measured on instead of scoring it as zero", () => {
    const noShots = snlejh.map((p) => ({ ...p, shots: null }));
    const ratings = rateMatch(noShots);
    expect(ratings.get(33)!.parts.shots).toBeUndefined();
    expect(ratings.size).toBe(4);
  });
});

describe("ratingBand", () => {
  it("bands at 7.5, 7.0 and 6.5", () => {
    expect([7.6, 7.5, 7.4, 7.0, 6.9, 6.5, 6.4].map(ratingBand)).toEqual(["great", "great", "good", "good", "fair", "fair", "low"]);
  });
});

describe("radarFor", () => {
  it("scales each axis from 20 (bottom of the pitch) to 100 (top), level players together", () => {
    const radar = radarFor(snlejh[0], snlejh)!;
    // 0.88 v 0.90 km per 10 min is inside the 5% margin: the two share the top
    expect(radar.player.running).toBe(radarFor(snlejh[1], snlejh)!.player.running);
    expect(radar.player.running).toBeGreaterThan(80);
    expect(radar.player.onBall).toBe(20);
    for (const value of Object.values(radar.average)) {
      expect(value).toBeGreaterThanOrEqual(20);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("puts players within the margin at the same point", () => {
    const close = [player(1, { topSpeedKmh: 30 }), player(2, { topSpeedKmh: 30.5 }), player(3, { topSpeedKmh: 20 })];
    expect(radarFor(close[0], close)!.player.speed).toBe(radarFor(close[1], close)!.player.speed);
  });

  it("needs three ranked players, like the rating", () => {
    expect(radarFor(snlejh[0], snlejh.slice(0, 2))).toBeNull();
  });

  it("draws a missing axis at the average, never at the centre", () => {
    const points = radarPoints({ running: 100, speed: 100, passing: null, dribbling: 100, onBall: 100 }, 150, 135, 100, { running: 50, speed: 50, passing: 50, dribbling: 50, onBall: 50 });
    expect(points[2]).not.toEqual([150, 135]);
  });

  it("is null for a player who isn't ranked", () => {
    expect(radarFor(player(9, { minutes: 4 }), [...snlejh, player(9, { minutes: 4 })])).toBeNull();
  });

  it("draws five corners, the first straight up", () => {
    const points = radarPoints({ running: 100, speed: 100, passing: 100, dribbling: 100, onBall: 100 }, 150, 135, 100);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual([150, 35]);
  });
});
