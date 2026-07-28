import { Router, type IRouter } from "express";
import { Readable } from "stream";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, userClipsTable, usersTable, likesTable, followsTable, academiesTable } from "@workspace/db";
import {
  CreateUserClipBody,
  CreateUserClipResponse,
  ListUserClipsResponse,
  DeleteUserClipParams,
  UpdateUserClipBody,
  UpdateUserClipParams,
  UpdateUserClipResponse,
  ToggleUserClipLikeParams,
  ToggleUserClipLikeResponse,
  GetFeedResponse,
  RecordViewParams,
  RecordViewBody,
  RecordShareParams,
  RecordViewResponse,
  RecordShareResponse,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";
import {
  getBunnyPlaybackUrl,
  getBunnyThumbnailUrl,
  getBunnyDirectMp4Url,
  getBunnyVideoInfo,
  isBunnyConfigured,
  isBunnyStorageConfigured,
  uploadToBunnyStorage,
  BUNNY_STORAGE_API_KEY,
} from "../lib/bunny";
import { renderClip, cleanupTempFile } from "../lib/ffmpegExport";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Clip IDs currently being rendered — prevents duplicate concurrent jobs. */
const inFlight = new Set<number>();

/**
 * Live-stream clips are saved with a synthetic videoId like "live:camera2".
 * These are not real Bunny Stream GUIDs, so URL generation and export must
 * be skipped for them until the recording is uploaded to Bunny Stream.
 */
function isLiveVideoId(videoId: string): boolean {
  return videoId.startsWith("live:");
}

/** Look up the branding intro for an academy id, if any. Null-safe on both ends. */
async function resolveIntroVideoUrl(academyId: number | null): Promise<string | null> {
  if (!academyId) return null;
  const [academy] = await db
    .select({ introVideoUrl: academiesTable.introVideoUrl })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  return academy?.introVideoUrl ?? null;
}

// Engagement scoring: weighted composite of likes, views, and recency
function computeScore(likeCount: number, viewCount: number, shareCount: number, createdAt: Date): number {
  const hoursOld = Math.max(0, (Date.now() - createdAt.getTime()) / 36e5);
  const decayFactor = Math.exp(-hoursOld / 168); // 7-day half-life
  const raw = likeCount * 5 + viewCount * 1 + shareCount * 10;
  return Math.round(raw * decayFactor);
}

// Recalculate and persist a clip's engagement score
async function updateClipScore(clipId: number): Promise<number> {
  const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipId));
  if (!clip) return 0;
  const newScore = computeScore(clip.likeCount, clip.viewCount, clip.shareCount, clip.createdAt);
  await db.update(userClipsTable).set({ score: newScore }).where(eq(userClipsTable.id, clipId));
  return newScore;
}

router.post("/user-clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const body = CreateUserClipBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { videoId, title, startTime, endTime, cropPath, visibility, aspectRatio, academyId } = body.data;

  // Validate rather than trust blindly: a nonexistent id would just silently
  // resolve to no intro later, but storing it anyway would be confusing to
  // debug. Cheap to check up front since we already touch this table below.
  let validAcademyId: number | null = null;
  if (academyId != null) {
    const [academy] = await db.select({ id: academiesTable.id }).from(academiesTable).where(eq(academiesTable.id, academyId));
    validAcademyId = academy?.id ?? null;
  }

  const [row] = await db
    .insert(userClipsTable)
    .values({
      userId,
      videoId,
      title,
      startTime: String(startTime),
      endTime: String(endTime),
      cropPath,
      visibility: visibility ?? "private",
      aspectRatio: aspectRatio ?? "16:9",
      academyId: validAcademyId,
    })
    .returning();

  const thumbnailTime = row.thumbnailTime != null ? parseFloat(row.thumbnailTime) : null;
  const isLive = isLiveVideoId(row.videoId);
  const thumbnailUrl = !isLive && isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId, thumbnailTime) : null;
  const playbackUrl = !isLive && isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null;
  const introVideoUrl = await resolveIntroVideoUrl(row.academyId);

  res.status(201).json(
    CreateUserClipResponse.parse({
      id: row.id,
      userId: row.userId,
      videoId: row.videoId,
      title: row.title,
      startTime: parseFloat(row.startTime),
      endTime: parseFloat(row.endTime),
      cropPath: row.cropPath,
      visibility: row.visibility,
      aspectRatio: row.aspectRatio,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      shareCount: row.shareCount,
      score: row.score,
      thumbnailTime,
      thumbnailUrl,
      playbackUrl,
      exportStatus: row.exportStatus ?? null,
      exportedUrl: row.exportedUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      academyId: row.academyId ?? null,
      introVideoUrl,
    })
  );
});

