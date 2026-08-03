import { Router, type IRouter } from "express";
import { eq, count, and, desc, sql } from "drizzle-orm";
import { db, adsTable, adImpressionsTable, adClicksTable, usersTable, userClipsTable, fieldsTable, recordingsTable, savedClipsTable, likesTable, followsTable, clipSettingsTable, recordingSchedulesTable } from "@workspace/db";
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
import { getBunnyThumbnailUrl, getBunnyPlaybackUrl, isBunnyConfigured, BUNNY_API_KEY, BUNNY_LIBRARY_ID, BUNNY_CDN_HOSTNAME, isBunnyStorageConfigured, uploadClipIntroToBunnyStorage } from "../lib/bunny";
import { getStorageConfig as getBannerStorageConfig, isValidBannerId, type BannerJson } from "./banners";
import { logger } from "../lib/logger";
import { isLiveVideoId } from "./userClips";
import multer from "multer";

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
      // Live-sourced clips carry a synthetic videoId ("live:camera2"), not a
      // Bunny GUID — building CDN URLs from it gives the admin panel a broken
      // thumbnail and a player that 404s. Same guard the user-facing routes use.
      thumbnailUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId, thumbnailTime) : null,
      playbackUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null,
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

router.delete("/admin/clips/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(likesTable).where(eq(likesTable.userClipId, id));
  await db.delete(userClipsTable).where(eq(userClipsTable.id, id));
  // savedClipsTable references clipsTable (legacy), not userClipsTable — skip

  res.json({ ok: true });
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
    phone: u.phone ?? null,
    position: u.position ?? null,
    age: u.age ?? null,
    gender: u.gender ?? null,
    clerkId: u.clerkId ?? null,
    createdAt: u.createdAt.toISOString(),
    academyId: u.academyId ?? null,
  })));
});

router.patch("/admin/users/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = req.body as Partial<{
    name: string; email: string; phone: string; position: string;
    age: number | null; gender: string; isDisabled: boolean; isAdmin: boolean;
    academyId: number | null;
  }>;
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (body.name !== undefined && body.name.trim()) updates.name = body.name.trim();
  if (body.email !== undefined && body.email.trim()) updates.email = body.email.trim();
  if (body.phone !== undefined) updates.phone = body.phone.trim() || null;
  if (body.position !== undefined) updates.position = body.position.trim() || null;
  if (body.age !== undefined) updates.age = body.age ?? null;
  if (body.gender !== undefined) updates.gender = body.gender.trim() || null;
  if (body.isDisabled !== undefined) updates.isDisabled = body.isDisabled;
  if (body.isAdmin !== undefined) updates.isAdmin = body.isAdmin;
  if (body.academyId !== undefined) updates.academyId = body.academyId ?? null;

  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  res.json({
    id: user.id, name: user.name, email: user.email, isAdmin: user.isAdmin,
    isDisabled: user.isDisabled, phone: user.phone ?? null, position: user.position ?? null,
    age: user.age ?? null, gender: user.gender ?? null, academyId: user.academyId ?? null,
  });
});

router.delete("/admin/users/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  if (id === adminId) { res.status(409).json({ error: "Cannot delete yourself" }); return; }

  // One transaction, so a failure part-way cannot leave the account alive with
  // its clips already destroyed.
  //
  // ad_impressions.user_id / ad_clicks.user_id reference users.id with no
  // ON DELETE action, so deleting a user who has ever been served an ad used to
  // raise 23503 on the final statement — after the clips were gone. Both columns
  // are nullable, so detach them first and keep the ad analytics rows.
  try {
    await db.transaction(async (tx) => {
      await tx.update(adImpressionsTable).set({ userId: null }).where(eq(adImpressionsTable.userId, id));
      await tx.update(adClicksTable).set({ userId: null }).where(eq(adClicksTable.userId, id));
      await tx.delete(savedClipsTable).where(eq(savedClipsTable.userId, id));
      await tx.delete(likesTable).where(eq(likesTable.userId, id));
      await tx.delete(followsTable).where(eq(followsTable.followerId, id));
      await tx.delete(followsTable).where(eq(followsTable.followeeId, id));
      await tx.delete(userClipsTable).where(eq(userClipsTable.userId, id));
      await tx.delete(usersTable).where(eq(usersTable.id, id));
    });
  } catch (err) {
    logger.error({ err, userId: id }, "Failed to delete user");
    res.status(500).json({ error: "Could not delete user — nothing was changed" });
    return;
  }

  res.json({ ok: true });
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
    isHidden: f.isHidden,
    clipsVisible: f.clipsVisible,
    lastRecordedAt: f.lastRecordedAt?.toISOString() ?? null,
  })));
});

