import { createCanvas, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import {
  CREATIVE_FORMATS,
  fillText,
  layerVisibleAt,
  resolveColor,
  resolveSource,
  resolveTint,
  type CreativeBrand,
  type CreativeFormat,
  type CreativeData,
  type MediaSource,
  type Scene,
  type SceneLayer,
} from "@workspace/api-zod";
import { FONT, ensureBrandingFonts } from "../clipBranding/assets";
import { drawCrest, roundRect } from "../clipBranding/draw";
import {
  baselineIn,
  displayText,
  entranceAt,
  fitRect,
  fontFace,
  gradientPoints,
  hasArabic,
  isolateLtrRuns,
  layoutText,
  lineGeometry,
  slantPoints,
  textDirection,
  type FontFace,
} from "./renderLayout";
import { tintPicture } from "./renderTint";
import { ensureLibraryFonts, libraryFaceAvailable } from "./fonts";

/**
 * Creative hub engine: a scene → PNG, with @napi-rs/canvas, the fonts the
 * clip branding and Studio already ship, and the Creative font library
 * (fonts.ts; a layer's `family`). See renderLayout.ts fontFace for the mapping.
 *
 * Pure drawing: pictures arrive through `images`, so this module never touches
 * the database or the network (renderMedia.ts does that for the routes, tests
 * pass stubs). Layer by layer, bottom to top:
 *   shape  rect / ellipse / line / slant, fill or gradient, stroke, radius
 *   text   {{bindings}} filled, fit-to-box, uppercase, letter spacing, line
 *          height, stroke, shadow, background pill, Arabic shaped right-to-left
 *   image  cover / contain, radius, tint (renderTint.ts; cutout is not done yet: drawn as is)
 *   video  its still (a thumbnail) — the MP4 renderer plays the footage
 * then rotation, opacity and hidden, as SceneCanvas does in the browser.
 */

export type ConcreteSource = Exclude<MediaSource, { type: "binding" }>;
export type MediaLayer = Extract<SceneLayer, { kind: "image" | "video" }>;
/**
 * A picture for an image layer, or the still of a video layer. Null skips the
 * layer (the crest draws initials). `scene.format` picks a background plate's
 * post or story file.
 */
export type ImageResolver = (layer: MediaLayer, src: ConcreteSource, scene: { format: CreativeFormat }) => Promise<Image | Canvas | null>;

export type SceneRenderOptions = {
  scene: Scene;
  brand: CreativeBrand;
  data?: CreativeData;
  images?: ImageResolver;
  /** Scene time for video scenes (ms); null/undefined draws every layer that is not hidden. */
  t?: number | null;
  /** Only draw the layers this accepts (the MP4 renderer draws overlays in runs). */
  include?: (layer: SceneLayer) => boolean;
  /** Fill the scene background (default true). Overlays are transparent. */
  background?: boolean;
  /** Output width in pixels (default 1080, the design width). */
  width?: number;
  /** Apply entrance animations at time t (previews of a video frame). */
  entrances?: boolean;
};

const ITALIC_SKEW = -0.25;
const FAMILY: Record<"rajdhani" | "cairo", Record<number, string>> = {
  rajdhani: { 600: FONT.displaySemi, 700: FONT.display, 900: FONT.display },
  cairo: { 600: FONT.arabicBold, 700: FONT.arabicBold, 900: FONT.arabicBlack },
};

/** Every face is registered under its own name, so the string names exactly one file. */
export function fontString(face: FontFace, size: number): string {
  if (face.family === "library") return `${face.weight} ${size}px ${face.alias}`;
  return `${face.weight} ${size}px ${FAMILY[face.family][face.weight]}`;
}

export function sceneSize(scene: Pick<Scene, "format">): { w: number; h: number } {
  return CREATIVE_FORMATS[scene.format] ?? CREATIVE_FORMATS.post;
}

const color = (c: string | undefined, brand: CreativeBrand, fallback: string) => resolveColor(c, brand, fallback);

// ── Shapes ───────────────────────────────────────────────────────────────────

function drawShape(ctx: SKRSContext2D, layer: Extract<SceneLayer, { kind: "shape" }>, brand: CreativeBrand): void {
  const { w, h } = layer;
  const paint = (): string | ReturnType<SKRSContext2D["createLinearGradient"]> | null => {
    if (layer.gradient) {
      const p = gradientPoints(w, h, layer.gradient.angle ?? 180);
      const g = ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1);
      g.addColorStop(0, color(layer.gradient.from, brand, "#000000"));
      g.addColorStop(1, color(layer.gradient.to, brand, "#000000"));
      return g;
    }
    return layer.fill ? color(layer.fill, brand, "#000000") : null;
  };

  if (layer.shape === "line") {
    const g = lineGeometry(w, h, layer.stroke?.width);
    ctx.beginPath();
    ctx.moveTo(g.x0, g.y0);
    ctx.lineTo(g.x1, g.y1);
    ctx.lineWidth = g.width;
    ctx.lineCap = "butt";
    const c = layer.stroke?.color ?? layer.fill ?? layer.gradient?.from ?? "@ink";
    ctx.strokeStyle = (layer.gradient && !layer.stroke ? paint() : null) ?? color(c, brand, "#000000");
    ctx.stroke();
    return;
  }

  // Strokes sit inside the box (like a CSS border), so the path is inset by half.
  const sw = layer.stroke && layer.stroke.width > 0 ? layer.stroke.width : 0;
  const path = (inset: number) => {
    ctx.beginPath();
    if (layer.shape === "ellipse") {
      ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset), 0, 0, Math.PI * 2);
    } else if (layer.shape === "slant") {
      const pts = slantPoints(w - inset * 2, h - inset * 2, layer.skew ?? 12);
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px + inset, py + inset) : ctx.moveTo(px + inset, py + inset)));
      ctx.closePath();
    } else {
      roundRect(ctx, inset, inset, w - inset * 2, h - inset * 2, Math.max(0, (layer.radius ?? 0) - inset));
    }
  };
  const fill = paint();
  if (fill) {
    path(0);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (sw) {
    path(sw / 2);
    ctx.lineWidth = sw;
    ctx.lineJoin = "miter";
    ctx.strokeStyle = color(layer.stroke!.color, brand, "#000000");
    ctx.stroke();
  }
}