router.get("/user-clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rows = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.userId, userId))
    .orderBy(desc(userClipsTable.createdAt));

  // Resolve all distinct academies in one query instead of one per clip.
  const academyIds = [...new Set(rows.map((r) => r.academyId).filter((id): id is number => id != null))];
  const introByAcademy = new Map<number, string | null>();
  if (academyIds.length > 0) {
    const academies = await db
      .select({ id: academiesTable.id, introVideoUrl: academiesTable.introVideoUrl })
      .from(academiesTable)
      .where(inArray(academiesTable.id, academyIds));
    for (const a of academies) introByAcademy.set(a.id, a.introVideoUrl ?? null);
  }

  const result = rows.map((row) => {
    const thumbnailTime = row.thumbnailTime != null ? parseFloat(row.thumbnailTime) : null;
    return {
      id: row.id,
      userId: row.userId,
      videoId: row.videoId,
      title: row.title,
      startTime: parseFloat(row.startTime),
      endTime: parseFloat(row.endTime),
      cropPath: row.cropPath,
      visibility: row.visibility,
      aspectRatio: row.aspectRatio,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      shareCount: row.shareCount,
      score: row.score,
      thumbnailTime,
      thumbnailUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId, thumbnailTime) : null,
      playbackUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null,
      exportStatus: row.exportStatus ?? null,
      exportedUrl: row.exportedUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      academyId: row.academyId ?? null,
      introVideoUrl: row.academyId != null ? (introByAcademy.get(row.academyId) ?? null) : null,
    };
  });

  res.json(ListUserClipsResponse.parse(result));
});

router.delete("/user-clips/:id", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteUserClipParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  if (existing.userId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db
    .delete(userClipsTable)
    .where(and(eq(userClipsTable.id, params.data.id), eq(userClipsTable.userId, userId)));

  res.json({ ok: true });
});

router.patch("/user-clips/:id", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateUserClipParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateUserClipBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  if (existing.userId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const updates: Partial<{ title: string; visibility: string; thumbnailTime: string | null }> = {};
  if (body.data.title !== undefined) updates.title = body.data.title;
  if (body.data.visibility !== undefined) updates.visibility = body.data.visibility;
  if (body.data.thumbnailTime !== undefined)
    updates.thumbnailTime = body.data.thumbnailTime != null ? String(body.data.thumbnailTime) : null;

  const [row] = await db
    .update(userClipsTable)
    .set(updates)
    .where(eq(userClipsTable.id, params.data.id))
    .returning();

  const thumbnailTime = row.thumbnailTime != null ? parseFloat(row.thumbnailTime) : null;
  const isLiveUpdate = isLiveVideoId(row.videoId);
  const thumbnailUrl = !isLiveUpdate && isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId, thumbnailTime) : null;
  const playbackUrl = !isLiveUpdate && isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null;
  const introVideoUrl = await resolveIntroVideoUrl(row.academyId);

  res.json(
    UpdateUserClipResponse.parse({
      id: row.id,
      userId: row.userId,
      videoId: row.videoId,
      title: row.title,
      startTime: parseFloat(row.startTime),
      endTime: parseFloat(row.endTime),
      cropPath: row.cropPath,
      visibility: row.visibility,
      aspectRatio: row.aspectRatio,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      shareCount: row.shareCount,
      score: row.score,
      thumbnailTime,
      thumbnailUrl,
      playbackUrl,
      exportStatus: row.exportStatus ?? null,
      exportedUrl: row.exportedUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      academyId: row.academyId ?? null,
      introVideoUrl,
    })
  );
});

