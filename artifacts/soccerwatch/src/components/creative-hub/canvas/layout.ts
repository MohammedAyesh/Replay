import { faceAlias, libraryFont, matchLibraryFace, type SceneLayer } from "@workspace/api-zod";

/**
 * COPY of artifacts/api-server/src/lib/creative/renderLayout.ts — keep the two identical.
 *
 * Creative hub engine: the layout maths both renderers share.
 *
 * The API draws a scene with @napi-rs/canvas; the console previews it with the
 * DOM (components/creative-hub/canvas/layout.ts is a line-for-line copy of
 * this file, because the browser bundle cannot import the API). Anything that
 * decides where a pixel goes lives here, so the two only differ in how glyphs
 * are rasterised: text wrapping and fit-to-box, gradient end points, the slant
 * polygon, cover/contain rectangles, the font a layer uses and the video
 * timeline (trim, speed, slow-motion window).
 *
 * KEEP IN SYNC with artifacts/soccerwatch/src/components/creative-hub/canvas/layout.ts.
 */

type TextLayer = Extract<SceneLayer, { kind: "text" }>;
type VideoLayer = Extract<SceneLayer, { kind: "video" }>;

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const hasArabic = (s: string) => ARABIC.test(s);

const LTR_RUN = /[#@+×]?[A-Za-z0-9](?:[A-Za-z0-9#@+×:.,'’\-–/_ ]*[A-Za-z0-9])?/g;

/** Inside Arabic text, isolate Latin/number runs so "079 543 3320" stays in order (as Studio does). */
export function isolateLtrRuns(text: string): string {
  if (!hasArabic(text)) return text;
  return text.replace(LTR_RUN, (run) => `⁦${run}⁩`);
}

// ── Fonts ────────────────────────────────────────────────────────────────────

/**
 * The faces a text layer uses.
 *
 * House faces: Replay ships Rajdhani (600, 700) and Cairo (700, 900) for the
 * clip branding and Studio; every scene `font` maps onto those, so an export
 * never falls back to a system face. Anything with Arabic in it is set in
 * Cairo whatever the layer's font: Rajdhani has no Arabic.
 *
 *   display, condensed, script → Rajdhani (script is drawn slanted)
 *   body, serif               → Rajdhani (serif has no face of its own yet)
 *   arabic, arabic-display     → Cairo (display is the black weight)
 *
 * Library faces (creativeFonts.ts): a layer's `family` overrides `font` when
 * the family is in the library (and, on the server, its file registered):
 *   - the face is picked by CSS weight matching (matchLibraryFace); italic
 *     uses the family's italic file, else the upright face drawn slanted;
 *     `font: "script"` does not slant a library face (the family is the look);
 *   - text with Arabic in it uses the family only if the family is Arabic
 *     (Cairo, Tajawal, IBM Plex Sans Arabic, Baloo Bhaijaan 2); otherwise the
 *     house mapping above applies, so Bebas Neue never draws tofu;
 *   - an unknown family, or one whose file is missing, falls back to `font`.
 * `arabic` drives the taller line height: Arabic text, or an Arabic family on
 * an arabic / arabic-display layer, as the house Cairo does.
 */
export type HouseFace = { family: "rajdhani" | "cairo"; weight: 600 | 700 | 900; italic: boolean; arabic: boolean };
export type LibraryFace = {
  family: "library";
  /** The library family ("Bebas Neue"). */
  name: string;
  /** The file drawn, and the name it is registered under on both sides. */
  file: string;
  alias: string;
  /** The weight of that file. */
  weight: number;
  /** Drawn slanted (no italic file for the weight asked for). */
  italic: boolean;
  arabic: boolean;
};
export type FontFace = HouseFace | LibraryFace;

/** Is a library file usable? The server answers from what it registered; the browser loads on demand. */
export type FaceAvailable = (file: string) => boolean;

export function fontFace(
  layer: Pick<TextLayer, "font" | "weight" | "italic" | "family">,
  text: string,
  available: FaceAvailable = () => true,
): FontFace {
  const weight = layer.weight ?? 700;
  const font = layer.font ?? "body";
  const arabicFont = font === "arabic" || font === "arabic-display";
  const lib = libraryFont(layer.family);
  if (lib && (lib.isArabic || !hasArabic(text))) {
    const { face, synthItalic } = matchLibraryFace(lib, weight, !!layer.italic);
    if (available(face.file)) {
      return {
        family: "library", name: lib.family, file: face.file, alias: faceAlias(face), weight: face.weight,
        italic: synthItalic, arabic: lib.isArabic && (arabicFont || hasArabic(text)),
      };
    }
  }
  const italic = !!layer.italic || font === "script";
  if (arabicFont || hasArabic(text)) {
    const black = font === "arabic-display" ? weight >= 600 : weight >= 800;
    return { family: "cairo", weight: black ? 900 : 700, italic, arabic: true };
  }
  return { family: "rajdhani", weight: weight >= 650 ? 700 : 600, italic, arabic: false };
}

/** Rendered text direction for a layer and its (filled) text. */
export function textDirection(layer: Pick<TextLayer, "dir">, text: string): "ltr" | "rtl" {
  if (layer.dir === "rtl" || layer.dir === "ltr") return layer.dir;
  return hasArabic(text) ? "rtl" : "ltr";
}

/** The text exactly as drawn: bindings already filled; uppercase applies to Latin only. */
export function displayText(layer: Pick<TextLayer, "uppercase">, filled: string): string {
  return layer.uppercase ? filled.toUpperCase() : filled;
}

// ── Text layout ──────────────────────────────────────────────────────────────

export type MeasureText = (text: string, size: number) => number;

export type TextLayout = {
  size: number;
  lineHeight: number;
  lines: string[];
  widths: number[];
  /** The block (lines + background padding), in box coordinates. */
  block: { x: number; y: number; w: number; h: number };
  /** Each line's left edge and top, in box coordinates. */
  positions: Array<{ x: number; top: number }>;
};

/** Default line height: Arabic needs room for its marks (Studio's numbers). */
export function lineHeightPx(layer: Pick<TextLayer, "lineHeight">, size: number, arabic: boolean, designSize: number): number {
  const lh = layer.lineHeight;
  if (lh === undefined || lh <= 0) return size * (arabic ? 1.45 : 1.15);
  // Small numbers are multipliers (1.1); bigger ones are pixels at the design size.
  return lh <= 4 ? size * lh : lh * (size / designSize);
}

/** Greedy word wrap. Newlines are kept; a word longer than the line stays whole. */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/ +/).filter((w, i, all) => w !== "" || all.length === 1);
    if (!words.length || (words.length === 1 && words[0] === "")) { out.push(""); continue; }
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (!current || measure(next) <= maxWidth) current = next;
      else { out.push(current); current = word; }
    }
    out.push(current);
  }
  return out;
}

