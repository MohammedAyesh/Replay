/**
 * The one stat tile Home shows under "Your next match": every tile that fits
 * the player's situation is built and scored for how impressive it is, and
 * the highest score wins.
 *
 * Situations, in the order they matter:
 *   1. A recent match the player is in but hasn't claimed: a claim tile, so
 *      the player goes and gets their numbers (friends / not found / nobody).
 *   2. Otherwise the most impressive thing in their numbers: a personal best,
 *      a #1 on the pitch, a milestone, a run of form, a rival within reach...
 *   3. A match later today adds a challenge for it.
 *
 * Scores are 0-100 and only compare tiles with each other. A tile from an old
 * match counts for less than one from last night.
 *
 * Everything here is pure: the route loads the rows, this decides.
 */

import type { MatchPlayerStatsCacheValue } from "@workspace/db";
import {
  BEST_BASIS,
  MIN_RANKED_MINUTES,
  PB_MIN_EARLIER_MATCHES,
  RANK_BASIS,
  isLevel,
  isPersonalBest,
  isRateMetric,
  previousBest as bestOf,
  rankedCount,
  standings,
  type HeadlineStat,
  type RankablePlayer,
} from "@workspace/api-zod";

export type TileStats = MatchPlayerStatsCacheValue;

export type TileMatchRef = {
  matchId: number;
  code: string;
  /** "YYYY-MM-DD HH:MM", Amman */
  startLocal: string;
  fieldId: number;
  fieldName: string;
  /** people on the roster who said they're in */
  players: number;
  /** the full-match player (/w/<token>?m=<code>), when footage is shared */
  watch: string | null;
};

export type TilePeer = {
  matchPlayerId: number;
  userId: number;
  name: string;
  team: string | null;
  me: boolean;
  stats: TileStats;
};

export type HomeTileInput = {
  /** "YYYY-MM-DD HH:MM", Amman */
  nowLocal: string;
  /** the player's claimed matches, newest first */
  history: Array<{ match: TileMatchRef; stats: TileStats }>;
  /** claimed players the viewer may see in their newest claimed match, including them */
  lastPeers: TilePeer[] | null;
  /** distance this month at the newest match's field, for the people the player plays with */
  fieldMonth: { fieldName: string; month: string; rows: Array<{ userId: number; name: string; distanceKm: number; me: boolean }> } | null;
  /** players at that field whose best top speed beats the newest match's top speed */
  fieldFaster: number | null;
  /** recent matches the player was in and hasn't claimed, newest first */
  unclaimed: Array<{ match: TileMatchRef; findRecordingId: number; claimed: number; peers: TilePeer[] | null }>;
  /** the player's next match, when it hasn't started */
  upcoming: { code: string; startLocal: string; fieldName: string } | null;
};

export type TileMetric = "distanceKm" | "topSpeedKmh" | "touches" | "passesCompleted" | "dribblesWon" | "goals" | "shots";

type MatchBit = { code: string; startLocal: string; fieldName: string; players: number; watch: string | null };

export type StatTile =
  | { kind: "lastMatch"; match: MatchBit; metric: TileMetric; value: number; pitchAverage: number; claimed: number; secondary: Partial<Record<TileMetric, number>>; per10?: boolean }
  | { kind: "personalBest"; match: MatchBit; metric: TileMetric; value: number; previousBest: number; previousBestLocal: string; at: number | null; fasterAtField: number | null }
  | { kind: "rival"; fieldName: string; month: string; board: Array<{ rank: number; name: string; distanceKm: number; me: boolean }>; total: number; myRank: number; other: { name: string; distanceKm: number }; mine: number; perMatch: number; upcoming: { code: string; startLocal: string } | null }
  | { kind: "form"; metric: "distanceKm" | "topSpeedKmh" | "touches"; values: Array<{ startLocal: string; value: number }>; streak: number; latest: number; average: number; upcoming: { code: string; startLocal: string } | null }
  | { kind: "notFound"; match: MatchBit; findRecordingId: number; found: number; teaser: { metric: TileMetric; value: number } | null }
  | { kind: "passing"; match: MatchBit; completed: number; tried: number; rate: number; bestRate: boolean; pitchRate: number | null }
  | { kind: "touches"; match: MatchBit; total: number; firstIndex: number; blocks: number[]; busiest: { index: number; count: number }; everySeconds: number | null }
  | { kind: "distanceTotal"; fieldName: string | null; sinceLocal: string; latestLocal: string; matches: number; totalKm: number; perMatch: number[]; milestone: number; passed: boolean; matchesToGo: number }
  | { kind: "distanceSpells"; match: MatchBit; spells: number[]; strongest: number; finishedStrongest: boolean }
  | { kind: "ranks"; match: MatchBit; claimed: number; ranks: Array<{ metric: TileMetric; rank: number; value: number; of: number | null; shared?: boolean; per10?: boolean }> }
  | { kind: "style"; matches: number; touches: number; passes: number; dribbles: number; shots: number; other: number; lean: "passer" | "dribbler" | "shooter" | "allRounder" }
  | { kind: "challenge"; upcoming: { code: string; startLocal: string; fieldName: string }; metric: "passesCompleted" | "distanceKm" | "touches" | "dribblesWon"; target: number; average: number; best: number; scaleMax: number }
  | { kind: "dribbles"; match: MatchBit; won: number; lost: number; rank: number | null; leaderName: string | null }
  | { kind: "matchesPlayed"; dates: string[]; weekStarts: string[]; total: number; upcomingDate: string | null }
  | { kind: "shots"; match: MatchBit; shots: number; times: number[] }
  | { kind: "passingTrend"; rates: Array<{ startLocal: string; rate: number }> }
  | { kind: "teamShare"; match: MatchBit; mine: number; teamTotal: number; teammates: number[] }
  | { kind: "dribbleDuel"; match: MatchBit; me: { won: number; tries: number }; other: { name: string; won: number; tries: number } }
  | { kind: "week"; matches: number; distanceKm: number; touches: number; passesCompleted: number; passesTried: number; dribblesWon: number; dribbles: number; shots: number }
  | { kind: "friends"; match: MatchBit; findRecordingId: number; found: number; peers: Array<{ name: string; distanceKm: number | null; topSpeedKmh: number | null; shots: number | null; dribblesWon: number | null }> }
  | { kind: "unclaimed"; match: MatchBit; findRecordingId: number };