router.post("/user-clips/:id/like", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ToggleUserClipLikeParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userClipId = params.data.id;
  const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, userClipId));
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(likesTable)
    .where(and(eq(likesTable.userId, userId), eq(likesTable.userClipId, userClipId)));

  let liked: boolean;
  let newCount: number;

  if (existing) {
    await db
      .delete(likesTable)
      .where(and(eq(likesTable.userId, userId), eq(likesTable.userClipId, userClipId)));
    newCount = Math.max(0, clip.likeCount - 1);
    liked = false;
  } else {
    await db.insert(likesTable).values({ userId, userClipId });
    newCount = clip.likeCount + 1;
    liked = true;
  }

  await db.update(userClipsTable).set({ likeCount: newCount }).where(eq(userClipsTable.id, userClipId));
  await updateClipScore(userClipId);

  res.json(ToggleUserClipLikeResponse.parse({ liked, likeCount: newCount }));
});

router.post("/user-clips/:id/view", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = RecordViewParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userClipId = params.data.id;
  const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, userClipId));
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const body = RecordViewBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { secondsWatched } = body.data;
  // Only count views with meaningful watch time (>2 seconds)
  if (secondsWatched > 2) {
    const newViewCount = clip.viewCount + 1;
    await db.update(userClipsTable).set({ viewCount: newViewCount }).where(eq(userClipsTable.id, userClipId));
    const newScore = await updateClipScore(userClipId);
    res.json(
      RecordViewResponse.parse({
        ok: true,
        viewCount: newViewCount,
        shareCount: clip.shareCount,
        likeCount: clip.likeCount,
        score: newScore,
      })
    );
    return;
  }

  res.json(
    RecordViewResponse.parse({
      ok: false,
      viewCount: clip.viewCount,
      shareCount: clip.shareCount,
      likeCount: clip.likeCount,
      score: clip.score,
    })
  );
});

router.post("/user-clips/:id/share", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = RecordShareParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userClipId = params.data.id;
  const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, userClipId));
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const newShareCount = clip.shareCount + 1;
  await db.update(userClipsTable).set({ shareCount: newShareCount }).where(eq(userClipsTable.id, userClipId));
  const newScore = await updateClipScore(userClipId);

  res.json(
    RecordShareResponse.parse({
      ok: true,
      viewCount: clip.viewCount,
      shareCount: newShareCount,
      likeCount: clip.likeCount,
      score: newScore,
    })
  );
});

