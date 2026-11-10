import { CREATIVE_FORMATS, type Framing, type MediaSource, type Scene, type SceneLayer, type SceneMusic } from "./creativeScene";

/**
 * A player's highlight reel (Creative hub → Player reel): one video scene in
 * three parts, built from what the owner picked.
 *
 *   intro   his photos (up to three, one after another), his shirt number,
 *           first name, age / position / squad, and up to four headline numbers
 *   clips   his moments, one after another, each framed on him (the server's
 *           player-following framing) with a caption
 *   outro   his numbers: a grid of up to eight, with what they cover
 *           ("Season · 6 matches", "vs Al-Faisaly")
 *
 * The result is an ordinary scene: it opens in the editor, renders and
 * publishes like any template. Colours: a dark ground and white type
 * whatever the brand, with the academy's @primary for numbers and captions.
 */

/** The catalogue template whose soundtrack a reel starts with (player of the match: an epic track). */
export const PLAYER_REEL_MUSIC_TEMPLATE = "potm";
export const REEL_MAX_CLIPS = 8;
export const REEL_MAX_PHOTOS = 3;
export const REEL_MAX_INTRO_STATS = 4;
export const REEL_MAX_OUTRO_STATS = 8;
export const REEL_INTRO_MS = 5_000;
export const REEL_OUTRO_MS = 6_000;
export const REEL_CLIP_MIN_MS = 2_000;
export const REEL_CLIP_MAX_MS = 20_000;
/** A scene is at most three minutes. */
export const REEL_MAX_MS = 180_000;
export const REEL_FORMATS = ["story", "post", "wide"] as const;
export type ReelFormat = (typeof REEL_FORMATS)[number];

const DARK = "#0B0F1A";
const DARK_CLEAR = "#0B0F1A00";
const DARK_SOFT = "#0B0F1ACC";
const WHITE = "#FFFFFF";
const WHITE_SOFT = "#FFFFFFB3";

export type ReelStat = { label: string; value: string };

export type ReelClip = {
  src: MediaSource;
  /** how long it plays, ms (clamped to REEL_CLIP_MIN_MS … REEL_CLIP_MAX_MS) */
  durationMs: number;
  /** where in the source it starts, ms (a saved clip: 0; a recording window: 0 too, the window is the source) */
  trimInMs?: number;
  framing?: Framing | null;
  /** the caption ("Goal · 34'"); none when empty */
  label?: string | null;
};

export type PlayerReelInput = {
  format: ReelFormat;
  locale: "en" | "ar";
  player: {
    /** first name, or null when the academy hides names */
    name: string | null;
    number: number | null;
    /** "Age 12 · Winger · U13", already in the reel's language; empty for none */
    meta?: string | null;
  };
  /** photo sources (player-photo / player), shown one after another in the intro */
  photos: MediaSource[];
  introStats: ReelStat[];
  clips: ReelClip[];
  outroTitle?: string | null;
  outroStats: ReelStat[];
  /** a corner crest on every part */
  crest?: boolean;
  /** keep the footage's own sound (crowd, coaches) under the music */
  footageSound?: boolean;
  /** the soundtrack (recommendationSceneMusic of PLAYER_REEL_MUSIC_TEMPLATE); none when null */
  music?: SceneMusic | null;
};

export class PlayerReelError extends Error {}

/** Each clip's length after clamping, shortened together when the reel would run past REEL_MAX_MS. */
export function reelClipDurations(clips: ReadonlyArray<Pick<ReelClip, "durationMs">>): number[] {
  const clamped = clips.map((c) => Math.round(Math.max(REEL_CLIP_MIN_MS, Math.min(REEL_CLIP_MAX_MS, c.durationMs || 0))));
  const room = REEL_MAX_MS - REEL_INTRO_MS - REEL_OUTRO_MS;
  const total = clamped.reduce((s, d) => s + d, 0);
  if (total <= room) return clamped;
  const scale = room / total;
  return clamped.map((d) => Math.max(REEL_CLIP_MIN_MS, Math.floor(d * scale)));
}

type Box = { x: number; y: number; w: number; h: number };

