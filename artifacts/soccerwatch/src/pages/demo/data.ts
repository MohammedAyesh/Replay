import { useQuery } from "@tanstack/react-query";

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export const withBase = (path: string) => (path.startsWith("/") ? `${basePath}${path}` : path);

export type DemoClip = {
  id: number;
  aspectRatio: "16:9" | "9:16";
  src: string;
  poster: string;
};

export type DemoMatch = {
  recordingId: number;
  date: string;
  timeSlot: string;
  src: string;
  rawSrc: string;
  poster: string;
  analysed: boolean;
};

export type DemoShowcase = {
  counts: { recordings: number; clips: number; analysed: number };
  returnRatePercent?: number | null;
  match: DemoMatch | null;
  clips: DemoClip[];
  socialClips?: DemoClip[];
  salesWhatsapp: string | null;
  /** Set once the callback form has somewhere to go. */
  leadsEnabled?: boolean;
};

export type DemoMoment = { type: "goal" | "shot"; t: number; side: 0 | 1 | null };

export type DemoPlayer = {
  label: string;
  number: string | null;
  side: 0 | 1 | null;
  minutes: number;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesCompleted: number | null;
  heatmap: Array<{ x: number; y: number; weight: number }>;
};

export type DemoReport = {
  recordingId: number;
  date: string;
  timeSlot: string;
  durationSeconds: number;
  hasBall: boolean;
  hasPitch: boolean;
  team: {
    colours: [string, string];
    possessionPercent: [number, number];
    passesCompleted: [number, number];
    passesTried: [number, number];
    shots: [number, number];
    goals: [number, number];
    dribblesWon: [number, number];
  } | null;
  /** Seconds in the video file. */
  moments: DemoMoment[];
  players: DemoPlayer[];
  /** A few busy minutes and the ball's path through them: [video s, x 0-1, y 0-1]. */
  broadcast?: { start: number; end: number; path: Array<[number, number, number]> } | null;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(withBase(path), { credentials: "omit" });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json() as Promise<T>;
}

export function useShowcase() {
  return useQuery({
    queryKey: ["demo-showcase"],
    queryFn: () => getJson<DemoShowcase>("/api/demo/showcase"),
    staleTime: 5 * 60 * 1000,
    retry: 2,
  });
}

/**
 * The report is started as soon as the page knows there is an analysed match,
 * not when its section scrolls into view: the first build reads the whole
 * bundle and can take a while, and the visitor spends that time on the clips.
 */
export function useReport(enabled: boolean) {
  return useQuery({
    queryKey: ["demo-report"],
    queryFn: () => getJson<{ available: boolean; report: DemoReport | null }>("/api/demo/showcase/report"),
    enabled,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatMatchDate(date: string, locale: "ar" | "en"): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

export function formatNumber(value: number, locale: "ar" | "en", digits = 0): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}