router.get("/feed", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);

  // Get the set of creator IDs the current user follows
  let followedIds: number[] = [];
  if (userId) {
    const follows = await db
      .select({ followeeId: followsTable.followeeId })
      .from(followsTable)
      .where(eq(followsTable.followerId, userId));
    followedIds = follows.map((f) => f.followeeId);
  }

  // Fetch all clips with their creator info, ordered by engagement score
  const rows = await db
    .select({
      id: userClipsTable.id,
      userId: userClipsTable.userId,
      videoId: userClipsTable.videoId,
      title: userClipsTable.title,
      startTime: userClipsTable.startTime,
      endTime: userClipsTable.endTime,
      cropPath: userClipsTable.cropPath,
      aspectRatio: userClipsTable.aspectRatio,
      likeCount: userClipsTable.likeCount,
      viewCount: userClipsTable.viewCount,
      shareCount: userClipsTable.shareCount,
      score: userClipsTable.score,
      visibility: userClipsTable.visibility,
      isHidden: userClipsTable.isHidden,
      createdAt: userClipsTable.createdAt,
      creatorId: usersTable.id,
      creatorName: usersTable.name,
      creatorPosition: usersTable.position,
    })
    .from(userClipsTable)
    .innerJoin(usersTable, eq(userClipsTable.userId, usersTable.id))
    .orderBy(desc(userClipsTable.score), desc(userClipsTable.createdAt));

  // Filter by visibility and admin-hidden status
  const visible = rows.filter((row) => {
    if ((row as { isHidden?: boolean }).isHidden) return false;
    if (row.visibility === "public") return true;
    if (row.visibility === "private") return row.creatorId === userId;
    if (!userId) return false;
    if (row.creatorId === userId) return true;
    return followedIds.includes(row.creatorId);
  });

  // Check which clips the current user has liked
  let likedSet = new Set<number>();
  // Map of clipId -> array of { userId, name } (capped at 3) for followers who liked that clip
  let socialLikesMap = new Map<number, { userId: number; name: string }[]>();

  if (userId && visible.length > 0) {
    const visibleIds = visible.map((r) => r.id);
    const liked = await db
      .select({ userClipId: likesTable.userClipId })
      .from(likesTable)
      .where(
        and(
          eq(likesTable.userId, userId),
          inArray(likesTable.userClipId, visibleIds)
        )
      );
    likedSet = new Set(liked.map((l) => l.userClipId).filter((id): id is number => id !== null));

    // Fetch social likes: followers of current user who liked visible clips
    if (followedIds.length > 0) {
      const socialRows = await db
        .select({
          userClipId: likesTable.userClipId,
          likerUserId: usersTable.id,
          likerName: usersTable.name,
        })
        .from(likesTable)
        .innerJoin(usersTable, eq(likesTable.userId, usersTable.id))
        .where(
          and(
            inArray(likesTable.userClipId, visibleIds),
            inArray(likesTable.userId, followedIds)
          )
        );

      for (const row of socialRows) {
        if (row.userClipId === null) continue;
        const clipId = row.userClipId;
        const arr = socialLikesMap.get(clipId) ?? [];
        if (arr.length < 3) {
          arr.push({ userId: row.likerUserId, name: row.likerName });
          socialLikesMap.set(clipId, arr);
        }
      }
    }
  }

  const result = visible.map((row) => ({
    id: row.id,
    userId: row.userId,
    videoId: row.videoId,
    title: row.title,
    startTime: parseFloat(row.startTime),
    endTime: parseFloat(row.endTime),
    cropPath: row.cropPath,
    aspectRatio: row.aspectRatio,
    likeCount: row.likeCount,
    viewCount: row.viewCount,
    shareCount: row.shareCount,
    score: row.score,
    isLiked: likedSet.has(row.id),
    visibility: row.visibility,
    thumbnailUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId) : null,
    playbackUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null,
    createdAt: row.createdAt.toISOString(),
    creatorId: row.creatorId,
    creatorName: row.creatorName,
    creatorPosition: row.creatorPosition ?? null,
    socialLikes: socialLikesMap.get(row.id) ?? [],
  }));

  res.json(GetFeedResponse.parse(result));
});

/**
 * POST /user-clips/:id/export
 * Kick off a background FFmpeg render + Bunny Storage upload.
 * Returns immediately with { status: "pending" | "done", url? }.
 * If already exported, returns the cached URL without re-rendering.
 */