export type StatTileKind = StatTile["kind"];
export type ScoredTile = { tile: StatTile; score: number };

const round1 = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const num = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const bit = (m: TileMatchRef): MatchBit => ({ code: m.code, startLocal: m.startLocal, fieldName: m.fieldName, players: m.players, watch: m.watch });

/** Whole days between two "YYYY-MM-DD..." strings (b - a). */
export function daysBetween(a: string, b: string): number {
  const at = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((at(b) - at(a)) / 86_400_000);
}

/** Monday of the week holding a date, "YYYY-MM-DD". */
export function mondayOf(date: string): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Last night's tiles beat last month's. */
export function freshness(matchStartLocal: string, nowLocal: string): number {
  const age = daysBetween(matchStartLocal, nowLocal);
  return age <= 3 ? 1 : age <= 10 ? 0.9 : age <= 21 ? 0.8 : 0.65;
}

/*
 * Every comparison below -- who is first, what rank, what counts as a
 * personal best, what counts as "more" -- goes through the rule set the match
 * report uses (@workspace/api-zod statsRanking): at least ten minutes on
 * camera to be ranked, distance and touches per ten minutes on camera, the
 * same measuring margins (a gap inside one is level, not a win), and a
 * personal best only over three earlier matches and by more than the margin.
 * Home must never say something the report would contradict.
 */

/** The players of one match as the shared ranking rule sees them. */
function rankable(peers: TilePeer[]): RankablePlayer[] {
  return peers.map((peer) => ({
    playerId: peer.matchPlayerId,
    claimed: true,
    minutes: peer.stats.minutes,
    distanceKm: peer.stats.distanceKm,
    topSpeedKmh: peer.stats.topSpeedKmh,
    touches: peer.stats.touches,
    passesCompleted: peer.stats.passesCompleted,
    dribblesWon: peer.stats.dribblesWon,
    goals: peer.stats.goals,
  }));
}

/** Rounded for display: distance to 10 m (or 0.01 km per 10 min), speed and rates to one decimal, counts whole. */
function shown(metric: HeadlineStat, value: number, per10: boolean): number {
  if (metric === "distanceKm") return Math.round(value * 100) / 100;
  if (metric === "topSpeedKmh" || per10) return round1(value);
  return value;
}

