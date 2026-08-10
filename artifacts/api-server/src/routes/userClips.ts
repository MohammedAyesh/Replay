import { Router, type IRouter } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { eq, and, desc, inArray, count, sql, like } from "drizzle-orm";
import { db, userClipsTable, usersTable, likesTable, followsTable, academiesTable, recordingsTable, academyRecordingsTable } from "@workspace/db";
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
  getBunnyProxiedPlaybackUrl,
  getBunnyProxiedThumbnailUrl,
  getBunnyDirectMp4Url,
  getBunnyVideoInfo,
  isBunnyConfigured,
  isBunnyStorageConfigured,
  uploadToBunnyStorage,
  deleteBunnyExport,
  BUNNY_STORAGE_API_KEY,
  BUNNY_CDN_HOSTNAME,
} from "../lib/bunny";
import { clipSettingsTable } from "@workspace/db";
import { renderClip, cleanupTempFile, bufferRemoteClip } from "../lib/ffmpegExport";
import { logger } from "../lib/logger";
import { introPlaybackPath } from "./clipIntro";

const router: IRouter = Router();

/** Clip IDs currently being rendered — prevents duplicate concurrent jobs. */
const inFlight = new Set<number>();

/**
 * In-memory progress stage for each clip currently being exported.
 * Keys are clip IDs; values are one of "fetching" | "encoding" | "uploading".
 * The key is absent (not set to null) when the clip is idle, queued, or done.
 * Returned as an additive `progress` field in the export-status response so the
 * frontend can show a human-readable stage label instead of a static spinner.
 */
const exportProgress = new Map<number, string>();

/**
 * Renders are CPU-bound: a single 1080p `-preset slow -crf 16` pass already
 * saturates several of the VPS's 6 shared vCPUs. `inFlight` only dedupes per
 * clip id, so without a global cap one account can queue N clips and fire N
 * exports at once, starving the live remux and the hourly archive encoder that
 * share the box. Everything past the cap waits its turn instead; the clip row
 * stays "pending" throughout, so the client's existing polling loop is unaffected.
 */
const MAX_CONCURRENT_RENDERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_RENDERS ?? "2", 10) || 2);
let activeRenders = 0;
const renderQueue: (() => void)[] = [];

async function withRenderSlot<T>(job: () => Promise<T>): Promise<T> {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    await new Promise<void>((resolve) => renderQueue.push(resolve));
  }
  activeRenders++;
  try {
    return await job();
  } finally {
    activeRenders--;
    renderQueue.shift()?.();
  }
}

export function normalizeExportWindow(
  startTime: number,
  endTime: number,
  totalDuration: number,
): { startSec: number; endSec: number; clipDuration: number } {
  const duration = Math.max(0, Number.isFinite(totalDuration) ? totalDuration : 0);
  const rawStartSec = Number.isFinite(startTime) ? startTime * duration : 0;
  const rawEndSec = Number.isFinite(endTime) ? endTime * duration : duration;
  const startSec = Math.min(duration, Math.max(0, rawStartSec));
  const endSec = Math.min(duration, Math.max(startSec, Math.max(0, rawEndSec)));
  const actualDuration = endSec - startSec;
  return {
    startSec,
    endSec,
    clipDuration: actualDuration > 0 ? Math.max(0.1, actualDuration) : 0,
  };
}

/**
 * Clip exports are normally owner-only, but admins need to preview any clip
 * from the admin Clips tab. Keep the ownership check for regular users while
 * allowing an authenticated admin to start/poll an export.
 */
async function getExportAccessibleClip(req: Parameters<typeof getLocalUserId>[0], clipId: number) {
  const userId = await getLocalUserId(req);
  if (!userId) return false as const;

  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, clipId));
  if (!clip) return null;
  if (clip.userId === userId) return clip;

  const [user] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isAdmin ? clip : null;
}