/** The next size down when fitting: 5% steps, at least 1 px, never under 6. */
export const nextFitSize = (s: number) => Math.max(6, s - Math.max(1, Math.round(s * 0.05)));

/**
 * Where every line of a text layer goes inside its box (0,0,w,h). The block is
 * centred vertically; lines align to start/centre/end of the reading direction.
 * With `fit`, the size steps down until the wrapped block fits the box.
 */
export function layoutText(
  layer: Pick<TextLayer, "size" | "lineHeight" | "fit" | "align" | "background" | "w" | "h">,
  text: string,
  dir: "ltr" | "rtl",
  arabic: boolean,
  measure: MeasureText,
): TextLayout {
  const pad = layer.background ? layer.background.padding : 0;
  const availW = Math.max(1, layer.w - pad * 2);
  const availH = Math.max(1, layer.h - pad * 2);
  let size = layer.size;
  let lines: string[] = [];
  let widths: number[] = [];
  let lh = 0;
  for (;;) {
    const s = size;
    lines = wrapLines(text, availW, (t) => measure(t, s));
    widths = lines.map((l) => (l ? measure(l, s) : 0));
    lh = lineHeightPx(layer, s, arabic, layer.size);
    if (!layer.fit || s <= 6) break;
    const maxW = Math.max(0, ...widths);
    if (maxW <= availW + 0.5 && lines.length * lh <= availH + 0.5) break;
    size = nextFitSize(s);
  }
  const textW = Math.max(0, ...widths);
  const blockW = textW + pad * 2;
  const blockH = lines.length * lh + pad * 2;
  const align = layer.align ?? "start";
  const right = (align === "start" && dir === "rtl") || (align === "end" && dir === "ltr");
  const blockX = align === "center" ? (layer.w - blockW) / 2 : right ? layer.w - blockW : 0;
  const blockY = (layer.h - blockH) / 2;
  const positions = widths.map((w, i) => ({
    x: align === "center" ? blockX + (blockW - w) / 2 : right ? blockX + blockW - pad - w : blockX + pad,
    top: blockY + pad + i * lh,
  }));
  return { size, lineHeight: lh, lines, widths, block: { x: blockX, y: blockY, w: blockW, h: blockH }, positions };
}

/** Baseline of a line, CSS-style: half the leading above, then the font's ascent. */
export function baselineIn(top: number, lineHeight: number, ascent: number, descent: number): number {
  return top + (lineHeight - (ascent + descent)) / 2 + ascent;
}

// ── Shapes ───────────────────────────────────────────────────────────────────

