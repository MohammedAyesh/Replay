import type { CreativeData, CreativeFormat, CreativeStyle, Scene, SceneLayer } from "./creativeScene";
import { DEFINITIONS, sampleFor } from "./creativeTemplates/content";
import { buildScene, plateLayer } from "./creativeTemplates/build";
export { packPlate } from "./creativeTemplates/build";
export { AUTOPILOT_AWARD_KEYS, AUTOPILOT_TEMPLATE_KEYS, awardTemplateKey, awardTitle } from "./creativeTemplates/content";
export {
  FIELD_STYLE, FIELD_TEMPLATE_KEYS, FIELD_TIMING, buildFieldScene, countData, fieldCountSteps, fieldSampleData, fieldTemplateFormats,
  fieldTemplateTitle, formatNumber, isFieldTemplate, type FieldTemplateKey,
} from "./creativeTemplates/fieldPack";
import { FIELD_TEMPLATE_DEFS, buildFieldScene, fieldSampleData, isFieldTemplate } from "./creativeTemplates/fieldPack";
import { STYLE_KITS } from "./creativeTemplates/styles";

/**
 * Creative hub template catalogue. Every template builds a Scene for any
 * style and format; academy colours come in through @primary/@accent tokens
 * and the academy's facts through {{bindings}} (see CreativeData).
 *
 * CONTRACT (frozen; the full catalogue replaces the bodies, not the shapes):
 *   CREATIVE_TEMPLATES: TemplateMeta[]
 *   buildTemplateScene(key, style, format, locale): Scene
 *   templateSampleData(key, locale): CreativeData
 *   templatePlateLayer(style, format): SceneLayer   (additive: the style's background plate layer)
 *
 * The implementation lives in creativeTemplates/: content.ts says what each
 * template says (fixed labels in EN and AR, {{bindings}} for facts, sample
 * data); styles/*.ts draw each of the six layouts by hand per style; kit.ts
 * mirrors everything for Arabic.
 */

export type TemplateCategory = "matchday" | "live" | "results" | "players" | "recruitment" | "academy-life" | "community";

export type TemplateMeta = {
  key: string;
  category: TemplateCategory;
  title: { en: string; ar: string };
  /** Video templates have a duration and a video slot; stills do not. */
  kind: "image" | "video";
  /** Formats the layout is designed for; the first is the default. */
  formats: CreativeFormat[];
  /** Which bindings the template reads (drives the "fill in" form). */
  fields: string[];
};

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["matchday", "live", "results", "players", "recruitment", "academy-life", "community"];

const BINDING = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Every {{binding}} and media slot a scene reads, in first-seen order. */
export function sceneFields(scene: Scene): string[] {
  const out = new Set<string>();
  for (const layer of scene.layers) {
    if (layer.kind === "text") for (const m of layer.text.matchAll(BINDING)) out.add(m[1]);
    else if ((layer.kind === "image" || layer.kind === "video") && layer.src.type === "binding") out.add(layer.src.path);
  }
  return [...out];
}

export const CREATIVE_TEMPLATES: TemplateMeta[] = DEFINITIONS.map((def) => {
  const scene = buildScene(def.key, "broadcast", def.formats[0], "en");
  return {
    key: def.key,
    category: def.category,
    title: def.title,
    kind: scene.durationMs !== undefined ? "video" : "image",
    formats: def.formats,
    fields: sceneFields(scene),
  };
});

/**
 * The football fields' pack as catalogue entries (the field console's Creative hub shows these
 * under "Field pack"; academies never see them). Each has one look, FIELD_STYLE, whatever style
 * is picked. Category is a placeholder: the pack is its own chip.
 */
export const FIELD_TEMPLATES: TemplateMeta[] = FIELD_TEMPLATE_DEFS.map((def) => {
  const scene = buildFieldScene(def.key, def.formats[0], "en");
  return {
    key: def.key,
    category: "community",
    title: def.title,
    kind: scene.durationMs !== undefined ? "video" : "image",
    formats: def.formats,
    fields: sceneFields(scene),
  };
});

export function buildTemplateScene(key: string, style: CreativeStyle, format: CreativeFormat, locale: "en" | "ar"): Scene {
  return buildScene(key, style, format, locale);
}

/** Believable sample data so a gallery looks real before any data exists. Media are artwork keys "sample/<name>". */
export function templateSampleData(key: string, locale: "en" | "ar"): CreativeData {
  if (isFieldTemplate(key)) return fieldSampleData(key, locale);
  return sampleFor(key, locale);
}

/**
 * The background plate layer a style's templates start with (id "plate",
 * artwork "bg/<style>/1", tinted @primary, the style's own strength). The
 * editor uses it to put a plate back into a design that has none.
 */
export function templatePlateLayer(style: CreativeStyle, format: CreativeFormat, templateKey?: string): SceneLayer {
  return plateLayer(STYLE_KITS[style] ? style : "broadcast", format, STYLE_KITS[style] ?? STYLE_KITS.broadcast, templateKey);
}
