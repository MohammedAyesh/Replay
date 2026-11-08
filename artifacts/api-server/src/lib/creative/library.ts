/**
 * Creative hub → Library: the pure parts (no database, no storage).
 *
 *   - which stretch of a recording a match moment plays, as the scene format's
 *     recording window {recordingId, fromMs, toMs} (video milliseconds), and
 *     the frame its thumbnail is taken from;
 *   - how a player is shown: shirt number always, first name only when the
 *     academy allows names (most of these players are children);
 *   - the list filters and paging every Library list shares.
 *
 * Tracking seconds (the analysis clock: goals, shots, dribbles) become video
 * seconds by adding manifest.videoStartSeconds, as everywhere else
 * (goalReel.reelWindow, userClips' moment clips).
 */
import type { MediaSource } from "@workspace/api-zod";

export const LIBRARY_MOMENT_TYPES = ["goal", "chance", "highlight", "saved"] as const;
export type LibraryMomentType = (typeof LIBRARY_MOMENT_TYPES)[number];

/** How much each kind of moment plays around its instant, seconds. */
export const MOMENT_WINDOW = {
  /** the build-up, the strike, and the ball in the net */
  goal: { before: 8, after: 4 },
  /** the shot and whether it went in, wide or was saved */
  chance: { before: 6, after: 3 },
  /** a dribble: from just before the run to just after it */
  highlight: { before: 2, after: 2, maxSeconds: 15 },
  /** a member's saved clip plays exactly as saved, at most this long */
  saved: { maxSeconds: 60 },
} as const;

export type RecordingWindow = { recordingId: number; fromMs: number; toMs: number };

const ms = (s: number) => Math.max(0, Math.round(s * 1000));

/**
 * The window of an analysis moment, in video ms. `t0`..`t1` is the moment on
 * the tracking clock (a goal or shot is an instant: t1 = t0). `durationSec` is
 * the recording's length when known; the window never runs past it.
 */
export function analysisMomentWindow(
  type: "goal" | "chance" | "highlight",
  recordingId: number,
  t0: number,
  t1: number,
  videoStartSeconds: number,
  durationSec: number | null,
): RecordingWindow & { atMs: number } {
  const shape = MOMENT_WINDOW[type];
  const start = Math.min(t0, t1);
  let end = Math.max(t0, t1);
  if (type === "highlight") end = Math.min(end, start + MOMENT_WINDOW.highlight.maxSeconds - shape.before - shape.after);
  const v0 = Math.max(0, start - shape.before) + videoStartSeconds;
  let v1 = end + shape.after + videoStartSeconds;
  if (durationSec && durationSec > 0) v1 = Math.min(v1, durationSec);
  const fromMs = ms(v0);
  const toMs = Math.max(fromMs + 500, ms(v1));
  // The still: a goal or chance at its instant, a dribble half-way through.
  const at = type === "highlight" ? (start + end) / 2 : start;
  const atMs = Math.min(toMs, Math.max(fromMs, ms(at + videoStartSeconds)));
  return { recordingId, fromMs, toMs, atMs };
}

/** A saved clip's own stretch of the recording (video seconds), as a window. */
export function savedClipWindow(
  recordingId: number,
  startSeconds: number,
  endSeconds: number,
  thumbSeconds: number | null,
): (RecordingWindow & { atMs: number }) | null {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return null;
  const end = Math.min(endSeconds, startSeconds + MOMENT_WINDOW.saved.maxSeconds);
  const fromMs = ms(startSeconds);
  const toMs = ms(end);
  const thumb = thumbSeconds !== null && Number.isFinite(thumbSeconds) && thumbSeconds >= startSeconds && thumbSeconds <= end
    ? thumbSeconds : (startSeconds + end) / 2;
  return { recordingId, fromMs, toMs, atMs: ms(thumb) };
}

/** The match minute (1-based) of a tracking time, counted from kick-off. */
export function matchMinute(trackingSeconds: number, kickOffSeconds: number): number {
  return Math.max(1, Math.floor((trackingSeconds - kickOffSeconds) / 60) + 1);
}

export const windowSource = (w: RecordingWindow): Extract<MediaSource, { type: "recording" }> =>
  ({ type: "recording", recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs });

export const frameSource = (recordingId: number, atMs: number): Extract<MediaSource, { type: "frame" }> =>
  ({ type: "frame", recordingId, atMs: Math.max(0, Math.round(atMs)) });

/** Private Creative Hub thumbnail endpoint; it resolves saved-file/Stream media without requiring 4K. */
export function creativeClipStillUrl(academyId: number, clipId: number): string {
  const src = encodeURIComponent(JSON.stringify({ type: "clip", clipId }));
  return `/api/academy/console/academies/${academyId}/creative/media?src=${src}&want=still`;
}

// ── Players ─────────────────────────────────────────────────────────────────

export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first.slice(0, 30) : null;
}

