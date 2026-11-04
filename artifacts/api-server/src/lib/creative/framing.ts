/**
 * A camera that follows the ball across the panorama, for clips and match
 * moments in the Creative hub (scene video layers' `framing`).
 *
 * The match analysis gives the ball's place (x, y as shares of the frame) at
 * the frames it was seen. Here that becomes keys every STEP_MS through a
 * window: the nearest sighting within 0.6 s, else the last place seen (or the
 * first, before it), then smoothed both ways so the camera glides instead of
 * twitching with the tracker. Vertical movement is damped towards the
 * pitch's middle band: on a 32:9 panorama a 16:9 window already shows most of
 * the height, and chasing a lofted ball up looks wrong.
 *
 * A clip with no ball data falls back to its own camera path (the player's or
 * Replay's follow crop, user_clips.crop_path), and otherwise to the middle.
 */
import type { Framing } from "@workspace/api-zod";
import type { UserClipRow } from "@workspace/db";
import { logger } from "../logger";

export const STEP_MS = 400;
/** A 16:9 window 45% of the panorama wide: ~1730×970 of the 3840×1080 source, so barely upscaled at 1080p. */
export const DEFAULT_ZOOM = 0.45;
const NEAR_S = 0.6;
const MAX_KEYS = 600;

/** Ball sightings: [video seconds, x, y], x and y as shares of the frame, sorted by time. */
export type BallSamples = ReadonlyArray<readonly [number, number, number]>;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Keys through [fromMs, toMs] of the video, relative to fromMs (pure).
 * Returns null when the ball is never seen inside the window.
 */
export function ballKeys(samples: BallSamples, fromMs: number, toMs: number, zoom = DEFAULT_ZOOM): { framing: Framing; coverage: number } | null {
  if (!samples.length || toMs <= fromMs) return null;
  const step = Math.max(STEP_MS, Math.ceil((toMs - fromMs) / MAX_KEYS / 100) * 100);
  const times: number[] = [];
  for (let t = fromMs; t < toMs; t += step) times.push(t);
  times.push(toMs);
  const firstAt = (sec: number) => {
    let lo = 0, hi = samples.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid][0] < sec) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const raw: Array<[number, number] | null> = times.map((ms) => {
    const sec = ms / 1000;
    const i = firstAt(sec);
    let best: readonly [number, number, number] | null = null;
    for (const j of [i - 1, i]) {
      const s = samples[j];
      if (s && Math.abs(s[0] - sec) <= NEAR_S && (!best || Math.abs(s[0] - sec) < Math.abs(best[0] - sec))) best = s;
    }
    return best ? [best[1], best[2]] : null;
  });
  const seen = raw.filter(Boolean).length;
  if (!seen) return null;
  // Hold the last place seen; before the first sighting, where it is first seen.
  const firstSeen = raw.find((p): p is [number, number] => p !== null)!;
  let last: [number, number] = firstSeen;
  const filled = raw.map((p) => (p ? (last = p) : last));
  // Smooth forwards then backwards (no lag either way).
  const ease = (xs: number[], a: number) => {
    const f = [...xs];
    for (let i = 1; i < f.length; i++) f[i] = f[i - 1] + a * (f[i] - f[i - 1]);
    for (let i = f.length - 2; i >= 0; i--) f[i] = f[i + 1] + a * (f[i] - f[i + 1]);
    return f;
  };
  const xs = ease(filled.map((p) => p[0]), 0.35);
  const ys = ease(filled.map((p) => 0.52 + (p[1] - 0.52) * 0.5), 0.2);
  const keys = times.map((ms, i) => [Math.max(0, ms - fromMs), round3(Math.min(1, Math.max(0, xs[i]))), round3(Math.min(1, Math.max(0, ys[i])))] as [number, number, number]);
  return { framing: { zoom, keys, mode: "ball" }, coverage: round3(seen / times.length) };
}

type CropKeyframe = { t: number; x: number; y: number; w: number; h: number };

/**
 * A clip's own camera path as framing (relative to the clip's start). Its
 * keyframes are shares of the clip's length and of the frame (origin and size).
 */
