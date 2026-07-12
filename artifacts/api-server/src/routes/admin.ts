import { Router, type IRouter } from "express";
import { eq, count, and, desc } from "drizzle-orm";
import { db, adsTable, adImpressionsTable, adClicksTable, usersTable, userClipsTable, fieldsTable } from "@workspace/db";
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
import { getBunnyThumbnailUrl, getBunnyPlaybackUrl, isBunnyConfigured } from "../lib/bunny";
import { getStorageConfig as getBannerStorageConfig, type BannerJson } from "./banners";

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

// ─── Admin: Clips ─────────────────────────────────────────────────────────────

router.get("/admin/clips", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const rows = await db
    .select({
      id: userClipsTable.id,
      userId: userClipsTable.userId,
      videoId: userClipsTable.videoId,
      title: userClipsTable.title,
      visibility: userClipsTable.visibility,
      isHidden: userClipsTable.isHidden,
      likeCount: userClipsTable.likeCount,
      viewCount: userClipsTable.viewCount,
      shareCount: userClipsTable.shareCount,
      score: userClipsTable.score,
      createdAt: userClipsTable.createdAt,
      thumbnailTime: userClipsTable.thumbnailTime,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(userClipsTable)
    .innerJoin(usersTable, eq(userClipsTable.userId, usersTable.id))
    .orderBy(desc(userClipsTable.createdAt));

  const result = rows.map((row) => {
    const thumbnailTime = row.thumbnailTime != null ? parseFloat(row.thumbnailTime) : null;
    return {
      id: row.id,
      userId: row.userId,
      videoId: row.videoId,
      title: row.title,
      visibility: row.visibility,
      isHidden: row.isHidden,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      shareCount: row.shareCount,
      score: row.score,
      createdAt: row.createdAt.toISOString(),
      thumbnailUrl: isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId, thumbnailTime) : null,
      playbackUrl: isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null,
      userName: row.userName,
      userEmail: row.userEmail,
    };
  });

  res.json(result);
});

router.patch("/admin/clips/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { isHidden, visibility } = req.body as { isHidden?: boolean; visibility?: string };
  const updates: Partial<typeof userClipsTable.$inferInsert> = {};
  if (isHidden !== undefined) updates.isHidden = isHidden;
  if (visibility !== undefined) updates.visibility = visibility;

  const [clip] = await db.update(userClipsTable).set(updates).where(eq(userClipsTable.id, id)).returning();
  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }

  res.json({ id: clip.id, isHidden: clip.isHidden, visibility: clip.visibility });
});

// ─── Admin: Users ─────────────────────────────────────────────────────────────

router.get("/admin/users", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.isGuest, false))
    .orderBy(desc(usersTable.createdAt));

  res.json(users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    isAdmin: u.isAdmin,
    isDisabled: u.isDisabled,
    isGuest: u.isGuest,
    profileComplete: u.profileComplete,
    createdAt: u.createdAt.toISOString(),
  })));
});

router.patch("/admin/users/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { isDisabled, isAdmin } = req.body as { isDisabled?: boolean; isAdmin?: boolean };
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (isDisabled !== undefined) updates.isDisabled = isDisabled;
  if (isAdmin !== undefined) updates.isAdmin = isAdmin;

  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  res.json({ id: user.id, isAdmin: user.isAdmin, isDisabled: user.isDisabled });
});

// ─── Admin: Fields ────────────────────────────────────────────────────────────

router.get("/admin/fields", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const fields = await db.select().from(fieldsTable).orderBy(fieldsTable.name);
  res.json(fields.map((f) => ({
    id: f.id,
    name: f.name,
    location: f.location,
    courts: f.courts,
    weight: f.weight,
    thumbnailUrl: f.thumbnailUrl ?? null,
    lastRecordedAt: f.lastRecordedAt?.toISOString() ?? null,
  })));
});

router.patch("/admin/fields/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { thumbnailUrl, weight } = req.body as { thumbnailUrl?: string | null; weight?: number };
  const updates: Partial<typeof fieldsTable.$inferInsert> = {};
  if (thumbnailUrl !== undefined) updates.thumbnailUrl = thumbnailUrl ?? undefined;
  if (weight !== undefined) updates.weight = weight;

  const [field] = await db.update(fieldsTable).set(updates).where(eq(fieldsTable.id, id)).returning();
  if (!field) { res.status(404).json({ error: "Field not found" }); return; }

  res.json({ id: field.id, thumbnailUrl: field.thumbnailUrl ?? null, weight: field.weight });
});

