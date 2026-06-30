import { Router, type IRouter } from "express";
import { eq, and, gt } from "drizzle-orm";
import { db, adsTable, adImpressionsTable, adClicksTable } from "@workspace/db";
import {
  RecordImpressionParams,
  RecordImpressionBody,
  RecordClickParams,
  GetNextAdResponse,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";

const router: IRouter = Router();

router.get("/ads/next", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  const now = new Date();

  const allActive = await db
    .select()
    .from(adsTable)
    .where(eq(adsTable.status, "active"));

  const eligible = allActive.filter((ad) => {
    if (ad.startsAt && ad.startsAt > now) return false;
    if (ad.endsAt && ad.endsAt < now) return false;
    return true;
  });

  if (eligible.length === 0) {
    res.status(204).end();
    return;
  }

  if (userId) {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentImpressions = await db
      .select({ adId: adImpressionsTable.adId })
      .from(adImpressionsTable)
      .where(
        and(
          eq(adImpressionsTable.userId, userId),
          gt(adImpressionsTable.shownAt, thirtyMinutesAgo)
        )
      );

    const recentAdIds = new Set(recentImpressions.map((i) => i.adId));
    const uncapped = eligible.filter((ad) => !recentAdIds.has(ad.id));
    if (uncapped.length === 0) {
      res.status(204).end();
      return;
    }
    const ad = uncapped[Math.floor(Math.random() * uncapped.length)];

    res.json(GetNextAdResponse.parse({
      id: ad.id,
      creativeUrl: ad.creativeUrl,
      clickUrl: ad.clickUrl,
      durationSeconds: ad.durationSeconds,
      targetType: ad.targetType,
    }));
    return;
  }

  const ad = eligible[Math.floor(Math.random() * eligible.length)];
  res.json(GetNextAdResponse.parse({
    id: ad.id,
    creativeUrl: ad.creativeUrl,
    clickUrl: ad.clickUrl,
    durationSeconds: ad.durationSeconds,
    targetType: ad.targetType,
  }));
});

router.post("/ads/:id/impression", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = RecordImpressionParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = RecordImpressionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const userId = await getLocalUserId(req);

  await db.insert(adImpressionsTable).values({
    adId: params.data.id,
    userId: userId ?? undefined,
    clipId: body.data.clipId,
    completed: body.data.completed,
    skippedAtSecond: body.data.skippedAtSecond ?? undefined,
  });

  res.json({ ok: true });
});

router.post("/ads/:id/click", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = RecordClickParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userId = await getLocalUserId(req);

  await db.insert(adClicksTable).values({
    adId: params.data.id,
    userId: userId ?? undefined,
  });

  res.json({ ok: true });
});

export default router;
