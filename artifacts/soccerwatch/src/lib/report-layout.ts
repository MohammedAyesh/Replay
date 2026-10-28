/**
 * The arithmetic behind the compact and sheet match-report layouts.
 *
 * Nothing here draws. It decides which layout a viewer gets, which single
 * number leads the report, where the viewer stands on each stat and which
 * clips go into "a reel of this match". The ranking rules themselves (margins,
 * shared places, the ten-minute minimum, personal bests) are the shared ones in
 * lib/match-report.ts, so the new layouts can never say something the long
 * report would not.
 */

import {
  formLine,
  isPersonalBest,
  metricValue,
  rankedCount,
  standings,
  type Direction,
  type ReportMetric,
  type ReportPlayer,
} from "@/lib/match-report";
import type { PlayerForm } from "@/lib/match-api";
import { clipShape } from "@/lib/end-screen";

export type ReportLayout = "full" | "compact" | "sheet";

const LAYOUTS: readonly ReportLayout[] = ["full", "compact", "sheet"];

/**
 * The admin setting decides; `?view=` on the match link overrides it, so a
 * layout can be compared on any match without changing the setting.
 */
export function resolveReportLayout(setting: unknown, override: string | null | undefined): ReportLayout {
  const wanted = (override ?? "").trim().toLowerCase();
  if ((LAYOUTS as readonly string[]).includes(wanted)) return wanted as ReportLayout;
  return typeof setting === "string" && (LAYOUTS as readonly string[]).includes(setting) ? (setting as ReportLayout) : "full";
}

/* ------------------------------------------------------------------ standing */

export type MyStanding = {
  rank: number;
  shared: boolean;
  /** ranked players on this stat */
  of: number;
  ranked: boolean;
  value: number;
  /** the best ranked value on the pitch, and who holds it */
  top: { value: number; names: string[] } | null;
};

/** Where one player stands on one stat among the claimed players, or null when they aren't measured on it. */
export function myStanding<T extends ReportPlayer>(claimed: T[], metric: ReportMetric, meId: number): MyStanding | null {
  const table = standings(claimed, metric);
  const mine = table.find((entry) => entry.player.playerId === meId);
  if (!mine) return null;
  const leaders = table.filter((entry) => entry.ranked && entry.rank === 1);
  return {
    rank: mine.rank,
    shared: mine.shared,
    of: rankedCount(claimed, metric),
    ranked: mine.ranked,
    value: mine.value,
    top: leaders.length ? { value: leaders[0].value, names: leaders.map((entry) => entry.player.name) } : null,
  };
}

/* ------------------------------------------------------------------ headline */

export type Headline =
  /** both whole-game personal bests in one match */
  | { kind: "twoBests"; topSpeedKmh: number; distanceKm: number; topOfPitch: boolean }
  | { kind: "best"; metric: "topSpeed" | "distance"; value: number; topOfPitch: boolean; sharedTop: boolean }
  | { kind: "top"; metric: ReportMetric; value: number; shared: boolean }
  | { kind: "rank"; metric: ReportMetric; value: number; rank: number; shared: boolean; of: number }
  | { kind: "total"; distanceKm: number };

/** The stats a headline may lead with, in the order a tie between them is broken. */
const HEADLINE_METRICS: ReportMetric[] = ["topSpeed", "distanceRate", "dribblesWon", "passes", "touchRate", "goals"];

function isTop(standing: MyStanding | null): boolean {
  return Boolean(standing && standing.ranked && standing.rank === 1 && standing.of >= 2 && standing.value > 0);
}

/**
 * The single most impressive true thing the report can say about this player.
 * Personal bests beat being top of the pitch, which beats a rank, which beats
 * just the distance. Nothing is claimed that the margins don't support.
 */