// ─── Admin: Banners ───────────────────────────────────────────────────────────

function getBannerCfg() {
  return getBannerStorageConfig();
}

router.get("/admin/banners", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const cfg = getBannerCfg();
  if (!cfg) { res.json([]); return; }

  try {
    const listRes = await fetch(`${cfg.base}/${cfg.zone}/`, { headers: { AccessKey: cfg.key } });
    if (!listRes.ok) { res.status(502).json({ error: "Failed to list banners" }); return; }
    const items = (await listRes.json()) as Array<{ ObjectName: string; IsDirectory: boolean }>;
    const folders = items.filter((i) => i.IsDirectory);

    const banners = await Promise.all(folders.map(async (f) => {
      const jsonRes = await fetch(`${cfg.base}/${cfg.zone}/${f.ObjectName}/banner.json`, { headers: { AccessKey: cfg.key } });
      const json: BannerJson = jsonRes.ok ? (await jsonRes.json() as BannerJson) : {};
      return {
        id: f.ObjectName,
        title: json.title ?? f.ObjectName,
        upperSubtext: json.upperSubtext ?? "",
        lowerSubtext: json.lowerSubtext ?? "",
        hyperlink: json.hyperlink ?? null,
        imageUrl: `/api/banners/${encodeURIComponent(f.ObjectName)}/image`,
      };
    }));

    res.json(banners);
  } catch {
    res.status(502).json({ error: "Failed to fetch banners" });
  }
});

router.post("/admin/banners", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const cfg = getBannerCfg();
  if (!cfg) { res.status(503).json({ error: "Storage not configured" }); return; }

  const { id, title, upperSubtext, lowerSubtext, hyperlink } = req.body as {
    id: string; title?: string; upperSubtext?: string; lowerSubtext?: string; hyperlink?: string | null;
  };
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: "id must be alphanumeric/dash/underscore" }); return;
  }

  const json: BannerJson = { title: title ?? id, upperSubtext: upperSubtext ?? "", lowerSubtext: lowerSubtext ?? "", hyperlink: hyperlink ?? null };
  const body = JSON.stringify(json);

  const putRes = await fetch(`${cfg.base}/${cfg.zone}/${id}/banner.json`, {
    method: "PUT",
    headers: { AccessKey: cfg.key, "Content-Type": "application/json" },
    body,
  });

  if (!putRes.ok) { res.status(502).json({ error: "Failed to create banner" }); return; }

  res.status(201).json({ id, title: json.title, upperSubtext: json.upperSubtext, lowerSubtext: json.lowerSubtext, hyperlink: json.hyperlink, imageUrl: `/api/banners/${encodeURIComponent(id)}/image` });
});

router.patch("/admin/banners/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const cfg = getBannerCfg();
  if (!cfg) { res.status(503).json({ error: "Storage not configured" }); return; }

  const folderId = req.params.id as string;
  const { title, upperSubtext, lowerSubtext, hyperlink } = req.body as {
    title?: string; upperSubtext?: string; lowerSubtext?: string; hyperlink?: string | null;
  };

  // Fetch existing json first
  const existingRes = await fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json`, { headers: { AccessKey: cfg.key } });
  const existing: BannerJson = existingRes.ok ? (await existingRes.json() as BannerJson) : {};

  const updated: BannerJson = {
    title: title !== undefined ? title : existing.title,
    upperSubtext: upperSubtext !== undefined ? upperSubtext : existing.upperSubtext,
    lowerSubtext: lowerSubtext !== undefined ? lowerSubtext : existing.lowerSubtext,
    hyperlink: hyperlink !== undefined ? hyperlink : existing.hyperlink,
  };

  const putRes = await fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json`, {
    method: "PUT",
    headers: { AccessKey: cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify(updated),
  });

  if (!putRes.ok) { res.status(502).json({ error: "Failed to update banner" }); return; }

  res.json({ id: folderId, ...updated, imageUrl: `/api/banners/${encodeURIComponent(folderId)}/image` });
});

router.delete("/admin/banners/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const cfg = getBannerCfg();
  if (!cfg) { res.status(503).json({ error: "Storage not configured" }); return; }

  const folderId = req.params.id as string;

  // Delete banner.json and banner.png
  await Promise.allSettled([
    fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json`, { method: "DELETE", headers: { AccessKey: cfg.key } }),
    fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.png`, { method: "DELETE", headers: { AccessKey: cfg.key } }),
  ]);

  res.json({ ok: true });
});

export default router;
