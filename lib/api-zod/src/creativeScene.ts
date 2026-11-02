import * as z from "zod";

/**
 * Creative hub scene format (academy console → Creative hub).
 *
 * One JSON document describes a post, story or video: its size, its layers and
 * the data they are bound to. The browser previews it (SceneCanvas) and the
 * API renders the same document to PNG or MP4, so what the manager sees is
 * what is exported. Templates are scenes with {{bindings}} left in.
 *
 * Coordinates are real pixels on a 1080-wide canvas (1080×1350, 1080×1080 or
 * 1080×1920). Times are milliseconds from the start of the scene.
 */

export const CREATIVE_FORMATS = {
  post: { w: 1080, h: 1350 },
  square: { w: 1080, h: 1080 },
  story: { w: 1080, h: 1920 },
} as const;
export type CreativeFormat = keyof typeof CREATIVE_FORMATS;

/**
 * Visual families. Two flashy, two subdued, one for kids, plus two photo-led
 * club looks (cinematic: dark crimson smoke and embers; stadium: bright blue
 * stadium night with light rays). Every style works for every academy: the
 * academy's own colours fill the @primary / @accent tokens.
 */
export const CREATIVE_STYLES = ["broadcast", "street", "editorial", "luxury", "playful", "cinematic", "stadium"] as const;
export type CreativeStyle = (typeof CREATIVE_STYLES)[number];

/** A colour is a hex string or a brand token resolved at render time. */
export const COLOR_TOKENS = ["@primary", "@accent", "@ink", "@paper", "@muted"] as const;
const colorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|@(primary|accent|ink|paper|muted))$/);