function personalBest(input: HomeTileInput): ScoredTile | null {
  const [latest, ...before] = input.history;
  if (!latest || before.length < PB_MIN_EARLIER_MATCHES) return null;
  let best: ScoredTile | null = null;
  for (const metric of ["topSpeedKmh", "distanceKm", "passesCompleted", "dribblesWon", "touches", "goals"] as const) {
    const value = latest.stats[metric];
    if (!num(value) || value <= 0) continue;
    const previousBest = bestOf(before.map((row) => row.stats[metric]));
    // the report's rule: three earlier matches, and clear of the old best by more than the margin
    if (previousBest === null || !isPersonalBest(BEST_BASIS[metric], value, previousBest, before.length)) continue;
    const top = before.find((row) => row.stats[metric] === previousBest)!;
    const gain = previousBest > 0 ? (value - previousBest) / previousBest : 0.3;
    const score = (86 + Math.min(12, gain * 40)) * freshness(latest.match.startLocal, input.nowLocal);
    if (!best || score > best.score) {
      best = {
        score,
        tile: {
          kind: "personalBest",
          match: bit(latest.match),
          metric,
          value: metric === "distanceKm" || metric === "topSpeedKmh" ? round1(value) : value,
          previousBest: metric === "distanceKm" || metric === "topSpeedKmh" ? round1(previousBest) : previousBest,
          previousBestLocal: top.match.startLocal,
          at: metric === "topSpeedKmh" ? latest.stats.extras?.topSpeedAt ?? null : null,
          fasterAtField: metric === "topSpeedKmh" ? input.fieldFaster : null,
        },
      };
    }
  }
  return best;
}

const PEERS_FOR_RANKS = 4;

function lastMatchFirst(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const peers = input.lastPeers;
  if (!latest || !peers || peers.length < PEERS_FOR_RANKS) return null;
  const me = peers.find((p) => p.me);
  if (!me) return null;
  const players = rankable(peers);
  let best: ScoredTile | null = null;
  for (const metric of ["distanceKm", "topSpeedKmh", "touches", "passesCompleted", "dribblesWon", "goals"] as const) {
    const basis = RANK_BASIS[metric];
    // enough players the report would rank, and the report shows this one clearly first
    if (rankedCount(players, basis) < PEERS_FOR_RANKS) continue;
    const table = standings(players, basis).filter((entry) => entry.ranked);
    const mineEntry = table.find((entry) => entry.player.playerId === me.matchPlayerId);
    if (!mineEntry || mineEntry.rank !== 1 || mineEntry.shared) continue;
    const mine = mineEntry.value;
    const others = table.filter((entry) => entry !== mineEntry).map((entry) => entry.value);
    if (mine <= 0 || !others.length) continue;
    const second = Math.max(...others);
    const margin = second > 0 ? (mine - second) / second : 0.3;
    const score = (80 + Math.min(10, margin * 50)) * freshness(latest.match.startLocal, input.nowLocal);
    if (!best || score > best.score) {
      const per10 = isRateMetric(basis);
      const average = others.reduce((a, b) => a + b, 0) / others.length;
      const secondary: Partial<Record<TileMetric, number>> = {};
      for (const m of ["topSpeedKmh", "distanceKm", "touches", "passesCompleted"] as const) {
        const v = me.stats[m];
        if (m !== metric && num(v)) secondary[m] = m === "distanceKm" || m === "topSpeedKmh" ? round1(v) : v;
      }
      best = {
        score,
        tile: {
          kind: "lastMatch",
          match: bit(latest.match),
          metric,
          value: shown(metric, mine, per10),
          pitchAverage: metric === "distanceKm" ? Math.round(average * 100) / 100 : round1(average),
          claimed: peers.length,
          secondary,
          ...(per10 ? { per10: true } : {}),
        },
      };
    }
  }
  return best;
}

// Shots are not ranked: the report doesn't rank them, so Home doesn't either.
const RANK_METRICS: HeadlineStat[] = ["distanceKm", "dribblesWon", "passesCompleted", "touches", "topSpeedKmh"];

function ranks(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const peers = input.lastPeers;
  if (!latest || !peers || peers.length < PEERS_FOR_RANKS) return null;
  const me = peers.find((p) => p.me);
  if (!me) return null;
  const players = rankable(peers);
  const list: Array<{ metric: HeadlineStat; rank: number; value: number; of: number | null; shared?: boolean; per10?: boolean }> = [];
  for (const metric of RANK_METRICS) {
    const basis = RANK_BASIS[metric];
    if (rankedCount(players, basis) < PEERS_FOR_RANKS) continue;
    const mine = standings(players, basis).find((entry) => entry.player.playerId === me.matchPlayerId);
    // under ten minutes on camera the report ranks nobody, so neither does Home
    if (!mine || !mine.ranked) continue;
    const per10 = isRateMetric(basis);
    const of = metric === "dribblesWon" ? me.stats.dribbles : metric === "passesCompleted" ? me.stats.passesTried : null;
    list.push({
      metric,
      rank: mine.rank,
      value: shown(metric, mine.value, per10),
      of: num(of) ? of : null,
      ...(mine.shared ? { shared: true } : {}),
      ...(per10 ? { per10: true } : {}),
    });
  }
  list.sort((a, b) => a.rank - b.rank || RANK_METRICS.indexOf(a.metric) - RANK_METRICS.indexOf(b.metric));
  const top = list.slice(0, 5);
  if (top.length < 3) return null;
  const podiums = top.filter((r) => r.rank <= 3).length;
  return {
    score: (40 + 6 * podiums) * freshness(latest.match.startLocal, input.nowLocal),
    tile: { kind: "ranks", match: bit(latest.match), claimed: peers.length, ranks: top },
  };
}

