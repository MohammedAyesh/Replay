/**
 * Where the match is on a recording.
 *
 * A recording is an hour (or two) of footage, and the booking it is joined to
 * says when the pitch was paid for -- not when this group was playing. On
 * recording 392 the previous booking's game ran over until 10:58, the pitch
 * was empty, and this group warmed up and kicked off at 24:20. Every number a
 * player saw counted the other group's game as theirs.
 *
 * The window is stored in the manifest, at manifest.provenance.matchWindow,
 * on the tracking clock (the same seconds as segments, events and claim
 * parts). It lives in provenance rather than a column so it needs no
 * migration, and because provenance is deliberately outside
 * trackingBundleFingerprint: setting a window must never invalidate a claim.
 *
 * Two writers: an admin (PATCH /admin/recordings/:id/match-window) and the
 * pipeline's detector (carried through bundle upload). On a bundle
 * replacement the new bundle's own window wins; an admin window is carried
 * over only when the new bundle has none (storeUploadBundle).
 *
 * Pure. Every reader of the window goes through here so "outside the window"
 * means the same thing to stats, the claim picker, coverage and clips.
 */
import type { TrackingManifest } from "@workspace/db";

export type MatchWindowSource = "admin" | "detector";

/** What is stored. `endSeconds` null or absent means "to the end of the recording". */
export type StoredMatchWindow = {
  startSeconds: number;
  endSeconds?: number | null;
  source: MatchWindowSource;
  setBy?: number;
  setAt?: string;
  why?: string;
};

/** A stored window resolved against the recording: both ends are real seconds. */
export type ResolvedMatchWindow = {
  startSeconds: number;
  endSeconds: number;
  source: MatchWindowSource;
  setBy?: number;
  setAt?: string;
  why?: string;
};

type WindowManifest = Pick<TrackingManifest, "duration"> & { provenance?: Record<string, unknown> | null };

const WHY_MAX_CHARS = 500;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse a window from untrusted JSON (an upload, or a stored manifest written
 * by an older build). Shape only; it is checked against a duration separately
 * because an upload's provenance is parsed before its duration is final.
 */
export function parseStoredMatchWindow(value: unknown, defaultSource: MatchWindowSource = "detector"): StoredMatchWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const start = raw.startSeconds;
  if (!finite(start) || start < 0) return null;
  const end = raw.endSeconds;
  if (end !== undefined && end !== null && (!finite(end) || end <= start)) return null;
  const source: MatchWindowSource = raw.source === "admin" || raw.source === "detector" ? raw.source : defaultSource;
  const out: StoredMatchWindow = { startSeconds: start, endSeconds: finite(end) ? end : null, source };
  if (Number.isSafeInteger(raw.setBy)) out.setBy = raw.setBy as number;
  if (typeof raw.setAt === "string" && raw.setAt.length <= 64) out.setAt = raw.setAt;
  if (typeof raw.why === "string" && raw.why.trim()) out.why = raw.why.trim().slice(0, WHY_MAX_CHARS);
  return out;
}

/**
 * A stored window that still makes sense on a recording of `duration`
 * seconds: the start inside it, the end clamped to it. Null when the window
 * cannot apply (it starts at or after the end of the footage).
 */
export function fitMatchWindow(window: StoredMatchWindow | null, duration: number): StoredMatchWindow | null {
  if (!window || !finite(duration) || duration <= 0) return null;
  if (window.startSeconds >= duration) return null;
  const end = window.endSeconds == null ? null : Math.min(window.endSeconds, duration);
  if (end !== null && end <= window.startSeconds) return null;
  return { ...window, endSeconds: end };
}

/** The recording's match window, or null when none is set (the whole recording is the match). */
export function readMatchWindow(manifest: WindowManifest | null | undefined): ResolvedMatchWindow | null {
  if (!manifest) return null;
  const stored = fitMatchWindow(parseStoredMatchWindow(manifest.provenance?.matchWindow), manifest.duration);
  if (!stored) return null;
  const end = stored.endSeconds ?? manifest.duration;
  // A window covering the whole recording is no window: return null so every
  // caller's "no window" path (and every cached number) is unchanged.
  if (stored.startSeconds <= 0 && end >= manifest.duration) return null;
  const { endSeconds: _end, ...rest } = stored;
  return { ...rest, endSeconds: end };
}

