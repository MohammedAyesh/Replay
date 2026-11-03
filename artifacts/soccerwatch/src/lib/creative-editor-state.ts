import {
  buildTemplateScene,
  clampPhotoVideoMs,
  CREATIVE_FORMATS,
  hasMusic,
  isPhotoVideo,
  PHOTO_VIDEO_DEFAULT_MS,
  parsePlateKey,
  PLATE_LAYER_ID,
  templatePlateLayer,
  type LayerTint,
  type CreativeData,
  type CreativeFormat,
  type CreativeStyle,
  type MediaSource,
  type Scene,
  type SceneLayer,
  type SceneMusic,
} from "@workspace/api-zod";

/**
 * Creative hub → Editor: the scene being edited, as pure functions.
 *
 * The editor keeps the scene in a reducer with an undo/redo history. A burst
 * of changes of the same kind to the same layer (a drag on the canvas, typing,
 * a slider) collapses into one undo step when the changes come within
 * COALESCE_MS of each other. Times are passed in so tests control them.
 */

export const COALESCE_MS = 1000;
export const HISTORY_LIMIT = 100;
const CANVAS_W = 1080;

export type MediaLayer = Extract<SceneLayer, { kind: "image" | "video" }>;
export type TextLayer = Extract<SceneLayer, { kind: "text" }>;
export type VideoLayer = Extract<SceneLayer, { kind: "video" }>;
export type ShapeLayer = Extract<SceneLayer, { kind: "shape" }>;

/** A change to one layer: a partial of any one kind's props (fields the layer lacks are harmless). */
type Change<L> = Partial<Omit<L, "kind" | "id">>;
export type LayerChange = Change<TextLayer> | Change<VideoLayer> | Change<Extract<SceneLayer, { kind: "image" }>> | Change<ShapeLayer>;

export type EditorState = {
  scene: Scene;
  past: Scene[];
  future: Scene[];
  /** Coalescing key of the last recorded change, and when it happened. */
  lastKey: string | null;
  lastAt: number;
  /** Bumped on every change to the scene; the autosave watches it. */
  revision: number;
  /**
   * The template's recommended music (setAutoMusic), put on the design the
   * first time it turns from a still into a video without music; once only,
   * so music the manager removes stays removed.
   */
  autoMusic: SceneMusic | null;
  autoMusicUsed: boolean;
};

export type EditorAction =
  | { type: "load"; scene: Scene }
  | { type: "updateLayer"; id: string; change: LayerChange; key?: string; at?: number }
  | { type: "addLayer"; layer: SceneLayer; index?: number }
  | { type: "removeLayer"; id: string }
  | { type: "duplicateLayer"; id: string; newId?: string }
  | { type: "moveLayer"; id: string; to: "up" | "down" | "top" | "bottom" | number }
  | { type: "updateScene"; change: Partial<Pick<Scene, "durationMs" | "background" | "music" | "branding" | "slowZoom">>; key?: string; at?: number }
  /**
   * Editor → Music on a still: put music on it, which makes it a short video
   * (photoVideoFrom). `music` is the track the manager picked; without one the
   * template's recommendation (setAutoMusic) goes on. No music, no change.
   * On a video it just sets the music.
   */
  | { type: "addMusic"; music?: SceneMusic | null; durationMs?: number }
  /** A photo video back to the photo it was (photoFrom): music, duration and zoom go. */
  | { type: "backToPhoto" }
  | { type: "setFormat"; format: CreativeFormat }
  | { type: "setStyle"; style: CreativeStyle }
  | { type: "setPlate"; change: PlateChange; key?: string; at?: number }
  | { type: "setAutoMusic"; music: SceneMusic | null }
  | { type: "checkpoint" }
  | { type: "undo" }
  | { type: "redo" };

export function createEditorState(scene: Scene): EditorState {
  return { scene, past: [], future: [], lastKey: null, lastAt: 0, revision: 0, autoMusic: null, autoMusicUsed: false };
}

/**
 * `next` with `music` on it when this change turns a still (`prev`) into a
 * video and the video has no music; otherwise `next` itself.
 */
export function withAutoMusic(prev: Scene, next: Scene, music: SceneMusic | null | undefined): Scene {
  if (!music || prev.durationMs !== undefined || next.durationMs === undefined || hasMusic(next.music)) return next;
  return { ...next, music: { ...music } };
}

