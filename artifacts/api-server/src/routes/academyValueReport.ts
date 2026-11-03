import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { academyValueReportSharesTable, db } from "@workspace/db";
import { logger } from "../lib/logger";
import { ammanMonth, buildValueReport, isMonth, shareView } from "../lib/valueReport";
import { consoleAccess } from "./academyMatches";

/**
 * The monthly value report (academy console, owner):
 *
 *   GET    …/value-report?month=YYYY-MM     the month's figures and its share link, if any
 *   POST   …/value-report/share {month}     a link anyone can open (/vr/<token>); the same link again if one is live
 *   DELETE …/value-report/share/:id         turn a link off
 *
 * And without an account: GET /vr/:token, the shared month (counts only).
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/value-report";

async function liveShare(academyId: number, month: string) {
  const [row] = await db.select().from(academyValueReportSharesTable).where(and(
    eq(academyValueReportSharesTable.academyId, academyId),
    eq(academyValueReportSharesTable.month, month),
    isNull(academyValueReportSharesTable.revokedAt),
  )).limit(1);
  return row ? { id: row.id, token: row.token, createdAt: row.createdAt.toISOString() } : null;
}

router.get(base, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res, true);
  if (!access) return;
  const month = isMonth(req.query.month) ? req.query.month : ammanMonth(new Date());
  if (month > ammanMonth(new Date())) { res.status(400).json({ error: "That month hasn't started" }); return; }
  try {
    const report = await buildValueReport(access.academyId, month);
    if (!report) { res.status(404).json({ error: "Academy not found" }); return; }
    res.json({ report, share: await liveShare(access.academyId, month) });
  } catch (error) {
    logger.error({ error: (error as Error)?.message, academyId: access.academyId, month }, "Value report failed");
    res.status(500).json({ error: "Couldn't build the report" });
  }
});

const ShareBody = z.object({ month: z.string().refine(isMonth) });

router.post(`${base}/share`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res, true);
  if (!access) return;
  const body = ShareBody.safeParse(req.body ?? {});
  if (!body.success || body.data.month > ammanMonth(new Date())) { res.status(400).json({ error: "Invalid month" }); return; }
  const existing = await liveShare(access.academyId, body.data.month);
  if (existing) { res.json({ share: existing }); return; }
  const [row] = await db.insert(academyValueReportSharesTable).values({
    academyId: access.academyId, month: body.data.month, token: randomBytes(16).toString("hex"), createdBy: access.user.id,
  }).returning();
  res.status(201).json({ share: { id: row.id, token: row.token, createdAt: row.createdAt.toISOString() } });
});

router.delete(`${base}/share/:shareId`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res, true);
  if (!access) return;
  const shareId = Number(req.params.shareId);
  if (!Number.isSafeInteger(shareId) || shareId <= 0) { res.status(400).json({ error: "Invalid link" }); return; }
  const done = await db.update(academyValueReportSharesTable).set({ revokedAt: new Date() }).where(and(
    eq(academyValueReportSharesTable.id, shareId),
    eq(academyValueReportSharesTable.academyId, access.academyId),
    isNull(academyValueReportSharesTable.revokedAt),
  )).returning({ id: academyValueReportSharesTable.id });
  if (!done.length) { res.status(404).json({ error: "Link not found" }); return; }
  res.json({ ok: true });
});

router.get("/vr/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  if (!/^[0-9a-f]{32}$/.test(token)) { res.status(404).json({ error: "Report not found" }); return; }
  const [row] = await db.select().from(academyValueReportSharesTable).where(and(
    eq(academyValueReportSharesTable.token, token),
    isNull(academyValueReportSharesTable.revokedAt),
  )).limit(1);
  if (!row) { res.status(404).json({ error: "Report not found" }); return; }
  try {
    const report = await buildValueReport(row.academyId, row.month);
    if (!report) { res.status(404).json({ error: "Report not found" }); return; }
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Robots-Tag", "noindex");
    res.json({ report: shareView(report) });
  } catch (error) {
    logger.error({ error: (error as Error)?.message, shareId: row.id }, "Shared value report failed");
    res.status(500).json({ error: "Couldn't build the report" });
  }
});

export default router;
