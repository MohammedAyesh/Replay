import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { academyFavoritesTable, db } from "@workspace/db";
import { consoleAccess } from "./academyMatches";

/**
 * Stars in the Creative hub (each console user's own):
 *
 *   GET …/favorites                        { template: [...keys], clip: [...], project: [...] }, newest star first
 *   PUT …/favorites { kind, key, on }      star or unstar one item; answers with the full set
 *
 * Starred items come first in Templates, Clips, Library and the draft lists.
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/favorites";
const KINDS = ["template", "clip", "project"] as const;
type Kind = (typeof KINDS)[number];

async function favoritesOf(academyId: number, userId: number): Promise<Record<Kind, string[]>> {
  const rows = await db.select({ kind: academyFavoritesTable.kind, key: academyFavoritesTable.itemKey })
    .from(academyFavoritesTable)
    .where(and(eq(academyFavoritesTable.academyId, academyId), eq(academyFavoritesTable.userId, userId)))
    .orderBy(desc(academyFavoritesTable.createdAt), desc(academyFavoritesTable.id));
  const out: Record<Kind, string[]> = { template: [], clip: [], project: [] };
  for (const r of rows) if ((KINDS as readonly string[]).includes(r.kind)) out[r.kind as Kind].push(r.key);
  return out;
}

router.get(base, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  res.json(await favoritesOf(access.academyId, access.user.id));
});

const Body = z.object({
  kind: z.enum(KINDS),
  // Template keys are slugs ("fulltime", "studio:match"); clips and drafts are numeric ids.
  key: z.string().trim().min(1).max(80).regex(/^[a-z0-9:_-]+$/i),
  on: z.boolean(),
});

router.put(base, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const body = Body.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid favourite" }); return; }
  const { kind, key, on } = body.data;
  if (kind !== "template" && !/^\d{1,12}$/.test(key)) { res.status(400).json({ error: "Invalid favourite" }); return; }
  if (on) {
    await db.insert(academyFavoritesTable).values({ academyId: access.academyId, userId: access.user.id, kind, itemKey: key }).onConflictDoNothing();
  } else {
    await db.delete(academyFavoritesTable).where(and(
      eq(academyFavoritesTable.academyId, access.academyId),
      eq(academyFavoritesTable.userId, access.user.id),
      eq(academyFavoritesTable.kind, kind),
      eq(academyFavoritesTable.itemKey, key),
    ));
  }
  res.json(await favoritesOf(access.academyId, access.user.id));
});

export default router;