export type LibraryPlayer = { number: number | null; firstName: string | null; squad: string | null };

/**
 * A player as the Library shows him. The full name never leaves the server;
 * the first name only when the academy's own profile allows names.
 */
export function libraryPlayer(
  p: { name: string | null; number: number | null; squad?: string | null },
  showNames: boolean,
): LibraryPlayer {
  return {
    number: p.number ?? null,
    firstName: showNames ? firstNameOf(p.name) : null,
    squad: p.squad ?? null,
  };
}

// ── Recordings ──────────────────────────────────────────────────────────────

/** "60:00", "1:59:57", "3600", "60" or "60 min" → seconds; null when unreadable. Bare small numbers are minutes. */
export function recordingSeconds(text: string | null | undefined): number | null {
  const raw = String(text ?? "").trim().toLowerCase().replace(/\s*(min|mins|minutes)$/, "");
  if (!raw) return null;
  if (raw.includes(":")) {
    const parts = raw.split(":").map(Number);
    if (parts.some((v) => !Number.isFinite(v) || v < 0)) return null;
    return parts.reduce((acc, v) => acc * 60 + v, 0) || null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 300 ? n * 60 : n;
}

const BUNNY_VIDEO_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;

/** The Bunny Stream video id in a recording's video URL (or the URL is one), else null. */
export function bunnyVideoIdOf(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (BUNNY_VIDEO_ID.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const nested = url.searchParams.get("url");
    if (nested && nested !== raw) {
      const inner = bunnyVideoIdOf(nested);
      if (inner) return inner;
    }
    return url.pathname.split("/").find((part) => BUNNY_VIDEO_ID.test(part)) ?? null;
  } catch {
    return null;
  }
}

// ── Amman dates ─────────────────────────────────────────────────────────────

const ammanParts = (date: Date) => {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date)) out[p.type] = p.value;
  return out;
};

/** "2026-10-31" in Amman. */
export function ammanDate(date: Date): string {
  const p = ammanParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "17:00" in Amman. */
export function ammanClock(date: Date): string {
  const p = ammanParts(date);
  return `${p.hour}:${p.minute}`;
}

/**
 * The instant an Amman calendar day starts. Jordan has kept UTC+3 all year
 * since 2022; the offset is read from Intl anyway so a rule change is picked up.
 */
export function ammanDayStart(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const guess = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(guess.getTime())) return null;
  const p = ammanParts(guess);
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  const offset = local - guess.getTime();
  return new Date(guess.getTime() - offset);
}

// ── Filters and paging ──────────────────────────────────────────────────────

export type LibraryFilters = {
  squadId: number | null;
  playerNumber: number | null;
  types: LibraryMomentType[];
  /** inclusive, Amman days */
  from: Date | null;
  /** exclusive: the start of the day after `to` */
  until: Date | null;
  kind: "image" | "video" | null;
  sessionType: "match" | "training" | null;
  offset: number;
  limit: number;
};

const one = (v: unknown): string | undefined => (Array.isArray(v) ? (v[0] as string | undefined) : typeof v === "string" ? v : undefined);
const posInt = (v: unknown): number | null => {
  const s = one(v);
  if (s === undefined || s === "") return null;
  const n = Number(s.replace(/^#/, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export function parseLibraryFilters(query: Record<string, unknown>, defaults: { limit?: number; maxLimit?: number } = {}): LibraryFilters {
  const maxLimit = defaults.maxLimit ?? 60;
  const limit = Math.min(maxLimit, Math.max(1, posInt(query.limit) ?? defaults.limit ?? 24));
  const types = String(one(query.type) ?? "").split(",").map((s) => s.trim())
    .filter((s): s is LibraryMomentType => (LIBRARY_MOMENT_TYPES as readonly string[]).includes(s));
  const from = ammanDayStart(one(query.from) ?? "");
  const toDay = ammanDayStart(one(query.to) ?? "");
  const number = posInt(query.player ?? query.playerNumber);
  const kind = one(query.kind);
  const sessionType = one(query.sessionType);
  return {
    squadId: posInt(query.squadId) || null,
    playerNumber: number !== null && number <= 99 ? number : null,
    types,
    from,
    until: toDay ? new Date(toDay.getTime() + 86_400_000) : null,
    kind: kind === "image" || kind === "video" ? kind : null,
    sessionType: sessionType === "match" || sessionType === "training" ? sessionType : null,
    offset: Math.min(100_000, posInt(query.offset) ?? 0),
    limit,
  };
}

/** One page of a list already in memory. */
export function pageOf<T>(items: T[], f: Pick<LibraryFilters, "offset" | "limit">): { items: T[]; total: number; nextOffset: number | null } {
  const slice = items.slice(f.offset, f.offset + f.limit);
  const next = f.offset + slice.length;
  return { items: slice, total: items.length, nextOffset: next < items.length ? next : null };
}
