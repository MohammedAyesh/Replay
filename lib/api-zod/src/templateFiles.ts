import * as z from "zod";
import { CREATIVE_FORMAT_KEYS, sceneSchema, type CreativeData, type CreativeFormat, type CreativeStyle, type Scene } from "./creativeScene";
import { buildTemplateScene, CREATIVE_TEMPLATES, packLookOf, templateSampleData } from "./creativeTemplates";
import { FIELD_STYLE, fieldTemplateFormats, fieldTemplateTitle, isFieldTemplate } from "./creativeTemplates/fieldPack";
import { CLUB_STYLE, isClubTemplate } from "./creativeTemplates/clubPack";

/**
 * Template files (Admin → Template library, 2026-11-08): a template made outside the code, uploaded
 * as one JSON file. No deploy is needed: the server checks the file, stores it, and every field (or
 * academy) sees it in its Creative hub. With `replacesBase` it stands in for a built-in template,
 * the Instagram autopilots included.
 *
 * A file holds one template:
 *
 *   {
 *     "replayTemplate": 1,
 *     "key": "field-special-offer",              lower-case letters, digits and dashes
 *     "title": { "en": "Special offer", "ar": "عرض خاص" },
 *     "audience": "field",                       field | academy | all
 *     "baseKey": "field-open-slots",             optional: the built-in it fills like
 *     "replacesBase": false,                     true: use it instead of baseKey everywhere
 *     "clips": 3,                                optional: a montage's clip count it is laid out for
 *     "formats": { "story": <scene>, "post": <scene> },
 *     "sampleData": { "custom": { "title": "…" } }
 *   }
 *
 * or several: { "replayTemplates": 1, "templates": [ … ] }.
 *
 * A scene is the Creative hub's own format (creativeScene.ts): 1080 wide, layers bottom to top,
 * colours as hex or the brand's tokens (@primary, @ink, @paper, @on-primary …), words with
 * {{bindings}} ({{custom.title}}, {{academy.phone}}, {{media}} for the clip). Download any built-in
 * template from the library page to start from one.
 */

export const TEMPLATE_AUDIENCES = ["field", "academy", "all"] as const;
export type TemplateAudience = (typeof TEMPLATE_AUDIENCES)[number];
export const TEMPLATE_FILE_MAX_BYTES = 3_000_000;

const formatsSchema = z.object({
  post: sceneSchema.optional(),
  square: sceneSchema.optional(),
  story: sceneSchema.optional(),
  wide: sceneSchema.optional(),
}).strict();

const sampleDataSchema = z.object({
  custom: z.record(z.string().max(60), z.string().max(400)).optional(),
}).passthrough();

export const templateEntrySchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "key: lower-case letters, digits and dashes, 2 to 63 long"),
  title: z.object({ en: z.string().trim().min(1).max(80), ar: z.string().trim().min(1).max(80) }),
  description: z.string().trim().max(300).optional(),
  audience: z.enum(TEMPLATE_AUDIENCES).default("field"),
  baseKey: z.string().max(80).optional(),
  replacesBase: z.boolean().default(false),
  clips: z.number().int().min(1).max(5).optional(),
  formats: formatsSchema,
  sampleData: sampleDataSchema.optional(),
});
export type TemplateEntry = z.infer<typeof templateEntrySchema>;

const singleFile = templateEntrySchema.extend({ replayTemplate: z.literal(1) });
const packFile = z.object({ replayTemplates: z.literal(1), templates: z.array(z.unknown()).min(1).max(60) });

export type TemplateFileResult = { ok: true; templates: TemplateEntry[] } | { ok: false; errors: string[] };