router.post("/user-clips/:id/export", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthenticated" }); return; }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = parseInt(rawId, 10);
  if (isNaN(clipId)) { res.status(400).json({ error: "Invalid clip id" }); return; }

  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(and(eq(userClipsTable.id, clipId), eq(userClipsTable.userId, userId)));

  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
  if (isLiveVideoId(clip.videoId)) {
    res.status(400).json({ error: "Live stream clips cannot be exported. The recording must be uploaded to Bunny Stream first." });
    return;
  }
  if (!isBunnyConfigured()) { res.status(400).json({ error: "Video playback not configured" }); return; }
  if (!isBunnyStorageConfigured()) { res.status(400).json({ error: "Export storage not configured" }); return; }

  // Already exported — return the cached URL immediately (no re-render)
  if (clip.exportStatus === "done" && clip.exportedUrl) {
    res.json({ status: "done", url: clip.exportedUrl });
    return;
  }

  // Render already in progress (in this process or leftover from last restart)
  if (inFlight.has(clipId) || clip.exportStatus === "pending") {
    res.json({ status: "pending" });
    return;
  }

  // Mark pending and respond immediately so the client can start polling
  inFlight.add(clipId);
  await db
    .update(userClipsTable)
    .set({ exportStatus: "pending", exportedUrl: null })
    .where(eq(userClipsTable.id, clipId));
  res.json({ status: "pending" });

  // Fire-and-forget: render → upload → update DB
  const startTime = parseFloat(clip.startTime);
  const endTime = parseFloat(clip.endTime);
  const cropPath = (clip.cropPath ?? []) as { t: number; x: number; y: number; w: number; h: number }[];
  const videoId = clip.videoId;

  void (async () => {
    let tmpPath: string | null = null;
    try {
      logger.info({ clipId, startTime, endTime }, "Starting background clip export");

      // Get duration from Bunny Stream API — avoids ffprobe needing CDN access
      const { duration: totalDuration } = await getBunnyVideoInfo(videoId);
      logger.info({ clipId, videoId, totalDuration }, "Got video duration from Bunny API");

      // Use HLS URL for FFmpeg — pass CDN origin as Referer so Bunny CDN
      // accepts the server-side request (CDN blocks requests without it).
      const videoUrl = getBunnyPlaybackUrl(videoId);
      const referer = `https://${new URL(videoUrl).host}/`;
      logger.info({ clipId, videoUrl }, "Using HLS URL for FFmpeg input");

      const introUrl = (await resolveIntroVideoUrl(clip.academyId)) ?? undefined;
      const introReferer = introUrl ? `https://${new URL(introUrl).host}/` : undefined;
      if (introUrl) logger.info({ clipId, introUrl }, "Prepending academy intro to export");

      tmpPath = await renderClip({ videoUrl, totalDuration, startTime, endTime, cropPath, aspectRatio: clip.aspectRatio, title: clip.title, referer, introUrl, introReferer });
      const exportedUrl = await uploadToBunnyStorage(tmpPath, clipId);
      await db
        .update(userClipsTable)
        .set({ exportStatus: "done", exportedUrl })
        .where(eq(userClipsTable.id, clipId));
      logger.info({ clipId, exportedUrl }, "Clip export complete");
    } catch (err) {
      logger.error({ err, clipId }, "Background clip export failed");
      await db
        .update(userClipsTable)
        .set({ exportStatus: "error" })
        .where(eq(userClipsTable.id, clipId));
    } finally {
      inFlight.delete(clipId);
      if (tmpPath) cleanupTempFile(tmpPath);
    }
  })();
});

/**
 * GET /user-clips/:id/export-status
 * Poll this while waiting for a background export to finish.
 * Returns { status: "idle"|"pending"|"done"|"error", url: string|null }.
 */
router.get("/user-clips/:id/export-status", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthenticated" }); return; }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = parseInt(rawId, 10);
  if (isNaN(clipId)) { res.status(400).json({ error: "Invalid clip id" }); return; }

  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(and(eq(userClipsTable.id, clipId), eq(userClipsTable.userId, userId)));

  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }

  res.json({ status: clip.exportStatus ?? "idle", url: clip.exportedUrl ?? null });
});

/**
 * GET /user-clips/:id/download
 * Proxy-downloads the rendered MP4 from Bunny Storage through our server.
 * Avoids CORS issues and works uniformly on iOS and desktop.
 */
router.get("/user-clips/:id/download", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthenticated" }); return; }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = parseInt(rawId, 10);
  if (isNaN(clipId)) { res.status(400).json({ error: "Invalid clip id" }); return; }

  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(and(eq(userClipsTable.id, clipId), eq(userClipsTable.userId, userId)));

  if (!clip || !clip.exportedUrl) { res.status(404).json({ error: "Export not ready" }); return; }

  const safeName = clip.title.replace(/[^a-z0-9_\-]/gi, "_") || "clip";
  const upstream = await fetch(clip.exportedUrl, {
    headers: { AccessKey: BUNNY_STORAGE_API_KEY },
  });
  if (!upstream.ok || !upstream.body) { res.status(502).json({ error: "Could not fetch from storage" }); return; }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
  nodeStream.pipe(res);
  nodeStream.on("error", (err) => {
    logger.error({ err }, "Error proxying clip download");
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  });
});

export default router;
