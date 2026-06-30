import { Router, type IRouter } from "express";
import { eq, count, and } from "drizzle-orm";
import { db, adsTable, adImpressionsTable, adClicksTable, usersTable } from "@workspace/db";
import {
  UpdateAdParams,
  UpdateAdBody,
  CreateAdBody,
  GetAdStatsParams,
  ListAdminAdsResponse,
  CreateAdResponse,
  UpdateAdResponse,
  GetAdStatsResponse,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";

const router: IRouter = Router();

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.isAdmin) return null;

  return userId;
}

function adToEntry(ad: typeof adsTable.$inferSelect) {
  return {
    id: ad.id,
    title: ad.title,
    creativeUrl: ad.creativeUrl,
    clickUrl: ad.clickUrl,
    durationSeconds: ad.durationSeconds,
    targetType: ad.targetType,
    targetFieldId: ad.targetFieldId ?? null,
    startsAt: ad.startsAt?.toISOString() ?? null,
    endsAt: ad.endsAt?.toISOString() ?? null,
    status: ad.status,
    createdAt: ad.createdAt.toISOString(),
  };
}

router.get("/admin/ads", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const ads = await db.select().from(adsTable).orderBy(adsTable.createdAt);
  res.json(ListAdminAdsResponse.parse(ads.map(adToEntry)));
});

router.post("/admin/ads", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateAdBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [ad] = await db
    .insert(adsTable)
    .values({
      title: body.data.title,
      creativeUrl: body.data.creativeUrl,
      clickUrl: body.data.clickUrl,
      durationSeconds: body.data.durationSeconds ?? 15,
      targetType: body.data.targetType ?? "all",
      targetFieldId: body.data.targetFieldId ?? undefined,
      startsAt: body.data.startsAt ? new Date(body.data.startsAt) : undefined,
      endsAt: body.data.endsAt ? new Date(body.data.endsAt) : undefined,
      status: body.data.status ?? "active",
    })
    .returning();

  res.status(201).json(CreateAdResponse.parse(adToEntry(ad)));
});

router.patch("/admin/ads/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateAdParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateAdBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const updates: Partial<typeof adsTable.$inferInsert> = {};
  if (body.data.status !== undefined) updates.status = body.data.status;
  if (body.data.title !== undefined) updates.title = body.data.title;
  if (body.data.creativeUrl !== undefined) updates.creativeUrl = body.data.creativeUrl;
  if (body.data.clickUrl !== undefined) updates.clickUrl = body.data.clickUrl;
  if (body.data.durationSeconds !== undefined) updates.durationSeconds = body.data.durationSeconds;

  const [ad] = await db
    .update(adsTable)
    .set(updates)
    .where(eq(adsTable.id, params.data.id))
    .returning();

  if (!ad) {
    res.status(404).json({ error: "Ad not found" });
    return;
  }

  res.json(UpdateAdResponse.parse(adToEntry(ad)));
});

router.get("/admin/ads/:id/stats", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetAdStatsParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const adId = params.data.id;

  const [impressionCount] = await db
    .select({ value: count() })
    .from(adImpressionsTable)
    .where(eq(adImpressionsTable.adId, adId));

  const [completionCount] = await db
    .select({ value: count() })
    .from(adImpressionsTable)
    .where(and(eq(adImpressionsTable.adId, adId), eq(adImpressionsTable.completed, true)));

  const [clickCount] = await db
    .select({ value: count() })
    .from(adClicksTable)
    .where(eq(adClicksTable.adId, adId));

  const impressions = impressionCount?.value ?? 0;
  const completions = completionCount?.value ?? 0;
  const clicks = clickCount?.value ?? 0;

  res.json(GetAdStatsResponse.parse({
    impressions,
    clicks,
    completions,
    skipRate: impressions > 0 ? (impressions - completions) / impressions : 0,
    completionRate: impressions > 0 ? completions / impressions : 0,
  }));
});

export default router;