function form(input: HomeTileInput): ScoredTile | null {
  const recent = input.history.slice(0, 5);
  if (recent.length < 3) return null;
  let best: ScoredTile | null = null;
  for (const metric of ["distanceKm", "topSpeedKmh", "touches"] as const) {
    const rows = recent.filter((row) => num(row.stats[metric])).reverse();
    if (rows.length < 3) continue;
    const values = rows.map((row) => row.stats[metric] as number);
    let streak = 0;
    // each match clearly up on the one before: past the report's margin, not a decimal
    for (let i = values.length - 1; i > 0 && values[i] > values[i - 1] && !isLevel(BEST_BASIS[metric], values[i], values[i - 1]); i--) streak++;
    if (streak < 2) continue;
    const average = values.slice(0, -1).reduce((a, b) => a + b, 0) / (values.length - 1);
    const score = (66 + Math.min(12, 3 * streak)) * freshness(recent[0].match.startLocal, input.nowLocal);
    if (!best || score > best.score) {
      best = {
        score,
        tile: {
          kind: "form",
          metric,
          values: rows.map((row) => ({ startLocal: row.match.startLocal, value: metric === "touches" ? (row.stats[metric] as number) : round1(row.stats[metric] as number) })),
          streak,
          latest: metric === "distanceKm" ? Math.round(values.at(-1)! * 100) / 100 : round1(values.at(-1)!),
          average: metric === "distanceKm" ? Math.round(average * 100) / 100 : round1(average),
          upcoming: input.upcoming ? { code: input.upcoming.code, startLocal: input.upcoming.startLocal } : null,
        },
      };
    }
  }
  return best;
}

const MIN_PASSES = 8;
const rateOf = (s: TileStats) => (num(s.passesTried) && s.passesTried >= MIN_PASSES && num(s.passesCompleted) ? s.passesCompleted / s.passesTried : null);

function passing(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  if (!latest) return null;
  const rate = rateOf(latest.stats);
  if (rate === null) return null;
  const previous = input.history.slice(1).map((row) => rateOf(row.stats)).filter((r): r is number => r !== null);
  const bestRate = previous.length >= PB_MIN_EARLIER_MATCHES && previous.every((r) => rate > r + 0.01);
  const peerRates = (input.lastPeers ?? []).filter((p) => !p.me).map((p) => (num(p.stats.passesTried) && p.stats.passesTried >= 5 && num(p.stats.passesCompleted) ? p.stats.passesCompleted / p.stats.passesTried : null)).filter((r): r is number => r !== null);
  const pitchRate = peerRates.length >= 3 ? peerRates.reduce((a, b) => a + b, 0) / peerRates.length : null;
  const base = bestRate ? 72 : pitchRate !== null && rate >= pitchRate + 0.1 ? 60 : rate >= 0.7 ? 48 : 0;
  if (!base) return null;
  return {
    score: base * freshness(latest.match.startLocal, input.nowLocal),
    tile: { kind: "passing", match: bit(latest.match), completed: latest.stats.passesCompleted!, tried: latest.stats.passesTried!, rate: round3(rate), bestRate, pitchRate: pitchRate === null ? null : round3(pitchRate) },
  };
}

function passingTrend(input: HomeTileInput): ScoredTile | null {
  const rows = input.history.slice(0, 3);
  if (rows.length < 3) return null;
  const rates = rows.map((row) => rateOf(row.stats));
  if (rates.some((r) => r === null)) return null;
  const ordered = (rates as number[]).slice().reverse();
  if (!(ordered[1] > ordered[0] + 0.02 && ordered[2] > ordered[1] + 0.02)) return null;
  const rise = ordered[2] - ordered[0];
  if (rise < 0.08) return null;
  return {
    score: (64 + Math.min(8, rise * 30)) * freshness(rows[0].match.startLocal, input.nowLocal),
    tile: { kind: "passingTrend", rates: rows.slice().reverse().map((row, i) => ({ startLocal: row.match.startLocal, rate: round3(ordered[i]) })) },
  };
}

