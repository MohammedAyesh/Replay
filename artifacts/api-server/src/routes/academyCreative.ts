import fs from "fs";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { academyCreativeProjectsTable, brandingProfilesTable, db } from "@workspace/db";
import { CREATIVE_STATUSES, CREATIVE_STYLES, sceneSchema, type CreativeBrand } from "@workspace/api-zod";
import { displayPhone, instagramHandle } from "../lib/academyOwner";
import { namesAllowed, studioLook } from "./academyStudio";
import { CREATIVE_BASE, creativeOwner, loadCreativeProject, publicProject } from "../lib/creative/projects";
import { academyPack, publicPack, styleAllowedFor } from "../lib/creative/packs";

/**
 * Academy console → Creative hub: projects (owner only).
 *
 * A project is one post, story or video, stored as a scene. Sections of the
 * hub add their own routers under the same base:
 *   academyCreativeForYou    drafts Replay prepares after each match
 *   academyCreativeLibrary   footage, moments, players and uploads to build from
 *   academyCreativeTemplates the template catalogue as scenes
 *   academyCreativeRender    PNG / MP4 export of a scene
 *   academyCreativePublish   download, Instagram/Facebook, WhatsApp, ads, schedule
 */
const router: IRouter = Router();
const base = CREATIVE_BASE;

const createBody = z.object({
  title: z.string().trim().max(120).default(""),
  kind: z.enum(["image", "video"]).optional(),
  templateKey: z.string().max(80).nullish(),
  style: z.enum(CREATIVE_STYLES).nullish(),
  scene: sceneSchema,
  data: z.record(z.unknown()).nullish(),
  sourceSessionId: z.number().int().positive().nullish(),
});

const patchBody = z.object({
  title: z.string().trim().max(120).optional(),
  templateKey: z.string().max(80).nullish(),
  style: z.enum(CREATIVE_STYLES).nullish(),
  scene: sceneSchema.optional(),
  data: z.record(z.unknown()).nullish(),
  status: z.enum(CREATIVE_STATUSES).optional(),
});

/**
 * GET …/creative/brand — what scene tokens resolve to (@primary, @accent, …),
 * the crest URL, contact lines, whether players' names may be shown, and the
 * academy's brand pack ({ key, name, franchise } or null; see lib/creative/packs.ts).
 */
router.get(`${base}/brand`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const temps: string[] = [];
  try {
    const [look, showNames, profileRows] = await Promise.all([
      studioLook(access, temps),
      namesAllowed(access.academyId),
      db.select({ crestUrl: brandingProfilesTable.crestUrl, updatedAt: brandingProfilesTable.updatedAt }).from(brandingProfilesTable)
        .where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, access.academyId))),
    ]);
    const profile = profileRows[0];
    const brand: CreativeBrand = {
      primary: look.primaryColor,
      accent: look.accentColor ?? "#D4FF4F",
      ink: "#0B0F1A",
      paper: "#FFFFFF",
      muted: "#8A93A6",
      nameEn: look.nameEn,
      nameAr: look.nameAr,
    };
    const crestUrl = profile?.crestUrl
      ? `/api/academy/console/academies/${access.academyId}/branding/crest?v=${encodeURIComponent(profile.updatedAt.toISOString())}`
      : access.academy.logoUrl ?? null;
    res.json({
      brand,
      crestUrl,
      showPlayerNames: showNames,
      instagram: look.instagram ?? instagramHandle(access.academy.instagramUrl),
      phone: look.bookingPhone ?? displayPhone(access.academy.whatsappPhone) ?? access.academy.contactPhone ?? null,
      pack: publicPack(academyPack(access.academy)),
    });
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
});

/**
 * A pack style is only for the academy it was made for: refuse (400) a project
 * whose style, or whose scene's template style, is someone else's pack.
 */
