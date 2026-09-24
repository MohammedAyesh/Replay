/**
 * What a match cost a player, in kilocalories.
 *
 * ONE number, computed from that player's own distance, their own speeds and
 * their own weight. It is not a range, not a floor, and not an estimate to be
 * read cautiously -- the sentence on the screen that says whose numbers went
 * into it is the credibility, not a hedge. It is also never a diet number: no
 * daily target, no food equivalent, no streak. Once, per match.
 *
 *   kcal = STOP_START * SUM over zones ( distance_zone_km * weight_kg * cost_zone )
 *          + ON_PITCH_KCAL_PER_KG_PER_MINUTE * weight_kg * minutes_on_pitch
 *
 * The first term is locomotion. The STOP_START premium is there because
 * steady-state running economy understates a sport built on accelerating and
 * decelerating; the coefficients below are steady-state costs.
 *
 * The second term is the cost of being in a game at all -- turning, jostling,
 * jumping, getting back up -- at 1.5 kcal/kg/hour above rest. Without it the
 * figure counts only covering ground and lands far too low.
 *
 * SPEED_ZONES is the single definition of the partition. The zone bars on the
 * "where you played" screen must read it from here too: if the two screens
 * ever partition speed differently, one of them is lying about the other's
 * total.
 */

export type SpeedZoneKey = "walking" | "jogging" | "running" | "sprinting";

export type SpeedZone = {
  key: SpeedZoneKey;
  /** inclusive lower bound, km/h */
  fromKmh: number;
  /** exclusive upper bound, km/h; Infinity for the top zone */
  toKmh: number;
  /** kcal per kg per km at a steady pace in this zone */
  costKcalPerKgPerKm: number;
};

export const SPEED_ZONES: readonly SpeedZone[] = [
  { key: "walking", fromKmh: 0, toKmh: 7, costKcalPerKgPerKm: 0.52 },
  { key: "jogging", fromKmh: 7, toKmh: 13, costKcalPerKgPerKm: 0.9 },
  { key: "running", fromKmh: 13, toKmh: 19, costKcalPerKgPerKm: 1.05 },
  { key: "sprinting", fromKmh: 19, toKmh: Number.POSITIVE_INFINITY, costKcalPerKgPerKm: 1.2 },
] as const;

/** The stop-start premium on steady-state locomotion cost. */
export const STOP_START_MULTIPLIER = 1.15;

/** 1.5 kcal/kg/hour above rest, expressed per minute. */
export const ON_PITCH_KCAL_PER_KG_PER_MINUTE = 0.025;

export const MIN_WEIGHT_KG = 30;
export const MAX_WEIGHT_KG = 200;
export const MIN_HEIGHT_CM = 100;
export const MAX_HEIGHT_CM = 230;

export function zoneForSpeedKmh(kmh: number): SpeedZoneKey {
  const zone = SPEED_ZONES.find((candidate) => kmh >= candidate.fromKmh && kmh < candidate.toKmh);
  return zone?.key ?? "sprinting";
}

export type ZoneDistancesKm = Record<SpeedZoneKey, number>;

export function emptyZoneDistances(): ZoneDistancesKm {
  return { walking: 0, jogging: 0, running: 0, sprinting: 0 };
}

/**
 * Split a run of position samples into the four zones.
 *
 * Each sample carries the distance covered since the previous one and how long
 * that took, which is exactly what the metrics pipeline already produces. A
 * sample with no elapsed time contributes nothing rather than an infinite
 * speed.
 */
export function zoneDistancesFromIntervals(
  intervals: Array<{ metres: number; seconds: number }>,
): ZoneDistancesKm {
  const totals = emptyZoneDistances();
  for (const interval of intervals) {
    if (!(interval.seconds > 0) || !(interval.metres > 0)) continue;
    const kmh = (interval.metres / interval.seconds) * 3.6;
    totals[zoneForSpeedKmh(kmh)] += interval.metres / 1000;
  }
  return totals;
}

export type EnergyZoneRow = {
  key: SpeedZoneKey;
  distanceKm: number;
  /** already carries the stop-start premium, so the rows sum to locomotionKcal */
  kcal: number;
};

