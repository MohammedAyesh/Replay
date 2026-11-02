import type { CreativeFormat, CreativeStyle, Scene } from "../creativeScene";
import { contentFor, type Content } from "./content";
import { Ctx, type Locale } from "./kit";
import { composeVideo } from "./parts";
import { STYLE_KITS } from "./styles";

/** Lays one template out in one style and format. Unknown keys fall back to Full time. */
export function buildScene(key: string, style: CreativeStyle, format: CreativeFormat, locale: Locale): Scene {
  const content: Content = contentFor(key, locale) ?? contentFor("fulltime", locale)!;
  const kit = STYLE_KITS[style] ?? STYLE_KITS.broadcast;
  const c = new Ctx(format, locale);
  let durationMs: number | undefined;
  if (content.arch === "video") durationMs = composeVideo(c, content, kit.skin);
  else kit[content.arch](c, content);
  return {
    v: 1,
    format,
    ...(durationMs !== undefined ? { durationMs } : {}),
    background: kit.background,
    layers: c.layers,
    template: { key: content.key, style },
    locale,
  } as Scene;
}
