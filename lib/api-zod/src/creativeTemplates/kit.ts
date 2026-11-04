import { CREATIVE_FORMATS, type CreativeFormat, type Entrance, type MediaSource, type SceneLayer } from "../creativeScene";

/**
 * Layout kit for the template catalogue. Every layout is written once in
 * left-to-right terms on the 1080-wide canvas; the kit mirrors it for Arabic
 * (x positions, rotations, skews and gradient angles flip, text takes the
 * Arabic fonts and right-to-left direction, and Latin-only tricks such as
 * letter spacing and italics are dropped because they break Arabic joining).
 *
 * Layers that are meant to run off the canvas (street type, light rays) are
 * named "bleed"; everything else stays inside the canvas.
 */

export type Locale = "en" | "ar";
/** A layer's show-condition (SceneLayer.when). */
export type LayerCondition = { path: string; not?: boolean };
export type Box = { x: number; y: number; w: number; h: number };
export type LatinFont = "display" | "condensed" | "body" | "serif" | "script";
export type Timing = { startMs?: number; endMs?: number; enter?: Entrance };

type Common = Timing & {
  name?: string;
  rotation?: number;
  opacity?: number;
  /** false = keep the x as written in Arabic too (full-width layers need not care). */
  mirror?: boolean;
};

export const MARGIN = 72;

/** One layout pass: the canvas, its safe area and the layers so far. */
export class Ctx {
  readonly W = 1080;
  readonly H: number;
  readonly M = MARGIN;
  /** Safe top / bottom. Stories keep clear of Instagram's own bars. */
  readonly T: number;
  readonly B: number;
  /** Type scale for the format (post 1). */
  readonly k: number;
  readonly ar: boolean;
  readonly layers: SceneLayer[] = [];
  private readonly ids = new Set<string>();
  private readonly conditions: LayerCondition[] = [];

  constructor(readonly format: CreativeFormat, readonly locale: Locale) {
    this.H = CREATIVE_FORMATS[format].h;
    this.ar = locale === "ar";
    this.T = format === "story" ? 216 : MARGIN;
    this.B = format === "story" ? this.H - 264 : this.H - MARGIN;
    this.k = format === "square" ? 0.88 : format === "story" ? 1.06 : 1;
  }

  get story() { return this.format === "story"; }
  get square() { return this.format === "square"; }
  /** Content width inside the margins. */
  get CW() { return this.W - 2 * this.M; }
  /** Pick a number per format. */
  pick<T>(post: T, square: T, story: T): T { return this.format === "post" ? post : this.format === "square" ? square : story; }

  mx(x: number, w: number, mirror = true): number { return this.ar && mirror ? this.W - x - w : x; }

  push(layer: SceneLayer): SceneLayer {
    if (this.ids.has(layer.id)) throw new Error(`duplicate layer id ${layer.id}`);
    this.ids.add(layer.id);
    if (this.conditions.length) layer = { ...layer, when: [...(layer.when ?? []), ...this.conditions] } as SceneLayer;
    this.layers.push(layer);
    return layer;
  }

  /** Every layer drawn inside `draw` shows only when `when` holds for the data (SceneLayer.when). */
  only<T>(when: LayerCondition[], draw: () => T): T {
    this.conditions.push(...when);
    try {
      return draw();
    } finally {
      this.conditions.splice(this.conditions.length - when.length, when.length);
    }
  }
}

const r = (n: number) => Math.round(n);

function base(c: Ctx, id: string, b: Box, o: Common) {
  const mirror = o.mirror !== false;
  return {
    id,
    ...(o.name ? { name: o.name } : {}),
    x: r(c.mx(b.x, b.w, mirror)),
    y: r(b.y),
    w: Math.max(1, r(b.w)),
    h: Math.max(1, r(b.h)),
    ...(o.rotation ? { rotation: c.ar && mirror ? -o.rotation : o.rotation } : {}),
    ...(o.opacity !== undefined ? { opacity: o.opacity } : {}),
    ...(o.startMs !== undefined ? { startMs: o.startMs } : {}),
    ...(o.endMs !== undefined ? { endMs: o.endMs } : {}),
    ...(o.enter ? { enter: o.enter } : {}),
  };
}

type ShapeOpts = Common & {
  fill?: string;
  gradient?: { from: string; to: string; angle?: number };
  stroke?: { color: string; width: number };
  radius?: number;
};

function shape(c: Ctx, id: string, kind: "rect" | "ellipse" | "slant", b: Box, o: ShapeOpts, skew?: number) {
  const mirror = o.mirror !== false;
  const angle = o.gradient?.angle ?? 180;
  return c.push({
    ...base(c, id, b, o),
    kind: "shape",
    shape: kind,
    ...(o.fill ? { fill: o.fill } : {}),
    ...(o.gradient ? { gradient: { from: o.gradient.from, to: o.gradient.to, angle: c.ar && mirror ? (360 - angle) % 360 : angle } } : {}),
    ...(o.stroke ? { stroke: o.stroke } : {}),
    ...(o.radius !== undefined ? { radius: o.radius } : {}),
    ...(skew !== undefined ? { skew: c.ar && mirror ? -skew : skew } : {}),
  } as SceneLayer);
}

