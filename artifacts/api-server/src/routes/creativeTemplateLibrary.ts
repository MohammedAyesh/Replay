import { eq } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { creativeLibraryTemplatesTable, db } from "@workspace/db";
import {
  CREATIVE_STYLES, CREATIVE_TEMPLATES, FIELD_TEMPLATE_KEYS, CLUB_TEMPLATE_KEYS, TEMPLATE_AUDIENCES, TEMPLATE_FILE_MAX_BYTES,
  builtInTemplateFile, fieldTemplateTitle, parseTemplateFile, type CreativeStyle,
} from "@workspace/api-zod";
import { adminAccess } from "../lib/meta/routeAccess";
import { CREATIVE_BASE, creativeOwner } from "../lib/creative/projects";
import { clearOtherReplacements, fileFor, libraryFor, listLibrary, publicLibraryTemplate, saveEntries } from "../lib/creative/templateLibrary";
import { logger } from "../lib/logger";

/**
 * Template library: templates uploaded as files, no code change (2026-11-08).
 *
 * Admin:
 *   GET    /admin/creative/template-library                  every template, every size
 *   POST   /admin/creative/template-library                  body: a template file (see lib/api-zod templateFiles.ts)
 *   PATCH  /admin/creative/template-library/:key             { active?, replacesBase?, audience?, academyIds? } for every size of it
 *   DELETE /admin/creative/template-library/:key
 *   GET    /admin/creative/template-library/:key/file         the template back as a file
 *   GET    /admin/creative/template-builtins                  the built-in templates, to download one as a starting file
 *   GET    /admin/creative/template-builtins/:key/file?locale=ar&style=broadcast
 *
 * A field or academy owner:
 *   GET    …/creative/library-templates                       what its Creative hub shows
 */
const router: IRouter = Router();
const adminBase = "/admin/creative/template-library";

const keyParam = (v: unknown): string | null => (typeof v === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(v) ? v : null);

function failed(res: Response, error: unknown, what: string) {
  logger.error({ error: (error as Error)?.message }, what);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
}

const list = async () => (await listLibrary()).map(publicLibraryTemplate);

router.get(adminBase, async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  try {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ templates: await list() });
  } catch (error) {
    failed(res, error, "Template library: list failed");
  }
});

router.post(adminBase, async (req, res): Promise<void> => {
  const admin = await adminAccess(req, res);
  if (!admin) return;
  try {
    // The page sends the file's own JSON; {"file": …} is taken too.
    const raw = req.body && typeof req.body === "object" && "file" in req.body ? (req.body as { file: unknown }).file : req.body;
    if (JSON.stringify(raw ?? null).length > TEMPLATE_FILE_MAX_BYTES) {
      res.status(413).json({ error: "The file is too big (3 MB at most)", errors: [] });
      return;
    }
    const parsed = parseTemplateFile(raw);
    if (!parsed.ok) {
      res.status(400).json({ error: "The file has problems; nothing was kept", errors: parsed.errors });
      return;
    }
    const saved = await saveEntries(parsed.templates, admin.id);
    logger.info({ adminId: admin.id, keys: [...new Set(saved.map((s) => s.key))] }, "Template library: file uploaded");
    res.status(201).json({ saved, templates: await list() });
  } catch (error) {
    failed(res, error, "Template library: upload failed");
  }
});

const patchBody = z.object({
  active: z.boolean().optional(),
  replacesBase: z.boolean().optional(),
  audience: z.enum(TEMPLATE_AUDIENCES).optional(),
  academyIds: z.array(z.number().int().positive()).max(200).nullable().optional(),
}).strict();