/** "formats.story.layers.3.size: Number must be less than or equal to 600" */
const describe = (where: string, error: z.ZodError) =>
  error.issues.slice(0, 6).map((i) => `${where}${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);

/** The checks a schema can't make: each scene is the size it is filed under, a replacement names what it replaces. */
function entryProblems(e: TemplateEntry, where: string): string[] {
  const out: string[] = [];
  const formats = Object.entries(e.formats).filter(([, s]) => s) as Array<[CreativeFormat, Scene]>;
  if (!formats.length) out.push(`${where}formats: give at least one of post, square, story`);
  for (const [f, s] of formats) if (s.format !== f) out.push(`${where}formats.${f}: the scene says it is "${s.format}"`);
  if (e.replacesBase && !e.baseKey) out.push(`${where}replacesBase: say which template it replaces in baseKey`);
  if (e.clips !== undefined && formats.some(([, s]) => s.durationMs === undefined)) out.push(`${where}clips: only a video template has clips`);
  if (e.baseKey && !knownTemplate(e.baseKey)) out.push(`${where}baseKey: there is no built-in template "${e.baseKey}"`);
  return out;
}

export const knownTemplate = (key: string) => isFieldTemplate(key) || isClubTemplate(key) || CREATIVE_TEMPLATES.some((t) => t.key === key);

/** Read an uploaded file: every template in it, or every problem found (nothing is kept from a file with problems). */
export function parseTemplateFile(raw: unknown): TemplateFileResult {
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["The file is not a JSON object"] };
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const templates: TemplateEntry[] = [];
  const take = (value: unknown, where: string) => {
    const parsed = templateEntrySchema.safeParse(value);
    if (!parsed.success) { errors.push(...describe(where, parsed.error)); return; }
    const problems = entryProblems(parsed.data, where);
    if (problems.length) { errors.push(...problems); return; }
    templates.push(parsed.data);
  };
  if ("replayTemplates" in obj) {
    const pack = packFile.safeParse(obj);
    if (!pack.success) return { ok: false, errors: describe("", pack.error) };
    pack.data.templates.forEach((t, i) => take(t, `templates.${i}.`));
  } else if ("replayTemplate" in obj) {
    const one = singleFile.safeParse(obj);
    if (!one.success) return { ok: false, errors: describe("", one.error) };
    const { replayTemplate: _v, ...entry } = one.data;
    take(entry, "");
  } else {
    return { ok: false, errors: ['Not a Replay template file: it needs "replayTemplate": 1 (or "replayTemplates": 1 and a "templates" list)'] };
  }
  const keys = templates.map((t) => t.key);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length) errors.push(`The same key twice: ${[...new Set(twice)].join(", ")}`);
  return errors.length ? { ok: false, errors } : { ok: true, templates };
}

/** The look a built-in template is drawn in when it is exported: its pack's own, else the house default. */
export function exportStyleOf(key: string, style?: CreativeStyle): CreativeStyle {
  return packLookOf(key) ?? style ?? "broadcast";
}

/**
 * A built-in template as a file, to start a new one from: every size it is designed for, its sample
 * words, and `baseKey` set to itself (upload it with "replacesBase": true to use the edited copy instead).
 */
export function builtInTemplateFile(key: string, locale: "en" | "ar", style?: CreativeStyle): Record<string, unknown> | null {
  if (!knownTemplate(key)) return null;
  const look = exportStyleOf(key, style);
  const meta = CREATIVE_TEMPLATES.find((t) => t.key === key);
  const formats: CreativeFormat[] = isFieldTemplate(key) ? fieldTemplateFormats(key) : meta?.formats ?? ["post"];
  const title = isFieldTemplate(key)
    ? { en: fieldTemplateTitle(key, false), ar: fieldTemplateTitle(key, true) }
    : meta?.title ?? { en: key, ar: key };
  const scenes: Partial<Record<CreativeFormat, Scene>> = {};
  for (const f of formats) scenes[f] = buildTemplateScene(key, look, f, locale);
  const sample: CreativeData = templateSampleData(key, locale);
  return {
    replayTemplate: 1,
    key: `${key}-copy`,
    title: { en: `${title.en} (copy)`, ar: `${title.ar} (نسخة)` },
    audience: isFieldTemplate(key) ? "field" : isClubTemplate(key) ? "academy" : "all",
    baseKey: key,
    replacesBase: false,
    formats: scenes,
    sampleData: { custom: sample.custom ?? {} },
  };
}

/** The style a library template's scenes are marked with: a field's, an academy pack's, or the scene's own. */
export function libraryStyle(audience: TemplateAudience, scene: Scene): CreativeStyle {
  return scene.template?.style ?? (audience === "academy" ? CLUB_STYLE : FIELD_STYLE);
}