// ── Text ─────────────────────────────────────────────────────────────────────

function drawTextLayer(ctx: SKRSContext2D, layer: Extract<SceneLayer, { kind: "text" }>, brand: CreativeBrand, data: CreativeData): void {
  const text = displayText(layer, fillText(layer.text, data, false));
  if (!text.trim()) return;
  const dir = textDirection(layer, text);
  const face = fontFace(layer, text, libraryFaceAvailable);
  const arabic = face.arabic;
  // Letter spacing breaks Arabic joins, so it applies to Latin text only.
  const spacing = (size: number) => (!hasArabic(text) && layer.letterSpacing ? (layer.letterSpacing * size) / layer.size : 0);
  const shown = (line: string) => (dir === "rtl" ? isolateLtrRuns(line) : line);
  const setFont = (size: number) => {
    ctx.font = fontString(face, size);
    ctx.letterSpacing = `${spacing(size)}px`;
    ctx.direction = dir;
  };
  const measure = (t: string, size: number) => {
    setFont(size);
    return ctx.measureText(shown(t)).width;
  };
  const layout = layoutText(layer, text, dir, arabic, measure);

  if (layer.background) {
    ctx.fillStyle = color(layer.background.color, brand, "#000000");
    roundRect(ctx, layout.block.x, layout.block.y, layout.block.w, layout.block.h, layer.background.radius);
    ctx.fill();
  }

  setFont(layout.size);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("Hg");
  const ascent = m.fontBoundingBoxAscent || layout.size * 0.8;
  const descent = m.fontBoundingBoxDescent || layout.size * 0.2;
  const fill = color(layer.color, brand, "#0B0F1A");
  const stroke = layer.stroke && layer.stroke.width > 0 ? layer.stroke : null;
  const shadow = layer.shadow;
  const k = layout.size / layer.size;

  layout.lines.forEach((line, i) => {
    if (!line) return;
    const pos = layout.positions[i];
    const baseline = baselineIn(pos.top, layout.lineHeight, ascent, descent);
    const t = shown(line);
    ctx.save();
    ctx.translate(pos.x, baseline);
    if (face.italic) ctx.transform(1, 0, ITALIC_SKEW, 1, 0, 0);
    const withShadow = (draw: () => void, on: boolean) => {
      if (on && shadow) {
        ctx.save();
        ctx.shadowColor = color(shadow.color, brand, "#000000");
        ctx.shadowBlur = shadow.blur * k;
        ctx.shadowOffsetX = shadow.x * k;
        ctx.shadowOffsetY = shadow.y * k;
        draw();
        ctx.restore();
      } else {
        draw();
      }
    };
    if (stroke) {
      // Outside the glyphs, as paint-order: stroke fill in the browser.
      ctx.lineWidth = stroke.width * 2 * k;
      ctx.lineJoin = "round";
      ctx.strokeStyle = color(stroke.color, brand, "#000000");
      withShadow(() => ctx.strokeText(t, 0, 0), true);
    }
    ctx.fillStyle = fill;
    withShadow(() => ctx.fillText(t, 0, 0), !stroke);
    ctx.restore();
  });
}

