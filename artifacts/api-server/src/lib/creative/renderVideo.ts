import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  hasMusic,
  layerVisibleAt,
  musicFades,
  musicLoudnessGainDb,
  MUSIC_TARGET_LUFS,
  resolveColor,
  resolveSource,
  slowZoomOrigin,
  slowZoomsLayer,
  SLOW_ZOOM_TO,
  type Scene,
  type SceneLayer,
} from "@workspace/api-zod";
import { EXPORT_ENCODE_ARGS } from "../ffmpegExport";
import { applyEndScreen, type EndScreenJob } from "../clipBranding/endScreenVideo";
import { logger } from "../logger";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { renderSceneCanvas, sceneSize, type ConcreteSource, type SceneRenderOptions } from "./render";
import { ENTER_MS, PUSH_MS, SLIDE_PX, videoParts } from "./renderLayout";
import { DIP_FADE_MS, hasFades, isFadeEntrance, wipeSpan, type BallTrailSample } from "@workspace/api-zod";
import { prepareBallTrail, type BallTrailTrack } from "./ballTrailTrack";

/**
 * Creative hub engine: a video scene → MP4 (1080 wide, H.264 + AAC, 30 fps),
 * with ffmpeg, the way the clip exports encode (EXPORT_ENCODE_ARGS).
 *
 * The scene is a stack, bottom to top. Footage layers are ffmpeg inputs
 * (trimmed, sped up / slowed, a slow-motion window, cover/contain into their
 * box, opacity, rotation). Everything else is drawn by the still renderer as
 * transparent PNG overlays: each run of plain layers between two footage
 * layers becomes one PNG per distinct visibility interval, switched on with
 * enable='gte(t,a)*lt(t,b)'. A layer with an entrance (fade, slide-up,
 * slide-left; pop is drawn as a fade) gets a PNG of its own so it can move.
 * A layer with fades (fadeInMs / fadeOutMs / dip, creativeMotion.ts fadeAt)
 * gets one too, with ffmpeg fade filters; a dip splits it into two overlays
 * of the same PNG, before and after (see fadeSegments).
 * Z-order is exactly the scene's. With the scene's slow zoom on, the
 * background and full-bleed photos (slowZoomsLayer) get a PNG of their own
 * (neighbours with the same origin and window share one) that ffmpeg's
 * zoompan scales from 1 to SLOW_ZOOM_TO about the layer's origin, as
 * slowZoomAt does in the editor and in frame previews.
 *
 * Audio: each footage layer that is not muted and has sound, at its speed,
 * delayed to its start; the optional soundtrack (see musicFilters: from its
 * start point, looped, brought to MUSIC_TARGET_LUFS, at its volume, faded, and
 * ducked under the footage's sound when asked); or silence, so the file
 * always has an AAC track (Instagram and WhatsApp want one).
 *
 * A scene without footage (a photo with music) is capped to a bitrate that
 * keeps the file under PHOTO_VIDEO_TARGET_BYTES, so a story stays small.
 */

type VideoLayer = Extract<SceneLayer, { kind: "video" }>;

/** Footage on local disk. Source time 0 (trimInMs = 0) is at `zeroAtSec` in the file. */
export type VideoSourceFile = {
  path: string;
  zeroAtSec: number;
  durationMs: number | null;
  hasAudio: boolean;
  sourceDimensions?: { width: number; height: number };
  /** Match footage: its video and the match second at the file's 0, for the ball trail. */
  trailSource?: { videoId: string; fromSec: number };
  /** The ball trail laid over this footage (ballTrailTrack.ts), when the layer asks for it. */
  trail?: BallTrailTrack;
};

/** Local footage for a video layer, or null to draw it as its still. `need` is source ms. */
export type VideoResolver = (layer: VideoLayer, src: ConcreteSource, need: { fromMs: number; toMs: number }) => Promise<VideoSourceFile | null>;

export const FPS = 30;
const FFMPEG_TIMEOUT_MS = Math.max(60_000, Number(process.env.CREATIVE_FFMPEG_TIMEOUT_MS) || 20 * 60_000);

// ── Planning (pure) ──────────────────────────────────────────────────────────

export type StackItem =
  | { type: "stills"; layers: SceneLayer[] }
  | { type: "animated"; layer: SceneLayer }
  | { type: "zoom"; layers: SceneLayer[]; origin: { x: number; y: number } }
  | { type: "video"; layer: VideoLayer };

const animated = (l: SceneLayer) => !!l.enter && l.enter !== "none";

/** Layers that can appear at all within [0, durationMs). */
export function liveLayers(scene: Scene): SceneLayer[] {
  const d = scene.durationMs ?? 0;
  return scene.layers.filter((l) => !l.hidden && (l.startMs ?? 0) < d && (l.endMs === undefined || l.endMs > (l.startMs ?? 0)));
}

/**
 * The scene as a stack of footage, animated layers, slowly zooming layers and
 * runs of plain layers. Zooming neighbours share an item when they zoom about
 * the same point and show for the same window.
 */
