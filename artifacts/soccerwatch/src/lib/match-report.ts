/**
 * The arithmetic behind the match report. Nothing here draws anything; it is
 * the part worth testing, because it decides what the page is allowed to say.
 *
 * The rules come from how the numbers are measured (one fixed camera, no
 * wearables), not from taste:
 *   - distance is good to about 5%, top speed to 1-2 km/h, touches to 10-15%;
 *   - two players whose difference is inside that margin are LEVEL, and share
 *     a rank ("=3rd"), however the decimals fall;
 *   - rates are per ten minutes on camera, so a player the camera lost for a
 *     while is not ranked down for it;
 *   - fewer than ten minutes on camera is listed, never ranked;
 *   - a comparison ("further", "second half down") is only made when the gap
 *     is bigger than the margin.
 */

export const MIN_RANKED_MINUTES = 10;

export type ReportMetric = "distanceRate" | "topSpeed" | "touchRate" | "distance" | "touches" | "passes" | "dribblesWon" | "goals";

export type ReportBlock = { index: number; seconds: number; metres: number | null; touches: number | null };

export type ReportTimeline = {
  spans: Array<[number, number]>;
  blocks: ReportBlock[];
  touchTimes: number[];
  goalTimes: number[];
  dribbleWonTimes: number[];
  /** shots, goals included; absent from servers before the moments player */
  shotTimes?: number[];
  /** passes the player played; completed is null without a team pick */
  passes?: Array<{ t: number; completed: boolean | null }>;
  /** every dribble the player started */
  dribbles?: Array<{ t: number; outcome: "won" | "lost" | null }>;
  topSpeedAt: number | null;
  heatmap: { coordinateSpace: "pitch" | "camera"; columns: number; rows: number; weights: number[] } | null;
};

export type ReportPlayer = {
  playerId: number;
  name: string;
  team: string | null;
  claimed: boolean;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  dribblesWon: number | null;
  goals: number | null;
  report?: ReportTimeline;
};