export function cropPathFraming(cropPath: unknown, clipSeconds: number): Framing | null {
  if (!Array.isArray(cropPath) || !cropPath.length || !(clipSeconds > 0)) return null;
  const frames = (cropPath as CropKeyframe[]).filter((k) => k && [k.t, k.x, k.y, k.w, k.h].every((v) => typeof v === "number" && Number.isFinite(v)) && k.w > 0);
  if (!frames.length) return null;
  const zoom = Math.max(0.1, Math.min(1, frames.reduce((s, k) => s + k.w, 0) / frames.length));
  const keys = frames
    .map((k) => [Math.round(Math.max(0, Math.min(1, k.t)) * clipSeconds * 1000), round3(Math.min(1, Math.max(0, k.x + k.w / 2))), round3(Math.min(1, Math.max(0, k.y + k.h / 2)))] as [number, number, number])
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_KEYS);
  return { zoom: round3(zoom), keys, mode: "manual" };
}

/** A still camera in the middle of the pitch. */
export function centreFraming(zoom = DEFAULT_ZOOM): Framing {
  return { zoom, keys: [[0, 0.5, 0.52]], mode: "manual" };
}

// ── Ball sightings of a recording (cached) ──────────────────────────────────

const ballCache = new Map<number, { samples: BallSamples | null; at: number; ttl: number }>();
const ballLoading = new Map<number, Promise<BallSamples | null>>();
const BALL_TTL_MS = 10 * 60_000;
/**
 * A load that failed (a slow or dropped read of the match data) is retried after this, not
 * remembered for BALL_TTL_MS: remembering it put every clip of that match on the middle of the
 * pitch for ten minutes ("the clip resets to the middle", 2026-11-04).
 */
const BALL_FAILED_TTL_MS = 20_000;

export async function recordingBall(recordingId: number): Promise<BallSamples | null> {
  const hit = ballCache.get(recordingId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.samples;
  // One load per recording at a time: a framer and a template opening together share it.
  const loading = ballLoading.get(recordingId);
  if (loading) return loading;
  const load = loadBall(recordingId).finally(() => ballLoading.delete(recordingId));
  ballLoading.set(recordingId, load);
  return load;
}

async function loadBall(recordingId: number): Promise<BallSamples | null> {
  let samples: BallSamples | null = null;
  let ok = true;
  try {
    // Loaded on demand: the analysis modules are large.
    const [{ latestBundle }, { loadRecordingPlay }, { buildBallPath }] = await Promise.all([
      import("../academyMatchStats"),
      import("../matchPlayLoad"),
      import("../../routes/ballPath"),
    ]);
    const bundle = await latestBundle(recordingId);
    if (bundle) {
      const play = await loadRecordingPlay(recordingId, { keepSegments: false });
      // No play data for an analysed match is a failed read, not "no ball".
      if (!play) ok = false;
      const path = play ? buildBallPath(bundle.manifest, play.sidecars, play.inPlay) : null;
      samples = path?.samples ?? null;
    }
  } catch (error) {
    ok = false;
    logger.warn({ recordingId, error: (error as Error).message }, "Creative framing: ball path failed");
  }
  ballCache.set(recordingId, { samples, at: Date.now(), ttl: ok ? BALL_TTL_MS : BALL_FAILED_TTL_MS });
  if (ballCache.size > 8) ballCache.delete(ballCache.keys().next().value!);
  return samples;
}

/** For tests. */
export function rememberBall(recordingId: number, samples: BallSamples | null, ttl = BALL_TTL_MS): void {
  ballCache.set(recordingId, { samples, at: Date.now(), ttl });
}

export type FramingAnswer = { framing: Framing; source: "ball" | "clip" | "centre"; coverage: number };

/** Follow the ball through [fromMs, toMs] of a recording; else `fallback`, else the middle. */
export async function framingFor(recordingId: number | null, fromMs: number, toMs: number, fallback?: Framing | null): Promise<FramingAnswer> {
  if (recordingId) {
    const samples = await recordingBall(recordingId);
    const ball = samples ? ballKeys(samples, fromMs, toMs) : null;
    if (ball && ball.coverage >= 0.15) return { framing: ball.framing, source: "ball", coverage: ball.coverage };
  }
  if (fallback) return { framing: fallback, source: "clip", coverage: 0 };
  return { framing: centreFraming(), source: "centre", coverage: 0 };
}

export function clipFallback(clip: Pick<UserClipRow, "cropPath">, clipSeconds: number): Framing | null {
  return cropPathFraming(clip.cropPath, clipSeconds);
}