// ── Photos with music ───────────────────────────────────────────────────────

/** A layer's timing in a scene of `durationMs`: kept when it still makes sense, else the whole scene. */
function spanLayer(layer: SceneLayer, durationMs: number): SceneLayer {
  if (layer.startMs === undefined && layer.endMs === undefined) return layer;
  const start = clamp(layer.startMs ?? 0, 0, durationMs);
  const end = clamp(layer.endMs ?? durationMs, 0, durationMs);
  const next = { ...layer };
  delete next.startMs;
  delete next.endMs;
  if (end - start < 500) return next;
  if (start > 0) next.startMs = start;
  if (end < durationMs) next.endMs = end;
  return next;
}

/**
 * A still as a short video with music (Instagram takes music only inside a
 * video): the design held on screen for `durationMs` (the format's default,
 * kept within 5–30 s), every layer on screen the whole time unless it had a
 * sensible timing of its own, the music on, and the slow zoom on.
 */
export function photoVideoFrom(scene: Scene, music: SceneMusic, durationMs?: number): Scene {
  const D = clampPhotoVideoMs(durationMs ?? PHOTO_VIDEO_DEFAULT_MS[scene.format] ?? PHOTO_VIDEO_DEFAULT_MS.post);
  return { ...scene, durationMs: D, layers: scene.layers.map((l) => spanLayer(l, D)), music: { ...music }, slowZoom: true };
}

/** A photo video back to a still: no duration, no music, no zoom (stills ignore layer timing). */
export function photoFrom(scene: Scene): Scene {
  const next = { ...scene };
  delete next.durationMs;
  delete next.music;
  delete next.slowZoom;
  return next;
}

export const canUndo = (s: EditorState) => s.past.length > 0;
export const canRedo = (s: EditorState) => s.future.length > 0;

/** Record a new scene; merge it into the previous undo step when it continues the same gesture. */
function commit(state: EditorState, changed: Scene, key: string | null = null, at = 0): EditorState {
  if (changed === state.scene) return state;
  const scene = state.autoMusicUsed ? changed : withAutoMusic(state.scene, changed, state.autoMusic);
  const coalesce = key !== null && key === state.lastKey && at - state.lastAt <= COALESCE_MS;
  const past = coalesce ? state.past : [...state.past, state.scene].slice(-HISTORY_LIMIT);
  return { ...state, scene, past, future: [], lastKey: key, lastAt: at, revision: state.revision + 1, autoMusicUsed: state.autoMusicUsed || scene !== changed };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return { ...createEditorState(action.scene), revision: state.revision, autoMusic: state.autoMusic, autoMusicUsed: state.autoMusicUsed };
    case "updateLayer":
      return commit(state, updateLayer(state.scene, action.id, action.change), action.key ?? null, action.at ?? 0);
    case "addLayer":
      return commit(state, addLayer(state.scene, action.layer, action.index));
    case "removeLayer":
      return commit(state, removeLayer(state.scene, action.id));
    case "duplicateLayer":
      return commit(state, duplicateLayer(state.scene, action.id, action.newId).scene);
    case "moveLayer":
      return commit(state, moveLayer(state.scene, action.id, action.to));
    case "updateScene":
      return commit(state, { ...state.scene, ...action.change }, action.key ?? null, action.at ?? 0);
    case "setFormat":
      return commit(state, changeFormat(state.scene, action.format));
    case "setStyle":
      return commit(state, changeStyle(state.scene, action.style));
    case "setPlate":
      return commit(state, setPlate(state.scene, action.change), action.key ?? null, action.at ?? 0);
    case "addMusic": {
      const music = action.music ?? state.autoMusic;
      if (!hasMusic(music)) return state;
      const next = state.scene.durationMs === undefined
        ? photoVideoFrom(state.scene, music, action.durationMs)
        : { ...state.scene, music: { ...music } };
      // Asked for: the template's once-only music has had its turn.
      return { ...commit(state, next), autoMusicUsed: true };
    }
    case "backToPhoto":
      return isPhotoVideo(state.scene) ? commit(state, photoFrom(state.scene)) : state;
    case "setAutoMusic":
      return JSON.stringify(state.autoMusic) === JSON.stringify(action.music) ? state : { ...state, autoMusic: action.music };
    case "checkpoint":
      return { ...state, lastKey: null };
    case "undo": {
      if (!state.past.length) return state;
      const prev = state.past[state.past.length - 1]!;
      return { ...state, scene: prev, past: state.past.slice(0, -1), future: [state.scene, ...state.future], lastKey: null, lastAt: 0, revision: state.revision + 1 };
    }
    case "redo": {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return { ...state, scene: next!, past: [...state.past, state.scene], future: rest, lastKey: null, lastAt: 0, revision: state.revision + 1 };
    }
  }
}