router.patch("/admin/fields/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { thumbnailUrl, weight, name, isHidden, clipsVisible } = req.body as {
    thumbnailUrl?: string | null;
    weight?: number;
    name?: string;
    isHidden?: boolean;
    clipsVisible?: boolean;
  };
  const updates: Partial<typeof fieldsTable.$inferInsert> = {};
  if (thumbnailUrl !== undefined) updates.thumbnailUrl = thumbnailUrl ?? undefined;
  if (weight !== undefined) updates.weight = weight;
  if (name !== undefined && name.trim()) updates.name = name.trim();
  if (isHidden !== undefined) updates.isHidden = isHidden;
  if (clipsVisible !== undefined) updates.clipsVisible = clipsVisible;

  const [field] = await db.update(fieldsTable).set(updates).where(eq(fieldsTable.id, id)).returning();
  if (!field) { res.status(404).json({ error: "Field not found" }); return; }

  res.json({ id: field.id, name: field.name, thumbnailUrl: field.thumbnailUrl ?? null, weight: field.weight, isHidden: field.isHidden, clipsVisible: field.clipsVisible });
});


router.post("/admin/fields/sync", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  if (!BUNNY_API_KEY || !BUNNY_LIBRARY_ID) {
    res.status(503).json({ error: "Bunny not configured" }); return;
  }

  const bunnyRes = await fetch(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/collections?page=1&itemsPerPage=100&orderBy=date&includeThumbnails=true`,
    { headers: { AccessKey: BUNNY_API_KEY, accept: "application/json" } }
  );
  if (!bunnyRes.ok) { res.status(502).json({ error: "Bunny API error" }); return; }

  const data = (await bunnyRes.json()) as { items?: Array<{ guid?: string; name?: string; videoCount?: number; previewImageUrls?: string[] }> };
  const collections = (data.items ?? []).filter((c) => typeof c.guid === "string" && typeof c.name === "string");

  const existing = await db.select().from(fieldsTable);
  const existingByGuid = new Map(existing.filter((f) => f.bunnyGuid).map((f) => [f.bunnyGuid!, f]));

  const results = [];
  for (const c of collections) {
    const guid = c.guid as string;
    const name = c.name as string;
    const thumb = c.previewImageUrls?.[0] ?? null;
    const existingField = existingByGuid.get(guid);
    if (existingField) {
      // Preserve any admin-set display name; only sync the thumbnail from Bunny.
      if (existingField.thumbnailUrl !== thumb) {
        const [updated] = await db.update(fieldsTable)
          .set({ thumbnailUrl: thumb ?? undefined })
          .where(eq(fieldsTable.id, existingField.id))
          .returning();
        results.push(updated);
      } else {
        results.push(existingField);
      }
    } else {
      const [created] = await db.insert(fieldsTable)
        .values({ bunnyGuid: guid, name, location: "", thumbnailUrl: thumb, courts: 1, weight: 1.0 })
        .returning();
      results.push(created);
    }
  }

  res.json({ synced: results.length, fields: results.map((f) => ({
    id: f.id, name: f.name, location: f.location, courts: f.courts,
    weight: f.weight, thumbnailUrl: f.thumbnailUrl ?? null, isHidden: f.isHidden,
    lastRecordedAt: f.lastRecordedAt?.toISOString() ?? null,
  })) });
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
      const jsonRes = await fetch(`${cfg.base}/${cfg.zone}/${f.ObjectName}/banner.json?bust=${Date.now()}`, { headers: { AccessKey: cfg.key } });
      const json: BannerJson = jsonRes.ok ? (await jsonRes.json() as BannerJson) : {};
      return {
        id: f.ObjectName,
        title: json.title ?? f.ObjectName,
        upperSubtext: json.upperSubtext ?? "",
        lowerSubtext: json.lowerSubtext ?? "",
        hyperlink: json.hyperlink ?? null,
        imageUrl: json.imageUrl ?? `/api/banners/${encodeURIComponent(f.ObjectName)}/image`,
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

  const { id, title, upperSubtext, lowerSubtext, hyperlink, imageUrl } = req.body as {
    id: string; title?: string; upperSubtext?: string; lowerSubtext?: string; hyperlink?: string | null; imageUrl?: string | null;
  };
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: "id must be alphanumeric/dash/underscore" }); return;
  }

  const json: BannerJson = { title: title ?? id, upperSubtext: upperSubtext ?? "", lowerSubtext: lowerSubtext ?? "", hyperlink: hyperlink ?? null, imageUrl: imageUrl ?? null };
  const body = JSON.stringify(json);

  const putRes = await fetch(`${cfg.base}/${cfg.zone}/${id}/banner.json?bust=${Date.now()}`, {
    method: "PUT",
    headers: { AccessKey: cfg.key, "Content-Type": "application/json" },
    body,
  });

  if (!putRes.ok) { res.status(502).json({ error: "Failed to create banner" }); return; }

  res.status(201).json({ id, title: json.title, upperSubtext: json.upperSubtext, lowerSubtext: json.lowerSubtext, hyperlink: json.hyperlink, imageUrl: json.imageUrl ?? `/api/banners/${encodeURIComponent(id)}/image` });
});

router.patch("/admin/banners/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const cfg = getBannerCfg();
  if (!cfg) { res.status(503).json({ error: "Storage not configured" }); return; }

  const folderId = req.params.id as string;
  if (!isValidBannerId(folderId)) { res.status(400).json({ error: "Invalid banner id" }); return; }
  const { title, upperSubtext, lowerSubtext, hyperlink, imageUrl } = req.body as {
    title?: string; upperSubtext?: string; lowerSubtext?: string; hyperlink?: string | null; imageUrl?: string | null;
  };

  // Fetch existing json first
  const existingRes = await fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json?bust=${Date.now()}`, { headers: { AccessKey: cfg.key } });
  const existing: BannerJson = existingRes.ok ? (await existingRes.json() as BannerJson) : {};

  const updated: BannerJson = {
    title: title !== undefined ? title : existing.title,
    upperSubtext: upperSubtext !== undefined ? upperSubtext : existing.upperSubtext,
    lowerSubtext: lowerSubtext !== undefined ? lowerSubtext : existing.lowerSubtext,
    hyperlink: hyperlink !== undefined ? hyperlink : existing.hyperlink,
    imageUrl: imageUrl !== undefined ? imageUrl : existing.imageUrl,
  };

  const putRes = await fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json`, {
    method: "PUT",
    headers: { AccessKey: cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify(updated),
  });

  if (!putRes.ok) { res.status(502).json({ error: "Failed to update banner" }); return; }

  res.json({ id: folderId, ...updated, imageUrl: updated.imageUrl ?? `/api/banners/${encodeURIComponent(folderId)}/image` });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const introUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });

router.get("/admin/clip-intro", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  const [settings] = await db.select().from(clipSettingsTable).limit(1);
  res.json({ introVideoUrl: settings?.introVideoUrl ?? null });
});

router.post("/admin/clip-intro", introUpload.single("video"), async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  if (!isBunnyStorageConfigured()) { res.status(503).json({ error: "Storage not configured" }); return; }
  const file = req.file;
  if (!file || !file.mimetype.startsWith("video/")) {
    res.status(400).json({ error: "Upload an MP4 video file" }); return;
  }
  try {
    const introVideoUrl = await uploadClipIntroToBunnyStorage(file.buffer, file.mimetype);
    const [existing] = await db.select().from(clipSettingsTable).limit(1);
    if (existing) {
      await db.update(clipSettingsTable).set({ introVideoUrl, updatedAt: new Date() }).where(eq(clipSettingsTable.id, existing.id));
    } else {
      await db.insert(clipSettingsTable).values({ introVideoUrl });
    }
    res.json({ introVideoUrl });
  } catch {
    res.status(502).json({ error: "Failed to upload intro video" });
  }
});

router.delete("/admin/clip-intro", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  await db.update(clipSettingsTable).set({ introVideoUrl: null, updatedAt: new Date() });
  res.status(204).send();
});

router.post("/admin/banners/:id/image", upload.single("image"), async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const bannerCfg = getBannerCfg();
  if (!bannerCfg) { res.status(503).json({ error: "Storage not configured" }); return; }

  const folderId = req.params.id as string;
  if (!isValidBannerId(folderId)) { res.status(400).json({ error: "Invalid banner id" }); return; }
  const file = req.file;
  if (!file) { res.status(400).json({ error: "No image file provided" }); return; }

  const ext = file.mimetype === "image/png" ? "png" : file.mimetype === "image/jpeg" ? "jpg" : "png";
  // Must be `<id>/banner.<ext>` — that is the only path GET /api/banners/:id/image
  // and DELETE /admin/banners/:id look at. The previous `banners/<id>/image.<ext>`
  // wrote to a path nothing read, so the image 404'd and was orphaned on delete.
  const remotePath = `${folderId}/banner.${ext}`;

  try {
    // Upload to banner storage zone (not clip-export zone)
    const uploadUrl = `${bannerCfg.base}/${bannerCfg.zone}/${remotePath}`;
    const bannerPut = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        AccessKey: bannerCfg.key,
        "Content-Type": file.mimetype,
      },
      body: file.buffer,
    });
    if (!bannerPut.ok) {
      const text = await bannerPut.text().catch(() => "");
      res.status(502).json({ error: `Failed to upload image: ${bannerPut.status} ${text}` });
      return;
    }

    // Remove the other supported extension, or a PNG->JPEG replacement would
    // leave the old banner.png in place and the read route (which probes .png
    // first) would keep serving the stale image forever.
    const staleExt = ext === "png" ? "jpg" : "png";
    await fetch(`${bannerCfg.base}/${bannerCfg.zone}/${folderId}/banner.${staleExt}?bust=${Date.now()}`, {
      method: "DELETE",
      headers: { AccessKey: bannerCfg.key },
    }).catch(() => undefined);

    // Serve through our own proxy route rather than handing the browser a
    // storage.bunnycdn.com URL: that origin needs the AccessKey header, so an
    // <img src> pointing at it just 401s.
    const cdnUrl = `/api/banners/${encodeURIComponent(folderId)}/image`;

    // Update banner.json with the new imageUrl
    const cfg = getBannerCfg();
    if (cfg) {
      const existingRes = await fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json?bust=${Date.now()}`, { headers: { AccessKey: cfg.key } });
      const existing: BannerJson = existingRes.ok ? (await existingRes.json() as BannerJson) : {};
      const updated: BannerJson = { ...existing, imageUrl: cdnUrl };
      await fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json?bust=${Date.now()}`, {
        method: "PUT",
        headers: { AccessKey: cfg.key, "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
    }

    res.json({ imageUrl: cdnUrl });
  } catch {
    res.status(502).json({ error: "Failed to upload image" });
  }
});

router.delete("/admin/banners/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const cfg = getBannerCfg();
  if (!cfg) { res.status(503).json({ error: "Storage not configured" }); return; }

  const folderId = req.params.id as string;
  if (!isValidBannerId(folderId)) { res.status(400).json({ error: "Invalid banner id" }); return; }

  // Delete banner.json and the image in either supported format
  await Promise.allSettled([
    fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.json?bust=${Date.now()}`, { method: "DELETE", headers: { AccessKey: cfg.key } }),
    fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.png?bust=${Date.now()}`, { method: "DELETE", headers: { AccessKey: cfg.key } }),
    fetch(`${cfg.base}/${cfg.zone}/${folderId}/banner.jpg?bust=${Date.now()}`, { method: "DELETE", headers: { AccessKey: cfg.key } }),
  ]);

  res.json({ ok: true });
});

// ─── Admin: Recording Schedules ───────────────────────────────────────────────

/** All schedules across all fields (for the admin Recordings tab overview). */
router.get("/admin/schedules", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  const rows = await db.select().from(recordingSchedulesTable);
  res.json(rows);
});

/** Schedules for a single field. */
router.get("/admin/fields/:id/schedules", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  const fieldId = parseInt(req.params.id as string, 10);
  if (isNaN(fieldId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  res.json(rows);
});

/** Create a new exact-date visibility window for a field. */
router.post("/admin/fields/:id/schedules", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  const fieldId = parseInt(req.params.id as string, 10);
  if (isNaN(fieldId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { allowedDate, startTime, endTime, label } = req.body as {
    allowedDate?: string;
    startTime?: string;
    endTime?: string;
    label?: string | null;
  };
  if (
    typeof allowedDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(allowedDate) ||
    typeof startTime !== "string" ||
    typeof endTime !== "string"
  ) {
    res.status(400).json({ error: "allowedDate, startTime and endTime are required" }); return;
  }

  const [created] = await db
    .insert(recordingSchedulesTable)
    .values({
      fieldId,
      allowedDate,
      startTime,
      endTime,
      label: label ?? null,
    })
    .returning();
  res.json(created);
});

/** Delete a time window by its own id. */
router.delete("/admin/schedules/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.id, id));
  res.json({ ok: true });
});

// ─── Admin: Recordings ────────────────────────────────────────────────────────

router.get("/admin/recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const rows = await db
    .select({
      id: recordingsTable.id,
      fieldId: recordingsTable.fieldId,
      fieldName: fieldsTable.name,
      court: recordingsTable.court,
      date: recordingsTable.date,
      timeSlot: recordingsTable.timeSlot,
      duration: recordingsTable.duration,
      score: recordingsTable.score,
      videoUrl: recordingsTable.videoUrl,
      isVisible: recordingsTable.isVisible,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .orderBy(fieldsTable.name, recordingsTable.date);

  res.json(rows.map((r) => ({ ...r, score: r.score ?? null })));
});

router.patch("/admin/recordings/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { isVisible } = req.body as { isVisible?: boolean };
  if (typeof isVisible !== "boolean") { res.status(400).json({ error: "isVisible must be boolean" }); return; }

  const [row] = await db.update(recordingsTable).set({ isVisible }).where(eq(recordingsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Recording not found" }); return; }

  res.json({ id: row.id, isVisible: row.isVisible });
});

/**
 * POST /admin/recordings/import
 * Pulls all videos from every synced Bunny collection and registers any that
 * are not yet in the recordings table. New entries default to isVisible=false
 * so nothing appears publicly until the admin explicitly enables it.
 */
router.post("/admin/recordings/import", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  if (!BUNNY_API_KEY || !BUNNY_LIBRARY_ID || !BUNNY_CDN_HOSTNAME) {
    res.status(503).json({ error: "Bunny not configured" }); return;
  }

  // Fetch all collections from Bunny
  const collectionsRes = await fetch(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/collections?page=1&itemsPerPage=100&orderBy=date`,
    { headers: { AccessKey: BUNNY_API_KEY, accept: "application/json" } }
  );
  if (!collectionsRes.ok) { res.status(502).json({ error: "Bunny API error" }); return; }

  const collectionsData = (await collectionsRes.json()) as { items?: Array<{ guid?: string }> };
  const collectionGuids = (collectionsData.items ?? []).map((c) => c.guid).filter((g): g is string => typeof g === "string");

  // Map Bunny collection GUID → DB field
  const dbFields = await db.select().from(fieldsTable);
  const fieldByGuid = new Map(dbFields.filter((f) => f.bunnyGuid).map((f) => [f.bunnyGuid!, f]));

  // Fetch existing recordings; track which ones have empty timeSlots so we can repair them
  const existingRecordings = await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl, timeSlot: recordingsTable.timeSlot }).from(recordingsTable);
  const existingByUrl = new Map(existingRecordings.map((r) => [r.videoUrl, r]));

  /**
   * Parse date and timeSlot from a Bunny video title.
   * Supports two formats:
   *   cam{N}_{YYYY-MM-DD}_{HH:MM}[.mp4]   (current format)
   *   cam{N}_{...}_{YYYYMMDDHHmmss}         (legacy compact format)
   */
  function parseTitleTimestamp(title: string): { date: string; timeSlot: string } {
    // Format 1: cam1_2026-08-02_20:19  or  cam1_2026-08-02_20:19.mp4
    const isoMatch = title.match(/(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2})/);
    if (isoMatch) return { date: isoMatch[1], timeSlot: isoMatch[2] };
    // Format 2: any 8 digits immediately followed by 6 digits
    const compactMatch = title.match(/(\d{8})(\d{6})/);
    if (compactMatch) {
      const date = `${compactMatch[1].slice(0, 4)}-${compactMatch[1].slice(4, 6)}-${compactMatch[1].slice(6, 8)}`;
      const timeSlot = `${compactMatch[2].slice(0, 2)}:${compactMatch[2].slice(2, 4)}`;
      return { date, timeSlot };
    }
    return { date: new Date().toISOString().slice(0, 10), timeSlot: "" };
  }

  let imported = 0;
  let updated = 0;
  for (const collectionGuid of collectionGuids) {
    const field = fieldByGuid.get(collectionGuid);
    if (!field) continue; // not synced to a DB field

    const videosRes = await fetch(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?collection=${encodeURIComponent(collectionGuid)}&page=1&itemsPerPage=100&orderBy=date`,
      { headers: { AccessKey: BUNNY_API_KEY, accept: "application/json" } }
    );
    if (!videosRes.ok) continue;

    const videosData = (await videosRes.json()) as { items?: Array<{ guid?: string; title?: string; length?: number; status?: number }> };
    const videos = (videosData.items ?? []).filter((v) => typeof v.guid === "string" && (v.status === undefined || v.status === 4));

    for (const video of videos) {
      const videoUrl = `https://${BUNNY_CDN_HOSTNAME}/${video.guid}/playlist.m3u8`;
      const title = video.title ?? "";
      const { date, timeSlot } = parseTitleTimestamp(title);
      const camMatch = title.match(/^(cam\d+)/i);
      const court = camMatch?.[1] ?? "";
      const durationSecs = video.length ?? 0;
      const mins = Math.floor(durationSecs / 60);
      const secs = durationSecs % 60;
      const duration = `${mins}:${String(secs).padStart(2, "0")}`;

      const existing = existingByUrl.get(videoUrl);
      if (existing) {
        // Repair existing records that were imported before the parser was fixed
        if (!existing.timeSlot && timeSlot) {
          await db.update(recordingsTable)
            .set({ date, timeSlot, court, duration })
            .where(eq(recordingsTable.id, existing.id));
          updated++;
        }
        continue;
      }

      await db.insert(recordingsTable).values({
        fieldId: field.id,
        court,
        date,
        timeSlot,
        duration,
        videoUrl,
        isVisible: false,
      });
      existingByUrl.set(videoUrl, { id: 0, videoUrl, timeSlot });
      imported++;
    }
  }

  res.json({ imported, updated });
});

export default router;
