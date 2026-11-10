import type { Framing, MediaSource, PlayerReelInput, ReelClip, ReelFormat, ReelStat, SceneMusic } from "@workspace/api-zod";
import { REEL_CLIP_MAX_MS, REEL_CLIP_MIN_MS } from "@workspace/api-zod";
import { METRICS, combine, ratingsFor, type MetricKey } from "@/lib/academy-match-metrics";
import type { PlayerStatsRow } from "@/lib/academy-matches-api";

/** Creative hub → Player reel: the numbers, captions and choices that become a reel scene (playerReel.ts). */

export type StatScope = "season" | number;

/** The player's numbers over a scope: every analysed match ("season"), or one (a session id). Ratings are per match, against that match's squad. */
export function reelStatValues(rows: ReadonlyArray<PlayerStatsRow>, playerId: number, scope: StatScope): { values: Record<MetricKey, number | null>; matches: number } {
  const bySession = new Map<number, PlayerStatsRow[]>();
  for (const r of rows) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  const mine = rows.filter((r) => r.playerId === playerId && (scope === "season" || r.sessionId === scope));
  const perMatch = mine.map((r) => {
    const everyone = bySession.get(r.sessionId) ?? [r];
    const rating = ratingsFor(everyone.map((x) => ({ playerId: x.playerId, name: x.playerName, stats: x.stats }))).get(playerId) ?? null;
    return Object.fromEntries(METRICS.map((m) => [m.key, m.value(r.stats, rating)])) as Record<MetricKey, number | null>;
  });
  const values = Object.fromEntries(METRICS.map((m) => [m.key, combine(perMatch.map((v) => v[m.key]), m.combine)])) as Record<MetricKey, number | null>;
  return { values, matches: mine.length };
}

export type ReelStatCopy = Record<MetricKey, string> & { km: string; kmh: string };

/** One stat as the reel shows it: "7.4" over "Rating", "21.3 km/h" over "Top speed". */
export function reelStat(key: MetricKey, value: number | null, copy: ReelStatCopy, locale: "ar" | "en"): ReelStat | null {
  if (value === null || !Number.isFinite(value)) return null;
  const m = METRICS.find((x) => x.key === key)!;
  const decimals = key === "rating" ? 1 : m.decimals;
  const n = new Intl.NumberFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { maximumFractionDigits: decimals, minimumFractionDigits: key === "rating" ? 1 : 0 }).format(value);
  const unit = m.unit === "km" ? ` ${copy.km}` : m.unit === "kmh" ? ` ${copy.kmh}` : m.unit === "%" ? "%" : "";
  return { label: copy[key], value: `${n}${unit}` };
}

/** The stats a reel starts with: the first `max` of `prefer` that have a value. */
export function defaultStats(values: Record<MetricKey, number | null>, prefer: MetricKey[], max: number): MetricKey[] {
  return prefer.filter((k) => values[k] !== null && values[k] !== undefined).slice(0, max);
}

export const INTRO_PREFER: MetricKey[] = ["goals", "rating", "topSpeed", "dribbles", "distance", "passes"];
export const OUTRO_PREFER: MetricKey[] = ["rating", "minutes", "goals", "shots", "dribbles", "passes", "accuracy", "touches", "distance", "topSpeed"];

/** "Age 12 · Winger · U13" (any part may be missing). */
export function metaLine(parts: { age: number | null; position: string | null; squad: string | null }, show: { age: boolean; position: boolean; squad: boolean }, ageWord: (n: number) => string): string {
  return [show.age && parts.age !== null ? ageWord(parts.age) : null, show.position ? parts.position?.trim() || null : null, show.squad ? parts.squad?.trim() || null : null]
    .filter(Boolean).join(" · ");
}

export type ReelPick = {
  /** a stable key ("m:<moment id>", "c:<clip id>") */
  key: string;
  src: MediaSource;
  durationMs: number;
  label: string;
};

/** A picked item with the camera the server gave it: a clip on a recording plays from its window (so it can be framed). */
export function reelClipOf(pick: ReelPick, answer: { framing: Framing; source: string; window?: { recordingId: number; fromMs: number; toMs: number } | null } | null): ReelClip {
  const src: MediaSource = pick.src.type === "clip" && answer?.window
    ? { type: "recording", recordingId: answer.window.recordingId, fromMs: answer.window.fromMs, toMs: answer.window.toMs }
    : pick.src;
  const framed = src.type === "recording" && answer && answer.source !== "centre";
  const length = src.type === "recording" ? src.toMs - src.fromMs : pick.durationMs;
  return {
    src,
    durationMs: Math.max(REEL_CLIP_MIN_MS, Math.min(REEL_CLIP_MAX_MS, length || pick.durationMs || 8_000)),
    trimInMs: 0,
    framing: framed ? answer!.framing : null,
    label: pick.label,
  };
}

export type ReelChoices = {
  format: ReelFormat;
  locale: "en" | "ar";
  name: string | null;
  number: number | null;
  meta: string;
  photos: MediaSource[];
  introStats: ReelStat[];
  outroTitle: string;
  outroStats: ReelStat[];
  footageSound: boolean;
  music: SceneMusic | null;
};

export function reelInput(choices: ReelChoices, clips: ReelClip[]): PlayerReelInput {
  return {
    format: choices.format,
    locale: choices.locale,
    player: { name: choices.name, number: choices.number, meta: choices.meta },
    photos: choices.photos,
    introStats: choices.introStats,
    clips,
    outroTitle: choices.outroTitle,
    outroStats: choices.outroStats,
    crest: true,
    footageSound: choices.footageSound,
    music: choices.music,
  };
}
