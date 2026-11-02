import type { NextFunction, Request, Response } from "express";
import { getLocalUserRecord } from "../lib/clerkUserBridge";
import { academyRolesForUser } from "../lib/academyAccess";
import { logger } from "../lib/logger";
import { PRIVATE_SECTIONS, loadAccess, primaryRole, sectionForPath, staffAccess } from "../lib/academyPermissions";

/**
 * Runs before every academy console route. For managers and coaches it applies what the
 * owner set in Academy console → Team: a section hidden from the role refuses changes (and
 * reads of private data), and a section the member manages gets the owner's controls (the
 * route's own owner check then passes). Owners, non-members and other paths pass through.
 */
export async function academyAccessGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const target = sectionForPath(req.path);
  if (!target || !target.section || target.section === "team") { next(); return; }
  try {
    const user = await getLocalUserRecord(req);
    if (!user || user.isGuest) { next(); return; }
    const role = primaryRole(await academyRolesForUser(user.id, target.academyId));
    if (!role || role === "owner") { next(); return; }
    const access = staffAccess(role, await loadAccess(target.academyId));
    const section = target.section;
    if (!access.sections.includes(section)) {
      if (req.method !== "GET" || PRIVATE_SECTIONS.includes(section)) {
        res.status(403).json({ error: "The academy owner has turned this off for your role.", code: "section_hidden", section });
        return;
      }
      next();
      return;
    }
    if (access.manages.includes(section)) {
      res.locals.academyElevated = { academyId: target.academyId, userId: user.id };
    }
    next();
  } catch (error) {
    logger.warn({ error: (error as Error).message, path: req.path }, "Academy access gate failed; continuing without it");
    next();
  }
}
