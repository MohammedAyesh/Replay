import { and, eq, ne } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { academyCreativeProjectsTable, academyCreativeTemplatesTable, db } from "@workspace/db";
import { sceneSchema, type Scene } from "@workspace/api-zod";
import { CREATIVE_BASE, creativeOwner, projectIdParam } from "../lib/creative/projects";
import { listMyTemplates, publicTemplate, templatize } from "../lib/creative/myTemplates";

/**
 * Creative hub → Templates → My templates. Owner-only; see routes/academyCreative.ts.
 *
 *   GET    …/creative/my-templates                list
 *   POST   …/creative/my-templates                { projectId, title, replacesBase? } save a design as a template
 *   PATCH  …/creative/my-templates/:templateId    { title?, replacesBase?, projectId? } rename, switch, or update its design from a project
 *   DELETE …/creative/my-templates/:templateId
 *
 * "replacesBase": the template stands in for the catalogue template it came from, everywhere
 * (the field Instagram autopilot and the academy's own drafts included). One per template and size.
 */
const router: IRouter = Router();
const base = CREATIVE_BASE;

const createBody = z.object({
  projectId: z.number().int().positive(),
  title: z.string().trim().min(1).max(80),
  replacesBase: z.boolean().optional(),
});
const patchBody = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  replacesBase: z.boolean().optional(),
  projectId: z.number().int().positive().optional(),
});

/** Only one template replaces a catalogue template at a size: switching one on switches the other off. */
async function clearOtherReplacements(academyId: number, baseKey: string, format: string, keepId: number | null) {
  await db.update(academyCreativeTemplatesTable).set({ replacesBase: false, updatedAt: new Date() }).where(and(
    eq(academyCreativeTemplatesTable.academyId, academyId),
    eq(academyCreativeTemplatesTable.baseKey, baseKey),
    eq(academyCreativeTemplatesTable.format, format),
    eq(academyCreativeTemplatesTable.replacesBase, true),
    ...(keepId ? [ne(academyCreativeTemplatesTable.id, keepId)] : []),
  ));
}

async function projectFor(academyId: number, projectId: number) {
  const [row] = await db.select().from(academyCreativeProjectsTable)
    .where(and(eq(academyCreativeProjectsTable.id, projectId), eq(academyCreativeProjectsTable.academyId, academyId)));
  return row ?? null;
}

/** The project's design, ready to save: its template mark set to this template. */
function designOf(scene: unknown, id: number | null): Scene | null {
  const parsed = sceneSchema.safeParse(scene);
  if (!parsed.success) return null;
  const s = templatize(parsed.data);
  return s.template && id ? { ...s, template: { ...s.template, mine: id } } : s;
}

router.get(`${base}/my-templates`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  res.json({ templates: (await listMyTemplates(access.academyId)).map(publicTemplate) });
});

router.post(`${base}/my-templates`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const body = createBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Give the template a name" }); return; }
  const project = await projectFor(access.academyId, body.data.projectId);
  if (!project) { res.status(404).json({ error: "Not found" }); return; }
  const baseKey = project.templateKey ?? (project.scene as Scene | null)?.template?.key ?? null;
  if (!baseKey) { res.status(409).json({ error: "This design wasn't made from a template", code: "no_template" }); return; }
  const scene = designOf(project.scene, null);
  if (!scene) { res.status(409).json({ error: "This design can't be saved as a template", code: "invalid_scene" }); return; }
  const row = await db.transaction(async (tx) => {
    const [made] = await tx.insert(academyCreativeTemplatesTable).values({
      academyId: access.academyId, baseKey, style: project.style ?? scene.template?.style ?? null, format: scene.format,
      kind: scene.durationMs !== undefined ? "video" : "image", title: body.data.title, scene, sampleData: project.data ?? null,
      replacesBase: false, createdBy: access.user.id,
    }).returning();
    const marked = designOf(project.scene, made.id)!;
    const [done] = await tx.update(academyCreativeTemplatesTable).set({ scene: marked }).where(eq(academyCreativeTemplatesTable.id, made.id)).returning();
    // The project now belongs to this template: "Update template" from it changes this one.
    await tx.update(academyCreativeProjectsTable).set({ scene: { ...(project.scene as Scene), template: marked.template } })
      .where(eq(academyCreativeProjectsTable.id, project.id));
    return done;
  });
  if (body.data.replacesBase) {
    await clearOtherReplacements(access.academyId, row.baseKey, row.format, row.id);
    const [on] = await db.update(academyCreativeTemplatesTable).set({ replacesBase: true }).where(eq(academyCreativeTemplatesTable.id, row.id)).returning();
    res.status(201).json({ template: publicTemplate(on) });
    return;
  }
  res.status(201).json({ template: publicTemplate(row) });
});

router.patch(`${base}/my-templates/:templateId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const id = projectIdParam(req.params.templateId);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = patchBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid change" }); return; }
  const [row] = await db.select().from(academyCreativeTemplatesTable)
    .where(and(eq(academyCreativeTemplatesTable.id, id), eq(academyCreativeTemplatesTable.academyId, access.academyId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const set: Partial<typeof academyCreativeTemplatesTable.$inferInsert> = { updatedAt: new Date() };
  if (body.data.title !== undefined) set.title = body.data.title;
  if (body.data.projectId !== undefined) {
    const project = await projectFor(access.academyId, body.data.projectId);
    if (!project) { res.status(404).json({ error: "Not found" }); return; }
    const scene = designOf(project.scene, row.id);
    if (!scene) { res.status(409).json({ error: "This design can't be saved as a template", code: "invalid_scene" }); return; }
    if (scene.format !== row.format) { res.status(409).json({ error: "That design is another size: save it as a new template", code: "other_format" }); return; }
    set.scene = scene;
    set.kind = scene.durationMs !== undefined ? "video" : "image";
    set.sampleData = project.data ?? null;
  }
  if (body.data.replacesBase !== undefined) {
    if (body.data.replacesBase) await clearOtherReplacements(access.academyId, row.baseKey, row.format, row.id);
    set.replacesBase = body.data.replacesBase;
  }
  const [updated] = await db.update(academyCreativeTemplatesTable).set(set).where(eq(academyCreativeTemplatesTable.id, row.id)).returning();
  res.json({ template: publicTemplate(updated) });
});

router.delete(`${base}/my-templates/:templateId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const id = projectIdParam(req.params.templateId);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const gone = await db.delete(academyCreativeTemplatesTable)
    .where(and(eq(academyCreativeTemplatesTable.id, id), eq(academyCreativeTemplatesTable.academyId, access.academyId)))
    .returning({ id: academyCreativeTemplatesTable.id });
  if (!gone.length) { res.status(404).json({ error: "Not found" }); return; }
  res.status(204).end();
});

export default router;