function touches(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const total = latest?.stats.touches;
  const blocks = latest?.stats.extras?.blocks ?? [];
  if (!latest || !num(total) || total < 10) return null;
  const measured = blocks.filter((b) => num(b[2]));
  if (measured.length < 6) return null;
  const last = Math.max(...measured.map((b) => b[0]));
  const first = Math.min(...measured.map((b) => b[0]));
  const series: number[] = [];
  for (let i = first; i <= last; i++) series.push(blocks.find((b) => b[0] === i)?.[2] ?? 0);
  const busiestIndex = series.indexOf(Math.max(...series));
  const minutes = latest.stats.minutes;
  return {
    score: 42 * freshness(latest.match.startLocal, input.nowLocal),
    tile: {
      kind: "touches",
      match: bit(latest.match),
      total,
      firstIndex: first,
      blocks: series,
      busiest: { index: first + busiestIndex, count: series[busiestIndex] },
      everySeconds: num(minutes) && minutes > 0 ? Math.round((minutes * 60) / total) : null,
    },
  };
}

function distanceSpells(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const blocks = (latest?.stats.extras?.blocks ?? []).filter((b) => num(b[1]));
  if (!latest || blocks.length < 6) return null;
  const spells = new Map<number, number>();
  for (const [index, metres] of blocks) spells.set(Math.floor(index / 2), (spells.get(Math.floor(index / 2)) ?? 0) + (metres as number));
  const keys = [...spells.keys()].sort((a, b) => a - b);
  const values = keys.map((k) => Math.round(spells.get(k)!));
  // A spell the camera barely saw would read as a slow one.
  if (values.length < 3 || values.some((v) => v < 50)) return null;
  const strongest = values.indexOf(Math.max(...values));
  const finishedStrongest = strongest === values.length - 1;
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  if (!finishedStrongest || values.at(-1)! < average * 1.1) {
    return { score: 34 * freshness(latest.match.startLocal, input.nowLocal), tile: { kind: "distanceSpells", match: bit(latest.match), spells: values, strongest, finishedStrongest } };
  }
  return { score: 66 * freshness(latest.match.startLocal, input.nowLocal), tile: { kind: "distanceSpells", match: bit(latest.match), spells: values, strongest, finishedStrongest } };
}

export const MILESTONES_KM = [5, 10, 21.1, 42.2, 50, 75, 100, 150, 200, 300, 500];

function distanceTotal(input: HomeTileInput): ScoredTile | null {
  const rows = input.history.filter((row) => num(row.stats.distanceKm));
  if (rows.length < 2) return null;
  const perMatch = rows.map((row) => row.stats.distanceKm as number).reverse();
  const total = perMatch.reduce((a, b) => a + b, 0);
  const beforeLatest = total - perMatch.at(-1)!;
  const passedNow = MILESTONES_KM.filter((m) => beforeLatest < m && m <= total).at(-1);
  const next = MILESTONES_KM.find((m) => m > total);
  const perAverage = total / perMatch.length;
  const fields = new Set(rows.map((row) => row.match.fieldName));
  const common = {
    kind: "distanceTotal" as const,
    fieldName: fields.size === 1 ? rows[0].match.fieldName : null,
    sinceLocal: rows.at(-1)!.match.startLocal,
    latestLocal: rows[0].match.startLocal,
    matches: rows.length,
    totalKm: round1(total),
    perMatch: perMatch.map(round1),
  };
  const fresh = freshness(rows[0].match.startLocal, input.nowLocal);
  if (passedNow !== undefined) {
    return { score: 84 * fresh, tile: { ...common, milestone: passedNow, passed: true, matchesToGo: 0 } };
  }
  if (next === undefined) return null;
  const matchesToGo = Math.max(1, Math.ceil((next - total) / Math.max(0.1, perAverage)));
  return { score: (matchesToGo <= 2 ? 58 : 36) * fresh, tile: { ...common, milestone: next, passed: false, matchesToGo } };
}

function dribbles(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const won = latest?.stats.dribblesWon;
  const lost = latest?.stats.dribblesLost;
  if (!latest || !num(won) || !num(lost) || won < 2 || won + lost < 4) return null;
  const peers = input.lastPeers ?? [];
  const players = rankable(peers);
  const me = peers.find((p) => p.me);
  const table = standings(players, "dribblesWon");
  const mine = me ? table.find((entry) => entry.player.playerId === me.matchPlayerId) : undefined;
  // a rank only where the report gives one: ranked, enough ranked players, and not level with anyone
  const rank = mine && mine.ranked && !mine.shared && rankedCount(players, "dribblesWon") >= PEERS_FOR_RANKS ? mine.rank : null;
  const leaders = table.filter((entry) => entry.ranked && entry.rank === 1);
  const leaderId = rank === 2 && leaders.length === 1 ? leaders[0].player.playerId : null;
  const leader = leaderId === null ? null : peers.find((p) => p.matchPlayerId === leaderId) ?? null;
  const rate = won / (won + lost);
  if (rate < 0.55 && rank !== 2) return null;
  return {
    score: (52 + (rank === 2 ? 6 : 0) + Math.min(6, (rate - 0.55) * 20)) * freshness(latest.match.startLocal, input.nowLocal),
    tile: { kind: "dribbles", match: bit(latest.match), won, lost, rank, leaderName: leader?.name ?? null },
  };
}