export function planStack(scene: Scene, isFootage: (layer: SceneLayer) => boolean, zooms: (layer: SceneLayer) => boolean = () => false): StackItem[] {
  const out: StackItem[] = [];
  // Zooming layers share a PNG only when they show, and fade, together.
  const windowOf = (l: SceneLayer) => `${l.startMs ?? 0}:${l.endMs ?? ""}:${l.fadeInMs ?? 0}:${l.fadeOutMs ?? 0}:${l.dip ? `${l.dip.fromMs}-${l.dip.toMs}-${l.dip.fadeMs}` : ""}`;
  for (const layer of liveLayers(scene)) {
    if (layer.kind === "video" && isFootage(layer)) out.push({ type: "video", layer });
    else if (animated(layer)) out.push({ type: "animated", layer });
    else if (zooms(layer)) {
      const origin = slowZoomOrigin(layer, scene.format);
      const last = out[out.length - 1];
      if (last?.type === "zoom" && last.origin.x === origin.x && last.origin.y === origin.y && windowOf(last.layers[0]!) === windowOf(layer)) last.layers.push(layer);
      else out.push({ type: "zoom", layers: [layer], origin });
    }
    else if (hasFades(layer)) out.push({ type: "animated", layer });
    else {
      const last = out[out.length - 1];
      if (last?.type === "stills") last.layers.push(layer);
      else out.push({ type: "stills", layers: [layer] });
    }
  }
  return out;
}

export type FadeStep = { dir: "in" | "out"; atMs: number; ms: number };

/**
 * A fading layer's overlays over [its start, its end ∧ the scene's end): one, or two around a
 * dip (the first fades out at dip.fromMs and stops at dip.toMs, the second fades back in from
 * dip.toMs). Each carries the layer's own in and out fades. The same ramps as fadeAt.
 */
export function fadeSegments(layer: Pick<SceneLayer, "startMs" | "endMs" | "fadeInMs" | "fadeOutMs" | "dip">, durationMs: number, withDip = true): Array<{ fromMs: number; toMs: number; fades: FadeStep[] }> {
  const S = layer.startMs ?? 0;
  const E = Math.min(layer.endMs ?? durationMs, durationMs);
  if (E <= S) return [];
  const base: FadeStep[] = [];
  if (layer.fadeInMs) base.push({ dir: "in", atMs: S, ms: layer.fadeInMs });
  if (layer.fadeOutMs) base.push({ dir: "out", atMs: Math.max(S, E - layer.fadeOutMs), ms: Math.min(layer.fadeOutMs, E - S) });
  const dip = withDip ? layer.dip : undefined;
  if (!dip || dip.toMs <= dip.fromMs || dip.fromMs >= E || dip.toMs <= S) return [{ fromMs: S, toMs: E, fades: base }];
  const f = dip.fadeMs || DIP_FADE_MS;
  const out: Array<{ fromMs: number; toMs: number; fades: FadeStep[] }> = [];
  if (dip.fromMs > S) out.push({ fromMs: S, toMs: Math.min(dip.toMs, E), fades: [...base, { dir: "out", atMs: dip.fromMs, ms: f }] });
  if (dip.toMs < E) out.push({ fromMs: dip.toMs, toMs: E, fades: [...base, { dir: "in", atMs: dip.toMs, ms: f }] });
  return out;
}

/** ffmpeg fade filters (on the scene's clock, on the alpha) for fade steps, each with a leading comma. */
export function fadeFilters(fades: FadeStep[] | undefined): string {
  return (fades ?? []).filter((f) => f.ms > 0).map((f) => `,fade=t=${f.dir}:st=${sec(f.atMs)}:d=${sec(f.ms)}:alpha=1`).join("");
}

export type OverlayInterval = { fromMs: number; toMs: number; ids: string[] };

/**
 * The distinct visibility intervals of a run of layers over [0, durationMs):
 * one per change in which layers show, merged when nothing changes, empty
 * stretches left out. Each becomes one overlay PNG.
 */
