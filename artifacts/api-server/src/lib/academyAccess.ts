import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, academyMembersTable, usersTable } from "@workspace/db";
import { getLocalUserRecord, unauthenticatedResponse } from "./clerkUserBridge";

export type AcademyConsoleUser = NonNullable<Awaited<ReturnType<typeof getLocalUserRecord>>>;
export type AcademyConsoleRole = typeof academyMembersTable.$inferSelect.role;
const ACADEMY_ROLE_ORDER: AcademyConsoleRole[] = ["owner", "coach"];

export async function requireAcademyConsoleUser(
  req: Request,
  res: Response,
): Promise<AcademyConsoleUser | null> {
  const user = await getLocalUserRecord(req);
  if (!user || user.isGuest) {
    unauthenticatedResponse(res, req);
    return null;
  }
  return user;
}

export async function requireAcademyConsoleAdmin(
  user: AcademyConsoleUser,
  res: Response,
): Promise<boolean> {
  if (user.isAdmin) return true;
  res.status(403).json({ error: "Admin access required" });
  return false;
}

/**
 * Console access always comes from academy_members. Admin status is deliberately
 * not treated as an implicit academy role.
 */
export async function academyRolesForUser(
  userId: number,
  academyId: number,
): Promise<AcademyConsoleRole[]> {
  const assignments = await db
    .select({ role: academyMembersTable.role })
    .from(academyMembersTable)
    .where(and(
      eq(academyMembersTable.userId, userId),
      eq(academyMembersTable.academyId, academyId),
    ));

  return assignments
    .map(({ role }) => role)
    .sort((a, b) => ACADEMY_ROLE_ORDER.indexOf(a) - ACADEMY_ROLE_ORDER.indexOf(b));
}

export async function requireAcademyMembership(
  userId: number,
  academyId: number,
  res: Response,
): Promise<AcademyConsoleRole[] | null> {
  const roles = await academyRolesForUser(userId, academyId);
  if (roles.length > 0) return roles;
  res.status(403).json({ error: "Academy membership required" });
  return null;
}