router.patch(`${adminBase}/:key`, async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const key = keyParam(req.params.key);
  const body = patchBody.safeParse(req.body ?? {});
  if (!key || !body.success) { res.status(400).json({ error: "Invalid change" }); return; }
  try {
    const rows = await db.select().from(creativeLibraryTemplatesTable).where(eq(creativeLibraryTemplatesTable.key, key));
    if (!rows.length) { res.status(404).json({ error: "Not found" }); return; }
    if (body.data.replacesBase && !rows[0].baseKey) {
      res.status(409).json({ error: "This template doesn't name a built-in to replace (baseKey)", code: "no_base" });
      return;
    }
    await db.transaction(async (tx) => {
      const set = { ...body.data, ...(body.data.academyIds !== undefined ? { academyIds: body.data.academyIds?.length ? body.data.academyIds : null } : {}), updatedAt: new Date() };
      await tx.update(creativeLibraryTemplatesTable).set(set).where(eq(creativeLibraryTemplatesTable.key, key));
      if (body.data.replacesBase) for (const r of rows) await clearOtherReplacements(tx, r.baseKey!, r.format, r.clips ?? null, r.id);
    });
    res.json({ templates: await list() });
  } catch (error) {
    failed(res, error, "Template library: change failed");
  }
});

router.delete(`${adminBase}/:key`, async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const key = keyParam(req.params.key);
  if (!key) { res.status(400).json({ error: "Invalid key" }); return; }
  try {
    const gone = await db.delete(creativeLibraryTemplatesTable).where(eq(creativeLibraryTemplatesTable.key, key)).returning({ id: creativeLibraryTemplatesTable.id });
    if (!gone.length) { res.status(404).json({ error: "Not found" }); return; }
    res.status(204).end();
  } catch (error) {
    failed(res, error, "Template library: delete failed");
  }
});

function sendFile(res: Response, name: string, file: unknown) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.json"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(JSON.stringify(file, null, 2));
}

router.get(`${adminBase}/:key/file`, async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const key = keyParam(req.params.key);
  if (!key) { res.status(400).json({ error: "Invalid key" }); return; }
  try {
    const rows = await db.select().from(creativeLibraryTemplatesTable).where(eq(creativeLibraryTemplatesTable.key, key));
    const file = fileFor(rows);
    if (!file) { res.status(404).json({ error: "Not found" }); return; }
    sendFile(res, key, file);
  } catch (error) {
    failed(res, error, "Template library: download failed");
  }
});

/** The built-ins a new template can start from: the field pack, the academy pack and the catalogue. */
function builtIns() {
  const field = FIELD_TEMPLATE_KEYS.map((key) => ({ key, group: "field" as const, title: { en: fieldTemplateTitle(key, false), ar: fieldTemplateTitle(key, true) } }));
  const club = CLUB_TEMPLATE_KEYS.map((key) => ({ key, group: "academy" as const, title: CREATIVE_TEMPLATES.find((t) => t.key === key)?.title ?? { en: key, ar: key } }));
  const seen = new Set<string>([...field, ...club].map((t) => t.key));
  const other = CREATIVE_TEMPLATES.filter((t) => !seen.has(t.key)).map((t) => ({ key: t.key, group: "catalogue" as const, title: t.title }));
  return [...field, ...club, ...other];
}

router.get("/admin/creative/template-builtins", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  res.json({ templates: builtIns() });
});

router.get("/admin/creative/template-builtins/:key/file", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const key = typeof req.params.key === "string" ? req.params.key : "";
  const locale = req.query.locale === "en" ? "en" : "ar";
  const style = typeof req.query.style === "string" && (CREATIVE_STYLES as readonly string[]).includes(req.query.style) ? req.query.style as CreativeStyle : undefined;
  try {
    const file = builtInTemplateFile(key, locale, style);
    if (!file) { res.status(404).json({ error: "No such template" }); return; }
    sendFile(res, `${key}-copy`, file);
  } catch (error) {
    failed(res, error, "Template library: built-in download failed");
  }
});

router.get(`${CREATIVE_BASE}/library-templates`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    res.json({ templates: (await libraryFor(access.academyId)).map(publicLibraryTemplate) });
  } catch (error) {
    failed(res, error, "Template library: owner list failed");
  }
});

export default router;