const baseLayer = {
  id: z.string().min(1).max(64),
  name: z.string().max(80).optional(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  /** Visible from/until (ms). Omitted = the whole scene. */
  startMs: z.number().min(0).optional(),
  endMs: z.number().min(0).optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /** Entrance animation for video scenes. */
  enter: z.enum(["none", "fade", "slide-up", "slide-left", "pop"]).optional(),
};

/** Where a picture or a video comes from. Every source is the academy's own. */
export const mediaSourceSchema = z.discriminatedUnion("type", [
  /** A finished clip a member saved from the academy's footage (user_clips). */
  z.object({ type: z.literal("clip"), clipId: z.number().int() }),
  /** A window of an academy recording (a match moment, a goal). */
  z.object({ type: z.literal("recording"), recordingId: z.number().int(), fromMs: z.number().min(0), toMs: z.number().min(0) }),
  /** Something the academy uploaded (academy_ad_media). */
  z.object({ type: z.literal("upload"), mediaId: z.number().int() }),
  /** One frame of a recording, as a still. */
  z.object({ type: z.literal("frame"), recordingId: z.number().int(), atMs: z.number().min(0) }),
  /** The academy crest from its brand kit. */
  z.object({ type: z.literal("crest") }),
  /** Template artwork shipped with Replay, by key (e.g. "fulltime/broadcast"). */
  z.object({ type: z.literal("artwork"), key: z.string().max(120) }),
  /** A {{binding}} that resolves to one of the sources above at render time (e.g. "{{player.photo}}"). */
  z.object({ type: z.literal("binding"), path: z.string().max(120) }),
]);
export type MediaSource = z.infer<typeof mediaSourceSchema>;

export const sceneLayerSchema = z.discriminatedUnion("kind", [
  z.object({
    ...baseLayer,
    kind: z.literal("video"),
    src: mediaSourceSchema,
    fit: z.enum(["cover", "contain"]).default("cover"),
    /** Part of the source to use (ms into the source). */
    trimInMs: z.number().min(0).default(0),
    trimOutMs: z.number().min(0).optional(),
    speed: z.number().min(0.25).max(4).default(1),
    /** Slow-motion window inside the trimmed source. */
    slowMo: z.object({ fromMs: z.number(), toMs: z.number(), speed: z.number().min(0.1).max(1) }).optional(),
    muted: z.boolean().default(false),
    /** Crop follows a tracked player (match analysis track id). */
    followTrackId: z.number().int().optional(),
  }),
  z.object({
    ...baseLayer,
    kind: z.literal("image"),
    src: mediaSourceSchema,
    fit: z.enum(["cover", "contain"]).default("cover"),
    /** Remove the background (player cut-out). */
    cutout: z.boolean().optional(),
    radius: z.number().min(0).optional(),
  }),
  z.object({
    ...baseLayer,
    kind: z.literal("text"),
    /** May contain {{bindings}}. Newlines are kept. */
    text: z.string().max(2000),
    font: z.enum(["display", "condensed", "body", "serif", "script", "arabic", "arabic-display"]).default("body"),
    size: z.number().min(6).max(600),
    weight: z.number().min(100).max(900).default(700),
    italic: z.boolean().optional(),
    color: colorSchema.default("@ink"),
    align: z.enum(["start", "center", "end"]).default("start"),
    dir: z.enum(["auto", "ltr", "rtl"]).default("auto"),
    uppercase: z.boolean().optional(),
    letterSpacing: z.number().optional(),
    lineHeight: z.number().optional(),
    /** Shrink the size until the text fits the box. */
    fit: z.boolean().optional(),
    stroke: z.object({ color: colorSchema, width: z.number().min(0) }).optional(),
    shadow: z.object({ color: colorSchema, blur: z.number().min(0), x: z.number(), y: z.number() }).optional(),
    background: z.object({ color: colorSchema, padding: z.number().min(0), radius: z.number().min(0) }).optional(),
  }),
  z.object({
    ...baseLayer,
    kind: z.literal("shape"),
    shape: z.enum(["rect", "ellipse", "line", "slant"]),
    fill: colorSchema.optional(),
    /** Linear gradient top → bottom, overrides fill. */
    gradient: z.object({ from: colorSchema, to: colorSchema, angle: z.number().default(180) }).optional(),
    stroke: z.object({ color: colorSchema, width: z.number().min(0) }).optional(),
    radius: z.number().min(0).optional(),
    /** For "slant": horizontal skew in degrees. */
    skew: z.number().optional(),
  }),
]);
export type SceneLayer = z.infer<typeof sceneLayerSchema>;
export type SceneLayerKind = SceneLayer["kind"];

export const sceneSchema = z.object({
  v: z.literal(1),
  format: z.enum(["post", "square", "story"]),
  /** Present for video scenes; a still has no duration. */
  durationMs: z.number().min(500).max(180_000).optional(),
  background: colorSchema.default("@paper"),
  /** Bottom to top. */
  layers: z.array(sceneLayerSchema).max(120),
  /** Optional soundtrack from Replay's library. */
  music: z.object({ trackKey: z.string().max(80), volume: z.number().min(0).max(1).default(0.6) }).optional(),
  /** Which template and style this came from (for re-styling). */
  template: z.object({ key: z.string().max(80), style: z.enum(CREATIVE_STYLES) }).optional(),
  locale: z.enum(["en", "ar"]).default("ar"),
});
export type Scene = z.infer<typeof sceneSchema>;

/** Brand values a scene's tokens resolve to. */
export type CreativeBrand = {
  primary: string;
  accent: string;
  ink: string;
  paper: string;
  muted: string;
  nameEn: string;
  nameAr: string | null;
};

export function resolveColor(color: string | undefined, brand: CreativeBrand, fallback = "#000000"): string {
  if (!color) return fallback;
  switch (color) {
    case "@primary": return brand.primary;
    case "@accent": return brand.accent;
    case "@ink": return brand.ink;
    case "@paper": return brand.paper;
    case "@muted": return brand.muted;
    default: return color;
  }
}

/**
 * Data a scene's {{bindings}} read from. Every field is optional: a template
 * shows its sample text when a value is missing. Names are already filtered by
 * the academy's "show player names" setting before they reach here.
 */
export type CreativeData = {
  academy?: { name?: string; nameAr?: string | null; phone?: string | null; instagram?: string | null };
  match?: {
    ownName?: string; opponent?: string; ownScore?: number; opponentScore?: number;
    date?: string; time?: string; place?: string; squad?: string; competition?: string; stage?: string;
    scorers?: string;
  };
  player?: { name?: string | null; number?: number | null; squad?: string; position?: string; photo?: MediaSource };
  stats?: Record<string, string | number>;
  custom?: Record<string, string>;
};

const BINDING = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function lookup(data: CreativeData, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Fill {{bindings}} in a text. Unknown bindings become "" unless keepMissing. */
export function fillText(text: string, data: CreativeData, keepMissing = false): string {
  return text.replace(BINDING, (whole, path: string) => {
    const v = lookup(data, path);
    if (v === undefined || v === null || typeof v === "object") return keepMissing ? whole : "";
    return String(v);
  });
}

/** Resolve a binding media source to a concrete one, or null. */
export function resolveSource(src: MediaSource, data: CreativeData): Exclude<MediaSource, { type: "binding" }> | null {
  if (src.type !== "binding") return src;
  const v = lookup(data, src.path.replace(/^\{\{\s*|\s*\}\}$/g, ""));
  if (v && typeof v === "object" && "type" in (v as object)) {
    const parsed = mediaSourceSchema.safeParse(v);
    if (parsed.success && parsed.data.type !== "binding") return parsed.data as Exclude<MediaSource, { type: "binding" }>;
  }
  return null;
}

/** Is a layer visible at time t (ms)? Stills: always (t ignored). */
export function layerVisibleAt(layer: SceneLayer, t: number | null): boolean {
  if (layer.hidden) return false;
  if (t === null) return true;
  if (layer.startMs !== undefined && t < layer.startMs) return false;
  if (layer.endMs !== undefined && t >= layer.endMs) return false;
  return true;
}

export const isVideoScene = (scene: Scene) => scene.durationMs !== undefined;

/** Project lifecycle shared by the API and the console. */
export const CREATIVE_STATUSES = ["draft", "ready", "scheduled", "published", "skipped"] as const;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];
