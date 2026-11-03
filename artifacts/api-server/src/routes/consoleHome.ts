import { and, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { academiesTable, academyMembersTable, db, fieldOwnersTable } from "@workspace/db";
import { requireAcademyConsoleUser } from "../lib/academyAccess";

/**
 * Where someone with a console should land after signing in: academy owners, managers and
 * coaches go to their academy console; field staff to the field console; a field owner
 * without one yet to the footage owner page. Everyone else (and admins) keeps the app home.
 * The web app asks once per browser session, on the default landing.
 */
const router: IRouter = Router();

export async function consoleHomeFor(userId: number, isAdmin: boolean): Promise<"/academy" | "/field" | "/owner" | null> {
  if (isAdmin) return null;
  const rows = await db.select({ kind: academiesTable.kind })
    .from(academyMembersTable)
    .innerJoin(academiesTable, eq(academiesTable.id, academyMembersTable.academyId))
    .where(and(eq(academyMembersTable.userId, userId), inArray(academyMembersTable.role, ["owner", "manager", "coach"])));
  if (rows.some((r) => r.kind === "venue")) return "/field";
  if (rows.some((r) => r.kind === "academy")) return "/academy";
  const [owned] = await db.select({ id: fieldOwnersTable.fieldId }).from(fieldOwnersTable).where(eq(fieldOwnersTable.userId, userId)).limit(1);
  return owned ? "/owner" : null;
}

router.get("/me/console-home", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  res.setHeader("Cache-Control", "no-store");
  res.json({ target: await consoleHomeFor(user.id, Boolean(user.isAdmin)) });
});

export default router;