/** Where things go on each canvas: vertical formats stack, the wide one puts the photo beside the words. */
function layoutFor(format: ReelFormat) {
  const { w: W, h: H } = CREATIVE_FORMATS[format];
  const wide = format === "wide";
  const pad = Math.round(Math.min(W, H) * 0.055);
  const photo: Box = wide ? { x: 0, y: 0, w: Math.round(W * 0.5), h: H } : { x: 0, y: 0, w: W, h: Math.round(H * 0.66) };
  const text: Box = wide ? { x: Math.round(W * 0.5) + pad, y: pad, w: Math.round(W * 0.5) - 2 * pad, h: H - 2 * pad } : { x: pad, y: Math.round(H * 0.5), w: W - 2 * pad, h: Math.round(H * 0.5) - pad };
  const unit = H / 1920 * (wide ? 1.55 : format === "post" ? 1.2 : 1);
  return { W, H, wide, pad, photo, text, unit };
}

const round = (n: number) => Math.round(n);

/** The reel as a scene. Throws PlayerReelError when there is nothing to show. */
export function buildPlayerReelScene(input: PlayerReelInput): Scene {
  if (!input.clips.length) throw new PlayerReelError("Pick at least one clip");
  if (input.clips.length > REEL_MAX_CLIPS) throw new PlayerReelError(`At most ${REEL_MAX_CLIPS} clips`);
  const L = layoutFor(input.format);
  const { W, H, pad, unit } = L;
  const layers: SceneLayer[] = [];
  const push = (layer: SceneLayer) => layers.push(layer);
  const u = (n: number) => round(n * unit);
  const durations = reelClipDurations(input.clips);
  const clipsMs = durations.reduce((s, d) => s + d, 0);
  const outroAt = REEL_INTRO_MS + clipsMs;
  const D = outroAt + REEL_OUTRO_MS;
  const numberText = input.player.number !== null && input.player.number !== undefined ? String(input.player.number) : null;
  const name = input.player.name?.trim() || null;
  const tag = [numberText ? `#${numberText}` : null, name].filter(Boolean).join("  ");
  const photos = input.photos.slice(0, REEL_MAX_PHOTOS);

  // ── Intro ────────────────────────────────────────────────────────────────
  push({ id: "intro-ground", kind: "shape", shape: "rect", x: 0, y: 0, w: W, h: H, fill: DARK, startMs: 0, endMs: REEL_INTRO_MS });
  if (photos.length) {
    const slot = REEL_INTRO_MS / photos.length;
    photos.forEach((src, i) => push({
      id: `intro-photo-${i}`, kind: "image", src, fit: "cover",
      ...L.photo,
      startMs: round(i * slot), endMs: i === photos.length - 1 ? REEL_INTRO_MS : round((i + 1) * slot + 300),
      enter: "fade", fadeInMs: i === 0 ? 400 : 300,
    }));
    // The photo melts into the dark ground under the words.
    if (L.wide) {
      push({ id: "intro-photo-fade", kind: "shape", shape: "rect", x: round(L.photo.w * 0.55), y: 0, w: L.photo.w - round(L.photo.w * 0.55) + 2, h: H,
        gradient: { from: DARK_CLEAR, to: DARK, angle: 90 }, startMs: 0, endMs: REEL_INTRO_MS });
    } else {
      const top = round(L.photo.h * 0.55);
      push({ id: "intro-photo-fade", kind: "shape", shape: "rect", x: 0, y: top, w: W, h: L.photo.h - top + 2,
        gradient: { from: DARK_CLEAR, to: DARK, angle: 180 }, startMs: 0, endMs: REEL_INTRO_MS });
    }
  } else {
    const size = u(L.wide ? 520 : 460);
    push({ id: "intro-crest-big", kind: "image", src: { type: "crest" }, fit: "contain",
      x: round(L.photo.x + (L.photo.w - size) / 2), y: round(L.wide ? (H - size) / 2 : L.photo.h * 0.18), w: size, h: size,
      startMs: 0, endMs: REEL_INTRO_MS, enter: "pop" });
  }

  const tx = L.text.x;
  const tw = L.text.w;
  const introCount = input.introStats.slice(0, REEL_MAX_INTRO_STATS).filter((s) => s.value.trim()).length;
  const wordsH = (numberText ? u(250) : 0) + (name ? u(130) : 0) + (input.player.meta?.trim() ? u(94) : 0) + (introCount ? u(190) : 0);
  // Under the photo on tall canvases; in the middle of the words column on the wide one.
  let y = L.wide ? Math.max(pad, round((H - wordsH) / 2)) : round(H * 0.54);
  if (numberText) {
    const h = u(250);
    push({ id: "intro-number", kind: "text", text: numberText, font: "display", size: u(240), weight: 800, color: "@primary", align: "center", dir: "ltr",
      x: tx, y, w: tw, h, fit: true, startMs: 300, endMs: REEL_INTRO_MS, enter: "pop" });
    y += h;
  }
  if (name) {
    const h = u(130);
    push({ id: "intro-name", kind: "text", text: name, font: input.locale === "ar" ? "arabic-display" : "display", size: u(112), weight: 800, color: WHITE,
      align: "center", dir: "auto", uppercase: true, x: tx, y, w: tw, h, fit: true, startMs: 600, endMs: REEL_INTRO_MS, enter: "slide-up" });
    y += h;
  }
  if (input.player.meta?.trim()) {
    const h = u(64);
    push({ id: "intro-meta", kind: "text", text: input.player.meta.trim(), font: input.locale === "ar" ? "arabic" : "body", size: u(44), weight: 600, color: WHITE_SOFT,
      align: "center", dir: "auto", x: tx, y, w: tw, h, fit: true, startMs: 900, endMs: REEL_INTRO_MS, enter: "fade" });
    y += h + u(30);
  }
  const intro = input.introStats.slice(0, REEL_MAX_INTRO_STATS).filter((s) => s.value.trim());
  if (intro.length) {
    const gap = u(20);
    const cw = (tw - gap * (intro.length - 1)) / intro.length;
    const ch = u(190);
    intro.forEach((s, i) => {
      const x = round(tx + i * (cw + gap));
      const start = 1200 + i * 180;
      push({ id: `intro-stat-bg-${i}`, kind: "shape", shape: "rect", x, y, w: round(cw), h: ch, fill: "#FFFFFF14", radius: u(22), startMs: start, endMs: REEL_INTRO_MS, enter: "slide-up" });
      push({ id: `intro-stat-value-${i}`, kind: "text", text: s.value, font: "display", size: u(80), weight: 800, color: "@primary", align: "center", dir: "ltr",
        x, y: y + u(18), w: round(cw), h: u(100), fit: true, startMs: start, endMs: REEL_INTRO_MS, enter: "slide-up" });
      push({ id: `intro-stat-label-${i}`, kind: "text", text: s.label, font: input.locale === "ar" ? "arabic" : "body", size: u(28), weight: 600, color: WHITE_SOFT,
        align: "center", dir: "auto", x: x + u(8), y: y + u(122), w: round(cw) - u(16), h: u(50), fit: true, startMs: start, endMs: REEL_INTRO_MS, enter: "slide-up" });
    });
  }

  // ── Clips ────────────────────────────────────────────────────────────────
  let t = REEL_INTRO_MS;
  input.clips.forEach((clip, i) => {
    const d = durations[i];
    const trimIn = Math.max(0, Math.round(clip.trimInMs ?? 0));
    push({
      id: `clip-${i}`, kind: "video", src: clip.src, fit: "cover", x: 0, y: 0, w: W, h: H,
      startMs: t, endMs: t + d, trimInMs: trimIn, trimOutMs: trimIn + d, speed: 1, muted: !input.footageSound,
      enter: "fade", fadeInMs: 250,
      ...(clip.framing ? { framing: clip.framing } : {}),
    } as SceneLayer);
    const label = clip.label?.trim();
    if (label) {
      push({ id: `clip-label-${i}`, kind: "text", text: label, font: input.locale === "ar" ? "arabic-display" : "display", size: u(46), weight: 800,
        color: "@on-primary", align: "center", dir: "auto", uppercase: true,
        background: { color: "@primary", padding: u(18), radius: u(14) },
        x: pad, y: H - pad - u(110), w: W - 2 * pad, h: u(90), fit: true,
        startMs: t + 250, endMs: t + Math.min(d, 3_500), enter: "slide-up" });
    }
    if (tag) {
      push({ id: `clip-tag-${i}`, kind: "text", text: tag, font: input.locale === "ar" ? "arabic-display" : "display", size: u(40), weight: 800, color: WHITE,
        align: "center", dir: "auto", uppercase: true, background: { color: DARK_SOFT, padding: u(14), radius: u(12) },
        x: round(W * 0.2), y: pad + u(10), w: round(W * 0.6), h: u(70), fit: true, startMs: t + 150, endMs: t + d, enter: "fade" });
    }
    t += d;
  });

  // ── Outro ────────────────────────────────────────────────────────────────
  push({ id: "outro-ground", kind: "shape", shape: "rect", x: 0, y: 0, w: W, h: H, fill: DARK, startMs: outroAt, endMs: D, enter: "fade", fadeInMs: 350 });
  const outro = input.outroStats.slice(0, REEL_MAX_OUTRO_STATS).filter((s) => s.value.trim());
  const portrait = u(L.wide ? 300 : 340);
  const cols = L.wide ? Math.min(4, outro.length) : outro.length === 1 ? 1 : 2;
  const rows = outro.length ? Math.ceil(outro.length / cols) : 0;
  const gap = u(22);
  const titleH = input.outroTitle?.trim() ? u(70) : 0;
  const tagH = tag ? u(100) : 0;
  const ch = rows ? Math.min(u(210), round((H - 2 * pad - portrait - u(30) - tagH - titleH - gap * (rows - 1)) / rows)) : 0;
  // The whole block (picture, name, title, grid) in the middle of the canvas.
  const blockH = portrait + u(30) + tagH + titleH + rows * ch + Math.max(0, rows - 1) * gap;
  let oy = Math.max(pad, round((H - blockH) / 2));
  if (photos.length) {
    push({ id: "outro-photo", kind: "image", src: photos[0], fit: "cover", x: round((W - portrait) / 2), y: oy, w: portrait, h: portrait, radius: round(portrait / 2),
      startMs: outroAt + 200, endMs: D, enter: "pop" });
  } else {
    push({ id: "outro-crest", kind: "image", src: { type: "crest" }, fit: "contain", x: round((W - portrait) / 2), y: oy, w: portrait, h: portrait,
      startMs: outroAt + 200, endMs: D, enter: "pop" });
  }
  oy += portrait + u(30);
  if (tag) {
    push({ id: "outro-name", kind: "text", text: tag, font: input.locale === "ar" ? "arabic-display" : "display", size: u(84), weight: 800, color: WHITE,
      align: "center", dir: "auto", uppercase: true, x: pad, y: oy, w: W - 2 * pad, h: u(100), fit: true, startMs: outroAt + 400, endMs: D, enter: "slide-up" });
    oy += u(100);
  }
  if (input.outroTitle?.trim()) {
    push({ id: "outro-title", kind: "text", text: input.outroTitle.trim(), font: input.locale === "ar" ? "arabic" : "body", size: u(36), weight: 700, color: "@primary",
      align: "center", dir: "auto", uppercase: true, letterSpacing: 2, x: pad, y: oy, w: W - 2 * pad, h: u(56), fit: true, startMs: outroAt + 550, endMs: D, enter: "fade" });
    oy += u(70);
  }
  if (outro.length) {
    const gw = Math.min(W - 2 * pad, L.wide ? W - 4 * pad : W - 2 * pad);
    const gx = round((W - gw) / 2);
    const cw = (gw - gap * (cols - 1)) / cols;
    outro.forEach((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = round(gx + col * (cw + gap));
      const cy = round(oy + row * (ch + gap));
      const start = outroAt + 700 + i * 140;
      push({ id: `outro-stat-bg-${i}`, kind: "shape", shape: "rect", x, y: cy, w: round(cw), h: ch, fill: "#FFFFFF12", radius: u(24), startMs: start, endMs: D, enter: "pop" });
      push({ id: `outro-stat-value-${i}`, kind: "text", text: s.value, font: "display", size: u(92), weight: 800, color: WHITE, align: "center", dir: "ltr",
        x, y: cy + round(ch * 0.1), w: round(cw), h: round(ch * 0.52), fit: true, startMs: start, endMs: D, enter: "pop" });
      push({ id: `outro-stat-label-${i}`, kind: "text", text: s.label, font: input.locale === "ar" ? "arabic" : "body", size: u(30), weight: 600, color: WHITE_SOFT,
        align: "center", dir: "auto", x: x + u(10), y: cy + round(ch * 0.64), w: round(cw) - u(20), h: round(ch * 0.26), fit: true, startMs: start, endMs: D, enter: "pop" });
    });
  }

  // The academy's crest in a corner throughout (the intro and outro without photos already show it big).
  if (input.crest !== false) {
    const c = u(L.wide ? 120 : 130);
    push({ id: "crest-corner", kind: "image", src: { type: "crest" }, fit: "contain", x: W - pad - c, y: H - pad - c - (L.wide ? 0 : u(140)), w: c, h: c,
      startMs: REEL_INTRO_MS, endMs: outroAt, opacity: 0.9 });
  }

  return {
    v: 1,
    format: input.format,
    durationMs: D,
    background: DARK,
    layers,
    locale: input.locale,
    ...(input.music ? { music: { ...input.music, duck: input.footageSound ? true : input.music.duck } } : {}),
  };
}