/** CSS linear-gradient geometry: 0° points up, 90° right, 180° (the default) down. */
export function gradientPoints(w: number, h: number, angleDeg = 180): { x0: number; y0: number; x1: number; y1: number } {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return { x0: w / 2 - dx * half, y0: h / 2 - dy * half, x1: w / 2 + dx * half, y1: h / 2 + dy * half };
}

/** The slant (parallelogram) inside a w×h box; positive skew leans right. Default 12°. */
export function slantPoints(w: number, h: number, skewDeg = 12): Array<[number, number]> {
  const dx = Math.max(-w, Math.min(w, Math.tan((skewDeg * Math.PI) / 180) * h));
  return dx >= 0
    ? [[dx, 0], [w, 0], [w - dx, h], [0, h]]
    : [[0, 0], [w + dx, 0], [w, h], [-dx, h]];
}

/** A line is drawn through the middle of its box, along its longer side. */
export function lineGeometry(w: number, h: number, strokeWidth?: number): { x0: number; y0: number; x1: number; y1: number; width: number } {
  const horizontal = w >= h;
  const width = strokeWidth && strokeWidth > 0 ? strokeWidth : Math.max(1, Math.min(w, h));
  return horizontal ? { x0: 0, y0: h / 2, x1: w, y1: h / 2, width } : { x0: w / 2, y0: 0, x1: w / 2, y1: h, width };
}

/** Source rectangle (cover) or destination rectangle (contain) for a picture in a box. */
export function fitRect(fit: "cover" | "contain", srcW: number, srcH: number, w: number, h: number):
  { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  if (fit === "cover") {
    const k = Math.max(w / srcW, h / srcH);
    const sw = w / k;
    const sh = h / k;
    return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, dx: 0, dy: 0, dw: w, dh: h };
  }
  const k = Math.min(w / srcW, h / srcH);
  const dw = srcW * k;
  const dh = srcH * k;
  return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh };
}

// ── Entrances ────────────────────────────────────────────────────────────────

// One definition for the browser preview, frame previews and the MP4 (lib/api-zod creativeMotion.ts).
export { ENTER_MS, SLIDE_PX, PUSH_MS, entranceAt, blurAt } from "@workspace/api-zod";

// ── Video timeline ───────────────────────────────────────────────────────────

/** One stretch of source played at one speed. Source ms; output ms from the layer's start. */
export type VideoPart = { srcFrom: number; srcTo: number; speed: number; outFrom: number; outTo: number };

/**
 * How a video layer plays its source: trimInMs → trimOutMs at `speed`, with the
 * slow-motion window (source ms, clamped into the trim) at speed × slowMo.speed.
 * `sourceMs` is the source's length when known; without trimOutMs and without
 * it, the source plays for as long as the layer is on screen.
 */
export function videoParts(layer: Pick<VideoLayer, "trimInMs" | "trimOutMs" | "speed" | "slowMo">, sourceMs: number | null, windowMs: number): VideoPart[] {
  const speed = layer.speed && layer.speed > 0 ? layer.speed : 1;
  const from = Math.max(0, layer.trimInMs ?? 0);
  let to = layer.trimOutMs ?? (sourceMs ?? from + windowMs * speed);
  if (sourceMs !== null) to = Math.min(to, sourceMs);
  if (to <= from) to = from + Math.max(1, windowMs * speed);
  const raw: Array<{ a: number; b: number; s: number }> = [];
  const sm = layer.slowMo;
  if (sm && sm.toMs > sm.fromMs && sm.speed > 0) {
    const a = Math.max(from, Math.min(to, sm.fromMs));
    const b = Math.max(from, Math.min(to, sm.toMs));
    raw.push({ a: from, b: a, s: speed }, { a, b, s: speed * sm.speed }, { a: b, b: to, s: speed });
  } else {
    raw.push({ a: from, b: to, s: speed });
  }
  const parts: VideoPart[] = [];
  let out = 0;
  for (const r of raw) {
    if (r.b - r.a < 1) continue;
    const len = (r.b - r.a) / r.s;
    parts.push({ srcFrom: r.a, srcTo: r.b, speed: r.s, outFrom: out, outTo: out + len });
    out += len;
  }
  return parts;
}

/** Source time (ms) and speed at `localMs` after the layer starts. Holds the last frame past the end. */
export function sourceTimeAt(parts: VideoPart[], localMs: number): { srcMs: number; speed: number; ended: boolean } {
  if (!parts.length) return { srcMs: 0, speed: 1, ended: true };
  const t = Math.max(0, localMs);
  for (const p of parts) {
    if (t < p.outTo) return { srcMs: p.srcFrom + (t - p.outFrom) * p.speed, speed: p.speed, ended: false };
  }
  const last = parts[parts.length - 1];
  return { srcMs: last.srcTo, speed: last.speed, ended: true };
}
