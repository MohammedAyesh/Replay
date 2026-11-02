import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  layerVisibleAt,
  resolveColor,
  resolveSource,
  type Scene,
  type SceneLayer,
} from "@workspace/api-zod";
import { EXPORT_ENCODE_ARGS } from "../ffmpegExport";
import { renderScenePng, sceneSize, type ConcreteSource, type SceneRenderOptions } from "./render";
import { ENTER_MS, SLIDE_PX, videoParts } from "./renderLayout";

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
 * Z-order is exactly the scene's.
 *
 * Audio: each footage layer that is not muted and has sound, at its speed,
 * delayed to its start; the optional soundtrack; or silence, so the file
 * always has an AAC track (Instagram and WhatsApp want one).
 */

type VideoLayer = Extract<SceneLayer, { kind: "video" }>;

/** Footage on local disk. Source time 0 (trimInMs = 0) is at `zeroAtSec` in the file. */
export type VideoSourceFile = { path: string; zeroAtSec: number; durationMs: number | null; hasAudio: boolean };

/** Local footage for a video layer, or null to draw it as its still. `need` is source ms. */
export type VideoResolver = (layer: VideoLayer, src: ConcreteSource, need: { fromMs: number; toMs: number }) => Promise<VideoSourceFile | null>;

export const FPS = 30;
const FFMPEG_TIMEOUT_MS = Math.max(60_000, Number(process.env.CREATIVE_FFMPEG_TIMEOUT_MS) || 20 * 60_000);

// ── Planning (pure) ──────────────────────────────────────────────────────────

export type StackItem =
  | { type: "stills"; layers: SceneLayer[] }
  | { type: "animated"; layer: SceneLayer }
  | { type: "video"; layer: VideoLayer };

const animated = (l: SceneLayer) => !!l.enter && l.enter !== "none";

/** Layers that can appear at all within [0, durationMs). */
export function liveLayers(scene: Scene): SceneLayer[] {
  const d = scene.durationMs ?? 0;
  return scene.layers.filter((l) => !l.hidden && (l.startMs ?? 0) < d && (l.endMs === undefined || l.endMs > (l.startMs ?? 0)));
}

