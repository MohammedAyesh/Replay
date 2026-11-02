import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { academyCreativeProjectsTable, db, type AcademyCreativeProject } from "@workspace/db";
import { requireAcademyOwner, type AcademyOwnerAccess } from "../academyOwner";

/** Every Creative hub route lives under this base and is owner-only, like Studio. */
export const CREATIVE_BASE = "/academy/console/academies/:academyId/creative";

export const creativeOwner = (req: Request, res: Response): Promise<AcademyOwnerAccess | null> =>
  requireAcademyOwner(req, res, "the Creative hub");

export function projectIdParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The project, only if it belongs to this academy; otherwise answers 404 and returns null. */
export async function loadCreativeProject(
  access: AcademyOwnerAccess,
  req: Request,
  res: Response,
  param = "projectId",
): Promise<AcademyCreativeProject | null> {
  const id = projectIdParam(req.params[param]);
  if (!id) { res.status(400).json({ error: "Invalid project id" }); return null; }
  const [row] = await db.select().from(academyCreativeProjectsTable)
    .where(and(eq(academyCreativeProjectsTable.id, id), eq(academyCreativeProjectsTable.academyId, access.academyId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return null; }
  return row;
}

/** The shape the console reads. outputUrl is an API path, never a Storage URL. */
export function publicProject(row: AcademyCreativeProject) {
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    title: row.title,
    templateKey: row.templateKey,
    style: row.style,
    status: row.status,
    origin: row.origin,
    sourceSessionId: row.sourceSessionId,
    scene: row.scene,
    data: row.data ?? null,
    renderStatus: row.renderStatus,
    renderError: row.renderError,
    outputUrl: row.outputPath ? `/api/academy/console/academies/${row.academyId}/creative/projects/${row.id}/output` : null,
    outputMime: row.outputMime,
    renderedAt: row.renderedAt,
    publishTargets: row.publishTargets ?? [],
    scheduledAt: row.scheduledAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export type PublicCreativeProject = ReturnType<typeof publicProject>;
