import { PANORAMA_ASPECT, type Framing, type MediaSource, type Scene, type SceneBranding } from "@workspace/api-zod";
import { call } from "@/lib/academy-studio-api";
import { creativePath } from "@/lib/creative-hub-api";

/**
 * Creative hub: a clip's camera (framing), length and branding. Client for
 * POST …/creative/library/framing (routes/academyCreativeLibrary.ts).
 */

export type FramingAnswer = {
  framing: Framing;
  source: "ball" | "clip" | "centre";
  coverage: number;
  /** For a clip: its stretch of its recording, when it is on one (so its start and end can move). */
  window?: { recordingId: number; fromMs: number; toMs: number } | null;
};

export type FramingSource =
  | { type: "recording"; recordingId: number; fromMs: number; toMs: number }
  | { type: "clip"; clipId: number };

export function fetchFraming(academyId: number, src: FramingSource): Promise<FramingAnswer> {
  return call<FramingAnswer>(creativePath(academyId, "/library/framing"), { method: "POST", body: JSON.stringify({ src }) });
}

/**
 * The camera a freshly picked clip or match moment starts with: following the ball (or the
 * clip's own camera path). Null when there is nothing better than the middle, for footage that
 * is not match footage, or when the answer takes longer than `timeoutMs`: the layer then shows
 * its footage as it is, and the Camera button still opens the framer.
 */
export async function followTheBall(academyId: number, src: MediaSource, timeoutMs = 8000): Promise<Framing | null> {
  const req: FramingSource | null = src.type === "clip" ? { type: "clip", clipId: src.clipId }
    : src.type === "recording" ? { type: "recording", recordingId: src.recordingId, fromMs: src.fromMs, toMs: src.toMs }
    : null;
  if (!req) return null;
  try {
    const answer = await Promise.race([
      fetchFraming(academyId, req),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return answer && answer.source !== "centre" && answer.framing.keys.length ? answer.framing : null;
  } catch {
    return null;
  }
}

/**
 * The video's shape:
 *   wide  16:9, the camera fills it
 *   tall  9:16, a vertical camera fills it (full height, close on the play)
 *   bars  9:16 with black above and below: a 16:9 band in the middle (or the
 *         whole panorama, when the camera is off), so more width shows
 */
export type FramerShape = "wide" | "tall" | "bars";
export const FRAMER_SHAPES: FramerShape[] = ["wide", "tall", "bars"];

/** What the framer hands back: the footage (a recording's window or a fixed clip), its camera, branding and shape. */
export type FramedClip = {
  src: Extract<MediaSource, { type: "recording" | "clip" }>;
  durationMs: number;
  /** Null: the whole pitch. Keys are relative to the source's start. */
  framing: Framing | null;
  branding: SceneBranding;
  shape: FramerShape;
};

export const MAX_VIDEO_MS = 180_000;
export const DEFAULT_BRANDING: SceneBranding = { overlay: true, endCard: true };
/** A design saved before branding switches existed exports without any. */
export const NO_BRANDING: SceneBranding = { overlay: false, endCard: false };

/** The output frame for a shape. */
export function shapeFormat(shape: FramerShape): { format: "wide" | "story"; w: number; h: number } {
  return shape === "wide" ? { format: "wide", w: 1920, h: 1080 } : { format: "story", w: 1080, h: 1920 };
}

/**
 * Where the footage sits in the frame. Under a camera, wide and tall fill
 * it and bars puts a 16:9 band across the middle. With no camera (the whole
 * pitch) it is always a band in the panorama's own shape, so nothing is cut.
 */
export function footageBox(shape: FramerShape, framed: boolean, sourceAspect = PANORAMA_ASPECT): { x: number; y: number; w: number; h: number } {
  const f = shapeFormat(shape);
  if (framed && shape !== "bars") return { x: 0, y: 0, w: f.w, h: f.h };
  // A band across the middle: 16:9 under a camera, else the whole panorama.
  const h = Math.min(f.h, Math.round(f.w / (framed ? 16 / 9 : sourceAspect) / 2) * 2);
  return { x: 0, y: Math.round((f.h - h) / 2), w: f.w, h };
}

/** The camera window's shape (width / height): the footage box's. */
export const boxAspectOf = (shape: FramerShape, framed: boolean, sourceAspect = PANORAMA_ASPECT) => {
  const b = footageBox(shape, framed, sourceAspect);
  return b.w / b.h;
};

/**
 * The zoom range for a box: from the widest window that still fills it
 * (the panorama's full height) to twice as close.
 */
export function zoomRange(boxAspect: number, sourceAspect = PANORAMA_ASPECT): { min: number; max: number } {
  const max = Math.min(1, boxAspect / sourceAspect);
  return { min: max * 0.5, max };
}

/** A video of just the clip in the chosen shape: its camera, its branding. */
export function clipVideoScene(clip: FramedClip, locale: "ar" | "en"): Scene {
  const ms = Math.max(1000, Math.min(MAX_VIDEO_MS, Math.round(clip.durationMs)));
  const f = shapeFormat(clip.shape);
  const box = footageBox(clip.shape, !!clip.framing);
  return {
    v: 1,
    format: f.format,
    durationMs: ms,
    background: "#000000",
    locale,
    branding: clip.branding,
    layers: [{
      id: "clip",
      name: "Clip",
      kind: "video",
      src: clip.src,
      ...box,
      fit: "cover",
      trimInMs: 0,
      trimOutMs: ms,
      speed: 1,
      muted: false,
      ...(clip.framing ? { framing: clip.framing } : {}),
    }],
  };
}

/** Keys at most `max`, both ends kept. */
export function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  return out;
}

/**
 * CSS for a <video> so that a window of it (shares of the source) fills its
 * box: the element is scaled up and shifted, the box clips it.
 */
export function framedVideoStyle(win: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return {
    position: "absolute",
    width: `${100 / win.w}%`,
    height: `${100 / win.h}%`,
    left: `${(-win.x / win.w) * 100}%`,
    top: `${(-win.y / win.h) * 100}%`,
    maxWidth: "none",
    objectFit: "fill",
  };
}
