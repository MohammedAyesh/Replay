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
  /** 16:9 for a clip (YouTube, WhatsApp, a feed video). Not a template format: clips start here directly. */
  wide: { w: 1920, h: 1080 },
} as const;
export type CreativeFormat = keyof typeof CREATIVE_FORMATS;
export const CREATIVE_FORMAT_KEYS = ["post", "square", "story", "wide"] as const;
/** The formats templates are drawn for. */
export const TEMPLATE_FORMATS = ["post", "square", "story"] as const;

/**
 * Visual families. Two flashy, two subdued, one for kids, plus two photo-led
 * club looks (cinematic: dark crimson smoke and embers; stadium: bright blue
 * stadium night with light rays). Every style works for every academy: the
 * academy's own colours fill the @primary / @accent tokens.
 */
/** The seven house styles every academy can pick. */
export const PUBLIC_STYLES = ["broadcast", "street", "editorial", "luxury", "playful", "cinematic", "stadium"] as const;
/**
 * Brand packs: a style made for one academy from its brand deck. Only the
 * academy whose `creative_pack` names it sees it (see creativePacks.ts).
 */
export const PACK_STYLES = ["iris", "souqar", "barca", "juventus", "knights", "jufa"] as const;
export type PackStyle = (typeof PACK_STYLES)[number];
export const CREATIVE_STYLES = [...PUBLIC_STYLES, ...PACK_STYLES] as const;
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
  /**
   * Shown only when every condition holds for the scene's data (see
   * layerShownFor). A line-up draws its photo tiles when there are player
   * photos and its numbers-only rows when there are none.
   */
  when: z.array(z.object({ path: z.string().max(120), not: z.boolean().optional() })).max(4).optional(),
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
  /** Template artwork shipped with Replay, by key (e.g. "fulltime/broadcast"). `cutout`: it has a transparent background. */
  z.object({ type: z.literal("artwork"), key: z.string().max(120), cutout: z.boolean().optional() }),
  /**
   * A player of the academy: his primary photo (academy_player_photos), else
   * the avatar of his linked account. Only for an academy that shows players'
   * names; the server refuses it otherwise. `cutout`: the photo has a
   * transparent background (a layout draws it as a figure, not a card).
   */
  z.object({ type: z.literal("player"), playerId: z.number().int(), cutout: z.boolean().optional() }),
  /** One photo from a player's gallery (academy_player_photos), same rule as "player". */
  z.object({ type: z.literal("player-photo"), photoId: z.number().int(), cutout: z.boolean().optional() }),
  /** A {{binding}} that resolves to one of the sources above at render time (e.g. "{{player.photo}}"). */
  z.object({ type: z.literal("binding"), path: z.string().max(120) }),
]);
export type MediaSource = z.infer<typeof mediaSourceSchema>;

/**
 * Recolouring a picture with the academy's colour (image layers only).
 *   color     hex or brand token
 *   mode      "color" (default): Photoshop's Color blend — the picture keeps its
 *             own light and dark (white stays white, black stays black) and
 *             takes the tint's hue and saturation. Meant for greyscale plates.
 *             "multiply": darkens towards the tint. "screen": lightens towards it.
 *   amount    0..1 (default 1): how much of the tinted picture shows over the original.
 */
export const TINT_MODES = ["color", "multiply", "screen"] as const;
export type TintMode = (typeof TINT_MODES)[number];
export const tintSchema = z.object({
  color: colorSchema,
  mode: z.enum(TINT_MODES).optional(),
  amount: z.number().min(0).max(1).optional(),
});
export type LayerTint = z.infer<typeof tintSchema>;
/** A tint with its colour resolved to #RRGGBB and its defaults filled. */
export type ResolvedTint = { color: string; mode: TintMode; amount: number };

/**
 * A camera on panoramic footage.
 *   zoom   the window's width as a share of the source's width (0.5 on the
 *          32:9 panorama is a full-height 16:9 window)
 *   keys   [source ms, centre x, centre y]: where the window is centred, as
 *          shares of the source frame, at that time into the source (the same
 *          clock as trimInMs). Between keys it moves in a straight line; before
 *          the first and after the last it holds.
 *   mode   how the keys were made: following the ball, or by hand
 * The window has the box's shape and is kept inside the frame.
 */