function dribbleDuel(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const peers = input.lastPeers ?? [];
  const me = peers.find((p) => p.me);
  if (!latest || !me || peers.length < 3) return null;
  const won = me.stats.dribblesWon;
  const tries = me.stats.dribbles;
  if (!num(won) || !num(tries) || won < 2) return null;
  // "X beat you by two" is a ranking claim: both must be on camera long enough
  // to be ranked, and the gap must be past the report's margin (one dribble is level).
  if ((me.stats.minutes ?? 0) < MIN_RANKED_MINUTES) return null;
  const others = peers.filter((p) => !p.me && num(p.stats.dribblesWon) && num(p.stats.dribbles) && (p.stats.minutes ?? 0) >= MIN_RANKED_MINUTES);
  // The closest duel: someone a few dribbles either side of you, at the top.
  const top = Math.max(won, ...others.map((p) => p.stats.dribblesWon as number));
  const rival = others
    .filter((p) => Math.abs((p.stats.dribblesWon as number) - won) <= 3 && Math.max(won, p.stats.dribblesWon as number) === top)
    .filter((p) => !isLevel("dribblesWon", p.stats.dribblesWon as number, won))
    .sort((a, b) => Math.abs((a.stats.dribblesWon as number) - won) - Math.abs((b.stats.dribblesWon as number) - won))[0];
  if (!rival) return null;
  return {
    score: 56 * freshness(latest.match.startLocal, input.nowLocal),
    tile: {
      kind: "dribbleDuel",
      match: bit(latest.match),
      me: { won, tries },
      other: { name: rival.name, won: rival.stats.dribblesWon as number, tries: rival.stats.dribbles as number },
    },
  };
}

function shots(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const count = latest?.stats.shots;
  if (!latest || !num(count) || count < 2) return null;
  return {
    score: Math.min(60, 44 + 3 * count) * freshness(latest.match.startLocal, input.nowLocal),
    tile: { kind: "shots", match: bit(latest.match), shots: count, times: (latest.stats.extras?.shotTimes ?? []).slice(0, 6) },
  };
}

function teamShare(input: HomeTileInput): ScoredTile | null {
  const latest = input.history[0];
  const extras = latest?.stats.extras;
  const mine = latest?.stats.passesCompleted;
  const total = extras?.teamPassesCompleted;
  if (!latest || !extras || !num(mine) || !num(total) || total < 10 || mine < 6 || mine > total) return null;
  const share = mine / total;
  if (share < 0.28) return null;
  const teammates = (input.lastPeers ?? [])
    .filter((p) => !p.me && p.team !== null && p.team === extras.team && num(p.stats.passesCompleted))
    .map((p) => p.stats.passesCompleted as number)
    .sort((a, b) => b - a);
  return {
    score: (60 + Math.min(12, (share - 0.28) * 60)) * freshness(latest.match.startLocal, input.nowLocal),
    tile: { kind: "teamShare", match: bit(latest.match), mine, teamTotal: total, teammates },
  };
}

function style(input: HomeTileInput): ScoredTile | null {
  const rows = input.history.slice(0, 5);
  if (rows.length < 3) return null;
  const sum = (key: keyof TileStats) => rows.reduce((a, row) => a + (num(row.stats[key] as number | null) ? (row.stats[key] as number) : 0), 0);
  const touchesTotal = sum("touches");
  const passes = sum("passesTried");
  const dribblesTotal = sum("dribbles");
  const shotsTotal = sum("shots");
  if (touchesTotal < 60) return null;
  const other = Math.max(0, touchesTotal - passes - dribblesTotal - shotsTotal);
  const lean = passes >= 2 * dribblesTotal && passes >= touchesTotal * 0.4
    ? "passer"
    : dribblesTotal >= passes * 0.6 ? "dribbler" : shotsTotal >= touchesTotal * 0.08 ? "shooter" : "allRounder";
  return {
    score: 38 * freshness(rows[0].match.startLocal, input.nowLocal),
    tile: { kind: "style", matches: rows.length, touches: touchesTotal, passes, dribbles: dribblesTotal, shots: shotsTotal, other, lean },
  };
}