/**
 * Live-stream clips are saved with a synthetic videoId like "live:camera2".
 * These are not real Bunny Stream GUIDs, so URL generation and export must
 * be skipped for them until the recording is uploaded to Bunny Stream.
 */
export function isLiveVideoId(videoId: string): boolean {
  return videoId.startsWith("live:");
}

/**
 * The intro FFmpeg prepends to a clip's export.
 *
 * The academy's own intro wins, so each recording carries the branding of the
 * academy it belongs to. The global clip_settings intro is the fallback for
 * clips with no academy, or whose academy has not uploaded one.
 */
async function resolveIntroVideoUrl(academyId: number | null): Promise<string | null> {
  if (academyId) {
    const [academy] = await db
      .select({ introVideoUrl: academiesTable.introVideoUrl })
      .from(academiesTable)
      .where(eq(academiesTable.id, academyId));
    if (academy?.introVideoUrl) return academy.introVideoUrl;
  }
  const [settings] = await db.select().from(clipSettingsTable).orderBy(desc(clipSettingsTable.id)).limit(1);
  return settings?.introVideoUrl ?? null;
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

/**
 * Kick off a background FFmpeg render → Bunny Storage upload for the given
 * clip row.  Used both by the explicit POST /user-clips/:id/export endpoint
 * and by the clip-creation handler to pre-render immediately so the file is
 * ready (or close to it) by the time the user taps Download.
 *
 * Callers must:
 *   1. Guard on !isLiveVideoId and isBunnyStorageConfigured() before calling.
 *   2. Add clipId to inFlight and mark exportStatus "pending" in the DB *before*
 *      calling, so polls and duplicate requests see the correct state.
 *   3. Not await this — it is intentionally fire-and-forget via withRenderSlot.
 */
function startBackgroundExport(clip: typeof import("@workspace/db").userClipsTable.$inferSelect) {
  const clipId = clip.id;
  const startTime = parseFloat(clip.startTime);
  const endTime = parseFloat(clip.endTime);
  const cropPath = (clip.cropPath ?? []) as { t: number; x: number; y: number; w: number; h: number }[];
  const videoId = clip.videoId;

  void withRenderSlot(async () => {
    let tmpPath: string | null = null;
    let bufferTmpFile: string | null = null;
    try {
      logger.info({ clipId, startTime, endTime }, "Starting background clip export");

      const {
        duration: totalDuration,
        hasMP4Fallback,
        availableResolutions,
      } = await getBunnyVideoInfo(videoId);
      logger.info({ clipId, videoId, totalDuration }, "Got video duration from Bunny API");

      const referer = `https://${BUNNY_CDN_HOSTNAME}/`;
      const source = await selectExportSource({
        videoId,
        hasMP4Fallback,
        availableResolutions,
        referer,
      });
      const remoteUrl = source.url;
      logger.info(
        {
          clipId,
          videoId,
          sourcePath: source.path,
          remoteUrl,
          maxHeight: source.maxHeight ?? null,
        },
        `Selected export source: ${source.path}`,
      );

      // Compute a bounded, ordered source window before buffering. Persisted clip
      // fractions can be outside [0, 1], but renderClip has always clamped them
      // to the recording duration; keep the buffer path consistent with that
      // behavior so it does not reject a window the main render would accept.
      const { startSec, endSec, clipDuration } = normalizeExportWindow(
        startTime,
        endTime,
        totalDuration,
      );
      if (clipDuration <= 0) {
        throw new Error(
          `Clip selection has no content after clamping to the ${totalDuration}s recording`,
        );
      }

      let introUrl: string | undefined;
      let introReferer: string | undefined;
      const resolvedIntro = await resolveIntroVideoUrl(clip.academyId);
      if (resolvedIntro) {
        try {
          introReferer = `https://${new URL(resolvedIntro).host}/`;
          introUrl = resolvedIntro;
          logger.info({ clipId, academyId: clip.academyId, introUrl }, "Prepending intro to export");
        } catch {
          logger.warn({ clipId, resolvedIntro }, "Intro URL is not absolute — exporting without it");
        }
      }

      // ── Fix 4: buffer the required time window to disk before encoding ──
      // Downloading the clip window locally first avoids live-network stalls
      // during the encode pass, which was the main source of the freeze/stutter.
      exportProgress.set(clipId, "fetching");
      logger.info({ clipId, remoteUrl, startSec, clipDuration }, "Buffering remote clip window locally");
      const { bufferPath, bufferedDuration, adjustedOffsetSec } = await bufferRemoteClip({
        remoteUrl,
        referer,
        startSec,
        clipDuration,
        totalDuration,
      });
      bufferTmpFile = bufferPath;
      logger.info({ clipId, bufferPath, bufferedDuration, adjustedOffsetSec }, "Buffer complete — starting encode");

      // Recompute fractions relative to the buffered file so renderClip's
      // startTime * totalDuration / endTime * totalDuration arithmetic is correct.
      const bufStartFraction = Math.max(0, adjustedOffsetSec / bufferedDuration);
      const bufEndFraction = Math.min(1, (adjustedOffsetSec + clipDuration) / bufferedDuration);

      exportProgress.set(clipId, "encoding");
      tmpPath = await renderClip({
        // Encode from the local buffer — no remote URL, no referer needed
        videoUrl: bufferPath,
        totalDuration: bufferedDuration,
        startTime: bufStartFraction,
        endTime: bufEndFraction,
        cropPath,
        aspectRatio: clip.aspectRatio,
        title: clip.title,
        // referer omitted — local file
        introUrl,
        introReferer,
      });

      exportProgress.set(clipId, "uploading");
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
      exportProgress.delete(clipId);
      if (bufferTmpFile) cleanupTempFile(bufferTmpFile);
      if (tmpPath) cleanupTempFile(tmpPath);
    }
  });
}

type ExportSourcePath =
  | "HEAD-verified direct MP4"
  | "verified HLS variant playlist"
  | "master-playlist fallback";

export async function selectExportSource(options: {
  videoId: string;
  hasMP4Fallback: boolean;
  availableResolutions: string;
  referer: string;
}): Promise<{ url: string; path: ExportSourcePath; maxHeight: number | null }> {
  const { videoId, hasMP4Fallback, availableResolutions, referer } = options;
  const heights = availableResolutions
    .split(",")
    .map((resolution) => Number.parseInt(resolution.trim().replace(/p$/i, ""), 10))
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => b - a);
  const maxHeight = heights[0] ?? null;

  if (hasMP4Fallback && maxHeight !== null) {
    const directUrl = getBunnyDirectMp4Url(videoId, maxHeight);
    try {
      const response = await fetch(directUrl, {
        method: "HEAD",
        headers: { Referer: referer },
      });
      if (response.status === 200 || response.status === 206) {
        return {
          url: directUrl,
          path: "HEAD-verified direct MP4",
          maxHeight,
        };
      }
      logger.warn(
        { videoId, directUrl, status: response.status, maxHeight },
        "Direct MP4 source check failed; trying explicit HLS variant",
      );
    } catch (err) {
      logger.warn(
        { err, videoId, directUrl, maxHeight },
        "Direct MP4 source check errored; trying explicit HLS variant",
      );
    }
  }

  if (maxHeight !== null) {
    const variantUrl = `https://${BUNNY_CDN_HOSTNAME}/${videoId}/${maxHeight}p/video.m3u8`;
    try {
      const response = await fetch(variantUrl, {
        headers: { Referer: referer },
      });
      const playlist = await response.text();
      if (response.ok && playlist.trim().length > 0) {
        return {
          url: variantUrl,
          path: "verified HLS variant playlist",
          maxHeight,
        };
      }
      logger.warn(
        { videoId, variantUrl, status: response.status, maxHeight },
        "Explicit HLS variant check failed; falling back to master playlist",
      );
    } catch (err) {
      logger.warn(
        { err, videoId, variantUrl, maxHeight },
        "Explicit HLS variant check errored; falling back to master playlist",
      );
    }
  }

  const masterUrl = getBunnyPlaybackUrl(videoId);
  logger.warn(
    { videoId, masterUrl, maxHeight },
    "Explicit export source selection failed; relying on FFmpeg default stream selection",
  );
  return {
    url: masterUrl,
    path: "master-playlist fallback",
    maxHeight,
  };
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

  // Auto-detect academy from the recording this video belongs to, so the
  // academy's intro video is prepended on export even when the client doesn't
  // know the academy context (e.g. clips created via field-detail player).
  if (validAcademyId === null && videoId && !videoId.startsWith("live:")) {
    const [recAcademy] = await db
      .select({ academyId: academyRecordingsTable.academyId })
      .from(recordingsTable)
      .innerJoin(academyRecordingsTable, eq(academyRecordingsTable.recordingId, recordingsTable.id))
      .where(like(recordingsTable.videoUrl, `%${videoId}%`))
      .limit(1);
    if (recAcademy) validAcademyId = recAcademy.academyId;
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
  const thumbnailUrl = !isLive && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(row.videoId, thumbnailTime) : null;
  const playbackUrl = !isLive && isBunnyConfigured() ? getBunnyProxiedPlaybackUrl(row.videoId) : null;
  // Intro is intentionally suppressed in playback responses — it appears only
  // in the downloaded export file (see the renderClip call below). The player
  // treats null as "start the clip immediately", so no buffering delay occurs.
  const introVideoUrl = null;

  // Pre-render the clip immediately so it's ready (or nearly ready) by the
  // time the user navigates to My Clips and taps Download.
  let initialExportStatus: string | null = row.exportStatus ?? null;
  if (!isLive && isBunnyStorageConfigured() && !inFlight.has(row.id)) {
    inFlight.add(row.id);
    await db
      .update(userClipsTable)
      .set({ exportStatus: "pending", exportedUrl: null })
      .where(eq(userClipsTable.id, row.id));
    initialExportStatus = "pending";
    startBackgroundExport(row);
    logger.info({ clipId: row.id }, "Auto-triggered clip export on creation");
  }

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
      exportStatus: initialExportStatus,
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

  // Intro is intentionally suppressed in all playback responses — it appears
  // only in downloaded export files. Skip the intro DB queries entirely.

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
      thumbnailUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(row.videoId, thumbnailTime) : null,
      playbackUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyProxiedPlaybackUrl(row.videoId) : null,
      exportStatus: row.exportStatus ?? null,
      exportedUrl: row.exportedUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      academyId: row.academyId ?? null,
      // Intro suppressed in playback — appears only in downloaded exports.
      introVideoUrl: null,
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

  // Drop the rendered export too, otherwise it stays readable on the CDN (and
  // billable) forever after the row is gone.
  if (existing.exportedUrl) void deleteBunnyExport(params.data.id);

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
  const thumbnailUrl = !isLiveUpdate && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(row.videoId, thumbnailTime) : null;
  const playbackUrl = !isLiveUpdate && isBunnyConfigured() ? getBunnyProxiedPlaybackUrl(row.videoId) : null;
  // Intro is intentionally suppressed in playback responses — it appears only
  // in the downloaded export file (see the renderClip call below). The player
  // treats null as "start the clip immediately", so no buffering delay occurs.
  const introVideoUrl = null;

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

  if (existing) {
    await db
      .delete(likesTable)
      .where(and(eq(likesTable.userId, userId), eq(likesTable.userClipId, userClipId)));
    liked = false;
  } else {
    await db.insert(likesTable).values({ userId, userClipId });
    liked = true;
  }

  // Recount from the likes table rather than adjusting a value read earlier:
  // concurrent likes on the same clip would otherwise overwrite each other.
  const [{ value: newCount }] = await db
    .select({ value: count() })
    .from(likesTable)
    .where(eq(likesTable.userClipId, userClipId));

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
    // Atomic increment — computing viewCount + 1 in JS from an earlier read
    // loses concurrent views.
    const [updated] = await db
      .update(userClipsTable)
      .set({ viewCount: sql`${userClipsTable.viewCount} + 1` })
      .where(eq(userClipsTable.id, userClipId))
      .returning({ viewCount: userClipsTable.viewCount });
    const newViewCount = updated?.viewCount ?? clip.viewCount + 1;
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

  // Atomic increment — see the view handler above.
  const [updatedShare] = await db
    .update(userClipsTable)
    .set({ shareCount: sql`${userClipsTable.shareCount} + 1` })
    .where(eq(userClipsTable.id, userClipId))
    .returning({ shareCount: userClipsTable.shareCount });
  const newShareCount = updatedShare?.shareCount ?? clip.shareCount + 1;
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
    thumbnailUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(row.videoId) : null,
    playbackUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyProxiedPlaybackUrl(row.videoId) : null,
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
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = parseInt(rawId, 10);
  if (isNaN(clipId)) { res.status(400).json({ error: "Invalid clip id" }); return; }

  const accessibleClip = await getExportAccessibleClip(req, clipId);
  if (accessibleClip === false) { res.status(401).json({ error: "Unauthenticated" }); return; }
  const clip = accessibleClip;

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

  // Render already in progress *in this process*.
  //
  // Deliberately not `|| clip.exportStatus === "pending"`: that column is
  // persisted but `inFlight` is not, so a process restart mid-render used to
  // strand the row on "pending" forever — /export short-circuited,
  // /export-status kept reporting pending, and there was no reset path even for
  // an admin. A "pending" row this process isn't working on is stale by
  // definition, so fall through and re-render it.
  if (inFlight.has(clipId)) {
    res.json({ status: "pending" });
    return;
  }
  if (clip.exportStatus === "pending") {
    logger.warn({ clipId }, "Re-running export for a clip left pending by a previous process");
  }

  // Mark pending and respond immediately so the client can start polling
  inFlight.add(clipId);
  await db
    .update(userClipsTable)
    .set({ exportStatus: "pending", exportedUrl: null })
    .where(eq(userClipsTable.id, clipId));
  res.json({ status: "pending" });

  startBackgroundExport(clip);
});