/** The scene as a stack of footage, animated layers and runs of plain layers. */
export function planStack(scene: Scene, isFootage: (layer: SceneLayer) => boolean): StackItem[] {
  const out: StackItem[] = [];
  for (const layer of liveLayers(scene)) {
    if (layer.kind === "video" && isFootage(layer)) out.push({ type: "video", layer });
    else if (animated(layer)) out.push({ type: "animated", layer });
    else {
      const last = out[out.length - 1];
      if (last?.type === "stills") last.layers.push(layer);
      else out.push({ type: "stills", layers: [layer] });
    }
  }
  return out;
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
  | { type: "png"; path: string; fromMs: number; toMs: number; enter?: SceneLayer["enter"]; startMs?: number }
  | { type: "video"; layer: VideoLayer; file: VideoSourceFile };

const sec = (ms: number) => (ms / 1000).toFixed(3);
const hexColor = (c: string) => `0x${c.replace(/^#/, "").slice(0, 6)}`;

/** Overlay x/y expressions for an entrance starting at `startMs` (slides move in over ENTER_MS). */
function entranceXY(enter: SceneLayer["enter"], startMs: number, x: string, y: string): { x: string; y: string } {
  const ramp = `${SLIDE_PX}*max(0,1-(t-${sec(startMs)})/${sec(ENTER_MS)})`;
  if (enter === "slide-left") return { x: `${x}+${ramp}`, y };
  if (enter === "slide-up") return { x, y: `${y}+${ramp}` };
  return { x, y };
}

const fadeIn = (enter: SceneLayer["enter"], startMs: number) =>
  enter && enter !== "none" ? `,fade=t=in:st=${sec(startMs)}:d=${sec(ENTER_MS)}:alpha=1` : "";

/** The whole ffmpeg command for a planned scene (pure: no files are touched). */
export function buildFfmpegArgs(opts: {
  scene: Scene;
  backgroundHex: string;
  tracks: Track[];
  musicPath?: string | null;
  out: string;
}): string[] {
  const { scene, tracks } = opts;
  const D = scene.durationMs ?? 0;
  const { w: W, h: H } = sceneSize(scene);
  const inputs: string[] = ["-f", "lavfi", "-i", `color=c=${hexColor(opts.backgroundHex)}:s=${W}x${H}:r=${FPS}:d=${sec(D)}`];
  const filters: string[] = [`[0:v]format=yuv420p,setsar=1[b0]`];
  const audio: string[] = [];
  let prev = "b0";
  let input = 1;
  tracks.forEach((track, n) => {
    const k = input++;
    const next = `b${n + 1}`;
    if (track.type === "png") {
      inputs.push("-loop", "1", "-framerate", String(FPS), "-t", sec(D), "-i", track.path);
      const start = track.startMs ?? track.fromMs;
      const xy = entranceXY(track.enter, start, "0", "0");
      filters.push(`[${k}:v]format=rgba${fadeIn(track.enter, start)}[p${n}]`);
      filters.push(`[${prev}][p${n}]overlay=x='${xy.x}':y='${xy.y}':enable='gte(t,${sec(track.fromMs)})*lt(t,${sec(track.toMs)})'[${next}]`);
      prev = next;
      return;
    }
    const { layer, file } = track;
    inputs.push("-i", file.path);
    const S = layer.startMs ?? 0;
    const E = Math.min(layer.endMs ?? D, D);
    const parts = videoParts(layer, file.durationMs, E - S);
    const bw = Math.max(2, Math.round(layer.w));
    const bh = Math.max(2, Math.round(layer.h));
    // Each stretch of source at its own speed, then joined.
    const vparts = parts.map((_, i) => `v${n}_${i}`);
    if (parts.length > 1) filters.push(`[${k}:v]split=${parts.length}${vparts.map((p) => `[${p}in]`).join("")}`);
    parts.forEach((p, i) => {
      const src = parts.length > 1 ? `[${vparts[i]}in]` : `[${k}:v]`;
      filters.push(`${src}trim=start=${(file.zeroAtSec + p.srcFrom / 1000).toFixed(3)}:end=${(file.zeroAtSec + p.srcTo / 1000).toFixed(3)},setpts=(PTS-STARTPTS)/${p.speed.toFixed(6)}[${vparts[i]}]`);
    });
    const joined = `v${n}j`;
    filters.push(parts.length > 1 ? `${vparts.map((p) => `[${p}]`).join("")}concat=n=${parts.length}:v=1:a=0[${joined}]` : `[${vparts[0]}]null[${joined}]`);
    const fit = (layer.fit ?? "cover") === "cover"
      ? `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},format=rgba`
      : `scale=${bw}:${bh}:force_original_aspect_ratio=decrease,format=rgba,pad=${bw}:${bh}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
    const opacity = layer.opacity !== undefined && layer.opacity < 1 ? `,colorchannelmixer=aa=${layer.opacity.toFixed(3)}` : "";
    const rad = layer.rotation ? (layer.rotation * Math.PI) / 180 : 0;
    const rotate = rad ? `,rotate=a=${rad.toFixed(6)}:ow='rotw(${rad.toFixed(6)})':oh='roth(${rad.toFixed(6)})':c=none` : "";
    filters.push(`[${joined}]fps=${FPS},setsar=1,${fit}${opacity}${rotate},setpts=PTS+${sec(S)}/TB${fadeIn(layer.enter, S)}[v${n}]`);
    const cx = layer.x + layer.w / 2;
    const cy = layer.y + layer.h / 2;
    const xy = entranceXY(layer.enter, S, `${cx.toFixed(2)}-w/2`, `${cy.toFixed(2)}-h/2`);
    filters.push(`[${prev}][v${n}]overlay=x='${xy.x}':y='${xy.y}':eof_action=repeat:enable='gte(t,${sec(S)})*lt(t,${sec(E)})'[${next}]`);
    prev = next;

    if (!layer.muted && file.hasAudio) {
      const aparts = parts.map((_, i) => `a${n}_${i}`);
      if (parts.length > 1) filters.push(`[${k}:a]asplit=${parts.length}${aparts.map((p) => `[${p}in]`).join("")}`);
      parts.forEach((p, i) => {
        const src = parts.length > 1 ? `[${aparts[i]}in]` : `[${k}:a]`;
        const tempo = atempoChain(p.speed);
        filters.push(`${src}atrim=start=${(file.zeroAtSec + p.srcFrom / 1000).toFixed(3)}:end=${(file.zeroAtSec + p.srcTo / 1000).toFixed(3)},asetpts=PTS-STARTPTS${tempo.length ? `,${tempo.join(",")}` : ""},aresample=44100,aformat=channel_layouts=stereo[${aparts[i]}]`);
      });
      const aj = `a${n}j`;
      filters.push(parts.length > 1 ? `${aparts.map((p) => `[${p}]`).join("")}concat=n=${parts.length}:v=0:a=1[${aj}]` : `[${aparts[0]}]anull[${aj}]`);
      filters.push(`[${aj}]atrim=end=${sec(E - S)},adelay=${Math.round(S)}:all=1[a${n}]`);
      audio.push(`a${n}`);
    }
  });

  if (opts.musicPath) {
    const k = input++;
    inputs.push("-stream_loop", "-1", "-i", opts.musicPath);
    const vol = scene.music?.volume ?? 0.6;
    filters.push(`[${k}:a]atrim=end=${sec(D)},volume=${vol.toFixed(3)},aresample=44100,aformat=channel_layouts=stereo[am]`);
    audio.push("am");
  }
  let audioMap: string;
  if (audio.length) {
    filters.push(`${audio.map((a) => `[${a}]`).join("")}amix=inputs=${audio.length}:duration=longest:normalize=0,apad[aout]`);
    audioMap = "[aout]";
  } else {
    const k = input++;
    inputs.push("-f", "lavfi", "-t", sec(D), "-i", "anullsrc=r=44100:cl=stereo");
    audioMap = `${k}:a`;
  }
  filters.push(`[${prev}]format=yuv420p[vout]`);
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", audioMap,
    ...EXPORT_ENCODE_ARGS.video,
    ...EXPORT_ENCODE_ARGS.audio,
    "-movflags", "+faststart",
    "-t", sec(D),
    opts.out,
  ];
}

// ── Running ──────────────────────────────────────────────────────────────────

export function runFfmpeg(args: string[], signal?: AbortSignal, timeoutMs = FFMPEG_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-3000); });
    const kill = () => proc.kill("SIGKILL");
    const timer = setTimeout(() => { kill(); reject(new Error("ffmpeg timed out")); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${err.trim().split("\n").slice(-6).join(" | ")}`));
    });
  });
}