export const framingSchema = z.object({
  zoom: z.number().min(0.1).max(1),
  keys: z.array(z.tuple([z.number().min(0), z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(600),
  mode: z.enum(["ball", "manual"]).optional(),
});
export type Framing = z.infer<typeof framingSchema>;

/** Where the framing is centred at `ms` into the source. */
export function framingCentre(framing: Pick<Framing, "keys">, ms: number): [number, number] {
  const keys = framing.keys;
  if (!keys.length) return [0.5, 0.5];
  if (ms <= keys[0][0]) return [keys[0][1], keys[0][2]];
  const last = keys[keys.length - 1];
  if (ms >= last[0]) return [last[1], last[2]];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid][0] <= ms) lo = mid; else hi = mid; }
  const a = keys[lo], b = keys[hi];
  const f = b[0] > a[0] ? (ms - a[0]) / (b[0] - a[0]) : 0;
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * The window's size, as shares of the source: the box's shape, `zoom` of the
 * source's width, shrunk to fit when it would be taller than the source.
 */
export function framingSize(zoom: number, sourceAspect: number, boxAspect: number): { w: number; h: number } {
  let w = Math.max(0.02, Math.min(1, zoom));
  let h = (w * sourceAspect) / boxAspect;
  if (h > 1) { w = boxAspect / sourceAspect; h = 1; }
  if (w > 1) { h = h / w; w = 1; }
  return { w, h };
}

/** The part of the source (x, y, w, h as shares) that fills the box at `ms` into the source. */
export function framingWindow(framing: Framing, ms: number, sourceAspect: number, boxAspect: number): { x: number; y: number; w: number; h: number } {
  const { w, h } = framingSize(framing.zoom, sourceAspect, boxAspect);
  const [cx, cy] = framingCentre(framing, ms);
  const x = Math.max(0, Math.min(1 - w, cx - w / 2));
  const y = Math.max(0, Math.min(1 - h, cy - h / 2));
  return { x, y, w, h };
}

/** The panorama's shape (3840×1080). */
export const PANORAMA_ASPECT = 32 / 9;

/**
 * The venue's branding on a video: its mark over the footage (`overlay`) and
 * its sign-off card after it (`endCard`). Absent: no branding.
 */
export const sceneBrandingSchema = z.object({
  overlay: z.boolean().default(true),
  endCard: z.boolean().default(true),
});
export type SceneBranding = z.infer<typeof sceneBrandingSchema>;

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
    /**
     * A moving camera on panoramic footage: which part of the source fills the
     * box at each moment (see framingWindow). Absent: the whole source, by `fit`.
     */
    framing: framingSchema.optional(),
  }),
  z.object({
    ...baseLayer,
    kind: z.literal("image"),
    src: mediaSourceSchema,
    fit: z.enum(["cover", "contain"]).default("cover"),
    /** Remove the background (player cut-out). */
    cutout: z.boolean().optional(),
    radius: z.number().min(0).optional(),
    /** Recolour the picture (background plates are greyscale and tinted with @primary). */
    tint: tintSchema.optional(),
  }),
  z.object({
    ...baseLayer,
    kind: z.literal("text"),
    /** May contain {{bindings}}. Newlines are kept. */
    text: z.string().max(2000),
    font: z.enum(["display", "condensed", "body", "serif", "script", "arabic", "arabic-display"]).default("body"),
    /**
     * A specific typeface from Replay's font library (creativeFonts.ts), e.g.
     * "Bebas Neue". Overrides `font`; when the family can't be loaded the
     * renderer falls back to `font`. Arabic text still uses `font`'s Arabic face
     * unless the family itself is Arabic.
     */
    family: z.string().regex(/^[A-Za-z0-9 ]{2,40}$/).optional(),
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

/**
 * A video scene's soundtrack (creative_music_tracks, 0063).
 *
 *   trackId   a row of creative_music_tracks: Replay's library or the academy's own upload
 *   trackKey  a bundled file by key (assets/creative/music/<key>.m4a); kept for designs saved
 *             before the library existed. trackId wins when both are set.
 *   volume    0..1, applied after the track is brought to a common loudness
 *   startMs   where in the track the scene starts (the track loops when it is shorter than the scene)
 *   fadeInMs / fadeOutMs  at the scene's start / end
 *   duck      lower the music while unmuted footage has sound (voices, the crowd)
 *
 * Neither trackId nor trackKey: no music.
 */
export const sceneMusicSchema = z.object({
  trackKey: z.string().max(80).optional(),
  trackId: z.number().int().positive().optional(),
  volume: z.number().min(0).max(1).default(0.6),
  startMs: z.number().min(0).max(600_000).optional(),
  fadeInMs: z.number().min(0).max(10_000).optional(),
  fadeOutMs: z.number().min(0).max(10_000).optional(),
  duck: z.boolean().optional(),
});
export type SceneMusic = z.infer<typeof sceneMusicSchema>;

/** A line-up carries two versions of each row (photo tile and numbers-only), so scenes may be large. */
export const MAX_SCENE_LAYERS = 200;

export const sceneSchema = z.object({
  v: z.literal(1),
  format: z.enum(CREATIVE_FORMAT_KEYS),
  /** Present for video scenes; a still has no duration. */
  durationMs: z.number().min(500).max(180_000).optional(),
  background: colorSchema.default("@paper"),
  /** Bottom to top. */
  layers: z.array(sceneLayerSchema).max(MAX_SCENE_LAYERS),
  /** Optional soundtrack: a track of Replay's library or the academy's own (see sceneMusicSchema). */
  music: sceneMusicSchema.optional(),
  /** Which template and style this came from (for re-styling). */
  template: z.object({ key: z.string().max(80), style: z.enum(CREATIVE_STYLES) }).optional(),
  locale: z.enum(["en", "ar"]).default("ar"),
  /** Video scenes: the venue's mark and sign-off card (see sceneBrandingSchema). */
  branding: sceneBrandingSchema.optional(),
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

/** A tint's colour as #RRGGBB (alpha dropped), mode and amount filled; null when there is nothing to do. */
export function resolveTint(tint: LayerTint | undefined | null, brand: CreativeBrand): ResolvedTint | null {
  if (!tint) return null;
  const hex = resolveColor(tint.color, brand, "");
  if (!/^#[0-9a-fA-F]{6}/.test(hex)) return null;
  const amount = Math.max(0, Math.min(1, tint.amount ?? 1));
  if (amount <= 0) return null;
  return { color: hex.slice(0, 7).toUpperCase(), mode: tint.mode ?? "color", amount };
}

// ── Background plates ────────────────────────────────────────────────────────

/**
 * Background plates: text-free greyscale artwork shipped with Replay, tinted
 * with the academy's colour at render time. Files live in
 * artifacts/api-server/assets/creative/artwork/bg/<style>/<n>-<aspect>.png,
 * aspect "post" (4:5) or "story" (9:16). A scene names a plate by the artwork
 * key "bg/<style>/<n>"; the renderer picks the file for the scene's format
 * (story → the story file if there is one, else the post file with cover;
 * post and square → the post file). Every template has one plate layer, id
 * PLATE_LAYER_ID, at the bottom; a missing file draws nothing.
 */
export const PLATE_LAYER_ID = "plate";
export type PlateAspect = "post" | "story";
export const PLATE_KEY = /^bg\/([a-z]+)\/(\d{1,3})$/;

export const plateKey = (style: string, n: number) => `bg/${style}/${n}`;

export function parsePlateKey(key: string): { style: string; n: number } | null {
  const m = PLATE_KEY.exec(key);
  return m ? { style: m[1], n: Number(m[2]) } : null;
}

/** Plate files to try for a format, best first. */
export function plateAspects(format: CreativeFormat | undefined): PlateAspect[] {
  // A wide frame takes the post plate with cover (there is no landscape plate).
  return format === "story" ? ["story", "post"] : ["post", "story"];
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
  /** The picture or footage the template's main slot shows (layers with src {type:"binding", path:"media"}). */
  media?: MediaSource;
  /** Extra pictures/footage for multi-slot templates: media2, media3 … via path "more.0", "more.1". */
  more?: MediaSource[];
  /**
   * Player photos of a list template's rows (line-up, call-up): "photos.0" is
   * row 1. Present only when the academy shows players' names; a line-up
   * without it draws numbers only.
   */
  photos?: Array<MediaSource | null>;
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

/** Does a {{binding}} path hold something (not empty, not false, not an empty list)? */
export function hasValueAt(data: CreativeData | null | undefined, path: string): boolean {
  const v = lookup(data ?? {}, path);
  if (v === undefined || v === null || v === false || v === "") return false;
  if (Array.isArray(v)) return v.some((x) => x !== undefined && x !== null);
  return true;
}

/** Does a layer's `when` hold for this data? A layer without one always shows. */
export function layerShownFor(layer: SceneLayer, data: CreativeData | null | undefined): boolean {
  if (!layer.when?.length) return true;
  return layer.when.every((c) => hasValueAt(data, c.path) !== !!c.not);
}

/**
 * The scene as it draws for this data: layers whose `when` fails are left
 * out. Renderers call this once before drawing (the export and SceneCanvas).
 */
export function sceneForData(scene: Scene, data: CreativeData | null | undefined): Scene {
  if (!scene.layers.some((l) => l.when?.length)) return scene;
  return { ...scene, layers: scene.layers.filter((l) => layerShownFor(l, data)) };
}

export const isVideoScene = (scene: Scene) => scene.durationMs !== undefined;

/** Project lifecycle shared by the API and the console. */
export const CREATIVE_STATUSES = ["draft", "ready", "scheduled", "published", "skipped"] as const;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];
