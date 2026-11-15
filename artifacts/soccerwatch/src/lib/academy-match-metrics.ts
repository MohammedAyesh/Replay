import { rateMatch, type RatablePlayer } from "@/lib/replay-rating";
import type { AcademyPlayerStats } from "@/lib/academy-matches-api";

/** The numbers shown for academy players, with how each is read and combined across matches. */
export type MetricKey = "rating" | "minutes" | "distance" | "topSpeed" | "touches" | "passes" | "accuracy" | "dribbles" | "shots" | "goals";

export type Metric = {
  key: MetricKey;
  value: (s: AcademyPlayerStats, rating?: number | null) => number | null;
  /** across matches: an average, the best, or a total */
  combine: "avg" | "max" | "sum";
  decimals: number;
  unit?: "km" | "kmh" | "%";
};

export const METRICS: Metric[] = [
  { key: "rating", value: (_s, r) => r ?? null, combine: "avg", decimals: 1 },
  { key: "minutes", value: (s) => s.minutes, combine: "sum", decimals: 0 },
  { key: "distance", value: (s) => s.distanceKm, combine: "avg", decimals: 2, unit: "km" },
  { key: "topSpeed", value: (s) => s.topSpeedKmh, combine: "max", decimals: 1, unit: "kmh" },
  { key: "touches", value: (s) => s.touches, combine: "avg", decimals: 0 },
  { key: "passes", value: (s) => s.passesCompleted ?? s.passesTried, combine: "avg", decimals: 0 },
  { key: "accuracy", value: (s) => (s.passesTried && s.passesCompleted !== null && s.passesTried >= 3 ? Math.round((100 * s.passesCompleted) / s.passesTried) : null), combine: "avg", decimals: 0, unit: "%" },
  { key: "dribbles", value: (s) => s.dribblesWon, combine: "sum", decimals: 0 },
  { key: "shots", value: (s) => s.shots, combine: "sum", decimals: 0 },
  { key: "goals", value: (s) => s.goals, combine: "sum", decimals: 0 },
];

export function combine(values: Array<number | null>, how: Metric["combine"]): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return null;
  if (how === "max") return Math.max(...v);
  const total = v.reduce((a, b) => a + b, 0);
  return how === "sum" ? total : total / v.length;
}

export function formatMetric(value: number | null, metric: Metric, locale: "ar" | "en", units: { km: string; kmh: string }): string {
  if (value === null) return "–";
  const n = new Intl.NumberFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { maximumFractionDigits: metric.decimals, minimumFractionDigits: metric.key === "rating" ? 1 : 0 }).format(value);
  if (metric.unit === "km") return `${n} ${units.km}`;
  if (metric.unit === "kmh") return `${n} ${units.kmh}`;
  if (metric.unit === "%") return `${n}%`;
  return n;
}

/** The Replay rating (same as match rooms), for one match's players. */
export function ratingsFor(players: Array<{ playerId: number; name: string; stats: AcademyPlayerStats }>): Map<number, number> {
  const ratable: RatablePlayer[] = players.map(({ playerId, name, stats }) => ({
    playerId,
    name,
    team: "A",
    claimed: true,
    minutes: stats.minutes,
    distanceKm: stats.distanceKm,
    topSpeedKmh: stats.topSpeedKmh,
    touches: stats.touches,
    passesTried: stats.passesTried,
    passesCompleted: stats.passesCompleted,
    dribblesWon: stats.dribblesWon,
    goals: stats.goals,
    shots: stats.shots,
  }));
  const out = new Map<number, number>();
  for (const [id, r] of rateMatch(ratable)) out.set(id, r.rating);
  return out;
}

export type TrainingTimelineBucket = {
  seconds: number;
  groups: Record<string, number>;
  adults: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number {
  const raw = record(value);
  const scalar = value && typeof value === "object" ? raw.count ?? raw.visible ?? raw.players ?? raw.n : value;
  const numeric = typeof scalar === "number" ? scalar : Number(scalar);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function clockSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.length === 2
    ? Math.max(0, parts[0] * 60 + parts[1])
    : Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
}

function timelineRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.slice(0, 5000);
  const raw = record(value);
  return Object.entries(raw).slice(0, 5000).flatMap(([key, row]) => {
    const seconds = clockSeconds(key);
    return seconds === null ? [] : [{ ...record(row), seconds }];
  });
}

function groupCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = Array.isArray(value)
    ? value.map((item) => {
        const row = record(item);
        return [row.id ?? row.group ?? row.name, row.count ?? row.visible ?? row.players ?? row.n];
      })
    : Object.entries(record(value));
  for (const [key, raw] of rows) {
    if (typeof key !== "string" && typeof key !== "number") continue;
    const groupId = String(key);
    const row = record(raw);
    const value = raw && typeof raw === "object"
      ? row.count ?? row.visible ?? row.players ?? row.n
      : raw;
    if (groupId && groupId !== "adults" && groupId !== "adult") out[groupId] = count(value);
  }
  return out;
}

/** Reduce pipeline timeline samples to five-minute average headcounts. */
export function trainingTimelineBuckets(input: unknown): TrainingTimelineBucket[] {
  const bins = new Map<number, { groups: Map<string, number>; adults: number[]; samples: number }>();
  for (const value of timelineRows(input)) {
    const row: Record<string, unknown> = Array.isArray(value)
      ? { t: value[0], groups: value[1], adults: value[2] }
      : record(value);
    const minuteValue = row.minute ?? row.minutes ?? row.atMinute;
    const secondsValue = row.seconds ?? row.second ?? row.startSeconds ?? row.timeSeconds ?? row.secondsFromStart;
    const timeValue = row.t ?? row.start ?? row.time ?? row.at;
    const timeSeconds = typeof minuteValue === "number" && Number.isFinite(minuteValue)
      ? Math.max(0, minuteValue * 60)
      : clockSeconds(secondsValue ?? timeValue ?? row.seconds);
    if (timeSeconds === null) continue;
    const bucketSeconds = Math.floor(timeSeconds / 300) * 300;
    const bucket = bins.get(bucketSeconds) ?? { groups: new Map<string, number>(), adults: [], samples: 0 };
    const groups = groupCounts(row.groups ?? row.kids ?? row.children ?? row.byGroup ?? row.by_group);
    for (const [group, amount] of Object.entries(groups)) {
      bucket.groups.set(group, (bucket.groups.get(group) ?? 0) + amount);
    }
    bucket.adults.push(count(row.adults ?? row.adult ?? row.coaches));
    bucket.samples += 1;
    bins.set(bucketSeconds, bucket);
  }
  return [...bins.entries()].sort(([a], [b]) => a - b).map(([seconds, bucket]) => ({
    seconds,
    groups: Object.fromEntries([...bucket.groups.entries()].map(([id, total]) => [id, Math.round(total / bucket.samples)])),
    adults: Math.round(bucket.adults.reduce((sum, amount) => sum + amount, 0) / bucket.samples),
  }));
}

export const COMPARE_COLOURS = ["#D4FF4F", "#2FD8C4", "#7B5CFF"];