export type EnergyEstimate = {
  /** the one number the screen shows */
  totalKcal: number;
  locomotionKcal: number;
  onPitchKcal: number;
  zones: EnergyZoneRow[];
  totalDistanceKm: number;
  minutesOnPitch: number;
  weightKg: number;
  /** gross METs, for the sanity guardrail below -- never displayed */
  grossMets: number;
};

export type EnergyInput = {
  zoneDistancesKm: Partial<ZoneDistancesKm>;
  weightKg: number;
  minutesOnPitch: number;
};

/**
 * Null when there is nothing honest to show: no weight, no time on the pitch,
 * or no distance. The screen says "unavailable" and why; it never guesses a
 * weight from a default and never falls back to an average player.
 */
export function estimateMatchEnergy(input: EnergyInput): EnergyEstimate | null {
  const { weightKg, minutesOnPitch } = input;
  if (!isValidWeightKg(weightKg)) return null;
  if (!(minutesOnPitch > 0)) return null;

  const distances = { ...emptyZoneDistances(), ...input.zoneDistancesKm };
  const totalDistanceKm = SPEED_ZONES.reduce(
    (total, zone) => total + Math.max(0, distances[zone.key] ?? 0),
    0,
  );
  if (!(totalDistanceKm > 0)) return null;

  const zones: EnergyZoneRow[] = SPEED_ZONES.map((zone) => {
    const distanceKm = Math.max(0, distances[zone.key] ?? 0);
    return {
      key: zone.key,
      distanceKm,
      kcal: STOP_START_MULTIPLIER * distanceKm * weightKg * zone.costKcalPerKgPerKm,
    };
  });

  const locomotionKcal = zones.reduce((total, zone) => total + zone.kcal, 0);
  const onPitchKcal = ON_PITCH_KCAL_PER_KG_PER_MINUTE * weightKg * minutesOnPitch;
  const totalKcal = locomotionKcal + onPitchKcal;

  return {
    totalKcal,
    locomotionKcal,
    onPitchKcal,
    zones,
    totalDistanceKm,
    minutesOnPitch,
    weightKg,
    grossMets: totalKcal / (weightKg * (minutesOnPitch / 60)),
  };
}

/**
 * The figure and its breakdown, rounded once for display.
 *
 * Rounded so that the rows still add up to the total: the rows are rounded
 * first and the total is their sum plus the rounded on-pitch row, rather than
 * the unrounded total rounded separately. A breakdown whose parts do not reach
 * its own total is worse than no breakdown.
 */
export type RoundedEnergy = {
  totalKcal: number;
  onPitchKcal: number;
  zones: Array<{ key: SpeedZoneKey; distanceKm: number; kcal: number }>;
};

export function roundEnergyForDisplay(estimate: EnergyEstimate): RoundedEnergy {
  const zones = estimate.zones.map((zone) => ({
    key: zone.key,
    distanceKm: zone.distanceKm,
    kcal: Math.round(zone.kcal),
  }));
  const onPitchKcal = Math.round(estimate.onPitchKcal);
  return {
    zones,
    onPitchKcal,
    totalKcal: zones.reduce((total, zone) => total + zone.kcal, 0) + onPitchKcal,
  };
}

export function isValidWeightKg(weightKg: unknown): weightKg is number {
  return typeof weightKg === "number"
    && Number.isFinite(weightKg)
    && weightKg >= MIN_WEIGHT_KG
    && weightKg <= MAX_WEIGHT_KG;
}

export function isValidHeightCm(heightCm: unknown): heightCm is number {
  return typeof heightCm === "number"
    && Number.isFinite(heightCm)
    && heightCm >= MIN_HEIGHT_CM
    && heightCm <= MAX_HEIGHT_CM;
}

/**
 * The guardrail. A typical amateur small-sided game must land between 4 and 8
 * gross METs; if a change to the coefficients pushes it outside that band, the
 * change is wrong. "Typical" means the volume an amateur actually covers --
 * see the test, which pins both a 7 km game (in band) and the 3.7 km worked
 * example (deliberately light, and below the band, which is correct for it).
 */
export const TYPICAL_GAME_METS_RANGE = { min: 4, max: 8 } as const;