/** Seconds of the recording that are the match: the window's length, or the whole duration. */
export function matchWindowSeconds(manifest: WindowManifest): number {
  const window = readMatchWindow(manifest);
  return window ? window.endSeconds - window.startSeconds : manifest.duration;
}

/**
 * Clip a tracking-clock range to the window. Null when nothing is left.
 * Without a window the range is returned unchanged.
 */
export function clipRangeToMatchWindow(
  fromSeconds: number,
  toSeconds: number,
  manifest: WindowManifest | null | undefined,
): { fromSeconds: number; toSeconds: number } | null {
  const window = readMatchWindow(manifest);
  const from = window ? Math.max(fromSeconds, window.startSeconds) : fromSeconds;
  const to = window ? Math.min(toSeconds, window.endSeconds) : toSeconds;
  return to > from ? { fromSeconds: from, toSeconds: to } : null;
}

/** The stretches outside the window, as off-pitch spans: [0,start] and [end,duration]. */
export function outsideMatchWindowSpans(manifest: WindowManifest): Array<{ fromSeconds: number; toSeconds: number }> {
  const window = readMatchWindow(manifest);
  if (!window) return [];
  const out: Array<{ fromSeconds: number; toSeconds: number }> = [];
  if (window.startSeconds > 0) out.push({ fromSeconds: 0, toSeconds: window.startSeconds });
  if (window.endSeconds < manifest.duration) out.push({ fromSeconds: window.endSeconds, toSeconds: manifest.duration });
  return out;
}

/**
 * A claimant's off-pitch spans with the time outside the window added.
 *
 * Merged, because coverage subtracts the total off-pitch time from the
 * denominator: a bench span declared during the warm-up would otherwise be
 * subtracted twice. Idempotent, so applying it to a list that already has the
 * window in it changes nothing. Without a window the input is returned as is,
 * so recordings without one behave exactly as before.
 */
export function offPitchWithMatchWindow<T extends { fromSeconds: number; toSeconds: number }>(
  offPitch: readonly T[],
  manifest: WindowManifest,
): Array<{ fromSeconds: number; toSeconds: number }> {
  const outside = outsideMatchWindowSpans(manifest);
  if (!outside.length) return offPitch.map((span) => ({ fromSeconds: span.fromSeconds, toSeconds: span.toSeconds }));
  const all = [...offPitch, ...outside]
    .filter((span) => finite(span.fromSeconds) && finite(span.toSeconds))
    .map((span) => ({
      fromSeconds: Math.max(0, Math.min(manifest.duration, span.fromSeconds)),
      toSeconds: Math.max(0, Math.min(manifest.duration, span.toSeconds)),
    }))
    .filter((span) => span.toSeconds > span.fromSeconds)
    .sort((a, b) => a.fromSeconds - b.fromSeconds);
  const merged: Array<{ fromSeconds: number; toSeconds: number }> = [];
  for (const span of all) {
    const last = merged.at(-1);
    if (last && span.fromSeconds <= last.toSeconds) last.toSeconds = Math.max(last.toSeconds, span.toSeconds);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Claimed parts (frame ranges, inclusive) clipped to the window. Without a
 * window the parts are returned as they are.
 */
export function clipPartsToMatchWindow<T extends { fromFrame: number; toFrame: number }>(
  parts: readonly T[],
  manifest: WindowManifest & Pick<TrackingManifest, "frameRate">,
): T[] {
  const window = readMatchWindow(manifest);
  if (!window) return [...parts];
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const a = Math.ceil(window.startSeconds * fps);
  const b = Math.floor(window.endSeconds * fps);
  return parts
    .map((part) => ({ ...part, fromFrame: Math.max(part.fromFrame, a), toFrame: Math.min(part.toFrame, b) }))
    .filter((part) => part.toFrame > part.fromFrame);
}

/** Whether a frame range (inclusive) has any frame inside the window. */
export function framesTouchMatchWindow(
  fromFrame: number,
  toFrame: number,
  manifest: WindowManifest & Pick<TrackingManifest, "frameRate">,
): boolean {
  return clipPartsToMatchWindow([{ fromFrame, toFrame }], manifest).length > 0;
}

/** A stable string for cache keys that must change when the window does. */
export function matchWindowKey(manifest: WindowManifest | null | undefined): string {
  const window = readMatchWindow(manifest);
  return window ? `${window.startSeconds}-${window.endSeconds}` : "-";
}
