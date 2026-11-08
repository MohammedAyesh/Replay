import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { academiesTable, creativeLibraryTemplatesTable, db, type CreativeLibraryTemplate } from "@workspace/db";
import { libraryStyle, sceneSchema, type CreativeFormat, type Scene, type TemplateAudience, type TemplateEntry } from "@workspace/api-zod";
import { logger } from "../logger";

/**
 * Template library (Admin → Template library, 2026-11-08): templates uploaded as files, no code
 * change. lib/api-zod templateFiles.ts reads the file; this keeps the rows and answers who sees what.
 *
 * Who sees a template: its audience ("field" for fields, "academy" for academies, "all"), and when
 * `academyIds` is set, only those. A template with `replacesBase` stands in for its built-in
 * everywhere, the autopilots included; a field's or academy's own "use instead" (My templates)
 * still wins over it.
 */

export type LibraryTemplate = ReturnType<typeof publicLibraryTemplate>;

export function publicLibraryTemplate(row: CreativeLibraryTemplate) {
  return {
    id: row.id,
    key: row.key,
    title: { en: row.titleEn, ar: row.titleAr },
    description: row.description ?? null,
    audience: row.audience as TemplateAudience,
    academyIds: row.academyIds ?? null,
    baseKey: row.baseKey ?? null,
    replacesBase: row.replacesBase,
    clips: row.clips ?? null,
    format: row.format as CreativeFormat,
    kind: row.kind as "image" | "video",
    scene: row.scene as Scene,
    sampleData: (row.sampleData ?? null) as { custom?: Record<string, string> } | null,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listLibrary(): Promise<CreativeLibraryTemplate[]> {
  return db.select().from(creativeLibraryTemplatesTable).orderBy(asc(creativeLibraryTemplatesTable.key), asc(creativeLibraryTemplatesTable.format));
}

/** Which audience an academy row is in: a field business ("venue") or an academy. */
export const audienceOf = (kind: string | null | undefined): "field" | "academy" => (kind === "venue" ? "field" : "academy");

async function academyKind(academyId: number): Promise<"field" | "academy" | null> {
  const [row] = await db.select({ kind: academiesTable.kind }).from(academiesTable).where(eq(academiesTable.id, academyId));
  return row ? audienceOf(row.kind) : null;
}

const forThem = (row: CreativeLibraryTemplate, academyId: number, audience: "field" | "academy") =>
  row.active && (row.audience === "all" || row.audience === audience) && (!row.academyIds?.length || row.academyIds.includes(academyId));

/** The active templates a field or academy sees in its Creative hub. */
export async function libraryFor(academyId: number): Promise<CreativeLibraryTemplate[]> {
  const audience = await academyKind(academyId);
  if (!audience) return [];
  const rows = await db.select().from(creativeLibraryTemplatesTable)
    .where(and(eq(creativeLibraryTemplatesTable.active, true), inArray(creativeLibraryTemplatesTable.audience, ["all", audience])))
    .orderBy(asc(creativeLibraryTemplatesTable.key), asc(creativeLibraryTemplatesTable.format));
  return rows.filter((r) => forThem(r, academyId, audience));
}

/**
 * The library's scenes that stand in for built-in templates, for this field or academy: by
 * "baseKey:format", and "baseKey:format:clips" for a montage laid out for that many clips.
 */
export async function libraryReplacements(academyId: number): Promise<Map<string, Scene>> {
  const out = new Map<string, Scene>();
  for (const r of await libraryFor(academyId)) {
    if (!r.replacesBase || !r.baseKey) continue;
    const parsed = sceneSchema.safeParse(r.scene);
    if (!parsed.success) {
      logger.warn({ templateId: r.id, key: r.key }, "Template library: stored scene no longer valid; using the built-in");
      continue;
    }
    out.set(r.clips ? `${r.baseKey}:${r.format}:${r.clips}` : `${r.baseKey}:${r.format}`, parsed.data);
  }
  return out;
}

/** The scene as stored: marked with the template it came from, so the editor and My templates know it. */
function marked(entry: TemplateEntry, scene: Scene): Scene {
  return { ...scene, template: { key: entry.baseKey ?? entry.key, style: libraryStyle(entry.audience, scene) } };
}

export type SavedEntry = { key: string; format: CreativeFormat; id: number; created: boolean };

/**
 * Keep an uploaded file's templates: a template already in the library under the same key and size
 * is replaced (a new version of the file updates it); the rest are added. A replacement switches
 * off any other library template replacing the same built-in at that size.
 */
export async function saveEntries(entries: TemplateEntry[], userId: number | null): Promise<SavedEntry[]> {
  const out: SavedEntry[] = [];
  await db.transaction(async (tx) => {
    for (const e of entries) {
      for (const [format, scene] of Object.entries(e.formats) as Array<[CreativeFormat, Scene | undefined]>) {
        if (!scene) continue;
        const values = {
          key: e.key, titleEn: e.title.en, titleAr: e.title.ar, description: e.description ?? null,
          audience: e.audience, baseKey: e.baseKey ?? null, replacesBase: e.replacesBase, clips: e.clips ?? null,
          format, kind: scene.durationMs !== undefined ? "video" : "image", scene: marked(e, scene),
          sampleData: e.sampleData ?? null, uploadedBy: userId, updatedAt: new Date(),
        };
        const [existing] = await tx.select({ id: creativeLibraryTemplatesTable.id }).from(creativeLibraryTemplatesTable)
          .where(and(eq(creativeLibraryTemplatesTable.key, e.key), eq(creativeLibraryTemplatesTable.format, format)));
        let id: number;
        if (existing) {
          await tx.update(creativeLibraryTemplatesTable).set(values).where(eq(creativeLibraryTemplatesTable.id, existing.id));
          id = existing.id;
        } else {
          [{ id }] = await tx.insert(creativeLibraryTemplatesTable).values({ ...values, active: true }).returning({ id: creativeLibraryTemplatesTable.id });
        }
        if (e.replacesBase && e.baseKey) await clearOtherReplacements(tx, e.baseKey, format, e.clips ?? null, id);
        out.push({ key: e.key, format, id, created: !existing });
      }
    }
  });
  return out;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One library template replaces a built-in at a size (and clip count): switching one on switches the others off. */
export async function clearOtherReplacements(tx: Tx | typeof db, baseKey: string, format: string, clips: number | null, keepId: number) {
  await tx.update(creativeLibraryTemplatesTable).set({ replacesBase: false, updatedAt: new Date() }).where(and(
    eq(creativeLibraryTemplatesTable.baseKey, baseKey),
    eq(creativeLibraryTemplatesTable.format, format),
    clips === null ? isNull(creativeLibraryTemplatesTable.clips) : eq(creativeLibraryTemplatesTable.clips, clips),
    eq(creativeLibraryTemplatesTable.replacesBase, true),
    ne(creativeLibraryTemplatesTable.id, keepId),
  ));
}

/** A library template back as a file (every size kept under its key), to edit and upload again. */
export function fileFor(rows: CreativeLibraryTemplate[]): Record<string, unknown> | null {
  const [first] = rows;
  if (!first) return null;
  const formats: Partial<Record<CreativeFormat, Scene>> = {};
  for (const r of rows) formats[r.format as CreativeFormat] = r.scene as Scene;
  return {
    replayTemplate: 1,
    key: first.key,
    title: { en: first.titleEn, ar: first.titleAr },
    ...(first.description ? { description: first.description } : {}),
    audience: first.audience,
    ...(first.baseKey ? { baseKey: first.baseKey } : {}),
    replacesBase: first.replacesBase,
    ...(first.clips ? { clips: first.clips } : {}),
    formats,
    ...(first.sampleData ? { sampleData: first.sampleData } : {}),
  };
}
