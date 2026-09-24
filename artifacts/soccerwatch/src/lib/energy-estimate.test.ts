import { describe, expect, it } from "vitest";
import {
  TYPICAL_GAME_METS_RANGE,
  estimateMatchEnergy,
  isValidWeightKg,
  roundEnergyForDisplay,
  zoneDistancesFromIntervals,
  zoneForSpeedKmh,
} from "./energy-estimate";

/** 3.7 km split 42/38/17/3, the specified worked example. */
function workedExample() {
  const total = 3.7;
  return estimateMatchEnergy({
    weightKg: 78,
    minutesOnPitch: 81,
    zoneDistancesKm: {
      walking: total * 0.42,
      jogging: total * 0.38,
      running: total * 0.17,
      sprinting: total * 0.03,
    },
  });
}

describe("estimateMatchEnergy", () => {
  it("reproduces the worked example row for row", () => {
    const estimate = workedExample();
    expect(estimate).not.toBeNull();
    const rounded = roundEnergyForDisplay(estimate!);
    expect(Object.fromEntries(rounded.zones.map((zone) => [zone.key, zone.kcal]))).toEqual({
      walking: 72,
      jogging: 114,
      running: 59,
      sprinting: 12,
    });
    expect(rounded.onPitchKcal).toBe(158);
    expect(rounded.totalKcal).toBe(415);
  });

  it("leaves nothing out of the sum", () => {
    const rounded = roundEnergyForDisplay(workedExample()!);
    const parts = rounded.zones.reduce((total, zone) => total + zone.kcal, 0) + rounded.onPitchKcal;
    expect(parts).toBe(rounded.totalKcal);
  });

  /**
   * The specification annotated the worked example as "4.9 METs gross". That
   * is arithmetically wrong: 415 kcal / (78 kg * 1.35 h) is 3.94, and 3.7 km
   * in 81 minutes is a light game rather than a typical one -- 2.7 km/h
   * average, where an amateur small-sided game is nearer 5 km/h. The
   * coefficients are right and the annotation was not, so the guardrail is
   * pinned against a typical volume instead, and the light example is pinned
   * where it actually lands.
   */
  it("puts the light worked example just under the band, at its true METs", () => {
    expect(workedExample()!.grossMets).toBeCloseTo(3.94, 2);
  });

  it("puts a typical game inside 4-8 gross METs", () => {
    const total = 7;
    const estimate = estimateMatchEnergy({
      weightKg: 78,
      minutesOnPitch: 81,
      zoneDistancesKm: {
        walking: total * 0.4,
        jogging: total * 0.35,
        running: total * 0.2,
        sprinting: total * 0.05,
      },
    })!;
    expect(estimate.grossMets).toBeGreaterThanOrEqual(TYPICAL_GAME_METS_RANGE.min);
    expect(estimate.grossMets).toBeLessThanOrEqual(TYPICAL_GAME_METS_RANGE.max);
  });

  it("refuses to produce a number without a weight, a duration or a distance", () => {
    const base = { weightKg: 78, minutesOnPitch: 81, zoneDistancesKm: { jogging: 4 } };
    expect(estimateMatchEnergy({ ...base, weightKg: Number.NaN })).toBeNull();
    expect(estimateMatchEnergy({ ...base, weightKg: 0 })).toBeNull();
    expect(estimateMatchEnergy({ ...base, minutesOnPitch: 0 })).toBeNull();
    expect(estimateMatchEnergy({ ...base, zoneDistancesKm: {} })).toBeNull();
  });

  it("rejects weights outside the plausible range rather than clamping them", () => {
    expect(isValidWeightKg(29)).toBe(false);
    expect(isValidWeightKg(201)).toBe(false);
    expect(isValidWeightKg(78)).toBe(true);
  });
});

describe("speed zones", () => {
  it("partitions on the stated boundaries, lower bound inclusive", () => {
    expect(zoneForSpeedKmh(0)).toBe("walking");
    expect(zoneForSpeedKmh(6.99)).toBe("walking");
    expect(zoneForSpeedKmh(7)).toBe("jogging");
    expect(zoneForSpeedKmh(12.99)).toBe("jogging");
    expect(zoneForSpeedKmh(13)).toBe("running");
    expect(zoneForSpeedKmh(18.99)).toBe("running");
    expect(zoneForSpeedKmh(19)).toBe("sprinting");
    expect(zoneForSpeedKmh(40)).toBe("sprinting");
  });

  it("bins intervals by their own speed and ignores zero-length ones", () => {
    const zones = zoneDistancesFromIntervals([
      { metres: 10, seconds: 10 },   // 3.6 km/h  walking
      { metres: 30, seconds: 10 },   // 10.8 km/h jogging
      { metres: 50, seconds: 10 },   // 18 km/h   running
      { metres: 70, seconds: 10 },   // 25.2 km/h sprinting
      { metres: 99, seconds: 0 },    // dropped, not an infinite sprint
    ]);
    expect(zones).toEqual({ walking: 0.01, jogging: 0.03, running: 0.05, sprinting: 0.07 });
  });
});
