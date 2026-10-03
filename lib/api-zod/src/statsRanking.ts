/**
 * The one rule set for comparing players' numbers. The match report
 * (soccerwatch lib/match-report.ts) and Home's stat tiles
 * (api-server lib/homeStatTile.ts) both import it from here, so a player is
 * never "further than anyone" on Home and "=2nd" in the report.
 *
 * The rules come from how the numbers are measured (one fixed camera, no
 * wearables), not from taste:
 *   - distance is good to about 5%, top speed to 1-2 km/h, touches to 10-15%;
 *   - two players whose difference is inside that margin are LEVEL, and share
 *     a rank ("=3rd"), however the decimals fall;
 *   - distance and touches are ranked per ten minutes on camera, so a player
 *     the camera lost for a while is not ranked down for it;
 *   - fewer than ten minutes on camera is listed, never ranked;
 *   - a personal best needs three earlier matches and must clear the old best
 *     by more than the margin.
 *
 * Pure and dependency-free: it runs in the browser and on the server.
 */

/** Minutes on camera below which a player is shown but never ranked. */
export const MIN_RANKED_MINUTES = 10;

/** Earlier matches a personal best must beat before it is called one. */
export const PB_MIN_EARLIER_MATCHES = 3;

export type RankingMetric =
  | "distanceRate"
  | "topSpeed"
  | "touchRate"
  | "distance"
  | "touches"
  | "passes"
  | "dribblesWon"
  | "goals";

/** What a ranking needs to know about a player. */
export type RankablePlayer = {
  playerId: number;
  claimed: boolean;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesCompleted: number | null;
  dribblesWon: number | null;
  goals: number | null;
};

/** The headline stats, by the names the cached match stats use. */
export type HeadlineStat = "distanceKm" | "topSpeedKmh" | "touches" | "passesCompleted" | "dribblesWon" | "goals";

/**
 * What each headline stat is RANKED on, everywhere: distance and touches per
 * ten minutes on camera, everything else over the whole game.
 */
export const RANK_BASIS: Record<HeadlineStat, RankingMetric> = {
  distanceKm: "distanceRate",
  topSpeedKmh: "topSpeed",
  touches: "touchRate",
  passesCompleted: "passes",
  dribblesWon: "dribblesWon",
  goals: "goals",
};

/** What each headline stat's PERSONAL BEST is judged on: the whole-game figure. */
export const BEST_BASIS: Record<HeadlineStat, RankingMetric> = {
  distanceKm: "distance",
  topSpeedKmh: "topSpeed",
  touches: "touches",
  passesCompleted: "passes",
  dribblesWon: "dribblesWon",
  goals: "goals",
};

/** True when a metric is a per-ten-minutes rate. */
export function isRateMetric(metric: RankingMetric): boolean {
  return metric === "distanceRate" || metric === "touchRate";
}

/** The measuring margin around a value: half-width of the band inside which two players are level. */
export function band(metric: RankingMetric, value: number): number {
  switch (metric) {
    case "distanceRate":
    case "distance":
      return Math.abs(value) * 0.05;
    case "topSpeed":
      return 1.5;
    case "touchRate":
    case "touches":
      return Math.abs(value) * 0.12;
    case "passes":
      return Math.max(2, Math.abs(value) * 0.15);
    case "dribblesWon":
      return 1;
    case "goals":
      return 0;
  }
}

/** Level: the gap is inside the larger of the two margins. */
export function isLevel(metric: RankingMetric, a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(band(metric, a), band(metric, b)) + 1e-9;
}

export function metricValue(player: RankablePlayer, metric: RankingMetric): number | null {
  const minutes = player.minutes ?? 0;
  switch (metric) {
    case "distanceRate":
      return player.distanceKm !== null && minutes > 0 ? (player.distanceKm / minutes) * 10 : null;
    case "touchRate":
      return player.touches !== null && minutes > 0 ? (player.touches / minutes) * 10 : null;
    case "topSpeed":
      return player.topSpeedKmh;
    case "distance":
      return player.distanceKm;
    case "touches":
      return player.touches;
    case "passes":
      return player.passesCompleted;
    case "dribblesWon":
      return player.dribblesWon;
    case "goals":
      return player.goals;
  }
}

