import { CREATIVE_FORMATS, PLATE_LAYER_ID, plateKey, type CreativeFormat, type CreativeStyle, type Scene, type SceneLayer } from "../creativeScene";
import { contentFor, DEFINITIONS, type Content } from "./content";
import { CREATIVE_PACKS, isPackStyle } from "../creativePacks";
import { Ctx, type Locale } from "./kit";
import { composeVideo } from "./parts";
import { playerFigure } from "./players";
import { STYLE_KITS } from "./styles";
import type { StyleKit } from "./styles/types";

/**
 * The style's background plate: greyscale artwork "bg/<style>/1" over the
 * whole canvas, recoloured with the academy's main colour. Same id in every
 * style so a restyle carries the manager's choice. A missing file draws
 * nothing, so a style without plates looks exactly as it did before.
 */
export function plateLayer(style: CreativeStyle, format: CreativeFormat, kit: Pick<StyleKit, "plate">, templateKey?: string): SceneLayer {
  const { w, h } = CREATIVE_FORMATS[format];
  const key = isPackStyle(style) ? packPlate(style, templateKey) : plateKey(style, 1);
  return {
    id: PLATE_LAYER_ID,
    name: "bleed",
    kind: "image",
    src: { type: "artwork", key },
    fit: "cover",
    x: 0, y: 0, w, h,
    ...(kit.plate.opacity < 1 ? { opacity: kit.plate.opacity } : {}),
    tint: { color: "@primary", mode: "color" },
    locked: true,
  };
}

/**
 * A brand pack picks its plate by the moment of the match the template is for:
 * pre-game (matchday), live (in-game), post-game (results, players), else the
 * pack's cover plate.
 */
export function packPlate(style: keyof typeof CREATIVE_PACKS, templateKey?: string): string {
  const pack = CREATIVE_PACKS[style];
  const cat = DEFINITIONS.find((d) => d.key === templateKey)?.category;
  if (cat === "matchday") return pack.plates.pre;
  if (cat === "live") return pack.plates.live;
  if (cat === "results" || cat === "players") return pack.plates.post;
  return pack.plates.cover;
}

/**
 * A player post's own photo (player.photo, shown only when there is one): the
 * figure stands at the bottom of the main picture, at the far side from the
 * text's start, drawn above the picture and its shades and under the first
 * words that follow, so the type stays on top. A style can say where
 * (StyleKit.figure).
 */
function addPlayerFigure(c: Ctx, kit: StyleKit): void {
  const at = c.layers.findIndex((l) => (l.kind === "image" || l.kind === "video") && l.src.type === "binding" && l.src.path === "media");
  if (at < 0) return;
  const m = c.layers[at];
  // The media layer is already mirrored for Arabic; work in left-to-right terms.
  const media = { x: c.ar ? c.W - m.x - m.w : m.x, y: m.y, w: m.w, h: m.h };
  const bottom = Math.min(media.y + media.h, c.H);
  const h = Math.round(Math.min(media.h * 0.9, c.H * 0.58));
  const w = Math.round(Math.min(h * 0.86, c.W * 0.62));
  const box = kit.figure?.box?.(c, media) ?? { x: Math.min(c.W - w - 24, media.x + media.w - w - 24), y: bottom - h, w, h };
  const from = c.layers.length;
  playerFigure(c, box, kit.figure?.look);
  const added = c.layers.splice(from);
  // Above the picture and its shades, under the first words drawn after it.
  const firstText = c.layers.findIndex((l, i) => i > at && l.kind === "text");
  const after = kit.figure?.above ? c.layers.findIndex((l) => l.id === kit.figure!.above) : (firstText > at ? firstText : c.layers.length) - 1;
  c.layers.splice((after >= 0 ? after : at) + 1, 0, ...added);
}

/** Lays one template out in one style and format. Unknown keys fall back to Full time. */
export function buildScene(key: string, style: CreativeStyle, format: CreativeFormat, locale: Locale): Scene {
  const content: Content = contentFor(key, locale) ?? contentFor("fulltime", locale)!;
  const kit = STYLE_KITS[style] ?? STYLE_KITS.broadcast;
  const c = new Ctx(format, locale);
  let durationMs: number | undefined;
  if (content.arch === "video") durationMs = composeVideo(c, content, kit.skin);
  else kit[content.arch](c, content);
  if (content.playerPhoto) addPlayerFigure(c, kit);
  const layers = [...c.layers];
  const above = kit.plate.above ? layers.findIndex((l) => l.id === kit.plate.above) : -1;
  layers.splice(above + 1, 0, plateLayer(STYLE_KITS[style] ? style : "broadcast", format, kit, content.key));
  return {
    v: 1,
    format,
    ...(durationMs !== undefined ? { durationMs } : {}),
    background: kit.background,
    layers,
    template: { key: content.key, style },
    locale,
  } as Scene;
}