export const rect = (c: Ctx, id: string, b: Box, o: ShapeOpts = {}) => shape(c, id, "rect", b, o);
export const ellipse = (c: Ctx, id: string, b: Box, o: ShapeOpts = {}) => shape(c, id, "ellipse", b, o);
export const slant = (c: Ctx, id: string, b: Box, skew: number, o: ShapeOpts = {}) => shape(c, id, "slant", b, o, skew);
/** A hairline rule (a thin rect). */
export const rule = (c: Ctx, id: string, x: number, y: number, w: number, color: string, weight = 2, o: Common = {}) =>
  shape(c, id, "rect", { x, y, w, h: weight }, { ...o, fill: color });

export type TextOpts = Common & {
  size: number;
  font?: LatinFont;
  weight?: number;
  color?: string;
  align?: "start" | "center" | "end";
  upper?: boolean;
  ls?: number;
  lh?: number;
  italic?: boolean;
  fit?: boolean;
  shadow?: { color: string; blur: number; x: number; y: number };
  stroke?: { color: string; width: number };
  bg?: { color: string; padding: number; radius: number };
  /**
   * Digits and score punctuation only (a shirt number, a scoreline): keeps
   * the Latin display face and left-to-right order in Arabic too.
   */
  num?: boolean;
  /** Arabic size factor (default 0.82 for display faces, 0.92 for text faces). */
  arScale?: number;
};

const HEADLINE_FONTS: LatinFont[] = ["display", "condensed"];

export function text(c: Ctx, id: string, value: string, b: Box, o: TextOpts): SceneLayer {
  const font = o.font ?? "body";
  const display = HEADLINE_FONTS.includes(font);
  let align = o.align ?? "start";
  const layer: Record<string, unknown> = { ...base(c, id, b, o), kind: "text", text: value };
  if (c.ar && !o.num) {
    layer.font = display || font === "script" ? "arabic-display" : "arabic";
    layer.dir = "rtl";
    layer.size = r(o.size * (o.arScale ?? (display ? 0.82 : 0.92)));
    if (o.lh !== undefined) layer.lineHeight = Math.max(o.lh, 1.2);
  } else {
    layer.font = font;
    layer.dir = "ltr";
    layer.size = r(o.size);
    if (o.italic) layer.italic = true;
    if (o.ls) layer.letterSpacing = o.ls;
    if (o.lh !== undefined) layer.lineHeight = o.lh;
    if (o.upper) layer.uppercase = true;
    // A left-to-right run in an Arabic layout still sits on the mirrored side.
    if (c.ar && o.num && o.mirror !== false) align = align === "start" ? "end" : align === "end" ? "start" : align;
  }
  layer.size = Math.min(600, Math.max(6, layer.size as number));
  layer.weight = o.weight ?? 700;
  layer.color = o.color ?? "@ink";
  layer.align = align;
  if (o.fit) layer.fit = true;
  if (o.shadow) layer.shadow = o.shadow;
  if (o.stroke) layer.stroke = o.stroke;
  if (o.bg) layer.background = o.bg;
  return c.push(layer as SceneLayer);
}

type ImageOpts = Common & { fit?: "cover" | "contain"; radius?: number; cutout?: boolean; when?: LayerCondition[] };

export function image(c: Ctx, id: string, src: MediaSource, b: Box, o: ImageOpts = {}): SceneLayer {
  return c.push({
    ...base(c, id, b, o),
    kind: "image",
    src,
    fit: o.fit ?? "cover",
    ...(o.radius !== undefined ? { radius: o.radius } : {}),
    ...(o.cutout ? { cutout: true } : {}),
    ...(o.when?.length ? { when: o.when } : {}),
  } as SceneLayer);
}

/** The template's main picture slot (data.media), or an extra one ("more.0"). */
export const media = (c: Ctx, id: string, b: Box, o: ImageOpts & { path?: string } = {}) =>
  image(c, id, { type: "binding", path: o.path ?? "media" }, b, o);

export const crest = (c: Ctx, id: string, b: Box, o: Common = {}) =>
  image(c, id, { type: "crest" }, b, { ...o, fit: "contain" });

export function video(c: Ctx, id: string, b: Box, o: Common & { path?: string; muted?: boolean } = {}): SceneLayer {
  return c.push({
    ...base(c, id, b, o),
    kind: "video",
    src: { type: "binding", path: o.path ?? "media" },
    fit: "cover",
    trimInMs: 0,
    speed: 1,
    muted: o.muted ?? false,
  } as SceneLayer);
}

/** Full canvas box. */
export const full = (c: Ctx): Box => ({ x: 0, y: 0, w: c.W, h: c.H });

/**
 * Under a photo box that fades into the background colour (#RRGGBB): that
 * colour fading out again over the next stretch, so the background plate
 * (PLATE_LAYER_ID) below meets the photo without a hard line. Over a plain
 * background it is the background colour on itself, so it changes nothing.
 */
export function seam(c: Ctx, id: string, y: number, color: string, h = Math.round(c.H * 0.2)) {
  // Starts 2px up, over the end of the photo's fade, so the two edges never leave an antialiased hairline.
  const top = Math.round(y) - 2;
  const hh = Math.min(h + 2, c.H - top);
  if (hh < 8) return;
  rect(c, id, { x: 0, y: top, w: c.W, h: hh }, { gradient: { from: color, to: `${color.slice(0, 7)}00` } });
}
