import { and, desc, eq } from "drizzle-orm";
import { academyCreativeTemplatesTable, db, type AcademyCreativeTemplate } from "@workspace/db";
import { buildTemplateScene, sceneSchema, type Scene } from "@workspace/api-zod";
import { logger } from "../logger";

/**
 * My templates: a design saved from the editor to use again (routes/academyCreativeTemplates.ts).
 *
 * What is kept is the design. Bindings ({{media}}, {{more.0}}, {{custom.title}} …) stay, so the
 * template fills with any match's facts and footage. What belonged to the one clip it was made
 * with goes: a video slot's trim, slow-motion and camera path. A video's timing (how long each
 * part plays) is the template's and stays.
 */
export function templatize(scene: Scene): Scene {
  return {
    ...scene,
    layers: scene.layers.map((l) => {
      if (l.kind !== "video" || l.src.type !== "binding") return l;
      const { trimOutMs: _out, slowMo: _slow, framing: _cam, ...rest } = l;
      return { ...rest, trimInMs: 0 };
    }),
  } as Scene;
}

export function publicTemplate(row: AcademyCreativeTemplate) {
  return {
    id: row.id,
    baseKey: row.baseKey,
    style: row.style,
    format: row.format,
    kind: row.kind,
    title: row.title,
    scene: row.scene,
    sampleData: row.sampleData ?? null,
    replacesBase: row.replacesBase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listMyTemplates(academyId: number): Promise<AcademyCreativeTemplate[]> {
  return db.select().from(academyCreativeTemplatesTable)
    .where(eq(academyCreativeTemplatesTable.academyId, academyId))
    .orderBy(desc(academyCreativeTemplatesTable.updatedAt)).limit(200);
}

/**
 * The academy's own scenes that stand in for catalogue templates, by "key:format". Autopilots
 * (field Instagram, academy drafts) build from these instead of the catalogue's.
 */
export async function replacementScenes(academyId: number): Promise<Map<string, Scene>> {
  const rows = await db.select().from(academyCreativeTemplatesTable).where(and(
    eq(academyCreativeTemplatesTable.academyId, academyId),
    eq(academyCreativeTemplatesTable.replacesBase, true),
  ));
  const out = new Map<string, Scene>();
  for (const r of rows) {
    const parsed = sceneSchema.safeParse(r.scene);
    if (parsed.success) out.set(`${r.baseKey}:${r.format}`, parsed.data);
    else logger.warn({ academyId, templateId: r.id }, "My template: saved scene no longer valid; using the catalogue's");
  }
  return out;
}

/**
 * The catalogue's builder, with the academy's own scenes in place of the templates it replaced.
 * The saved scene keeps its own language: its words are the ones the owner typed.
 */
export function withReplacements(replacements: Map<string, Scene>, build: typeof buildTemplateScene): typeof buildTemplateScene {
  return (key, style, format, locale) => replacements.get(`${key}:${format}`) ?? build(key, style, format, locale);
}
