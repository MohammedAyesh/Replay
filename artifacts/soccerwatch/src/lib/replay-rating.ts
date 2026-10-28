/**
 * The Replay rating: one number per player, 3.0–10.0, for the SofaScore-style
 * match layout, and the five-sided "your style" radar.
 *
 * Replay has no event data a pro rating uses (tackles, key passes, xG), so the
 * rating is relative: each stat is scored against the other players found in
 * the same match, then weighted and mapped onto a familiar 10-point scale.
 * Rules, so it never says more than the measurement supports:
 *   - only ranked players count (found, ten minutes or more on camera);
 *   - it needs at least three of them, otherwise nobody gets a rating;
 *   - players inside each other's measuring margin score the same on that stat;
 *   - a stat nobody was measured on is left out and the weights are re-spread;
 *   - goals add a bonus on top, capped.
 * Rates (distance, touches) are per ten minutes on camera, like the rankings,
 * so a player the camera lost for a while is not marked down for it.
 */

import { isLevel, isRanked, metricValue, type ReportPlayer } from "@/lib/match-report";

export type RatablePlayer = ReportPlayer & { shots?: number | null };

export const RATING_MIN_PLAYERS = 3;
const MIN_PASSES_FOR_ACCURACY = 5;

type Component = {
  key: "running" | "speed" | "touches" | "accuracy" | "passes" | "dribbles" | "shots";
  weight: number;
  value: (player: RatablePlayer) => number | null;
  level: (a: number, b: number) => boolean;
};

const COMPONENTS: Component[] = [
  { key: "running", weight: 0.25, value: (p) => metricValue(p, "distanceRate"), level: (a, b) => isLevel("distanceRate", a, b) },
  { key: "speed", weight: 0.15, value: (p) => metricValue(p, "topSpeed"), level: (a, b) => isLevel("topSpeed", a, b) },
  { key: "touches", weight: 0.15, value: (p) => metricValue(p, "touchRate"), level: (a, b) => isLevel("touchRate", a, b) },
  {
    key: "accuracy",
    weight: 0.15,
    value: (p) => (p.passesTried !== null && p.passesCompleted !== null && p.passesTried >= MIN_PASSES_FOR_ACCURACY ? p.passesCompleted / p.passesTried : null),
    level: (a, b) => Math.abs(a - b) <= 0.03,
  },
  { key: "passes", weight: 0.1, value: (p) => p.passesCompleted, level: (a, b) => isLevel("passes", a, b) },
  { key: "dribbles", weight: 0.1, value: (p) => p.dribblesWon, level: (a, b) => isLevel("dribblesWon", a, b) },
  { key: "shots", weight: 0.1, value: (p) => p.shots ?? null, level: (a, b) => Math.abs(a - b) < 1 },
];

/** Where one value sits among others, 0 (bottom) to 1 (top); level values share the middle of their run. */
function standingShare(mine: number, all: number[], level: (a: number, b: number) => boolean): number {
  if (all.length < 2) return 0.5;
  let below = 0;
  let same = 0;
  for (const other of all) {
    if (level(other, mine)) same += 1;
    else if (other < mine) below += 1;
  }
  // `same` includes the player himself.
  return (below + (same - 1) / 2) / (all.length - 1);
}

export type PlayerRating = { playerId: number; rating: number; parts: Partial<Record<Component["key"], number>> };

/**
 * Ratings for every ranked player in the match, by player id. Empty when fewer
 * than three players are ranked: a rating against one other player says nothing.
 */
export function rateMatch(players: RatablePlayer[]): Map<number, PlayerRating> {
  const ranked = players.filter((player) => isRanked(player, "topSpeed") || isRanked(player, "distanceRate"));
  const out = new Map<number, PlayerRating>();
  if (ranked.length < RATING_MIN_PLAYERS) return out;
  const columns = COMPONENTS.map((component) => ({
    component,
    values: ranked.map((player) => component.value(player)).filter((value): value is number => value !== null),
  }));
  for (const player of ranked) {
    let weighted = 0;
    let weights = 0;
    const parts: PlayerRating["parts"] = {};
    for (const { component, values } of columns) {
      const mine = component.value(player);
      if (mine === null || values.length < 2) continue;
      const share = standingShare(mine, values, component.level);
      parts[component.key] = share;
      weighted += share * component.weight;
      weights += component.weight;
    }
    if (weights === 0) continue;
    const score = weighted / weights;
    const goals = Math.max(0, player.goals ?? 0);
    const raw = 5.8 + 2.6 * score + Math.min(1.2, goals * 0.5);
    out.set(player.playerId, { playerId: player.playerId, rating: Math.round(Math.min(10, Math.max(3, raw)) * 10) / 10, parts });
  }
  return out;
}

export type RatingBand = "great" | "good" | "fair" | "low";

/** The colour band a rating is drawn in. */
export function ratingBand(rating: number): RatingBand {
  return rating >= 7.5 ? "great" : rating >= 7 ? "good" : rating >= 6.5 ? "fair" : "low";
}

/* ------------------------------------------------------------------ radar */

export type RadarAxis = "running" | "speed" | "passing" | "dribbling" | "onBall";
export const RADAR_AXES: RadarAxis[] = ["running", "speed", "passing", "dribbling", "onBall"];

const RADAR_VALUE: Record<RadarAxis, (player: RatablePlayer) => number | null> = {
  running: (p) => metricValue(p, "distanceRate"),
  speed: (p) => metricValue(p, "topSpeed"),
  passing: (p) => (p.passesTried !== null && p.passesCompleted !== null && p.passesTried >= MIN_PASSES_FOR_ACCURACY ? p.passesCompleted / p.passesTried : null),
  dribbling: (p) => p.dribblesWon,
  onBall: (p) => metricValue(p, "touchRate"),
};

export type Radar = { player: Record<RadarAxis, number | null>; average: Record<RadarAxis, number | null> };

/**
 * One player's shape against the pitch, each axis 20–100: the weakest on the
 * pitch sits at 20 (so the shape never collapses to a point), the best at 100.
 * The average is the same scale applied to every ranked player, then averaged.
 */
export function radarFor(player: RatablePlayer, players: RatablePlayer[]): Radar | null {
  const ranked = players.filter((p) => isRanked(p, "topSpeed") || isRanked(p, "distanceRate"));
  if (ranked.length < 2 || !ranked.some((p) => p.playerId === player.playerId)) return null;
  const mine = {} as Radar["player"];
  const average = {} as Radar["average"];
  for (const axis of RADAR_AXES) {
    const values = ranked.map(RADAR_VALUE[axis]).filter((value): value is number => value !== null);
    const scale = (value: number) => {
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      return hi - lo < 1e-9 ? 60 : Math.round(20 + (80 * (value - lo)) / (hi - lo));
    };
    const own = RADAR_VALUE[axis](player);
    mine[axis] = own === null || values.length < 2 ? null : scale(own);
    average[axis] = values.length < 2 ? null : Math.round(values.map(scale).reduce((sum, value) => sum + value, 0) / values.length);
  }
  return { player: mine, average };
}

/** The radar's corner points for an SVG, given a centre and radius; a missing axis draws at 0. */
export function radarPoints(values: Record<RadarAxis, number | null>, cx: number, cy: number, radius: number): Array<[number, number]> {
  return RADAR_AXES.map((axis, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / RADAR_AXES.length;
    const r = (radius * (values[axis] ?? 0)) / 100;
    return [Math.round((cx + r * Math.cos(angle)) * 10) / 10, Math.round((cy + r * Math.sin(angle)) * 10) / 10];
  });
}