function refuseForeignPack(
  academy: { creativePack: string | null },
  styles: Array<string | null | undefined>,
  res: Response,
): boolean {
  if (styles.every((s) => styleAllowedFor(academy, s))) return false;
  res.status(400).json({ error: "That style isn't available to this academy.", code: "style_not_allowed" });
  return true;
}

router.get(`${base}/projects`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const statuses = String(req.query.status ?? "").split(",").filter((s): s is (typeof CREATIVE_STATUSES)[number] =>
    (CREATIVE_STATUSES as readonly string[]).includes(s));
  const origin = req.query.origin === "auto" || req.query.origin === "manual" ? req.query.origin : null;
  const where = [eq(academyCreativeProjectsTable.academyId, access.academyId)];
  if (statuses.length) where.push(inArray(academyCreativeProjectsTable.status, statuses));
  if (origin) where.push(eq(academyCreativeProjectsTable.origin, origin));
  const rows = await db.select().from(academyCreativeProjectsTable).where(and(...where))
    .orderBy(desc(academyCreativeProjectsTable.updatedAt)).limit(200);
  res.json({ projects: rows.map(publicProject) });
});

router.post(`${base}/projects`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid project", issues: parsed.error.issues.slice(0, 5) }); return; }
  const b = parsed.data;
  if (refuseForeignPack(access.academy, [b.style, b.scene.template?.style], res)) return;
  const [row] = await db.insert(academyCreativeProjectsTable).values({
    academyId: access.academyId,
    kind: b.kind ?? (b.scene.durationMs ? "video" : "image"),
    format: b.scene.format,
    title: b.title,
    templateKey: b.templateKey ?? b.scene.template?.key ?? null,
    style: b.style ?? b.scene.template?.style ?? null,
    scene: b.scene,
    data: b.data ?? null,
    sourceSessionId: b.sourceSessionId ?? null,
    createdBy: access.user.id,
  }).returning();
  res.status(201).json({ project: publicProject(row) });
});

router.get(`${base}/projects/:projectId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (row) res.json({ project: publicProject(row) });
});

router.patch(`${base}/projects/:projectId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid change", issues: parsed.error.issues.slice(0, 5) }); return; }
  const b = parsed.data;
  if (refuseForeignPack(access.academy, [b.style, b.scene?.template?.style], res)) return;
  const set: Partial<typeof academyCreativeProjectsTable.$inferInsert> = { updatedAt: new Date() };
  if (b.title !== undefined) set.title = b.title;
  if (b.templateKey !== undefined) set.templateKey = b.templateKey;
  if (b.style !== undefined) set.style = b.style;
  if (b.data !== undefined) set.data = b.data;
  if (b.status !== undefined) set.status = b.status;
  if (b.scene) {
    set.scene = b.scene;
    set.format = b.scene.format;
    set.kind = b.scene.durationMs ? "video" : "image";
    // An edited design needs a fresh export.
    set.renderStatus = "none";
    set.renderError = null;
  }
  const [updated] = await db.update(academyCreativeProjectsTable).set(set)
    .where(eq(academyCreativeProjectsTable.id, row.id)).returning();
  res.json({ project: publicProject(updated) });
});

router.post(`${base}/projects/:projectId/duplicate`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  const [copy] = await db.insert(academyCreativeProjectsTable).values({
    academyId: access.academyId, kind: row.kind, format: row.format,
    title: row.title ? `${row.title} (2)`.slice(0, 120) : "", templateKey: row.templateKey, style: row.style,
    scene: row.scene, data: row.data, sourceSessionId: row.sourceSessionId, createdBy: access.user.id,
  }).returning();
  res.status(201).json({ project: publicProject(copy) });
});

router.delete(`${base}/projects/:projectId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  if (row.origin === "auto") {
    // Keep the row so the same draft is not made again after the next sync.
    await db.update(academyCreativeProjectsTable).set({ status: "skipped", updatedAt: new Date() })
      .where(eq(academyCreativeProjectsTable.id, row.id));
  } else {
    await db.delete(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, row.id));
  }
  res.status(204).end();
});

export default router;
