import { Router, type IRouter } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { eq, and, desc, inArray, count, sql, like } from "drizzle-orm";
import { db, userClipsTable, usersTable, likesTable, followsTable, academiesTable, recordingsTable, academyRecordingsTable, clipDownloadsTable } from "@workspace/db";
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
import { getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import {
  getBunnyThumbnailUrl,
  getBunnyProxiedPlaybackUrl,
  getBunnyProxiedThumbnailUrl,
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
import { selectExportSource as resolveExportSource } from "../lib/exportSource";
import { logger } from "../lib/logger";
import { renderQueue, useLiveRenderSettings } from "../lib/renderQueue";
import {
  consumeQuota,
  evaluateQuota,
  toQuotaResponse,
  buildLimitReachedEvent,
  type DownloadEvent,
} from "../lib/downloadQuota";
import { shareCardPath } from "../lib/shareCard";
import { getAllSettings } from "../lib/settings";
import { ensureClipPoster } from "./share";
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
 * Renders are CPU-bound and contend with the hourly archive for the same cores,
 * so they run through a shared queue rather than all at once. The queue itself,
 * the concurrency cap and the rule that renders yield to the archive live in
 * lib/renderQueue.ts, which has no database imports and is unit-tested there.
 *
 * Keyed by clip id, which is what lets `positionOf` answer "where am I" for a
 * specific clip rather than only "how many are ahead".
 */
// Point the queue at the admin settings. Done here rather than in renderQueue.ts
// so that module keeps no database import and stays unit-testable.
useLiveRenderSettings(async () => {
  const settings = await getAllSettings();
  return {
    concurrency: Number(settings["render.maxConcurrent"]),
    yieldToArchive: settings["render.yieldToArchive"] !== false,
    yieldCeilingMs: Number(settings["render.yieldCeilingSeconds"]) * 1000,
  };
});

function withRenderSlot<T>(clipId: number, job: () => Promise<T>): Promise<T> {
  return renderQueue.run(String(clipId), job);
}

/**
 * Where a clip sits in the render queue, in the form the client shows.
 *
 * `position` counts jobs ahead of this one: 0 means it is rendering now. Null
 * means this process is not tracking the clip, which after a restart is the
 * truth — hence null rather than a reassuring 0.
 */
export function queueStateFor(clipId: number): {
  position: number | null;
  waiting: number;
  concurrency: number;
} {
  const snap = renderQueue.snapshot();
  return {
    position: renderQueue.positionOf(String(clipId)),
    waiting: snap.waiting,
    concurrency: snap.concurrency,
  };
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
 * Recording rows store the original Bunny playlist URL, while user_clips
 * stores only the Bunny Stream GUID. Keep this conversion server-side so a
 * claim moment can become a normal user clip without trusting a client-supplied
 * video id.
 */
export function extractBunnyVideoId(videoUrl: string): string | null {
  const value = videoUrl.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const nestedUrl = parsed.searchParams.get("url");
    if (nestedUrl) return extractBunnyVideoId(nestedUrl);

    const parts = parsed.pathname.split("/").filter(Boolean);
    const mediaIndex = parts.findIndex((part) =>
      part.endsWith(".m3u8") || /^play_\d+p\.mp4$/i.test(part),
    );
    if (mediaIndex > 0) return parts[mediaIndex - 1] ?? null;
    if (parsed.hostname.endsWith(".b-cdn.net") && parts.length > 0) return parts[0] ?? null;
    return null;
  } catch {
    // A bare Bunny GUID is useful in a few older recording rows.
    return /^[a-z0-9-]{16,}$/i.test(value) ? value : null;
  }
}

function parseRecordingDuration(value: string | null | undefined): number {
  const raw = value?.trim() ?? "";
  if (!raw) return 0;
  const clock = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    const hours = Number(clock[1] ?? 0);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

type ClaimMomentForClip = Pick<
  import("@workspace/db").ClaimEarnedClip,
  "id" | "title" | "momentSeconds" | "kind" | "status"
>;

/**
 * Materialize one accepted claim event as a private user clip. The clip uses
 * the same 16-second window and background FFmpeg export as manually-created
 * clips, so it is playable immediately through the source HLS and becomes a
 * downloadable MP4 when the background job finishes.
 */
export async function ensureClaimMomentUserClip(options: {
  userId: number;
  recording: typeof recordingsTable.$inferSelect;
  moment: ClaimMomentForClip;
  videoStartSeconds?: number;
  trackingDuration?: number;
}): Promise<{ userClipId: number; exportStatus: string | null }> {
  const { userId, recording, moment } = options;
  const videoId = extractBunnyVideoId(recording.videoUrl);
  if (!videoId || isLiveVideoId(videoId)) {
    throw new Error(`Recording ${recording.id} does not have a Bunny Stream video`);
  }

  const trackingDuration = Number.isFinite(options.trackingDuration) && (options.trackingDuration ?? 0) > 0
    ? options.trackingDuration!
    : 0;
  const recordingDuration = parseRecordingDuration(recording.duration) || trackingDuration;
  if (recordingDuration <= 0) {
    throw new Error(`Recording ${recording.id} does not have a usable duration`);
  }

  const videoStartSeconds = Number.isFinite(options.videoStartSeconds)
    ? Math.max(0, options.videoStartSeconds ?? 0)
    : 0;
  const startSeconds = Math.max(0, moment.momentSeconds - 8 + videoStartSeconds);
  const endSeconds = Math.min(
    recordingDuration,
    moment.momentSeconds + 8 + videoStartSeconds,
  );
  if (endSeconds <= startSeconds) {
    throw new Error(`Claim moment ${moment.id} has no exportable video window`);
  }

  const startTime = Math.max(0, Math.min(1, startSeconds / recordingDuration));
  const endTime = Math.max(startTime, Math.min(1, endSeconds / recordingDuration));
  const title = moment.title;

  const candidates = await db
    .select()
    .from(userClipsTable)
    .where(and(
      eq(userClipsTable.userId, userId),
      eq(userClipsTable.videoId, videoId),
      eq(userClipsTable.title, title),
    ));
  let clip = candidates.find((candidate) =>
    Math.abs(parseFloat(candidate.startTime) - startTime) < 0.0001 &&
    Math.abs(parseFloat(candidate.endTime) - endTime) < 0.0001,
  );

  if (!clip) {
    const [created] = await db
      .insert(userClipsTable)
      .values({
        userId,
        videoId,
        title,
        startTime: String(startTime),
        endTime: String(endTime),
        cropPath: [],
        visibility: "private",
        aspectRatio: "16:9",
      })
      .returning();
    clip = created;
  }

  let exportStatus = clip.exportStatus ?? null;
  if (isBunnyConfigured() && isBunnyStorageConfigured() && !inFlight.has(clip.id)) {
    if (clip.exportStatus !== "done" || !clip.exportedUrl) {
      inFlight.add(clip.id);
      await db
        .update(userClipsTable)
        .set({ exportStatus: "pending", exportedUrl: null })
        .where(eq(userClipsTable.id, clip.id));
      exportStatus = "pending";
      startBackgroundExport(clip);
    }
  }

  return { userClipId: clip.id, exportStatus };
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

  void withRenderSlot(clipId, async () => {
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
      const source = await resolveExportSource({
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
          // Declared geometry of the chosen variant, and the rendition folder
          // it happened to live in. The geometry is the contract; the label is
          // only there to make a ladder change readable in the logs.
          sourceWidth: source.width,
          sourceHeight: source.height,
          renditionLabel: source.renditionLabel,
        },
        `Selected export source: ${source.path} (${source.width}x${source.height})`,
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

/**
 * Source-rendition pinning lives in lib/exportSource.ts, which has no database
 * imports so it can be unit-tested on its own. Re-exported here because this
 * module is the historical import site.
 *
 * The behaviour changed: there is no longer a master-playlist fallback. See
 * exportSource.ts for why letting ABR choose the rendition silently corrupts
 * every crop calculation.
 */
export {
  selectExportSource,
  ExportSourceUnavailableError,
  EXPORT_SOURCE_LABEL,
} from "../lib/exportSource";
export type { ExportSource, ExportSourcePath, HlsVariant } from "../lib/exportSource";

router.post("/user-clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    unauthenticatedResponse(res, req);
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
    unauthenticatedResponse(res, req);
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
    unauthenticatedResponse(res, req);
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
    unauthenticatedResponse(res, req);
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
    unauthenticatedResponse(res, req);
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

  // Start the poster now, in the background. WhatsApp fetches the card within
  // seconds of the link being pasted, and a card whose og:image 404s is cached
  // as a card with no image — by the platform, not by us, and for a long time.
  // Not awaited: the share must not wait on FFmpeg.
  void ensureClipPoster(clip).catch(() => {});

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
  if (accessibleClip === false) { unauthenticatedResponse(res, req); return; }
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
  if (accessibleClip === false) { unauthenticatedResponse(res, req); return; }
  const clip = accessibleClip;

  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }

  const progress = exportProgress.get(clip.id) ?? null;
  // Queue position is additive and only meaningful while pending. A spinner that
  // says "3rd in line" is the difference between waiting and giving up.
  const queue = queueStateFor(clip.id);
  res.json({
    status: clip.exportStatus ?? "idle",
    url: clip.exportedUrl ?? null,
    progress,
    queuePosition: queue.position,
    queueWaiting: queue.waiting,
  });
});


/**
 * The rolling-30-day download ledger for one user.
 *
 * Reads a window's worth of rows, not a counter: see lib/downloadQuota.ts for
 * why the allowance is rolling rather than per calendar month.
 */
async function loadQuotaContext(
  userId: number,
  now: Date,
  clipId?: number,
  tx: Pick<typeof db, "select"> = db,
): Promise<{
  events: DownloadEvent[];
  unlimited: boolean;
  limit: number;
  windowDays: number;
  downloadsEnabled: boolean;
}> {
  const [user] = await tx
    .select({ plan: usersTable.plan, academyId: usersTable.academyId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  // Resolve the admin-configurable values for THIS user before reading their
  // ledger, because the window length decides which rows count.
  const settings = await getAllSettings({
    userId,
    academyId: user?.academyId ?? null,
    fieldId: await fieldIdForClip(clipId),
    at: now,
  });
  const limit = Number(settings["downloads.limit"]);
  const windowDays = Number(settings["downloads.windowDays"]);
  const downloadsEnabled = settings["downloads.enabled"] !== false;

  const windowStart = new Date(now.getTime() - (windowDays + 1) * 86_400_000);
  const rows = await tx
    .select({ at: clipDownloadsTable.createdAt, clipId: clipDownloadsTable.clipId })
    .from(clipDownloadsTable)
    .where(and(
      eq(clipDownloadsTable.userId, userId),
      sql`${clipDownloadsTable.createdAt} > ${windowStart.toISOString()}`,
    ));

  return {
    events: rows.map((r) => ({ at: r.at, clipId: r.clipId ?? -1 })),
    unlimited: (user?.plan ?? "free") !== "free",
    limit,
    windowDays,
    downloadsEnabled,
  };
}

/**
 * The field a clip was recorded at, for field-scoped settings.
 *
 * Best-effort by design: a clip whose recording cannot be matched simply has no
 * field scope, which means field rules do not apply to it. That is the correct
 * outcome, not an error, so this never throws and never blocks a download.
 */
async function fieldIdForClip(clipId?: number): Promise<number | null> {
  if (!clipId) return null;
  try {
    const [row] = await db
      .select({ fieldId: recordingsTable.fieldId })
      .from(userClipsTable)
      .innerJoin(recordingsTable, like(recordingsTable.videoUrl, sql`'%' || ${userClipsTable.videoId} || '%'`))
      .where(eq(userClipsTable.id, clipId))
      .limit(1);
    return row?.fieldId ?? null;
  } catch {
    return null;
  }
}


/**
 * Decide and record a download as one serialised operation.
 *
 * The previous shape — read the ledger, decide, then insert — has a race that a
 * five-download allowance makes easy to hit: two downloads of different clips
 * arriving together both read four-of-five used, both conclude they have a slot,
 * and both insert. The user gets six. Nothing surfaces it; the counter is simply
 * wrong from then on, and the 5/5 event either fires twice or not at all.
 *
 * A row lock on the user closes it. The lock is on `users` rather than on the
 * ledger because there is no ledger row to lock when the account is at zero —
 * you cannot lock what does not exist yet — and every download for one account
 * has to serialise against the same thing whether or not they have downloaded
 * before.
 *
 * Borrowed from the parallel implementation on claim-identity-binding, which got
 * this right where this one did not.
 */
async function reserveDownload(
  userId: number,
  clipId: number,
  now: Date,
): Promise<
  | { outcome: "disabled" }
  | { outcome: "refused"; state: ReturnType<typeof evaluateQuota> }
  | { outcome: "allowed"; state: ReturnType<typeof evaluateQuota>; limitReachedNow: boolean }
> {
  return db.transaction(async (tx) => {
    // Serialise every download for this account against this row.
    await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);

    const ctx = await loadQuotaContext(userId, now, clipId, tx);
    if (!ctx.downloadsEnabled) return { outcome: "disabled" as const };

    const decision = consumeQuota(ctx.events, clipId, now, {
      unlimited: ctx.unlimited,
      limit: ctx.limit,
      windowDays: ctx.windowDays,
    });
    if (!decision.allowed) return { outcome: "refused" as const, state: decision.state };

    if (decision.shouldRecord) {
      await tx.insert(clipDownloadsTable).values({ userId, clipId, createdAt: now });
    }
    return {
      outcome: "allowed" as const,
      state: decision.state,
      limitReachedNow: decision.limitReachedNow,
    };
  });
}

/**
 * GET /user-clips/download-quota
 *
 * The counter and reset date the UI shows. Surfaced as its own endpoint and read
 * before the user taps Download, not after: a limit nobody can see is an error
 * message, and a visible one is the conversion trigger.
 */
router.get("/user-clips/download-quota", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const now = new Date();
  const { events, unlimited, limit, windowDays } = await loadQuotaContext(userId, now);
  res.json(toQuotaResponse(evaluateQuota(events, now, { unlimited, limit, windowDays })));
});

/**
 * GET /user-clips/:id/share-link
 *
 * The public URL for a clip, and its poster. The token in the path is derived
 * server-side and never leaves this endpoint, which is what stops the share
 * space being walkable by counting ids.
 *
 * Kept out of openapi.yaml alongside /export, /export-status and /download,
 * which are also operational rather than data endpoints.
 */
router.get("/user-clips/:id/share-link", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = parseInt(rawId, 10);
  if (isNaN(clipId)) { res.status(400).json({ error: "Invalid clip id" }); return; }

  const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipId));
  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
  if (clip.userId !== userId && clip.visibility !== "public") {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.get("host") || "";
  const base = (process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL || `${proto}://${host}`).replace(/\/$/, "");
  const cardPath = shareCardPath(clip.id);

  void ensureClipPoster(clip).catch(() => {});

  res.json({
    shareUrl: `${base}${cardPath}`,
    posterUrl: `${base}${cardPath}/poster.jpg`,
    ready: clip.exportStatus === "done" && !!clip.exportedUrl,
  });
});

/**
 * GET /user-clips/:id/download
 * Proxy-downloads the rendered MP4 from Bunny Storage through our server.
 * Avoids CORS issues and works uniformly on iOS and desktop.
 */
router.get("/user-clips/:id/download", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = parseInt(rawId, 10);
  if (isNaN(clipId)) { res.status(400).json({ error: "Invalid clip id" }); return; }

  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(and(eq(userClipsTable.id, clipId), eq(userClipsTable.userId, userId)));

  if (!clip || !clip.exportedUrl) { res.status(404).json({ error: "Export not ready" }); return; }

  // ── the free tier's rolling allowance ───────────────────────────────────
  const now = new Date();
  const reservation = await reserveDownload(userId, clipId, now);

  // A global off switch, checked inside the same decision: an admin turning
  // downloads off means off, including for accounts that are not metered.
  if (reservation.outcome === "disabled") {
    res.status(403).json({ error: "Downloads are currently disabled" });
    return;
  }
  if (reservation.outcome === "refused") {
    res.status(402).json({
      error: "Download limit reached",
      quota: toQuotaResponse(reservation.state),
    });
    return;
  }
  if (reservation.limitReachedNow) {
    // The 5/5 event. Emitted exactly once per user per time they hit the wall —
    // the reservation is serialised, so two concurrent downloads cannot both
    // believe they were the one that hit it. The hit-limit-to-conversion rate is
    // the only clean read on whether five is the right number. A structured log
    // line rather than a call into an analytics SDK: this is the one place the
    // event is emitted, so pointing it somewhere else later is a one-line change.
    logger.info(buildLimitReachedEvent(userId, clipId, reservation.state, now), "Download quota limit reached");
  }

  res.setHeader("X-Download-Quota-Used", String(reservation.state.used));
  res.setHeader("X-Download-Quota-Limit", String(reservation.state.limit));
  if (reservation.state.resetAt) res.setHeader("X-Download-Quota-Reset", reservation.state.resetAt.toISOString());

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