// ── Layers ──────────────────────────────────────────────────────────────────

export const findLayer = (scene: Scene, id: string | null | undefined) => (id ? scene.layers.find((l) => l.id === id) ?? null : null);

export function updateLayer(scene: Scene, id: string, change: LayerChange): Scene {
  let changed = false;
  const layers = scene.layers.map((l) => {
    if (l.id !== id) return l;
    const next = { ...l } as Record<string, unknown>;
    for (const [k, v] of Object.entries(change)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    if (shallowEqual(next, l as Record<string, unknown>)) return l;
    changed = true;
    return next as SceneLayer;
  });
  return changed ? { ...scene, layers } : scene;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]) || JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export function addLayer(scene: Scene, layer: SceneLayer, index?: number): Scene {
  if (scene.layers.length >= 120) return scene;
  const layers = [...scene.layers];
  const at = index === undefined ? layers.length : Math.max(0, Math.min(layers.length, index));
  layers.splice(at, 0, { ...layer, id: uniqueLayerId(scene, layer.id) });
  return { ...scene, layers };
}

export function removeLayer(scene: Scene, id: string): Scene {
  const layers = scene.layers.filter((l) => l.id !== id);
  return layers.length === scene.layers.length ? scene : { ...scene, layers };
}

export function duplicateLayer(scene: Scene, id: string, newId?: string): { scene: Scene; id: string | null } {
  const i = scene.layers.findIndex((l) => l.id === id);
  if (i < 0 || scene.layers.length >= 120) return { scene, id: null };
  const src = scene.layers[i]!;
  const copyId = uniqueLayerId(scene, newId ?? `${src.id}-copy`);
  const copy = { ...src, id: copyId, x: src.x + 30, y: src.y + 30, locked: undefined } as SceneLayer;
  const layers = [...scene.layers];
  layers.splice(i + 1, 0, copy);
  return { scene: { ...scene, layers }, id: copyId };
}

/** Move a layer in the stack. "up" = towards the top (drawn later). */
export function moveLayer(scene: Scene, id: string, to: "up" | "down" | "top" | "bottom" | number): Scene {
  const i = scene.layers.findIndex((l) => l.id === id);
  if (i < 0) return scene;
  const last = scene.layers.length - 1;
  const target = to === "up" ? i + 1 : to === "down" ? i - 1 : to === "top" ? last : to === "bottom" ? 0 : to;
  const j = Math.max(0, Math.min(last, target));
  if (j === i) return scene;
  const layers = [...scene.layers];
  const [layer] = layers.splice(i, 1);
  layers.splice(j, 0, layer!);
  return { ...scene, layers };
}

export function uniqueLayerId(scene: Scene, base: string): string {
  const ids = new Set(scene.layers.map((l) => l.id));
  const clean = base.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56) || "layer";
  if (!ids.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const id = `${clean}-${n}`;
    if (!ids.has(id)) return id;
  }
}

export const canvasHeight = (format: CreativeFormat) => CREATIVE_FORMATS[format].h;
/** Every format is 1080 wide except the 16:9 clip format. */
export const canvasWidth = (format: CreativeFormat) => CREATIVE_FORMATS[format].w;
/** Height over width. */
export const canvasRatio = (format: CreativeFormat) => CREATIVE_FORMATS[format].h / CREATIVE_FORMATS[format].w;

// ── New layers ──────────────────────────────────────────────────────────────

export function newTextLayer(scene: Scene, text: string): TextLayer {
  const h = canvasHeight(scene.format);
  return {
    id: uniqueLayerId(scene, "text"), kind: "text", text,
    font: scene.locale === "ar" ? "arabic-display" : "display", size: 96, weight: 800,
    color: "@ink", align: "center", dir: "auto",
    x: 90, y: Math.round(h / 2 - 80), w: 900, h: 160, fit: true
  };
}

