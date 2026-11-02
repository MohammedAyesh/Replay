import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { academiesTable, db, type Academy } from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "./academyAccess";

/**
 * Academy console sections only the owner may use (Branding, Studio). Every
 * other member of the academy — a coach, today — gets 403, and so does anyone
 * outside it. Admin status is deliberately not an implicit owner, as in
 * academyAccess.ts.
 */

export function academyIdParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type AcademyOwnerAccess = { user: AcademyConsoleUser; academyId: number; academy: Academy };

export async function requireAcademyOwner(
  req: Request,
  res: Response,
  what = "this",
): Promise<AcademyOwnerAccess | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = academyIdParam(req.params.academyId);
  if (!academyId) { res.status(400).json({ error: "Invalid academy id" }); return null; }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  if (!roles.includes("owner")) {
    res.status(403).json({ error: `Only the academy owner can use ${what}.` });
    return null;
  }
  const [academy] = await db.select().from(academiesTable).where(eq(academiesTable.id, academyId));
  if (!academy) { res.status(404).json({ error: "Academy not found" }); return null; }
  return { user, academyId, academy };
}

/** "962791234567" → "079 123 4567"; anything else as stored. */
export function displayPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const m = /^962(7\d)(\d{3})(\d{4})$/.exec(phone);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : phone;
}

/** "https://instagram.com/galaxy.academy/" → "galaxy.academy". */
export function instagramHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (!/instagram\.com$/i.test(parsed.hostname.replace(/^www\./i, ""))) return null;
    const handle = parsed.pathname.split("/").filter(Boolean)[0];
    return handle && /^[\w.]{1,40}$/.test(handle) ? handle : null;
  } catch {
    return null;
  }
}
