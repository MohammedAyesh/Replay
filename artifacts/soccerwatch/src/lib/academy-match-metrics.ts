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

export const COMPARE_COLOURS = ["#D4FF4F", "#2FD8C4", "#7B5CFF"];