export function overlayIntervals(layers: SceneLayer[], durationMs: number): OverlayInterval[] {
  const cuts = new Set<number>([0, durationMs]);
  for (const l of layers) {
    for (const t of [l.startMs, l.endMs]) if (t !== undefined && t > 0 && t < durationMs) cuts.add(t);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: OverlayInterval[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (b <= a) continue;
    const ids = layers.filter((l) => layerVisibleAt(l, a)).map((l) => l.id);
    if (!ids.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.toMs === a && prev.ids.join("\u0000") === ids.join("\u0000")) prev.toMs = b;
    else out.push({ fromMs: a, toMs: b, ids });
  }
  return out;
}

/** atempo only takes 0.5–2 per instance: chain it for other speeds. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s < 0.5) { out.push("atempo=0.5"); s /= 0.5; }
  while (s > 2) { out.push("atempo=2"); s /= 2; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

export type Track =
  | {
    type: "png"; path: string; fromMs: number; toMs: number; enter?: SceneLayer["enter"]; startMs?: number;
    /** The layer's own end (a wipe crosses the canvas over its lifetime). */
    endMs?: number;
    /** Slow zoom about this point (canvas px), over the whole scene. */
    zoom?: { x: number; y: number };
    /** The layer's fades (fadeSegments). */
    fades?: FadeStep[];
    /** Where the PNG's top-left sits on the canvas: stills are cropped to what they draw. */
    x?: number;
    y?: number;
  }
  | { type: "video"; layer: VideoLayer; file: VideoSourceFile };

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** How the soundtrack goes into the mix (from the scene's music and the resolved file). */
export type MusicMix = {
  path: string;
  /** Measured integrated loudness; null = measure while mixing (loudnorm). */
  loudnessLufs: number | null;
  volume: number;
  startMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  duck: boolean;
};

/** The mix for a scene's music and its file, or null when there is no music. */
export function musicMixFor(scene: Scene, file: { path: string; loudnessLufs: number | null } | null): MusicMix | null {
  const m = scene.music;
  if (!file || !hasMusic(m)) return null;
  const D = scene.durationMs ?? 0;
  const { inMs, outMs } = musicFades(m, D);
  return {
    path: file.path,
    loudnessLufs: file.loudnessLufs,
    volume: Math.max(0, Math.min(1, m.volume ?? 0.6)),
    startMs: Math.max(0, m.startMs ?? 0),
    fadeInMs: inMs,
    fadeOutMs: outMs,
    duck: !!m.duck,
  };
}

/** Sidechain settings for "lower music under voices": about 10 dB down while the footage is loud, back within half a second. */
export const DUCK = { threshold: 0.02, ratio: 8, attackMs: 20, releaseMs: 500 } as const;

/**
 * The soundtrack's filter chain (pure): input `k` (opened with -stream_loop -1,
 * so it repeats for ever) cut to the scene from its start point, made stereo
 * 44.1 kHz, gained to MUSIC_TARGET_LUFS (a fixed gain from the measured
 * loudness, else loudnorm), its volume, then the fades. Output label `out`.
 */
export function musicFilters(k: number, mix: MusicMix, durationMs: number, out = "am"): string[] {
  const D = Math.max(0, durationMs);
  const chain = [
    `atrim=start=${sec(mix.startMs)}:end=${sec(mix.startMs + D)}`,
    "asetpts=PTS-STARTPTS",
    "aresample=44100",
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
  ];
  const gain = musicLoudnessGainDb(mix.loudnessLufs);
  if (gain === null) chain.push(`loudnorm=I=${MUSIC_TARGET_LUFS}:TP=-1.5:LRA=11`, "aresample=44100");
  else if (Math.abs(gain) >= 0.05) chain.push(`volume=${gain.toFixed(2)}dB`);
  chain.push(`volume=${mix.volume.toFixed(3)}`);
  if (mix.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${sec(mix.fadeInMs)}`);
  if (mix.fadeOutMs > 0) chain.push(`afade=t=out:st=${sec(Math.max(0, D - mix.fadeOutMs))}:d=${sec(mix.fadeOutMs)}`);
  return [`[${k}:a]${chain.join(",")}[${out}]`];
}

/**
 * Footage sound and music into [aout] (pure). With duck, the footage's sound
 * (padded to the scene) keys a sidechain compressor on the music; otherwise
 * everything is summed. A limiter keeps the sum under -1 dBFS.
 */
export function audioMixFilters(footage: string[], music: string | null, duck: boolean, durationMs: number): string[] {
  const all = [...footage, ...(music ? [music] : [])];
  if (!all.length) return [];
  const limit = music ? ",alimiter=limit=0.891:level=false" : "";
  if (music && duck && footage.length) {
    const voice = footage.length > 1
      ? `${footage.map((a) => `[${a}]`).join("")}amix=inputs=${footage.length}:duration=longest:normalize=0,apad=whole_dur=${sec(durationMs)}[voice]`
      : `[${footage[0]}]apad=whole_dur=${sec(durationMs)}[voice]`;
    return [
      voice,
      `[voice]asplit=2[voicemix][voicekey]`,
      `[${music}][voicekey]sidechaincompress=threshold=${DUCK.threshold}:ratio=${DUCK.ratio}:attack=${DUCK.attackMs}:release=${DUCK.releaseMs}[${music}d]`,
      `[voicemix][${music}d]amix=inputs=2:duration=first:normalize=0${limit}[aout]`,
    ];
  }
  // Padded to the scene's length, never open-ended: a bare apad makes silence without end, and
  // ffmpeg kept making it (hundreds of MB a second, the video starved) until the server killed it.
  return [`${all.map((a) => `[${a}]`).join("")}amix=inputs=${all.length}:duration=longest:normalize=0,apad=whole_dur=${sec(durationMs)}${limit}[aout]`];
}
const hexColor = (c: string) => `0x${c.replace(/^#/, "").slice(0, 6)}`;

/**
 * Overlay x/y expressions for an entrance starting at `startMs`, the same curves as
 * creativeMotion.ts entranceAt: slides move SLIDE_PX in over ENTER_MS; pushes come in from a
 * whole canvas below / above over PUSH_MS (ease-out cubic); a wipe crosses the canvas from the
 * right to the left over its own lifetime (smoothstep).
 */
export function entranceXY(enter: SceneLayer["enter"], startMs: number, x: string, y: string, canvas: { w: number; h: number } = { w: 1080, h: 1920 }, endMs?: number): { x: string; y: string } {
  const ramp = `${SLIDE_PX}*max(0,1-(t-${sec(startMs)})/${sec(ENTER_MS)})`;
  if (enter === "slide-left") return { x: `${x}+${ramp}`, y };
  if (enter === "slide-up") return { x, y: `${y}+${ramp}` };
  if (enter === "push-up" || enter === "push-down") {
    const left = `pow(1-clip((t-${sec(startMs)})/${sec(PUSH_MS)},0,1),3)`;
    return { x, y: `${y}${enter === "push-up" ? "+" : "-"}${canvas.h}*${left}` };
  }
  if (enter === "wipe") {
    const { from, ms } = wipeSpan({ startMs, endMs });
    const p = `clip((t-${sec(from)})/${sec(ms)},0,1)`;
    return { x: `${x}+${canvas.w}*(1-2*(${p})*(${p})*(3-2*(${p})))`, y };
  }
  return { x, y };
}

/**
 * zoompan for a full-canvas overlay: one output frame per looped input frame,
 * scale 1 → SLOW_ZOOM_TO linearly over the scene (on = output frame number),
 * the origin kept where it is (x + ox/zoom = ox).
 */
export function slowZoomFilter(origin: { x: number; y: number }, durationMs: number, size: { w: number; h: number }): string {
  const frames = Math.max(1, Math.round((durationMs / 1000) * FPS));
  const z = `1+${(SLOW_ZOOM_TO - 1).toFixed(4)}*min(1,on/${frames})`;
  return `zoompan=z='${z}':x='${origin.x.toFixed(2)}*(1-1/zoom)':y='${origin.y.toFixed(2)}*(1-1/zoom)':d=1:s=${size.w}x${size.h}:fps=${FPS}`;
}

/** The file size a video without footage aims under (a story with music; Instagram is happiest with small files). */
export const PHOTO_VIDEO_TARGET_BYTES = 7.5 * 1024 * 1024;

/** The video bitrate cap (kbit/s) for a scene without footage: the target size over the duration, less the audio, 1.5–4 Mbit/s. */
export function photoVideoMaxrateKbps(durationMs: number): number {
  const seconds = Math.max(0.5, durationMs / 1000);
  const total = (PHOTO_VIDEO_TARGET_BYTES * 8) / seconds / 1000;
  return Math.round(Math.max(1500, Math.min(4000, total - 128 - 32)));
}

const fadeIn = (enter: SceneLayer["enter"], startMs: number) =>
  isFadeEntrance(enter) ? `,fade=t=in:st=${sec(startMs)}:d=${sec(ENTER_MS)}:alpha=1` : "";

/** boxblur for a footage layer's end-card blur, switched on at its scene time (the chain's clock is the layer's own, from 0). */
export function blurFilter(layer: Pick<VideoLayer, "blur" | "startMs">): string {
  if (!layer.blur) return "";
  const r = Math.max(1, Math.round(layer.blur.px * 1.5));
  const at = Math.max(0, layer.blur.fromMs - (layer.startMs ?? 0));
  return `,boxblur=luma_radius=${r}:luma_power=2:chroma_radius=${Math.max(1, Math.round(r / 2))}:chroma_power=2:enable='gte(t,${sec(at)})'`;
}

/** Keys thinned to at most `max`, keeping both ends (an ffmpeg expression nests one level per key). */
export function thinKeys(keys: ReadonlyArray<readonly [number, number, number]>, max = 48): Array<[number, number, number]> {
  const sorted = [...keys].sort((a, b) => a[0] - b[0]).map((k) => [k[0], k[1], k[2]] as [number, number, number]);
  if (sorted.length <= max) return sorted;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < max; i++) out.push(sorted[Math.round((i * (sorted.length - 1)) / (max - 1))]);
  return out;
}

/**
 * A piecewise-linear ffmpeg expression in t (seconds into the file) through
 * points [file seconds, value]: holds before the first and after the last.
 */
export function piecewise(points: Array<[number, number]>): string {
  const v = (n: number) => n.toFixed(4);
  if (points.length === 1) return v(points[0][1]);
  let expr = v(points[points.length - 1][1]);
  for (let i = points.length - 2; i >= 0; i--) {
    const [t0, a] = points[i];
    const [t1, b] = points[i + 1];
    const seg = t1 > t0 ? `${v(a)}+(${v(b - a)})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)}` : v(b);
    expr = `if(lt(t,${t1.toFixed(3)}),${seg},${expr})`;
  }
  return `if(lt(t,${points[0][0].toFixed(3)}),${v(points[0][1])},${expr})`;
}

/**
 * The crop for a framed layer: a window of the box's shape, `zoom` of the
 * source's width (fitted inside the frame), centred on the keys, kept inside.
 * Applied to the input before any trim, so t is the file's own clock.
 */
export function framingCrop(framing: NonNullable<VideoLayer["framing"]>, boxW: number, boxH: number, zeroAtSec: number): string {
  const A = boxW / boxH;
  const keys = thinKeys(framing.keys);
  const at = (ms: number) => zeroAtSec + ms / 1000;
  // Framing keys are normalized on the stored 3840×1080 grid. Multiplying by
  // FFmpeg's probed iw/ih converts them to the actual camera-original pixels
  // (e.g. 4096×1152) without assuming every recording has the same dimensions.
  const cx = piecewise(keys.map((k) => [at(k[0]), k[1]]));
  const cy = piecewise(keys.map((k) => [at(k[0]), k[2]]));
  const w = `trunc(min(iw*${framing.zoom.toFixed(4)},ih*${A.toFixed(6)})/2)*2`;
  const h = `trunc(ow/${A.toFixed(6)}/2)*2`;
  return `crop=w='${w}':h='${h}':x='clip((${cx})*iw-ow/2,0,iw-ow)':y='clip((${cy})*ih-oh/2,0,ih-oh)'`;
}

/** The whole ffmpeg command for a planned scene (pure: no files are touched). */
export function buildFfmpegArgs(opts: {
  scene: Scene;
  backgroundHex: string;
  tracks: Track[];
  /** The soundtrack; `musicPath` is the older form (a file, mixed with the scene's music settings and no measured loudness). */
  music?: MusicMix | null;
  musicPath?: string | null;
  out: string;
}): string[] {
  const { scene, tracks } = opts;
  const D = scene.durationMs ?? 0;
  const { w: W, h: H } = sceneSize(scene);
  const inputs: string[] = ["-f", "lavfi", "-i", `color=c=${hexColor(opts.backgroundHex)}:s=${W}x${H}:r=${FPS}:d=${sec(D)}`];
  const filters: string[] = [`[0:v]format=yuv420p,setsar=1[b0]`];
  // Sound goes after the picture in the graph. With [aout] declared first, ffmpeg pulled the sound
  // ahead and queued every decoded 3840×1080 frame of the same file meanwhile: 2.1 GB for 15 s.
  const afilters: string[] = [];
  const audio: string[] = [];
  let prev = "b0";
  let input = 1;
  tracks.forEach((track, n) => {
    const k = input++;
    const next = `b${n + 1}`;
    if (track.type === "png") {
      // A still is decoded only while it shows: its input starts at its own time (-itsoffset) and
      // lasts its interval. Looping every still over the whole scene decoded and queued 20+ full
      // frames per output frame: 3.3 GB and minutes for a 15 s story, which the server killed.
      // A slow zoom keeps the whole-scene input: its zoom counts frames from the scene's start.
      const bounded = !track.zoom;
      const from = bounded ? Math.max(0, Math.min(track.fromMs, D)) : 0;
      const len = bounded ? Math.max(1000 / FPS, Math.min(track.toMs, D) - from) : D;
      inputs.push("-threads", "1", "-loop", "1", "-framerate", String(FPS), "-t", sec(len), ...(from > 0 ? ["-itsoffset", sec(from)] : []), "-i", track.path);
      const start = track.startMs ?? track.fromMs;
      const xy = entranceXY(track.enter, start, String(track.x ?? 0), String(track.y ?? 0), { w: W, h: H }, track.endMs);
      const zoom = track.zoom ? `,${slowZoomFilter(track.zoom, D, { w: W, h: H })}` : "";
      filters.push(`[${k}:v]format=rgba${zoom}${fadeIn(track.enter, start)}${fadeFilters(track.fades)}[p${n}]`);
      filters.push(`[${prev}][p${n}]overlay=x='${xy.x}':y='${xy.y}':${bounded ? "eof_action=pass:" : ""}enable='gte(t,${sec(track.fromMs)})*lt(t,${sec(track.toMs)})'[${next}]`);
      prev = next;
      return;
    }
    const { layer, file } = track;
    // Keep HEVC/H.264 decoder worker counts bounded: camera originals are 4K.
    inputs.push("-threads", "1", "-i", file.path);
    // The ball trail: its frames as a second input, on this file's clock.
    const trailInput = file.trail ? input++ : -1;
    if (file.trail) inputs.push("-threads", "1", "-f", "concat", "-safe", "0", "-i", file.trail.list);
    const S = layer.startMs ?? 0;
    const E = Math.min(layer.endMs ?? D, D);
    const parts = videoParts(layer, file.durationMs, E - S);
    const bw = Math.max(2, Math.round(layer.w));
    const bh = Math.max(2, Math.round(layer.h));
    // Each stretch of source at its own speed, then joined.
    const vparts = parts.map((_, i) => `v${n}_${i}`);
    // A framed layer: the moving window of the panorama, cut out before anything else.
    let input0 = `[${k}:v]`;
    if (layer.framing?.keys.length) {
      filters.push(`${input0}${framingCrop(layer.framing, bw, bh, file.zeroAtSec)}[f${n}]`);
      input0 = `[f${n}]`;
    }
    // Over the framed window (or the whole source), before any trim or speed change.
    if (file.trail && trailInput >= 0) {
      filters.push(`[${trailInput}:v]scale=${file.trail.w}:${file.trail.h}:flags=bilinear,format=yuva420p[tr${n}]`);
      filters.push(`${input0}[tr${n}]overlay=x=0:y=0:eof_action=pass:format=yuv420[bt${n}]`);
      input0 = `[bt${n}]`;
    }
    if (parts.length > 1) filters.push(`${input0}split=${parts.length}${vparts.map((p) => `[${p}in]`).join("")}`);
    parts.forEach((p, i) => {
      const src = parts.length > 1 ? `[${vparts[i]}in]` : input0;
      filters.push(`${src}trim=start=${(file.zeroAtSec + p.srcFrom / 1000).toFixed(3)}:end=${(file.zeroAtSec + p.srcTo / 1000).toFixed(3)},setpts=(PTS-STARTPTS)/${p.speed.toFixed(6)}[${vparts[i]}]`);
    });
    const joined = `v${n}j`;
    filters.push(parts.length > 1 ? `${vparts.map((p) => `[${p}]`).join("")}concat=n=${parts.length}:v=1:a=0[${joined}]` : `[${vparts[0]}]null[${joined}]`);
    // Cover: cut the box's shape out of the source first, then scale it down. Scaling first blew a
    // 3840×1080 panorama up to 6827×1920 RGBA for a 9:16 story (52 MB a frame) before cropping it.
    const R = (bw / bh).toFixed(6);
    const fit = (layer.fit ?? "cover") === "cover"
      ? `crop=w='trunc(min(iw,ih*${R})/2)*2':h='trunc(min(ih,iw/${R})/2)*2',scale=${bw}:${bh},format=rgba`
      : `scale=${bw}:${bh}:force_original_aspect_ratio=decrease,format=rgba,pad=${bw}:${bh}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
    const opacity = layer.opacity !== undefined && layer.opacity < 1 ? `,colorchannelmixer=aa=${layer.opacity.toFixed(3)}` : "";
    const rad = layer.rotation ? (layer.rotation * Math.PI) / 180 : 0;
    const rotate = rad ? `,rotate=a=${rad.toFixed(6)}:ow='rotw(${rad.toFixed(6)})':oh='roth(${rad.toFixed(6)})':c=none` : "";
    filters.push(`[${joined}]fps=${FPS},setsar=1,${fit}${blurFilter(layer)}${opacity}${rotate},setpts=PTS+${sec(S)}/TB${fadeIn(layer.enter, S)}${fadeFilters(fadeSegments(layer, D, false)[0]?.fades)}[v${n}]`);
    const cx = layer.x + layer.w / 2;
    const cy = layer.y + layer.h / 2;
    const xy = entranceXY(layer.enter, S, `${cx.toFixed(2)}-w/2`, `${cy.toFixed(2)}-h/2`, { w: W, h: H }, layer.endMs);
    filters.push(`[${prev}][v${n}]overlay=x='${xy.x}':y='${xy.y}':eof_action=repeat:enable='gte(t,${sec(S)})*lt(t,${sec(E)})'[${next}]`);
    prev = next;

    if (!layer.muted && file.hasAudio) {
      const aparts = parts.map((_, i) => `a${n}_${i}`);
      if (parts.length > 1) afilters.push(`[${k}:a]asplit=${parts.length}${aparts.map((p) => `[${p}in]`).join("")}`);
      parts.forEach((p, i) => {
        const src = parts.length > 1 ? `[${aparts[i]}in]` : `[${k}:a]`;
        const tempo = atempoChain(p.speed);
        afilters.push(`${src}atrim=start=${(file.zeroAtSec + p.srcFrom / 1000).toFixed(3)}:end=${(file.zeroAtSec + p.srcTo / 1000).toFixed(3)},asetpts=PTS-STARTPTS${tempo.length ? `,${tempo.join(",")}` : ""},aresample=44100,aformat=channel_layouts=stereo[${aparts[i]}]`);
      });
      const aj = `a${n}j`;
      afilters.push(parts.length > 1 ? `${aparts.map((p) => `[${p}]`).join("")}concat=n=${parts.length}:v=0:a=1[${aj}]` : `[${aparts[0]}]anull[${aj}]`);
      afilters.push(`[${aj}]atrim=end=${sec(E - S)},adelay=${Math.round(S)}:all=1[a${n}]`);
      audio.push(`a${n}`);
    }
  });

  const music = opts.music ?? (opts.musicPath
    ? musicMixFor({ ...scene, music: { volume: 0.6, ...scene.music, trackKey: scene.music?.trackKey ?? "file" } }, { path: opts.musicPath, loudnessLufs: null })
    : null);
  if (music) {
    const k = input++;
    inputs.push("-stream_loop", "-1", "-i", music.path);
    afilters.push(...musicFilters(k, music, D, "am"));
  }
  let audioMap: string;
  if (audio.length || music) {
    afilters.push(...audioMixFilters(audio, music ? "am" : null, !!music?.duck, D));
    audioMap = "[aout]";
  } else {
    const k = input++;
    inputs.push("-f", "lavfi", "-t", sec(D), "-i", "anullsrc=r=44100:cl=stereo");
    audioMap = `${k}:a`;
  }
  filters.push(`[${prev}]format=yuv420p[vout]`);
  const footageless = !tracks.some((t) => t.type === "video");
  const cap = footageless ? photoVideoMaxrateKbps(D) : null;
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-filter_threads", "1",
    "-filter_complex_threads", "1",
    ...inputs,
    "-filter_complex", [...filters, ...afilters].join(";"),
    "-map", "[vout]", "-map", audioMap,
    ...EXPORT_ENCODE_ARGS.video,
    ...(cap ? ["-maxrate", `${cap}k`, "-bufsize", `${cap * 2}k`] : []),
    ...EXPORT_ENCODE_ARGS.audio,
    "-movflags", "+faststart",
    "-t", sec(D),
    opts.out,
  ];
}

// ── Running ──────────────────────────────────────────────────────────────────

export class FfmpegProcessError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderrTail: string,
    readonly pid: number | null,
    readonly retries = 0,
  ) {
    const details = stderrTail || "(no stderr output)";
    const retryNote = retries > 0 ? " after one automatic retry" : "";
    const message = signal === "SIGKILL"
      ? `FFmpeg was killed by SIGKILL${retryNote}. The operating system may have terminated it because of memory pressure; the cause is not confirmed. stderr: ${details}`
      : signal
        ? `FFmpeg was terminated by ${signal}: ${details}`
        : `FFmpeg exited with code ${exitCode}: ${details}`;
    super(message);
    this.name = "FfmpegProcessError";
  }
}

export function runFfmpeg(args: string[], signal?: AbortSignal, timeoutMs = FFMPEG_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-3000); });
    const kill = () => proc.kill("SIGKILL");
    const timer = setTimeout(() => { kill(); reject(new Error("ffmpeg timed out")); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve();
      else {
        const stderrTail = err.trim().split("\n").slice(-6).join(" | ");
        reject(new FfmpegProcessError(code, sig, stderrTail, proc.pid ?? null));
      }
    });
  });
}

export async function runFfmpegWithSigkillRetry(
  args: string[],
  signal: AbortSignal | undefined,
  outputPath: string,
  runner: typeof runFfmpeg = runFfmpeg,
): Promise<void> {
  try {
    await runner(args, signal);
  } catch (error) {
    if (!(error instanceof FfmpegProcessError) || error.signal !== "SIGKILL" || signal?.aborted) throw error;
    logger.warn({
      outputPath,
      pid: error.pid,
      retry: 1,
      stderrTail: error.stderrTail || null,
    }, "Creative render FFmpeg was killed by SIGKILL; retrying once");
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    try {
      await runner(args, signal);
    } catch (retryError) {
      if (retryError instanceof FfmpegProcessError && retryError.signal === "SIGKILL") {
        throw new FfmpegProcessError(
          retryError.exitCode,
          retryError.signal,
          retryError.stderrTail,
          retryError.pid,
          1,
        );
      }
      throw retryError;
    }
  }
}

export type VideoRenderOptions = Omit<SceneRenderOptions, "t" | "include" | "background" | "width" | "entrances"> & {
  videos: VideoResolver;
  /** A scratch directory the caller creates and removes. */
  workDir: string;
  /** Where the MP4 goes. */
  out: string;
  /** The soundtrack's file (resolved by the caller for the academy); its settings are the scene's music. */
  music?: { path: string; loudnessLufs: number | null } | null;
  musicPath?: string | null;
  signal?: AbortSignal;
  /** The venue's mark over everything, and its sign-off card after the scene (renderBranding). */
  branding?: { overlayPath: string | null; endScreen: EndScreenJob | null } | null;
  /** A match video's ball path, for layers with the ball trail (tests inject one). */
  ballSamples?: (videoId: string) => Promise<ReadonlyArray<BallTrailSample> | null>;
};

/** The ball path of the camera recording a video id belongs to. */
async function matchBallSamples(videoId: string): Promise<ReadonlyArray<BallTrailSample> | null> {
  const [{ recordingForVideo }, { recordingBall }] = await Promise.all([
    import("../venues/igPick"),
    import("./framing"),
  ]);
  const rec = await recordingForVideo(videoId);
  return rec ? recordingBall(rec.id) : null;
}

/** The smallest box holding every pixel a still draws (alpha > 0), or null when it draws nothing. */
export function drawnBox(canvas: Canvas): { x: number; y: number; w: number; h: number } | null {
  const { width: W, height: H } = canvas;
  const px = canvas.getContext("2d").getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y += 1) {
    const row = y * W * 4;
    for (let x = 0; x < W; x += 1) {
      if (px[row + x * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Render a video scene to `opts.out`. */
export async function renderSceneMp4(opts: VideoRenderOptions): Promise<{ durationMs: number }> {
  const { scene } = opts;
  if (!scene.durationMs) throw new Error("Not a video scene");
  const D = scene.durationMs;
  const data = opts.data ?? {};

  // 1. Footage for every video layer that can show; the rest are stills.
  const footage = new Map<string, VideoSourceFile>();
  // Buffer one camera original at a time. Concurrent 4K HEVC decode/encode
  // jobs made busy multi-layer scenes exceed the render worker's memory limit.
  for (const layer of liveLayers(scene)) {
    if (layer.kind !== "video") continue;
    const src = resolveSource(layer.src, data);
    if (!src) continue;
    const S = layer.startMs ?? 0;
    const E = Math.min(layer.endMs ?? D, D);
    const span = videoParts(layer, null, E - S);
    const need = { fromMs: span[0]?.srcFrom ?? 0, toMs: span[span.length - 1]?.srcTo ?? (E - S) };
    const file = await opts.videos(layer, src, need);
    if (file && layer.ballTrail && file.trailSource) {
      // Branding, not content: a trail that can't be drawn leaves the video without it.
      try {
        const samples = await (opts.ballSamples ?? matchBallSamples)(file.trailSource.videoId);
        const track = samples?.length
          ? await prepareBallTrail({
            layer,
            file,
            samples,
            fileStartSec: file.trailSource.fromSec,
            usedFrom: file.zeroAtSec + need.fromMs / 1000,
            usedTo: file.zeroAtSec + need.toMs / 1000,
            workDir: opts.workDir,
          })
          : null;
        if (track) file.trail = track;
      } catch (error) {
        logger.warn({ layerId: layer.id, error: (error as Error).message }, "Creative render: ball trail left out");
      }
    }
    if (file) footage.set(layer.id, file);
  }

  // 2. Overlays, drawn by the still renderer (unzoomed: ffmpeg zooms the background and photos).
  const zooms = (l: SceneLayer) => !!scene.slowZoom && slowZoomsLayer(l, l.kind === "image" ? resolveSource(l.src, data) : null, scene.format);
  const stack = planStack(scene, (l) => footage.has(l.id), zooms);
  const tracks: Track[] = [];
  let png = 0;
  // Each still is cut down to what it draws: a full 1080×1920 RGBA frame per overlay, decoded and
  // blended every frame, was most of a render's memory. A still that draws nothing is left out.
  const still = async (ids: Set<string>, full = false): Promise<{ path: string; x: number; y: number } | null> => {
    const file = path.join(opts.workDir, `overlay-${String(png++).padStart(3, "0")}.png`);
    const canvas = await renderSceneCanvas({ ...opts, t: null, include: (l) => ids.has(l.id), background: false });
    const box = full ? { x: 0, y: 0, w: canvas.width, h: canvas.height } : drawnBox(canvas);
    if (!box) return null;
    const out = box.w === canvas.width && box.h === canvas.height ? canvas : (() => {
      const c = createCanvas(box.w, box.h);
      c.getContext("2d").drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      return c;
    })();
    await fs.promises.writeFile(file, await out.encode("png"));
    return { path: file, x: box.x, y: box.y };
  };
  for (const item of stack) {
    if (item.type === "video") {
      tracks.push({ type: "video", layer: item.layer, file: footage.get(item.layer.id)! });
    } else if (item.type === "animated") {
      const l = item.layer;
      const img = await still(new Set([l.id]));
      if (!img) continue;
      const own = { enter: l.enter, startMs: l.startMs ?? 0, ...(l.endMs !== undefined ? { endMs: l.endMs } : {}) };
      if (!hasFades(l)) tracks.push({ type: "png", ...img, fromMs: l.startMs ?? 0, toMs: Math.min(l.endMs ?? D, D), ...own });
      else for (const seg of fadeSegments(l, D)) tracks.push({ type: "png", ...img, fromMs: seg.fromMs, toMs: seg.toMs, ...own, fades: seg.fades });
    } else if (item.type === "zoom") {
      const first = item.layers[0]!;
      // Zoomed about a canvas point: kept whole.
      const img = (await still(new Set(item.layers.map((l) => l.id)), true))!;
      if (!hasFades(first)) tracks.push({ type: "png", path: img.path, fromMs: first.startMs ?? 0, toMs: Math.min(first.endMs ?? D, D), zoom: item.origin });
      else for (const seg of fadeSegments(first, D)) tracks.push({ type: "png", path: img.path, fromMs: seg.fromMs, toMs: seg.toMs, zoom: item.origin, fades: seg.fades });
    } else {
      for (const iv of overlayIntervals(item.layers, D)) {
        const img = await still(new Set(iv.ids));
        if (img) tracks.push({ type: "png", ...img, fromMs: iv.fromMs, toMs: iv.toMs });
      }
    }
  }

  // The venue's mark sits on top of everything, for the whole scene.
  if (opts.branding?.overlayPath) tracks.push({ type: "png", path: opts.branding.overlayPath, fromMs: 0, toMs: D });

  // 3. One ffmpeg pass.
  const args = buildFfmpegArgs({
    scene,
    backgroundHex: resolveColor(scene.background, opts.brand, "#000000"),
    tracks,
    music: musicMixFor(scene, opts.music ?? (opts.musicPath ? { path: opts.musicPath, loudnessLufs: null } : null)),
    out: opts.out,
  });
  await runFfmpegWithSigkillRetry(args, opts.signal, opts.out);

  // 4. The sign-off card after the scene, over its held last frame. Without it the video still stands.
  const card = opts.branding?.endScreen;
  if (card) {
    try {
      const { w, h } = sceneSize(scene);
      const withCard = await applyEndScreen({ mainPath: opts.out, dims: { w, h }, job: card, start: D / 1000, encode: EXPORT_ENCODE_ARGS, hasAudio: true });
      await fs.promises.rename(withCard, opts.out).catch(async () => {
        await fs.promises.copyFile(withCard, opts.out);
        await fs.promises.rm(withCard, { force: true });
      });
      return { durationMs: D + Math.round(card.seconds * 1000) };
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "Creative render: end card left out");
    }
  }
  return { durationMs: D };
}
