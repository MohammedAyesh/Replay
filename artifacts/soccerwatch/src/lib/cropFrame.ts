/**
 * Crop-frame geometry.
 *
 * A "frame" is the rectangle of the source recording that ends up in the
 * exported clip. It is stored in cropPath keyframes as fractions of the FULL
 * source frame: { x, y, w, h }.
 *
 * The frame is allowed to extend OUTSIDE the source (x < 0, y < 0, x + w > 1,
 * y + h > 1). Those regions render as black bars — this is how a clip can be
 * framed with deliberate letterboxing/pillarboxing. Everything downstream
 * (preview, playback, ffmpeg export) must therefore handle out-of-bounds
 * frames rather than clamping them into the source.
 *
 * The frame always has the OUTPUT aspect ratio (16:9 or 9:16), so its height
 * is fully determined by its width, the source aspect and the output aspect.
 * Only x/y/w are user-controlled; h is derived.
 */

export type AspectRatio = "16:9" | "9:16";

export type CropKeyframe = { t: number; x: number; y: number; w: number; h: number };

/** Fallback source aspect (Reolink Duo 3 stitched panorama) until metadata loads. */
export const DEFAULT_SRC_ASPECT = 3840 / 1080;

export const OUT_ASPECT: Record<AspectRatio, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

/** Frame height (fraction of source height) implied by its width. */
export function frameHeight(w: number, srcAspect: number, outAspect: number): number {
  if (!(outAspect > 0)) return 1;
  return (w * srcAspect) / outAspect;
}

/**
 * Width (fraction of source width) at which the frame exactly fills the source
 * height — i.e. zoom 1.0, the tightest framing with no black bars.
 * 16:9 over a 3840x1080 source -> 0.5. 9:16 -> ~0.158.
 */
export function baseWidth(srcAspect: number, outAspect: number): number {
  if (!(srcAspect > 0)) return 1;
  return outAspect / srcAspect;
}

/**
 * Clamp a frame origin so the source stays inside the frame when the frame is
 * larger than the source, and the frame stays inside the source when it is
 * smaller. Both cases collapse to the same min/max pair.
 */
export function clampOrigin(v: number, size: number): number {
  const lo = Math.min(0, 1 - size);
  const hi = Math.max(0, 1 - size);
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** Build a full keyframe from a zoom multiplier and origin. */
export function makeFrame(
  x: number,
  y: number,
  zoom: number,
  srcAspect: number,
  outAspect: number
): { x: number; y: number; w: number; h: number } {
  const w = baseWidth(srcAspect, outAspect) * Math.max(0.05, zoom);
  const h = frameHeight(w, srcAspect, outAspect);
  return { x: clampOrigin(x, w), y: clampOrigin(y, h), w, h };
}

/**
 * CSS for a <video> inside a container that has the OUTPUT aspect ratio, such
 * that the frame rect maps exactly onto that container. Any part of the
 * container the video does not cover shows the container's background (black).
 *
 * Percentages are relative to the container, so this stays correct at any
 * container size and needs no resize listener.
 */
export function frameToVideoStyle(f: { x: number; y: number; w: number; h: number }) {
  const w = f.w > 0 ? f.w : 1;
  const h = f.h > 0 ? f.h : 1;
  return {
    position: "absolute" as const,
    width: `${100 / w}%`,
    height: `${100 / h}%`,
    left: `${(-f.x * 100) / w}%`,
    top: `${(-f.y * 100) / h}%`,
    maxWidth: "none",
  };
}

/** Apply the same geometry straight to a DOM node (avoids per-frame React state). */
export function applyFrameToVideo(
  el: HTMLVideoElement,
  f: { x: number; y: number; w: number; h: number }
): void {
  const w = f.w > 0 ? f.w : 1;
  const h = f.h > 0 ? f.h : 1;
  el.style.position = "absolute";
  el.style.maxWidth = "none";
  el.style.width = `${100 / w}%`;
  el.style.height = `${100 / h}%`;
  el.style.left = `${(-f.x * 100) / w}%`;
  el.style.top = `${(-f.y * 100) / h}%`;
}

/**
 * Detect a cropPath written before the frame model existed.
 *
 * A valid frame always satisfies h === w * srcAspect / outAspect, because the
 * frame carries the output aspect ratio by construction. Legacy keyframes
 * violate that: 16:9 clips were stored as {x:0, w:1, y:0, h:1} (h should be 2
 * for a full-width frame), and 9:16 clips stored w as a fraction of the on-screen
 * container with h pinned to 1 (h should be 2 at that width). So the deviation
 * is an unambiguous marker — no schema change or version column needed.
 */
export function isLegacyFrame(kf: { w: number; h: number }, srcAspect: number, outAspect: number): boolean {
  if (!kf || !(kf.w > 0)) return true;
  return Math.abs(kf.h - frameHeight(kf.w, srcAspect, outAspect)) > 0.02;
}

/**
 * Rewrite a legacy keyframe as a zoom-1 frame (fills the source height, no black
 * bars), preserving its horizontal centre. This reproduces what the old exporter
 * actually did for 16:9 — centre-crop the output width — instead of stretching
 * the full panorama into the output box.
 */
export function normalizeFrame(kf: CropKeyframe, srcAspect: number, outAspect: number): CropKeyframe {
  if (!isLegacyFrame(kf, srcAspect, outAspect)) return kf;
  const w = baseWidth(srcAspect, outAspect);
  const h = frameHeight(w, srcAspect, outAspect);
  const cx = (kf.x ?? 0) + (kf.w > 0 ? kf.w : 1) / 2;
  return { t: kf.t, x: clampOrigin(cx - w / 2, w), y: clampOrigin(0, h), w, h };
}

/** Apply normalizeFrame across a whole path. */
export function normalizePath(path: CropKeyframe[], srcAspect: number, outAspect: number): CropKeyframe[] {
  if (!path || path.length === 0) return path;
  return path.map((kf) => normalizeFrame(kf, srcAspect, outAspect));
}

/**
 * Interpolate a cropPath at t (0-1 of clip duration).
 * Guards against duplicate/zero-length segments so a stalled recording can
 * never produce NaN geometry.
 */
export function interpolateFrame(path: CropKeyframe[], t: number): CropKeyframe {
  if (!path || path.length === 0) return { t, x: 0, y: 0, w: 1, h: 1 };
  if (path.length === 1) return path[0];
  const first = path[0];
  const last = path[path.length - 1];
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  const nextIdx = path.findIndex((kf) => kf.t > t);
  if (nextIdx <= 0) return last;
  const kf0 = path[nextIdx - 1];
  const kf1 = path[nextIdx];
  const span = kf1.t - kf0.t;
  const a = span > 1e-6 ? (t - kf0.t) / span : 0;
  return {
    t,
    x: kf0.x + (kf1.x - kf0.x) * a,
    y: kf0.y + (kf1.y - kf0.y) * a,
    w: kf0.w + (kf1.w - kf0.w) * a,
    h: kf0.h + (kf1.h - kf0.h) * a,
  };
}

/**
 * m:ss for elapsed clip time. Never returns an empty or negative string.
 * Named formatElapsed rather than formatClock because field-detail.tsx already
 * has a formatClock for wall-clock times of day (with AM/PM) — the two mean
 * different things and must not collide.
 */
export function formatElapsed(seconds: number): string {
  const s = !isFinite(seconds) || seconds < 0 ? 0 : seconds;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