export type VideoRenderOptions = Omit<SceneRenderOptions, "t" | "include" | "background" | "width" | "entrances"> & {
  videos: VideoResolver;
  /** A scratch directory the caller creates and removes. */
  workDir: string;
  /** Where the MP4 goes. */
  out: string;
  musicPath?: string | null;
  signal?: AbortSignal;
};

/** Render a video scene to `opts.out`. */
export async function renderSceneMp4(opts: VideoRenderOptions): Promise<{ durationMs: number }> {
  const { scene } = opts;
  if (!scene.durationMs) throw new Error("Not a video scene");
  const D = scene.durationMs;
  const data = opts.data ?? {};

  // 1. Footage for every video layer that can show; the rest are stills.
  const footage = new Map<string, VideoSourceFile>();
  await Promise.all(liveLayers(scene).map(async (layer) => {
    if (layer.kind !== "video") return;
    const src = resolveSource(layer.src, data);
    if (!src) return;
    const S = layer.startMs ?? 0;
    const E = Math.min(layer.endMs ?? D, D);
    const span = videoParts(layer, null, E - S);
    const need = { fromMs: span[0]?.srcFrom ?? 0, toMs: span[span.length - 1]?.srcTo ?? (E - S) };
    const file = await opts.videos(layer, src, need);
    if (file) footage.set(layer.id, file);
  }));

  // 2. Overlays, drawn by the still renderer.
  const stack = planStack(scene, (l) => footage.has(l.id));
  const tracks: Track[] = [];
  let png = 0;
  const still = async (ids: Set<string>) => {
    const file = path.join(opts.workDir, `overlay-${String(png++).padStart(3, "0")}.png`);
    const buf = await renderScenePng({ ...opts, t: null, include: (l) => ids.has(l.id), background: false });
    await fs.promises.writeFile(file, buf);
    return file;
  };
  for (const item of stack) {
    if (item.type === "video") {
      tracks.push({ type: "video", layer: item.layer, file: footage.get(item.layer.id)! });
    } else if (item.type === "animated") {
      const l = item.layer;
      tracks.push({ type: "png", path: await still(new Set([l.id])), fromMs: l.startMs ?? 0, toMs: Math.min(l.endMs ?? D, D), enter: l.enter, startMs: l.startMs ?? 0 });
    } else {
      for (const iv of overlayIntervals(item.layers, D)) {
        tracks.push({ type: "png", path: await still(new Set(iv.ids)), fromMs: iv.fromMs, toMs: iv.toMs });
      }
    }
  }

  // 3. One ffmpeg pass.
  const args = buildFfmpegArgs({
    scene,
    backgroundHex: resolveColor(scene.background, opts.brand, "#000000"),
    tracks,
    musicPath: opts.musicPath ?? null,
    out: opts.out,
  });
  await runFfmpeg(args, opts.signal);
  return { durationMs: D };
}