export function newShapeLayer(scene: Scene, shape: ShapeLayer["shape"]): ShapeLayer {
  const h = canvasHeight(scene.format);
  const base = { id: uniqueLayerId(scene, shape), kind: "shape" as const, shape, fill: "@primary" };
  if (shape === "line") return { ...base, x: 140, y: Math.round(h / 2) - 6, w: 800, h: 12, fill: "@accent" };
  if (shape === "slant") return { ...base, x: 0, y: Math.round(h * 0.7), w: 1080, h: 180, skew: -12 };
  if (shape === "ellipse") return { ...base, x: 390, y: Math.round(h / 2 - 150), w: 300, h: 300 };
  return { ...base, x: 140, y: Math.round(h / 2 - 150), w: 800, h: 300, radius: 24 };
}

export function newMediaLayer(scene: Scene, kind: "image" | "video", src: MediaSource, durationMs?: number): MediaLayer {
  const h = canvasHeight(scene.format);
  const W = canvasWidth(scene.format);
  const base = { id: uniqueLayerId(scene, kind === "video" ? "video" : src.type === "crest" ? "crest" : "picture"), src };
  if (src.type === "crest") return { ...base, kind: "image", fit: "contain", x: 440, y: 60, w: 200, h: 200 };
  if (kind === "image") return { ...base, kind: "image", fit: "cover", x: 140, y: Math.round(h / 2 - 300), w: 800, h: 600, radius: 24 };
  const span = src.type === "recording" ? Math.max(0, src.toMs - src.fromMs) : durationMs;
  return {
    ...base, kind: "video", fit: "cover", x: 0, y: 0, w: W, h,
    trimInMs: 0, ...(span ? { trimOutMs: span } : {}), speed: 1, muted: false,
  };
}

// ── Background plate ────────────────────────────────────────────────────────

export type ImageLayer = Extract<SceneLayer, { kind: "image" }>;
/** A change to the background plate: another picture, its tint (null removes it), shown or not, how strongly. */
export type PlateChange = { src?: MediaSource; tint?: LayerTint | null; hidden?: boolean; opacity?: number };

export const plateOf = (scene: Scene): ImageLayer | null => {
  const l = findLayer(scene, PLATE_LAYER_ID);
  return l && l.kind === "image" ? l : null;
};

/**
 * Change the background plate (Style panel → Background). A design without
 * one (made before plates, or the manager deleted it) gets the style's plate
 * back where the template puts it, unless the change only hides it.
 */
export function setPlate(scene: Scene, change: PlateChange, build: typeof buildTemplateScene = buildTemplateScene): Scene {
  const patch: LayerChange = {
    ...(change.src ? { src: change.src } : {}),
    ...("tint" in change ? { tint: change.tint ?? undefined } : {}),
    ...("hidden" in change ? { hidden: change.hidden ? true : undefined } : {}),
    ...(change.opacity !== undefined ? { opacity: change.opacity >= 1 ? undefined : Math.max(0, change.opacity) } : {}),
  };
  if (plateOf(scene)) return updateLayer(scene, PLATE_LAYER_ID, patch);
  if (findLayer(scene, PLATE_LAYER_ID) || change.hidden) return scene;
  const style = scene.template?.style ?? "broadcast";
  const fresh = templatePlateLayer(style, scene.format, scene.template?.key);
  // Where the template puts it: right above the layer under it in a fresh build (stadium's sky), else at the bottom.
  let index = 0;
  if (scene.template) {
    try {
      const built = build(scene.template.key, style, scene.format, scene.locale).layers;
      const below = built[built.findIndex((l) => l.id === PLATE_LAYER_ID) - 1];
      const at = below ? scene.layers.findIndex((l) => l.id === below.id) : -1;
      if (at >= 0) index = at + 1;
    } catch { /* bottom */ }
  }
  const layers = [...scene.layers];
  layers.splice(index, 0, updateLayer({ ...scene, layers: [fresh] }, PLATE_LAYER_ID, patch).layers[0]!);
  return { ...scene, layers };
}

// ── Format: proportional re-layout ──────────────────────────────────────────

/**
 * Re-lay a scene onto another format (the portrait ones are all 1080 wide, so
 * only the height changes; the 16:9 one is 1920 wide and is scaled across). Full-bleed layers stretch to cover the new canvas; edge-anchored
 * layers stay on their edge; everything else keeps its relative vertical
 * position, shrinks when the canvas gets shorter, and is kept inside the canvas.
 */
