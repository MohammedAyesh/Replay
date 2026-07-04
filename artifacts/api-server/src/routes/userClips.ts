import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, userClipsTable, usersTable, likesTable, followsTable } from "@workspace/db";
import {
  CreateUserClipBody,
  CreateUserClipResponse,
  ListUserClipsResponse,
  DeleteUserClipParams,
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
import { getBunnyPlaybackUrl, getBunnyThumbnailUrl, isBunnyConfigured } from "../lib/bunny";

const router: IRouter = Router();

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

  const { videoId, title, startTime, endTime, cropPath, isPublic } = body.data;

  const [row] = await db
    .insert(userClipsTable)
    .values({
      userId,
      videoId,
      title,
      startTime: String(startTime),
      endTime: String(endTime),
      cropPath,
      isPublic: isPublic ?? true,
    })
    .returning();

  const thumbnailUrl = isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId) : null;
  const playbackUrl = isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null;

  res.status(201).json(
    CreateUserClipResponse.parse({
      id: row.id,
      userId: row.userId,
      videoId: row.videoId,
      title: row.title,
      startTime: parseFloat(row.startTime),
      endTime: parseFloat(row.endTime),
      cropPath: row.cropPath,
      isPublic: row.isPublic,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      shareCount: row.shareCount,
      score: row.score,
      thumbnailUrl,
      playbackUrl,
      createdAt: row.createdAt.toISOString(),
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

  const result = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    videoId: row.videoId,
    title: row.title,
    startTime: parseFloat(row.startTime),
    endTime: parseFloat(row.endTime),
    cropPath: row.cropPath,
    isPublic: row.isPublic,
    likeCount: row.likeCount,
    viewCount: row.viewCount,
    shareCount: row.shareCount,
    score: row.score,
    thumbnailUrl: isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId) : null,
    playbackUrl: isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null,
    createdAt: row.createdAt.toISOString(),
  }));

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
      likeCount: userClipsTable.likeCount,
      viewCount: userClipsTable.viewCount,
      shareCount: userClipsTable.shareCount,
      score: userClipsTable.score,
      isPublic: userClipsTable.isPublic,
      createdAt: userClipsTable.createdAt,
      creatorId: usersTable.id,
      creatorName: usersTable.name,
      creatorPosition: usersTable.position,
    })
    .from(userClipsTable)
    .innerJoin(usersTable, eq(userClipsTable.userId, usersTable.id))
    .orderBy(desc(userClipsTable.score), desc(userClipsTable.createdAt));

  // Filter by visibility
  const visible = rows.filter((row) => {
    if (row.isPublic) return true;
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
    likeCount: row.likeCount,
    viewCount: row.viewCount,
    shareCount: row.shareCount,
    score: row.score,
    isLiked: likedSet.has(row.id),
    isPublic: row.isPublic,
    thumbnailUrl: isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId) : null,
    playbackUrl: isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null,
    createdAt: row.createdAt.toISOString(),
    creatorId: row.creatorId,
    creatorName: row.creatorName,
    creatorPosition: row.creatorPosition ?? null,
    socialLikes: socialLikesMap.get(row.id) ?? [],
  }));

  res.json(GetFeedResponse.parse(result));
});

export default router;
