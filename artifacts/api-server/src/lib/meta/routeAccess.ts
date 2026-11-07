import type { Request, Response } from "express";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "../academyAccess";
import { logger } from "../logger";
import { MetaGraphError } from "./graph";

export function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The academy's owner (or 400/403 already sent). */
export async function ownerAccess(req: Request, res: Response): Promise<{ user: AcademyConsoleUser; academyId: number } | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) {
    res.status(400).json({ error: "Invalid academy id" });
    return null;
  }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  if (!roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return null;
  }
  return { user, academyId };
}

export async function adminAccess(req: Request, res: Response): Promise<AcademyConsoleUser | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return user;
}

export function sendFailure(res: Response, error: unknown, what: string) {
  if (error instanceof MetaGraphError) {
    res.status(error.status >= 400 && error.status < 600 ? (error.status === 500 ? 502 : error.status) : 502).json({ error: error.message });
    return;
  }
  const cause = (error as { cause?: { code?: string } })?.cause;
  if (cause?.code === "42P01") {
    res.status(500).json({ error: "A required database table is missing. Apply the schema update, then publish again." });
    return;
  }
  if (cause?.code === "42703") {
    res.status(500).json({ error: "A required database column is missing. Apply the schema update, then publish again." });
    return;
  }
  logger.error({ error: (error as Error)?.message }, what);
  res.status(500).json({ error: (error as Error)?.message?.slice(0, 300) ?? "Failed" });
}