export function changeFormat(scene: Scene, format: CreativeFormat): Scene {
  if (scene.format === format) return scene;
  // Work on a 1080-wide copy (the 16:9 format is 1920 wide), re-lay its height, scale back out.
  const k0 = CANVAS_W / canvasWidth(scene.format);
  const k1 = canvasWidth(format) / CANVAS_W;
  const H0 = canvasHeight(scene.format) * k0;
  const H1 = canvasHeight(format) / k1;
  const relaid = relayHeight(scaleScene(scene, k0), H0, H1);
  return { ...scaleScene(relaid, k1), format };
}

/** Every layer (and text size) scaled by k about the top-left. */
function scaleScene(scene: Scene, k: number): Scene {
  if (k === 1) return scene;
  const layers = scene.layers.map((layer): SceneLayer => {
    const out = { ...layer, x: round(layer.x * k), y: round(layer.y * k), w: round(layer.w * k), h: round(layer.h * k) } as SceneLayer;
    if (out.kind === "text") out.size = clamp(round(out.size * k), 6, 600);
    return out;
  });
  return { ...scene, layers };
}

/** Re-lay a 1080-wide scene from a canvas H0 tall onto one H1 tall (the rules above). */
function relayHeight(scene: Scene, H0: number, H1: number): Scene {
  if (Math.abs(H0 - H1) < 0.5) return scene;
  const k = H1 / H0;
  const s = k < 1 ? Math.sqrt(k) : 1;
  const layers = scene.layers.map((layer): SceneLayer => {
    const fullBleed = layer.x <= 1 && layer.w >= CANVAS_W - 2 && layer.y <= 1 && layer.y + layer.h >= H0 - 1;
    if (fullBleed) return { ...layer, x: Math.min(layer.x, 0), y: Math.min(layer.y, 0), w: Math.max(layer.w, CANVAS_W), h: H1 };
    const wide = layer.w >= CANVAS_W * 0.95;
    let w = wide ? layer.w : layer.w * s;
    let h = layer.h * s;
    if (h > H1) { const f = H1 / h; h = H1; if (!wide) w *= f; }
    if (w > CANVAS_W && !wide) { const f = CANVAS_W / w; w = CANVAS_W; h *= f; }
    const cx = layer.x + layer.w / 2;
    let x = wide ? layer.x : cx - w / 2;
    let y: number;
    if (layer.y <= 1) y = Math.max(layer.y, 0);
    else if (layer.y + layer.h >= H0 - 1) y = H1 - h;
    else y = (layer.y + layer.h / 2) * k - h / 2;
    y = clamp(y, 0, H1 - h);
    if (!wide) x = clamp(x, 0, CANVAS_W - w);
    const out = { ...layer, x: round(x), y: round(y), w: round(w), h: round(h) } as SceneLayer;
    if (out.kind === "text" && s !== 1) out.size = clamp(round(out.size * Math.min(s, h / layer.h)), 6, 600);
    return out;
  });
  return { ...scene, layers };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 10) / 10;

// ── Style: rebuild from the template, keep what the manager made ────────────