/** The measuring margin around a value: half-width of the band inside which two players are level. */
export function band(metric: ReportMetric, value: number): number {
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
export function isLevel(metric: ReportMetric, a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(band(metric, a), band(metric, b)) + 1e-9;
}

export function metricValue(player: ReportPlayer, metric: ReportMetric): number | null {
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
export function isRanked(player: ReportPlayer, metric: ReportMetric): boolean {
  return player.claimed && (player.minutes ?? 0) >= MIN_RANKED_MINUTES && metricValue(player, metric) !== null;
}

export type Standing = {
  player: ReportPlayer;
  value: number;
  /** 1 + the number of players clearly ahead (by more than the margin) */
  rank: number;
  /** someone else is level with this player */
  shared: boolean;
  ranked: boolean;
};

/**
 * Everyone measured on one metric, best first. Players under ten minutes are
 * included (so they can be drawn) but carry ranked=false and no rank of their own.
 */
export function standings(players: ReportPlayer[], metric: ReportMetric): Standing[] {
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

export function rankedCount(players: ReportPlayer[], metric: ReportMetric): number {
  return players.filter((player) => isRanked(player, metric)).length;
}

/** Players level with a value, not counting the player it belongs to. */
export function levelWith(players: ReportPlayer[], metric: ReportMetric, playerId: number): ReportPlayer[] {
  const me = players.find((player) => player.playerId === playerId);
  const mine = me ? metricValue(me, metric) : null;
  if (mine === null) return [];
  return players.filter((player) => player.playerId !== playerId
    && isRanked(player, metric)
    && isLevel(metric, metricValue(player, metric)!, mine));
}

/** Round a metric the way the report shows it: the precision the measurement supports, no more. */
export function formatMetric(metric: ReportMetric, value: number): string {
  switch (metric) {
    case "distanceRate":
      return value.toFixed(2);
    case "distance":
      return value.toFixed(1);
    case "topSpeed":
      return String(Math.round(value));
    default:
      return String(Math.round(value));
  }
}

/** Where a value sits on an axis, 0..1, with the axis padded so no dot sits on the edge. */
export function axisFor(values: number[], pad = 0.08): { min: number; max: number; at: (value: number) => number } {
  const finite = values.filter(Number.isFinite);
  let min = finite.length ? Math.min(...finite) : 0;
  let max = finite.length ? Math.max(...finite) : 1;
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  min -= span * pad;
  max += span * pad;
  return { min, max, at: (value: number) => Math.min(1, Math.max(0, (value - min) / (max - min))) };
}

/* ------------------------------------------------------------------ time */

export type TenMinuteBlock = {
  index: number;
  from: number;
  to: number;
  seconds: number;
  metres: number | null;
  touches: number | null;
  /** metres per minute on camera; null when the camera barely saw the player in this block */
  metresPerMinute: number | null;
  onCamera: boolean;
};

/** Five-minute blocks folded into blocks of `size` seconds across the whole booking. */
export function foldBlocks(blocks: ReportBlock[], durationSeconds: number, size = 600, minSeconds = 120): TenMinuteBlock[] {
  const count = Math.max(1, Math.ceil(durationSeconds / size));
  const out: TenMinuteBlock[] = Array.from({ length: count }, (_, index) => ({
    index,
    from: index * size,
    to: Math.min(durationSeconds, (index + 1) * size),
    seconds: 0,
    metres: null,
    touches: null,
    metresPerMinute: null,
    onCamera: false,
  }));
  for (const block of blocks) {
    const at = Math.floor((block.index * 300) / size);
    const target = out[Math.min(out.length - 1, at)];
    target.seconds += block.seconds;
    if (block.metres !== null) target.metres = (target.metres ?? 0) + block.metres;
    if (block.touches !== null) target.touches = (target.touches ?? 0) + block.touches;
  }
  for (const block of out) {
    block.onCamera = block.seconds >= minSeconds;
    block.metresPerMinute = block.onCamera && block.metres !== null ? block.metres / (block.seconds / 60) : null;
  }
  return out;
}

export type HalvesComparison = { first: number; second: number; change: number; level: boolean } | null;

/** Ground covered per minute on camera, first half of the booking against the second. */
export function compareHalves(blocks: ReportBlock[], durationSeconds: number): HalvesComparison {
  const half = durationSeconds / 2;
  const sum = (pick: (block: ReportBlock) => boolean) => blocks.filter(pick).reduce(
    (acc, block) => ({ seconds: acc.seconds + block.seconds, metres: acc.metres + (block.metres ?? 0), measured: acc.measured || block.metres !== null }),
    { seconds: 0, metres: 0, measured: false },
  );
  const a = sum((block) => (block.index + 0.5) * 300 <= half);
  const b = sum((block) => (block.index + 0.5) * 300 > half);
  if (!a.measured || !b.measured || a.seconds < 300 || b.seconds < 300) return null;
  const first = a.metres / (a.seconds / 60);
  const second = b.metres / (b.seconds / 60);
  if (first <= 0) return null;
  const change = (second - first) / first;
  return { first, second, change, level: isLevel("distance", first, second) };
}

/** Stretches of the booking the camera did not see the player, longest first, ignoring short blinks. */
export function cameraGaps(spans: Array<[number, number]>, durationSeconds: number, minSeconds = 180): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  if (!spans.length) return gaps;
  let cursor = 0;
  for (const [a, b] of [...spans].sort((p, q) => p[0] - q[0])) {
    if (a - cursor >= minSeconds && cursor > 0) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (durationSeconds - cursor >= minSeconds) gaps.push([cursor, durationSeconds]);
  return gaps.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
}

export function onCameraSeconds(spans: Array<[number, number]>): number {
  return spans.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
}

/** 5-minute rows for the minutes view: what the camera saw of the player in each. */
export type FiveMinuteRow = {
  index: number;
  from: number;
  to: number;
  seconds: number;
  metres: number | null;
  touchTimes: number[];
  goals: number[];
  dribbles: number[];
  fastest: boolean;
  onCamera: boolean;
};

export function fiveMinuteRows(timeline: ReportTimeline, durationSeconds: number): FiveMinuteRow[] {
  const count = Math.max(1, Math.ceil(durationSeconds / 300));
  const byIndex = new Map(timeline.blocks.map((block) => [block.index, block]));
  const inRow = (index: number) => (at: number) => at >= index * 300 && at < (index + 1) * 300;
  return Array.from({ length: count }, (_, index) => {
    const block = byIndex.get(index);
    const test = inRow(index);
    return {
      index,
      from: index * 300,
      to: Math.min(durationSeconds, (index + 1) * 300),
      seconds: block?.seconds ?? 0,
      metres: block?.metres ?? null,
      touchTimes: timeline.touchTimes.filter(test),
      goals: timeline.goalTimes.filter(test),
      dribbles: timeline.dribbleWonTimes.filter(test),
      fastest: timeline.topSpeedAt !== null && test(timeline.topSpeedAt),
      onCamera: (block?.seconds ?? 0) >= 60,
    };
  });
}

/* ------------------------------------------------------------------ comparisons */

export type Direction = "more" | "less" | "level";

export function direction(metric: ReportMetric, mine: number, other: number): Direction {
  if (isLevel(metric, mine, other)) return "level";
  return mine > other ? "more" : "less";
}

export type RivalRow = {
  metric: ReportMetric;
  mine: number | null;
  theirs: number | null;
  outcome: "you" | "them" | "level" | null;
  /** the lead beyond the margin, as a share of the larger value (0..1); 0 when level */
  beyond: number;
};

export const RIVAL_METRICS: ReportMetric[] = ["distanceRate", "topSpeed", "touchRate", "passes", "dribblesWon"];

export function rivalRows(me: ReportPlayer, rival: ReportPlayer, metrics = RIVAL_METRICS): RivalRow[] {
  return metrics.map((metric) => {
    const mine = metricValue(me, metric);
    const theirs = metricValue(rival, metric);
    if (mine === null || theirs === null) return { metric, mine, theirs, outcome: null, beyond: 0 };
    const d = direction(metric, mine, theirs);
    const top = Math.max(Math.abs(mine), Math.abs(theirs), 1e-9);
    const margin = Math.max(band(metric, mine), band(metric, theirs));
    return {
      metric,
      mine,
      theirs,
      outcome: d === "level" ? "level" : d === "more" ? "you" : "them",
      beyond: d === "level" ? 0 : Math.min(1, (Math.abs(mine - theirs) - margin) / top),
    };
  });
}

export function tally(rows: RivalRow[]): { you: number; level: number; them: number } {
  return rows.reduce((acc, row) => {
    if (row.outcome === "you") acc.you++;
    else if (row.outcome === "them") acc.them++;
    else if (row.outcome === "level") acc.level++;
    return acc;
  }, { you: 0, level: 0, them: 0 });
}

/** The default rival: the nearest player clearly ahead on ground covered, else the nearest behind. */
export function defaultRival<T extends ReportPlayer>(players: T[], meId: number): T | null {
  const me = players.find((player) => player.playerId === meId);
  const others = players.filter((player) => player.playerId !== meId && player.claimed);
  if (!others.length) return null;
  const mine = me ? metricValue(me, "distanceRate") : null;
  if (mine === null) return others[0];
  const scored = others
    .map((player) => ({ player, value: metricValue(player, "distanceRate") }))
    .filter((entry): entry is { player: T; value: number } => entry.value !== null);
  const ahead = scored.filter((entry) => entry.value > mine).sort((a, b) => a.value - b.value);
  if (ahead.length) return ahead[0].player;
  const behind = scored.sort((a, b) => b.value - a.value);
  return behind[0]?.player ?? others[0];
}

/* ------------------------------------------------------------------ form */

export type FormLine = { distance: Direction | null; speed: Direction | null; touches: Direction | null; matches: number };

type FormAverages = { minutes: number | null; distanceKm: number | null; topSpeedKmh: number | null; touches: number | null };

/** This match against the player's earlier average, per ten minutes where that is fair. */
export function formLine(me: ReportPlayer, averages: FormAverages | null | undefined, matches: number): FormLine | null {
  if (!averages || matches < 1) return null;
  const rate = (value: number | null, minutes: number | null) => (value !== null && minutes && minutes > 0 ? (value / minutes) * 10 : null);
  const mineDistance = metricValue(me, "distanceRate");
  const mineTouches = metricValue(me, "touchRate");
  const theirDistance = rate(averages.distanceKm, averages.minutes);
  const theirTouches = rate(averages.touches, averages.minutes);
  const line: FormLine = {
    distance: mineDistance !== null && theirDistance !== null ? direction("distanceRate", mineDistance, theirDistance) : null,
    speed: me.topSpeedKmh !== null && averages.topSpeedKmh !== null ? direction("topSpeed", me.topSpeedKmh, averages.topSpeedKmh) : null,
    touches: mineTouches !== null && theirTouches !== null ? direction("touchRate", mineTouches, theirTouches) : null,
    matches,
  };
  return line.distance || line.speed || line.touches ? line : null;
}

/**
 * A personal best is only claimed with at least three earlier matches to beat,
 * and only when this one clears the old best by more than the margin.
 */
export function isPersonalBest(metric: ReportMetric, value: number | null, previousBest: number | null | undefined, earlierMatches: number): boolean {
  if (value === null || previousBest === null || previousBest === undefined || earlierMatches < 3) return false;
  return value > previousBest && !isLevel(metric, value, previousBest);
}

/* ------------------------------------------------------------------ standing out */

export type StandOut = {
  metric: ReportMetric;
  winners: ReportPlayer[];
  value: number;
  /** the gap to the next player, when it is bigger than the margin */
  clearBy: number | null;
};

/**
 * Who stood out on a metric: the leaders, and whether they are clear. When the
 * top of the table is level, every level player shares it rather than one
 * being named on a decimal.
 */
export function standOut(players: ReportPlayer[], metric: ReportMetric, minimum = 0): StandOut | null {
  const table = standings(players, metric).filter((entry) => entry.ranked);
  if (table.length < 2) return null;
  const top = table[0];
  if (top.value <= minimum) return null;
  const winners = table.filter((entry) => entry.rank === 1).map((entry) => entry.player);
  const next = table.find((entry) => entry.rank > 1);
  const clearBy = winners.length === 1 && next ? top.value - next.value : null;
  return { metric, winners, value: top.value, clearBy };
}

/* ------------------------------------------------------------------ misc */

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function minuteMark(seconds: number): number {
  return Math.floor(Math.max(0, seconds) / 60) + 1;
}

/** 12 x 8 heat weights folded into a coarser grid (defaults to 6 x 4), still summing to ~1. */
export function foldHeat(weights: number[], columns = 12, rows = 8, into: [number, number] = [6, 4]): number[] {
  const [c2, r2] = into;
  const out = new Array<number>(c2 * r2).fill(0);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const target = Math.floor((row * r2) / rows) * c2 + Math.floor((column * c2) / columns);
      out[target] += weights[row * columns + column] ?? 0;
    }
  }
  return out;
}