/**
 * GET /user-clips/:id/export-status
 * Poll this while waiting for a background export to finish.
 * Returns { status: "idle"|"pending"|"done"|"error", url: string|null }.
 */
router.get("/user-clips/:id/export-status", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = parseInt(rawId, 10);
  if (isNaN(clipId)) { res.status(400).json({ error: "Invalid clip id" }); return; }

  const accessibleClip = await getExportAccessibleClip(req, clipId);
  if (accessibleClip === false) { res.status(401).json({ error: "Unauthenticated" }); return; }
  const clip = accessibleClip;

  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }

  const progress = exportProgress.get(clip.id) ?? null;
  res.json({ status: clip.exportStatus ?? "idle", url: clip.exportedUrl ?? null, progress });
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

  // Abort the upstream fetch if the client goes away mid-download. Without this
  // a viewer closing the tab leaves the Bunny response body draining into a
  // detached stream for the length of the file.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let upstream: Response;
  try {
    upstream = await fetch(clip.exportedUrl, {
      headers: { AccessKey: BUNNY_STORAGE_API_KEY },
      signal: abort.signal,
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: "Could not fetch from storage" });
    return;
  }
  if (!upstream.ok || !upstream.body) { res.status(502).json({ error: "Could not fetch from storage" }); return; }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
  try {
    await pipeline(nodeStream, res);
  } catch (err) {
    // Client disconnects land here too; they are not worth an error log.
    if (!abort.signal.aborted) logger.error({ err, clipId }, "Error proxying clip download");
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  }
});

export default router;