function matchesPlayed(input: HomeTileInput): ScoredTile | null {
  const today = input.nowLocal.slice(0, 10);
  const firstMonday = mondayOf(today);
  const weekStarts = [-14, -7, 0].map((offset) => {
    const d = new Date(`${firstMonday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  });
  const dates = input.history.map((row) => row.match.startLocal.slice(0, 10)).filter((d) => d >= weekStarts[0] && d <= today).sort();
  if (dates.length < 3) return null;
  const upcomingDate = input.upcoming && input.upcoming.startLocal.slice(0, 10) <= addDays(weekStarts[2], 6) ? input.upcoming.startLocal.slice(0, 10) : null;
  return {
    score: 40 + Math.min(10, dates.length * 2) + (upcomingDate === today ? 4 : 0),
    tile: { kind: "matchesPlayed", dates, weekStarts, total: dates.length, upcomingDate },
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function week(input: HomeTileInput): ScoredTile | null {
  const monday = mondayOf(input.nowLocal.slice(0, 10));
  const rows = input.history.filter((row) => row.match.startLocal.slice(0, 10) >= monday);
  if (rows.length < 2) return null;
  const sum = (key: keyof TileStats) => rows.reduce((a, row) => a + (num(row.stats[key] as number | null) ? (row.stats[key] as number) : 0), 0);
  return {
    score: 46,
    tile: {
      kind: "week",
      matches: rows.length,
      distanceKm: round1(sum("distanceKm")),
      touches: sum("touches"),
      passesCompleted: sum("passesCompleted"),
      passesTried: sum("passesTried"),
      dribblesWon: sum("dribblesWon"),
      dribbles: sum("dribbles"),
      shots: sum("shots"),
    },
  };
}

function rival(input: HomeTileInput): ScoredTile | null {
  const month = input.fieldMonth;
  if (!month || month.rows.length < 3) return null;
  const board = [...month.rows].sort((a, b) => b.distanceKm - a.distanceKm);
  const myIndex = board.findIndex((row) => row.me);
  if (myIndex < 0) return null;
  const mine = board[myIndex].distanceKm;
  const myMatches = input.history.filter((row) => row.match.startLocal.slice(0, 7) === month.month && num(row.stats.distanceKm));
  const perMatch = myMatches.length ? mine / myMatches.length : mine;
  const other = myIndex === 0 ? board[1] : board[myIndex - 1];
  const gap = Math.abs(other.distanceKm - mine);
  // Only a rival you can catch (or who can catch you) in one match.
  if (gap > perMatch) return null;
  const shown = board.slice(0, 3);
  if (myIndex >= 3) shown.push(board[myIndex]);
  return {
    score: myIndex === 0 ? 70 : 68 - Math.min(8, myIndex * 2),
    tile: {
      kind: "rival",
      fieldName: month.fieldName,
      month: month.month,
      board: shown.map((row) => ({ rank: board.indexOf(row) + 1, name: row.name, distanceKm: round1(row.distanceKm), me: row.me })),
      total: board.length,
      myRank: myIndex + 1,
      other: { name: other.name, distanceKm: round1(other.distanceKm) },
      mine: round1(mine),
      perMatch: round1(perMatch),
      upcoming: input.upcoming ? { code: input.upcoming.code, startLocal: input.upcoming.startLocal } : null,
    },
  };
}

function challenge(input: HomeTileInput): ScoredTile | null {
  const upcoming = input.upcoming;
  if (!upcoming || input.history.length < 3) return null;
  const today = input.nowLocal.slice(0, 10);
  const day = upcoming.startLocal.slice(0, 10);
  if (day !== today && daysBetween(today, day) !== 1) return null;
  for (const metric of ["passesCompleted", "dribblesWon", "touches", "distanceKm"] as const) {
    const values = input.history.slice(0, 8).map((row) => row.stats[metric]).filter(num);
    if (values.length < 3) continue;
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    const best = Math.max(...values);
    if (metric !== "distanceKm" && best < 4) continue;
    const target = metric === "distanceKm" ? round1(best + 0.1) : best + 1;
    // A target more than half again over the average is a wish, not a challenge.
    if (target > average * 1.5) continue;
    const hoursAway = (Date.parse(`${upcoming.startLocal.replace(" ", "T")}:00Z`) - Date.parse(`${input.nowLocal.replace(" ", "T")}:00Z`)) / 3_600_000;
    return {
      score: day === today && hoursAway <= 8 ? 76 : 60,
      tile: {
        kind: "challenge",
        upcoming,
        metric,
        target,
        average: metric === "distanceKm" ? Math.round(average * 100) / 100 : round1(average),
        best: metric === "distanceKm" ? round1(best) : best,
        scaleMax: metric === "distanceKm" ? Math.ceil(target * 1.3) : Math.ceil(target * 1.35),
      },
    };
  }
  return null;
}

/** What the player stands to see, and who already has theirs. */
function claim(input: HomeTileInput): ScoredTile | null {
  // Any recent match still waiting, newest first, even one older than a match
  // already claimed: two games the same night are two sets of numbers.
  const next = input.unclaimed.find((row) => daysBetween(row.match.startLocal, input.nowLocal) <= 14);
  if (!next) return null;
  const age = daysBetween(next.match.startLocal, input.nowLocal);
  if (age > 14) return null;
  // Getting the player their own numbers beats anything already in them.
  const score = age <= 7 ? 100 : 70;
  const peers = (next.peers ?? []).filter((p) => !p.me);
  if (next.claimed === 0) {
    return { score, tile: { kind: "unclaimed", match: bit(next.match), findRecordingId: next.findRecordingId } };
  }
  if (peers.length >= 2) {
    const ordered = peers
      .slice()
      .sort((a, b) => (b.stats.distanceKm ?? 0) - (a.stats.distanceKm ?? 0))
      .slice(0, 3);
    return {
      score,
      tile: {
        kind: "friends",
        match: bit(next.match),
        findRecordingId: next.findRecordingId,
        found: next.claimed,
        peers: ordered.map((p) => ({
          name: p.name,
          distanceKm: num(p.stats.distanceKm) ? round1(p.stats.distanceKm) : null,
          topSpeedKmh: num(p.stats.topSpeedKmh) ? round1(p.stats.topSpeedKmh) : null,
          shots: num(p.stats.shots) ? p.stats.shots : null,
          dribblesWon: num(p.stats.dribblesWon) ? p.stats.dribblesWon : null,
        })),
      },
    };
  }
  return { score, tile: { kind: "notFound", match: bit(next.match), findRecordingId: next.findRecordingId, found: next.claimed, teaser: teaser(peers) } };
}

/** The number most likely to make someone wonder if it was them. */
export function teaser(peers: TilePeer[]): { metric: TileMetric; value: number } | null {
  const typical: Array<[TileMetric, number]> = [["topSpeedKmh", 22], ["distanceKm", 3], ["dribblesWon", 4], ["shots", 2]];
  let best: { metric: TileMetric; value: number; ratio: number } | null = null;
  for (const peer of peers) {
    for (const [metric, normal] of typical) {
      const value = peer.stats[metric];
      if (!num(value) || value <= 0) continue;
      const ratio = value / normal;
      if (!best || ratio > best.ratio) best = { metric, value: metric === "distanceKm" ? Math.round(value * 100) / 100 : metric === "topSpeedKmh" ? round1(value) : value, ratio };
    }
  }
  return best ? { metric: best.metric, value: best.value } : null;
}

const BUILDERS = [
  claim, personalBest, lastMatchFirst, distanceTotal, challenge, form, passing, rival, teamShare,
  distanceSpells, passingTrend, dribbleDuel, dribbles, ranks, week, shots, touches, matchesPlayed, style,
];

/** Every tile that fits, best first. */
export function scoreTiles(input: HomeTileInput): ScoredTile[] {
  const out: ScoredTile[] = [];
  for (const build of BUILDERS) {
    try {
      const tile = build(input);
      if (tile) out.push({ tile: tile.tile, score: Math.round(tile.score * 10) / 10 });
    } catch {
      // One odd row must never cost the player their tile.
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The most impressive tile for this player right now, or null when nothing fits. */
export function pickStatTile(input: HomeTileInput): StatTile | null {
  return scoreTiles(input)[0]?.tile ?? null;
}

const CLAIM_KINDS = new Set<StatTile["kind"]>(["unclaimed", "friends", "notFound"]);

/**
 * What a tile is about, so the carousel never shows the same number twice:
 * "17 passes, a personal best" and "17 of 21 passes completed" from the same
 * match are one story. Tiles that don't name a match and a number are their
 * own topic.
 */
export function tileTopic(tile: StatTile): string {
  if (CLAIM_KINDS.has(tile.kind)) return "claim";
  const code = "match" in tile ? tile.match.code : "";
  switch (tile.kind) {
    case "personalBest":
    case "lastMatch":
      return `${code}:${tile.metric}`;
    case "passing":
      return `${code}:passesCompleted`;
    case "touches":
      return `${code}:touches`;
    case "dribbles":
    case "dribbleDuel":
      return `${code}:dribblesWon`;
    case "shots":
      return `${code}:shots`;
    case "distanceSpells":
      return `${code}:distanceKm`;
    default:
      return tile.kind;
  }
}

/** The carousel: up to `limit` tiles, best first, one per topic. */
export function pickStatTiles(input: HomeTileInput, limit = 5): StatTile[] {
  const seen = new Set<string>();
  const out: StatTile[] = [];
  for (const { tile, score } of scoreTiles(input)) {
    if (out.length >= limit) break;
    if (score <= 0) continue;
    const topic = tileTopic(tile);
    if (seen.has(topic)) continue;
    seen.add(topic);
    out.push(tile);
  }
  return out;
}
