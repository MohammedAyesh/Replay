import { CREATIVE_FORMATS, PLATE_LAYER_ID, plateKey, type CreativeFormat, type CreativeStyle, type Scene, type SceneLayer } from "../creativeScene";
import { contentFor, type Content } from "./content";
import { Ctx, type Locale } from "./kit";
import { composeVideo } from "./parts";
import { STYLE_KITS } from "./styles";
import type { StyleKit } from "./styles/types";

/**
 * The style's background plate: greyscale artwork "bg/<style>/1" over the
 * whole canvas, recoloured with the academy's main colour. Same id in every
 * style so a restyle carries the manager's choice. A missing file draws
 * nothing, so a style without plates looks exactly as it did before.
 */
export function plateLayer(style: CreativeStyle, format: CreativeFormat, kit: Pick<StyleKit, "plate">): SceneLayer {
  const { w, h } = CREATIVE_FORMATS[format];
  return {
    id: PLATE_LAYER_ID,
    name: "bleed",
    kind: "image",
    src: { type: "artwork", key: plateKey(style, 1) },
    fit: "cover",
    x: 0, y: 0, w, h,
    ...(kit.plate.opacity < 1 ? { opacity: kit.plate.opacity } : {}),
    tint: { color: "@primary", mode: "color" },
    locked: true,
  };
}

/** Lays one template out in one style and format. Unknown keys fall back to Full time. */
export function buildScene(key: string, style: CreativeStyle, format: CreativeFormat, locale: Locale): Scene {
  const content: Content = contentFor(key, locale) ?? contentFor("fulltime", locale)!;
  const kit = STYLE_KITS[style] ?? STYLE_KITS.broadcast;
  const c = new Ctx(format, locale);
  let durationMs: number | undefined;
  if (content.arch === "video") durationMs = composeVideo(c, content, kit.skin);
  else kit[content.arch](c, content);
  const layers = [...c.layers];
  const above = kit.plate.above ? layers.findIndex((l) => l.id === kit.plate.above) : -1;
  layers.splice(above + 1, 0, plateLayer(STYLE_KITS[style] ? style : "broadcast", format, kit));
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
