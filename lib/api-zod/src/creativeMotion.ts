import type { Entrance, SceneLayer } from "./creativeScene";

/**
 * Entrances on video scenes, in one place for the browser preview, the still renderer (frame
 * previews) and the MP4 renderer (renderVideo.ts writes the same curves as ffmpeg expressions).
 *
 *   fade / pop          opacity 0 → 1 over ENTER_MS (pop draws as a fade)
 *   slide-up / -left    the fade, moving SLIDE_PX into place
 *   push-up / -down     a whole canvas below / above → in place over PUSH_MS, eased out, fully
 *                       opaque: a clip that covers the one before it
 *   wipe                crosses the whole canvas from the right to the left over the layer's own
 *                       lifetime (startMs → endMs), eased in and out: the brand-colour bar that
 *                       hides the cut between two parts of a video
 */
export const ENTER_MS = 400;
export const SLIDE_PX = 80;
export const PUSH_MS = 600;
/** A wipe without an end runs this long. */
export const WIPE_MS = 700;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Ease-out cubic: 1 - (1 - p)^3. */
export const easeOut = (p: number) => 1 - Math.pow(1 - clamp01(p), 3);
/** Smoothstep: p² (3 - 2p). */
export const easeInOut = (p: number) => {
  const c = clamp01(p);
  return c * c * (3 - 2 * c);
};

export const isFadeEntrance = (enter: Entrance | undefined) =>
  enter === "fade" || enter === "pop" || enter === "slide-up" || enter === "slide-left";

/** The wipe's window: its layer's lifetime, or WIPE_MS from its start. */
export function wipeSpan(layer: Pick<SceneLayer, "startMs" | "endMs">): { from: number; ms: number } {
  const from = layer.startMs ?? 0;
  const ms = layer.endMs !== undefined && layer.endMs > from ? layer.endMs - from : WIPE_MS;
  return { from, ms };
}

/** Opacity and offset of an entering layer at scene time t (ms), on a canvas of `size`. */
export function entranceAt(
  layer: Pick<SceneLayer, "enter" | "startMs" | "endMs">,
  t: number,
  size: { w: number; h: number } = { w: 1080, h: 1920 },
): { alpha: number; dx: number; dy: number } {
  const enter = layer.enter ?? "none";
  if (enter === "none") return { alpha: 1, dx: 0, dy: 0 };
  const start = layer.startMs ?? 0;
  if (enter === "push-up" || enter === "push-down") {
    const left = 1 - easeOut((t - start) / PUSH_MS);
    return { alpha: 1, dx: 0, dy: (enter === "push-up" ? 1 : -1) * size.h * left };
  }
  if (enter === "wipe") {
    const { from, ms } = wipeSpan(layer);
    return { alpha: 1, dx: size.w * (1 - 2 * easeInOut((t - from) / ms)), dy: 0 };
  }
  const p = clamp01((t - start) / ENTER_MS);
  return {
    alpha: p,
    dx: enter === "slide-left" ? SLIDE_PX * (1 - p) : 0,
    dy: enter === "slide-up" ? SLIDE_PX * (1 - p) : 0,
  };
}

/**
 * A video layer's blur at scene time t (px on the canvas): on from `fromMs`, off before. A step,
 * like ffmpeg's boxblur switched on with enable; the end card's dimmer fading in over it hides
 * the switch.
 */
export function blurAt(layer: { blur?: { fromMs: number; px: number } }, t: number): number {
  return layer.blur && t >= layer.blur.fromMs ? layer.blur.px : 0;
}