/** Ranked means claimed, measured on this metric, and on camera long enough. */
export function isRanked(player: RankablePlayer, metric: RankingMetric): boolean {
  return player.claimed && (player.minutes ?? 0) >= MIN_RANKED_MINUTES && metricValue(player, metric) !== null;
}

export type Standing<T extends RankablePlayer = RankablePlayer> = {
  player: T;
  value: number;
  /** 1 + the number of ranked players clearly ahead (by more than the margin); 0 when not ranked */
  rank: number;
  /** someone else ranked is level with this player */
  shared: boolean;
  ranked: boolean;
};

/**
 * Everyone measured on one metric, best first. Players under ten minutes are
 * included (so they can be drawn) but carry ranked=false and rank 0.
 */
export function standings<T extends RankablePlayer>(players: T[], metric: RankingMetric): Array<Standing<T>> {
  const measured = players
    .filter((player) => player.claimed && metricValue(player, metric) !== null)
    .map((player) => ({ player, value: metricValue(player, metric)!, ranked: isRanked(player, metric) }))
    .sort((a, b) => b.value - a.value);
  const ranked = measured.filter((entry) => entry.ranked);
  return measured.map((entry) => {
    if (!entry.ranked) return { ...entry, rank: 0, shared: false };
    const others = ranked.filter((other) => other.player.playerId !== entry.player.playerId);
    const ahead = others.filter((other) => other.value > entry.value && !isLevel(metric, other.value, entry.value)).length;
    const shared = others.some((other) => isLevel(metric, other.value, entry.value));
    return { ...entry, rank: ahead + 1, shared };
  });
}

export function rankedCount(players: RankablePlayer[], metric: RankingMetric): number {
  return players.filter((player) => isRanked(player, metric)).length;
}

/** Ranked players level with a player's value, not counting the player. */
export function levelWith<T extends RankablePlayer>(players: T[], metric: RankingMetric, playerId: number): T[] {
  const me = players.find((player) => player.playerId === playerId);
  const mine = me ? metricValue(me, metric) : null;
  if (mine === null) return [];
  return players.filter((player) => player.playerId !== playerId
    && isRanked(player, metric)
    && isLevel(metric, metricValue(player, metric)!, mine));
}

/** One player's standing on a metric, or null when they are not measured on it. */
export function standingOf<T extends RankablePlayer>(players: T[], metric: RankingMetric, playerId: number): Standing<T> | null {
  return standings(players, metric).find((entry) => entry.player.playerId === playerId) ?? null;
}

/**
 * The report would show this player clearly first: ranked, nobody ranked
 * level with them, and at least one other ranked player to be ahead of.
 */
export function isClearlyFirst(players: RankablePlayer[], metric: RankingMetric, playerId: number): boolean {
  const mine = standingOf(players, metric, playerId);
  return Boolean(mine && mine.ranked && mine.rank === 1 && !mine.shared && rankedCount(players, metric) >= 2);
}

/**
 * A personal best is only claimed with at least three earlier matches to beat,
 * and only when this one clears the old best by more than the margin.
 */
export function isPersonalBest(
  metric: RankingMetric,
  value: number | null,
  previousBest: number | null | undefined,
  earlierMatches: number,
): boolean {
  if (value === null || previousBest === null || previousBest === undefined || earlierMatches < PB_MIN_EARLIER_MATCHES) return false;
  return value > previousBest && !isLevel(metric, value, previousBest);
}

/** The best of the earlier measured values, or null when none was measured. */
export function previousBest(earlier: Array<number | null | undefined>): number | null {
  const measured = earlier.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return measured.length ? Math.max(...measured) : null;
}