// ── Pictures ─────────────────────────────────────────────────────────────────

function drawPicture(ctx: SKRSContext2D, layer: MediaLayer, img: Image | Canvas): void {
  const { w, h } = layer;
  const r = fitRect(layer.fit ?? "cover", img.width, img.height, w, h);
  ctx.save();
  const radius = layer.kind === "image" ? layer.radius ?? 0 : 0;
  if (radius > 0) {
    roundRect(ctx, 0, 0, w, h, radius);
    ctx.clip();
  }
  ctx.drawImage(img as Image, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
}

/** No crest uploaded: the initials shield in the academy colour, as Studio and the clip branding draw it. */
function drawInitialsCrest(ctx: SKRSContext2D, layer: MediaLayer, brand: CreativeBrand): void {
  const size = Math.min(layer.w, layer.h);
  drawCrest(ctx, {
    nameEn: brand.nameEn || "Replay", nameAr: brand.nameAr, taglineAr: null, primaryColor: brand.primary,
    accentColor: brand.accent, bookingPhone: null, instagram: null, crest: null, isAcademy: true,
  }, layer.w / 2, layer.h / 2, size);
}

// ── Scene ────────────────────────────────────────────────────────────────────

/** The layers drawn for these options, bottom to top. */
export function layersToDraw(scene: Scene, t: number | null, include?: (layer: SceneLayer) => boolean): SceneLayer[] {
  return scene.layers.filter((l) => layerVisibleAt(l, t) && (!include || include(l)));
}

/** Draw a scene on a canvas. Pictures must already be loaded (see renderSceneCanvas). */
export function drawScene(
  ctx: SKRSContext2D,
  opts: SceneRenderOptions,
  pictures: Map<string, Image | Canvas | null>,
): void {
  ensureBrandingFonts();
  ensureLibraryFonts();
  const { scene, brand } = opts;
  const data = opts.data ?? {};
  const { w: W, h: H } = sceneSize(scene);
  const scale = (opts.width ?? W) / W;
  const t = opts.t ?? null;
  ctx.save();
  ctx.scale(scale, scale);
  if (opts.background !== false) {
    ctx.fillStyle = color(scene.background, brand, "#FFFFFF");
    ctx.fillRect(0, 0, W, H);
  }
  for (const layer of layersToDraw(scene, t, opts.include)) {
    let alpha = layer.opacity ?? 1;
    let dx = 0;
    let dy = 0;
    if (opts.entrances && t !== null) {
      const e = entranceAt(layer, t);
      alpha *= e.alpha;
      dx = e.dx;
      dy = e.dy;
    }
    if (alpha <= 0) continue;
    const draw = (c: SKRSContext2D) => {
      c.translate(layer.x + dx + layer.w / 2, layer.y + dy + layer.h / 2);
      if (layer.rotation) c.rotate((layer.rotation * Math.PI) / 180);
      c.translate(-layer.w / 2, -layer.h / 2);
      switch (layer.kind) {
        case "shape": drawShape(c, layer, brand); break;
        case "text": drawTextLayer(c, layer, brand, data); break;
        case "image":
        case "video": {
          const img = pictures.get(layer.id) ?? null;
          if (img) drawPicture(c, layer, img);
          else if (resolveSource(layer.src, data)?.type === "crest") drawInitialsCrest(c, layer, brand);
          break;
        }
      }
    };
    if (alpha >= 1) {
      ctx.save();
      draw(ctx);
      ctx.restore();
    } else {
      // Opacity applies to the layer as a whole (stroke, fill and shadow together), as CSS opacity does.
      const surface = createCanvas(Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale)));
      const sctx = surface.getContext("2d");
      sctx.scale(scale, scale);
      draw(sctx);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(surface, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * How far a picture can be shrunk before it is tinted without losing detail:
 * the scale it will be drawn at (fit into the box, times the output scale), at most 1.
 */
function drawnScale(layer: MediaLayer, img: Image | Canvas, outScale: number): number {
  const kx = layer.w / img.width;
  const ky = layer.h / img.height;
  const fit = (layer.fit ?? "cover") === "contain" ? Math.min(kx, ky) : Math.max(kx, ky);
  return Math.min(1, fit * outScale);
}

/** Load every picture the visible layers need (in parallel), keyed by layer id. Tinted layers come back tinted. */
export async function loadPictures(opts: SceneRenderOptions): Promise<Map<string, Image | Canvas | null>> {
  const out = new Map<string, Image | Canvas | null>();
  const data = opts.data ?? {};
  const { w: W } = sceneSize(opts.scene);
  const outScale = (opts.width ?? W) / W;
  const scene = { format: opts.scene.format };
  const jobs = layersToDraw(opts.scene, opts.t ?? null, opts.include)
    .filter((l): l is MediaLayer => l.kind === "image" || l.kind === "video")
    .map(async (layer) => {
      const src = resolveSource(layer.src, data);
      if (!src || !opts.images) { out.set(layer.id, null); return; }
      let img = await opts.images(layer, src, scene).catch(() => null);
      if (!img || img.width <= 0 || img.height <= 0) { out.set(layer.id, null); return; }
      const tint = layer.kind === "image" ? resolveTint(layer.tint, opts.brand) : null;
      if (tint) {
        const k = drawnScale(layer, img, outScale);
        img = tintPicture(img, tint, Math.ceil(Math.max(img.width, img.height) * k));
      }
      out.set(layer.id, img);
    });
  await Promise.all(jobs);
  return out;
}

export async function renderSceneCanvas(opts: SceneRenderOptions): Promise<Canvas> {
  const { w: W, h: H } = sceneSize(opts.scene);
  const scale = (opts.width ?? W) / W;
  const canvas = createCanvas(Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale)));
  const pictures = await loadPictures(opts);
  drawScene(canvas.getContext("2d"), opts, pictures);
  return canvas;
}

/** The finished PNG of a still (or of one frame of a video scene, with t). */
export async function renderScenePng(opts: SceneRenderOptions): Promise<Buffer> {
  return (await renderSceneCanvas(opts)).toBuffer("image/png");
}