const sameSource = (a: MediaSource | undefined, b: MediaSource | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isMedia = (l: SceneLayer | undefined): l is MediaLayer => !!l && (l.kind === "image" || l.kind === "video");
const bindingPath = (l: SceneLayer | undefined) => (isMedia(l) && l.src.type === "binding" ? l.src.path : null);

/**
 * Rebuild the scene from its template in another style. What the manager did
 * on top of the template is carried over, matched by layer id: text they
 * edited, pictures/videos they put in a slot (with the video's trim, speed and
 * slow motion), layers they hid, layers they removed, layers they added, the
 * duration, the music and the slow zoom. Without a template the scene is left alone.
 */
export function changeStyle(scene: Scene, style: CreativeStyle, build: typeof buildTemplateScene = buildTemplateScene): Scene {
  const tpl = scene.template;
  if (!tpl || tpl.style === style) return scene;
  let orig: Scene;
  let next: Scene;
  try {
    orig = build(tpl.key, tpl.style, scene.format, scene.locale);
    next = build(tpl.key, style, scene.format, scene.locale);
  } catch {
    return scene;
  }
  const origById = new Map(orig.layers.map((l) => [l.id, l]));
  const curById = new Map(scene.layers.map((l) => [l.id, l]));
  const removed = new Set(orig.layers.filter((l) => !curById.has(l.id)).map((l) => l.id));
  const usedMediaTargets = new Set<string>();

  const layers: SceneLayer[] = [];
  for (const fresh of next.layers) {
    if (removed.has(fresh.id)) continue;
    const cur = curById.get(fresh.id);
    const was = origById.get(fresh.id);
    let out: SceneLayer = fresh;
    if (fresh.id === PLATE_LAYER_ID && cur?.kind === "image" && fresh.kind === "image") {
      out = carryPlate(fresh, cur, was?.kind === "image" ? was : undefined);
    } else if (cur && cur.kind === fresh.kind) {
      if (cur.kind === "text" && out.kind === "text" && (!was || was.kind !== "text" || was.text !== cur.text)) out = { ...out, text: cur.text };
      if (isMedia(cur) && isMedia(out) && !sameSource(cur.src, isMedia(was) ? was.src : undefined)) {
        out = carryMedia(out, cur);
        usedMediaTargets.add(out.id);
      }
      if (cur.hidden) out = { ...out, hidden: true };
    }
    layers.push(out);
  }

  // A slot the manager filled whose id the new style does not have: fill the
  // new style's slot bound to the same {{binding}} instead.
  for (const cur of scene.layers) {
    const was = origById.get(cur.id);
    if (!isMedia(cur) || !was || layers.some((l) => l.id === cur.id) || sameSource(cur.src, isMedia(was) ? was.src : undefined)) continue;
    const path = bindingPath(was);
    if (!path) continue;
    const i = layers.findIndex((l) => bindingPath(l) === path && !usedMediaTargets.has(l.id));
    if (i >= 0) { layers[i] = carryMedia(layers[i] as MediaLayer, cur); usedMediaTargets.add(layers[i]!.id); }
  }

  // Layers the manager added on top of the template keep their place on top.
  for (const cur of scene.layers) if (!origById.has(cur.id) && !layers.some((l) => l.id === cur.id)) layers.push(cur);

  return {
    ...next,
    layers,
    template: { key: tpl.key, style },
    durationMs: scene.durationMs !== orig.durationMs ? scene.durationMs : next.durationMs,
    music: scene.music ?? next.music,
    ...(scene.slowZoom ? { slowZoom: true } : {}),
  };
}

/**
 * The background plate in the new style: the new style's own artwork (plates
 * are drawn per style), with the manager's tint, strength and hiding carried.
 * A picture of their own in the plate's place is carried too.
 */
function carryPlate(fresh: ImageLayer, cur: ImageLayer, was: ImageLayer | undefined): ImageLayer {
  const out: ImageLayer = { ...fresh };
  const ownPicture = !sameSource(cur.src, was?.src) && !(cur.src.type === "artwork" && parsePlateKey(cur.src.key));
  if (ownPicture) out.src = cur.src;
  if (JSON.stringify(cur.tint ?? null) !== JSON.stringify(was?.tint ?? null)) {
    if (cur.tint) out.tint = cur.tint; else delete out.tint;
  }
  if (cur.opacity !== was?.opacity) {
    if (cur.opacity === undefined) delete out.opacity; else out.opacity = cur.opacity;
  }
  if (cur.hidden) out.hidden = true;
  return out;
}

function carryMedia(target: MediaLayer, from: MediaLayer): MediaLayer {
  const out = { ...target, src: from.src } as MediaLayer;
  if (out.kind === "video" && from.kind === "video") {
    out.trimInMs = from.trimInMs;
    out.trimOutMs = from.trimOutMs;
    out.speed = from.speed;
    out.slowMo = from.slowMo;
    out.muted = from.muted;
  }
  return out;
}

// ── Video timing ────────────────────────────────────────────────────────────

/** The source length a video layer can be trimmed within, when known. */
export function videoSourceMs(layer: VideoLayer): number | null {
  if (layer.src.type === "recording") return Math.max(0, layer.src.toMs - layer.src.fromMs);
  return layer.trimOutMs ?? null;
}

/** How long a video layer plays on screen: trimmed span at its speed, slow-motion window slower. */
export function videoPlayMs(layer: VideoLayer): number | null {
  const out = layer.trimOutMs ?? (layer.src.type === "recording" ? layer.src.toMs - layer.src.fromMs : null);
  if (out === null) return null;
  const span = Math.max(0, out - (layer.trimInMs ?? 0));
  const speed = layer.speed ?? 1;
  const sm = layer.slowMo;
  if (!sm) return Math.round(span / speed);
  const from = clamp(sm.fromMs, layer.trimInMs ?? 0, out);
  const to = clamp(sm.toMs, from, out);
  return Math.round((span - (to - from)) / speed + (to - from) / sm.speed);
}

/** A layer's visible window [start, end) in a scene of the given length. */
export function layerWindow(layer: SceneLayer, durationMs: number): { start: number; end: number } {
  const start = clamp(layer.startMs ?? 0, 0, durationMs);
  const end = clamp(layer.endMs ?? durationMs, start, durationMs);
  return { start, end };
}

/**
 * New visible window after dragging a timeline bar: "move" shifts it, "start"
 * / "end" trim one side. Snapped to `snap` ms, kept inside the scene and at
 * least `minMs` long. A window that covers the whole scene is stored as "no
 * window" (start/end omitted).
 */
export function dragWindow(
  win: { start: number; end: number }, edge: "move" | "start" | "end", deltaMs: number, durationMs: number, snap = 100, minMs = 200,
): { startMs: number | undefined; endMs: number | undefined } {
  const q = (v: number) => Math.round(v / snap) * snap;
  let { start, end } = win;
  if (edge === "move") {
    const len = end - start;
    start = clamp(q(start + deltaMs), 0, durationMs - len);
    end = start + len;
  } else if (edge === "start") {
    start = clamp(q(start + deltaMs), 0, end - minMs);
  } else {
    end = clamp(q(end + deltaMs), start + minMs, durationMs);
  }
  return { startMs: start <= 0 ? undefined : start, endMs: end >= durationMs ? undefined : end };
}

// ── Data (project.data) ─────────────────────────────────────────────────────

const NUMERIC_FIELDS = new Set(["match.ownScore", "match.opponentScore", "player.number"]);
export const isNumericField = (path: string) => NUMERIC_FIELDS.has(path);
export const isMediaField = (path: string) => path === "media" || path === "player.photo" || /^(more|photos)\.\d+$/.test(path);

export function getPath(data: CreativeData | null | undefined, path: string): unknown {
  let cur: unknown = data ?? {};
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Set a dotted path immutably; undefined / "" removes the value. Arrays are kept for numeric keys ("more.0"). */
export function setPath(data: CreativeData | null | undefined, path: string, value: unknown): CreativeData {
  const parts = path.split(".");
  const go = (node: unknown, i: number): unknown => {
    const key = parts[i]!;
    const isIndex = /^\d+$/.test(key);
    const base: Record<string, unknown> | unknown[] = Array.isArray(node) ? [...node] : node && typeof node === "object" ? { ...(node as Record<string, unknown>) } : isIndex ? [] : {};
    const container = base as Record<string, unknown>;
    if (i === parts.length - 1) {
      if (value === undefined || value === "") {
        if (Array.isArray(base)) base[Number(key)] = undefined; else delete container[key];
      } else container[key] = value;
    } else {
      container[key] = go(container[key], i + 1);
    }
    return base;
  };
  return go(data ?? {}, 0) as CreativeData;
}

/** Turn what was typed into a field into the value stored. */
export function parseFieldValue(path: string, raw: string): string | number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  if (isNumericField(path)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return raw;
}

/** Insert "{{path}}" into a text at the caret (or replacing the selection). */
export function insertBinding(text: string, path: string, selStart: number, selEnd = selStart): { text: string; caret: number } {
  const chip = `{{${path}}}`;
  const a = clamp(selStart, 0, text.length);
  const b = clamp(selEnd, a, text.length);
  return { text: text.slice(0, a) + chip + text.slice(b), caret: a + chip.length };
}

/** Every {{binding}} the scene's texts and media slots read, in first-seen order. */
export function sceneBindings(scene: Scene): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (!out.includes(p)) out.push(p); };
  for (const l of scene.layers) {
    if (l.kind === "text") for (const m of l.text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) add(m[1]!);
    if ((l.kind === "image" || l.kind === "video") && l.src.type === "binding") add(l.src.path.replace(/^\{\{\s*|\s*\}\}$/g, ""));
  }
  return out;
}