export function pickHeadline<T extends ReportPlayer>(me: T, claimed: T[], form: PlayerForm | null | undefined): Headline | null {
  const used = form?.matchesUsed ?? 0;
  const bestSpeed = form ? isPersonalBest("topSpeed", me.topSpeedKmh, form.bests.topSpeedKmh, used) : false;
  const bestDistance = form ? isPersonalBest("distance", me.distanceKm, form.bests.distanceKm, used) : false;
  const speed = myStanding(claimed, "topSpeed", me.playerId);
  const distance = myStanding(claimed, "distanceRate", me.playerId);

  if (bestSpeed && bestDistance && me.topSpeedKmh !== null && me.distanceKm !== null) {
    return { kind: "twoBests", topSpeedKmh: me.topSpeedKmh, distanceKm: me.distanceKm, topOfPitch: isTop(speed) || isTop(distance) };
  }
  if (bestSpeed && me.topSpeedKmh !== null) {
    return { kind: "best", metric: "topSpeed", value: me.topSpeedKmh, topOfPitch: isTop(speed), sharedTop: Boolean(speed?.shared) };
  }
  if (bestDistance && me.distanceKm !== null) {
    return { kind: "best", metric: "distance", value: me.distanceKm, topOfPitch: isTop(distance), sharedTop: Boolean(distance?.shared) };
  }

  // Top of the pitch on something: a clear first beats a shared one.
  const tops = HEADLINE_METRICS
    .map((metric) => ({ metric, standing: myStanding(claimed, metric, me.playerId) }))
    .filter((entry) => isTop(entry.standing));
  const clear = tops.find((entry) => !entry.standing!.shared) ?? tops[0];
  if (clear) return { kind: "top", metric: clear.metric, value: clear.standing!.value, shared: clear.standing!.shared };

  // Otherwise his best rank among the running stats.
  const ranks = (["topSpeed", "distanceRate", "touchRate"] as ReportMetric[])
    .map((metric) => ({ metric, standing: myStanding(claimed, metric, me.playerId) }))
    .filter((entry) => entry.standing?.ranked && entry.standing.of >= 2)
    .sort((a, b) => a.standing!.rank - b.standing!.rank);
  if (ranks[0] && ranks[0].standing!.rank <= 3) {
    const s = ranks[0].standing!;
    return { kind: "rank", metric: ranks[0].metric, value: s.value, rank: s.rank, shared: s.shared, of: s.of };
  }

  return me.distanceKm !== null && me.distanceKm > 0 ? { kind: "total", distanceKm: me.distanceKm } : null;
}

/* ------------------------------------------------------------------ form */

export type FormMarks = { distance: Direction | null; speed: Direction | null; touches: Direction | null; matches: number } | null;

/** Further/faster/more touches against his own recent average, only past the margin. */
export function formMarks(me: ReportPlayer, form: PlayerForm | null | undefined): FormMarks {
  if (!form) return null;
  return formLine(me, form.averages, form.matchesUsed);
}

/* ------------------------------------------------------------------ the board */

export type BoardRow = {
  playerId: number;
  name: string;
  value: number;
  /** 0 = on the board but not ranked (under ten minutes on camera) */
  rank: number;
  shared: boolean;
  isMe: boolean;
};

/**
 * The pitch board for one stat: the top `limit` rows, plus the viewer pinned at
 * the end when he would otherwise be cut off. Unranked players (under ten
 * minutes) are left off; they are counted by the caller.
 */
export function boardRows<T extends ReportPlayer>(claimed: T[], metric: ReportMetric, meId: number | null, limit = 5): { rows: BoardRow[]; pinned: BoardRow | null; topShared: number } {
  const table = standings(claimed, metric).filter((entry) => entry.ranked);
  const all: BoardRow[] = table.map((entry) => ({
    playerId: entry.player.playerId,
    name: entry.player.name,
    value: entry.value,
    rank: entry.rank,
    shared: entry.shared,
    isMe: entry.player.playerId === meId,
  }));
  const rows = all.slice(0, limit);
  const mine = all.find((row) => row.isMe) ?? null;
  const pinned = mine && !rows.some((row) => row.isMe) ? mine : null;
  return { rows, pinned, topShared: all.filter((row) => row.rank === 1).length };
}

/** A bar length for the board, 0..1 against the best value (never empty for a measured player). */
export function barShare(value: number, best: number): number {
  if (!(best > 0)) return 0;
  return Math.max(0.04, Math.min(1, value / best));
}

/* ------------------------------------------------------------------ the reel */

export type ReelClip = { id: number; startTime: number; aspectRatio: string; isHidden: boolean; createdAt: string };

/**
 * The clips to start "a reel of this match" with: the player's own clips from
 * the match, in the shape most of them share (a reel is one shape), in match
 * order, at most `max`.
 */
export function matchReelPicks(clips: ReelClip[], matchClipIds: Set<number>, max: number): number[] {
  const mine = clips.filter((clip) => matchClipIds.has(clip.id) && !clip.isHidden);
  if (!mine.length) return [];
  const counts = new Map<string, number>();
  for (const clip of mine) counts.set(clipShape(clip.aspectRatio), (counts.get(clipShape(clip.aspectRatio)) ?? 0) + 1);
  const shape = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] === "16:9" ? -1 : 1))[0][0];
  return mine
    .filter((clip) => clipShape(clip.aspectRatio) === shape)
    .sort((a, b) => a.startTime - b.startTime || a.createdAt.localeCompare(b.createdAt))
    .slice(0, max)
    .map((clip) => clip.id);
}

export { metricValue };
