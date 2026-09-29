import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { followCrop, type FollowPoint } from "../lib/personalMoments";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { eq, and, desc, inArray, count, sql, like } from "drizzle-orm";
import {
  db,
  userClipsTable,
  usersTable,
  likesTable,
  followsTable,
  academiesTable,
  recordingsTable,
  academyRecordingsTable,
  clipDownloadsTable,
  brandingAssetsTable,
  footageRequestsTable,
} from "@workspace/db";
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
import { blockedUserIdsFor, isBlockedEitherWay } from "../lib/safety";
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
import { classifyPortfolioSourceError } from "../lib/portfolioPlayback";
import { clipSettingsTable } from "@workspace/db";
import { renderClip, cleanupTempFile, bufferRemoteClip } from "../lib/ffmpegExport";
import { selectExportSource as resolveExportSource } from "../lib/exportSource";
import { logger } from "../lib/logger";
import { renderQueue, useLiveRenderSettings } from "../lib/renderQueue";
import { chooseBrandingAsset, type BrandingCandidate } from "../lib/brandingAssets";
import {
  consumeQuota,
  evaluateQuota,
  toQuotaResponse,
  buildLimitReachedEvent,
  type DownloadEvent,
} from "../lib/downloadQuota";
import { shareCardPath } from "../lib/shareCard";
import { getAllSettings, getSettingValue, type SettingsContext } from "../lib/settings";
import {
  clearPortfolioExportQueueAttempt,
  markPortfolioExportQueued,
} from "../lib/portfolioPlayback";
import { ensureClipPoster, resolveOwnerShare } from "./share";
import {
  fetchExportObject,
  forwardExportContentLength,
  isBackupExportConfigured,
  isBackupExportRef,
  isExportReachable,
} from "../lib/backupExport";
import {
  BACKUP_UNREACHABLE_GIVE_UP_MS,
  notePrimaryFinished,
  notePrimaryStarted,
  reconcileBackup,
  startExportFailoverSweep,
  type BackupOutcome,
} from "../lib/exportFailover";
import {
  PENDING_LOCAL_FALLBACK,
  PENDING_VPS1_AFTER_PRIMARY,
  PENDING_VPS1_OVERFLOW,
  isInternalPendingStatus,
  isLocalFallbackPendingStatus,
  isVps1PendingStatus,
  publicExportStatus,
} from "../lib/userClipExportState";
import { fetchBrandingAsset } from "../lib/brandingFetch";
import { introPlaybackPath } from "./clipIntro";
import { canCreateClipFromVideo } from "../lib/publicFootage";

const router: IRouter = Router();

/** Clip IDs currently being rendered — prevents duplicate concurrent jobs. */
const inFlight = new Set<number>();
/** Fallback work claimed by this process while a vps1 handoff is settling. */
const localFallbackOwned = new Set<number>();

/**
 * In-memory progress stage for each clip currently being exported.
 * Keys are clip IDs; values are one of "fetching" | "encoding" | "uploading".
 * The key is absent (not set to null) when the clip is idle, queued, or done.
 * Returned as an additive `progress` field in the export-status response so the
 * frontend can show a human-readable stage label instead of a static spinner.
 */
const exportProgress = new Map<number, string>();
/** Recent admin re-clip failures, intentionally process-local (no DB column). */
const adminClipFailureReasons = new Map<number, string>();

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

export function rememberAdminClipFailure(clipId: number, reason: string): void {
  adminClipFailureReasons.delete(clipId);
  adminClipFailureReasons.set(clipId, reason.trim().slice(0, 500) || "Unknown export failure");
  while (adminClipFailureReasons.size > 100) {
    const oldestId = adminClipFailureReasons.keys().next().value;
    if (oldestId === undefined) break;
    adminClipFailureReasons.delete(oldestId);
  }
}

export function adminClipExportSnapshot(clipId: number): {
  renderProgress: string | null;
  queuePosition: number | null;
  queueWaiting: number;
  failureReason: string | null;
} {
  const queue = queueStateFor(clipId);
  return {
    renderProgress: exportProgress.get(clipId) ?? null,
    queuePosition: queue.position,
    queueWaiting: queue.waiting,
    failureReason: adminClipFailureReasons.get(clipId) ?? null,
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
 * Claim-moment materialization may auto-start a local export for a new or
 * orphaned clip, but must not take work already assigned to another renderer.
 */
export function canAutoQueueClaimMomentExport(
  exportStatus: string | null | undefined,
  alreadyInFlight: boolean,
): boolean {
  return !alreadyInFlight && !isInternalPendingStatus(exportStatus);
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
  /** the claimant's position through the moment (personalMoments.followPath): frames the clip on them */
  follow?: FollowPoint[];
  /** source width / height, for the follow frame's shape */
  sourceAspect?: number;
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
    const cropPath = followCrop(options.follow, videoStartSeconds, startSeconds, endSeconds, options.sourceAspect ?? 3840 / 1080);
    const [created] = await db
      .insert(userClipsTable)
      .values({
        userId,
        videoId,
        title,
        startTime: String(startTime),
        endTime: String(endTime),
        cropPath,
        visibility: "private",
        aspectRatio: "16:9",
      })
      .returning();
    clip = created;
  }

  let exportStatus = publicExportStatus(clip.exportStatus);
  if (
    isBunnyConfigured() &&
    isBunnyStorageConfigured() &&
    canAutoQueueClaimMomentExport(clip.exportStatus, inFlight.has(clip.id))
  ) {
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

  return { userClipId: clip.id, exportStatus: publicExportStatus(exportStatus) };
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

/**
 * The overlay and end card this clip gets, as URLs the renderer can fetch.
 *
 * Academy, then field, then global — the same order as the intro above, so
 * there is one rule to learn rather than two. Each kind resolves on its own:
 * an academy with an overlay but no end card gets the global end card, because
 * a clip carrying an academy's logo and no sign-off is worse than one that
 * mixes tiers.
 *
 * Both settings are consulted here rather than inside the renderer, so that
 * turning branding off costs nothing at render time and the reason a clip has
 * no logo is visible in one place.
 */
async function resolveBrandingForClip(
  academyId: number | null,
  fieldId: number | null,
  ctx: SettingsContext,
): Promise<{ overlayUrl?: string; endCardUrl?: string; brandingReferer?: string }> {
  const [overlayOn, endCardOn] = await Promise.all([
    getSettingValue<boolean>("branding.overlayEnabled", ctx),
    getSettingValue<boolean>("branding.endCardEnabled", ctx),
  ]);
  if (!overlayOn && !endCardOn) return {};

  let rows: BrandingCandidate[] = [];
  try {
    rows = (await db.select().from(brandingAssetsTable)).map((row) => ({
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      kind: row.kind,
      assetUrl: row.assetUrl,
      width: row.width,
      height: row.height,
    }));
  } catch (err) {
    // No branding table yet is not a reason to fail an export.
    logger.warn({ err }, "Could not read branding assets — exporting unbranded");
    return {};
  }

  const scope = { academyId, fieldId };
  const overlay = overlayOn ? chooseBrandingAsset(rows, "overlay", scope) : null;
  const endCard = endCardOn ? chooseBrandingAsset(rows, "endCard", scope) : null;
  if (!overlay && !endCard) return {};

  // The renderer needs a Referer for the pull zone, the same way the intro
  // fetch does; derived from the asset's own host so a future move to another
  // zone does not need a second thing changed.
  const anyUrl = overlay?.assetUrl ?? endCard?.assetUrl ?? "";
  let brandingReferer: string | undefined;
  try {
    brandingReferer = anyUrl ? `https://${new URL(anyUrl).host}/` : undefined;
  } catch {
    brandingReferer = undefined;
  }

  return {
    overlayUrl: overlay?.assetUrl,
    endCardUrl: endCard?.assetUrl,
    brandingReferer,
  };
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
function startBackgroundExport(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
  options: { exportRevision?: string; trackAdminFailure?: boolean } = {},
) {
  const clipId = clip.id;
  void (async () => {
    const admission = await renderQueue.tryRunImmediately(String(clipId), () =>
      runBackgroundExport(clip, options),
    );
    if (admission.started) {
      void admission.completion.catch((err) => {
        logger.error({ err, clipId }, "Background clip export escaped its error handler");
      });
      return;
    }

    if (isBackupExportConfigured()) {
      const handoff = await tryOverflowHandoff(clip, admission.snapshot);
      if (handoff !== "local") {
        if (!localFallbackOwned.has(clipId)) inFlight.delete(clipId);
        return;
      }
      localFallbackOwned.add(clipId);
    }

    queueLocalBackgroundExport(clip, options);
  })().catch((err) => {
    logger.error({ err, clipId }, "Could not choose a clip export renderer — queuing locally");
    queueLocalBackgroundExport(clip, options);
  });
}

async function tryOverflowHandoff(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
  localQueue: ReturnType<typeof renderQueue.snapshot>,
): Promise<"handed-off" | "owned-elsewhere" | "local"> {
  const [claimed] = await db
    .update(userClipsTable)
    .set({ exportStatus: PENDING_VPS1_OVERFLOW })
    .where(and(
      eq(userClipsTable.id, clip.id),
      eq(userClipsTable.exportStatus, "pending"),
    ))
    .returning({ id: userClipsTable.id });

  if (!claimed) {
    const [current] = await db
      .select({ exportStatus: userClipsTable.exportStatus })
      .from(userClipsTable)
      .where(eq(userClipsTable.id, clip.id));
    return current?.exportStatus === "done" || isInternalPendingStatus(current?.exportStatus)
      ? "owned-elsewhere"
      : "local";
  }

  try {
    const outcome = await reconcileBackup(
      { ...clip, exportStatus: PENDING_VPS1_OVERFLOW },
      {
        overlayUrl: await overlayUrlForClip(clip),
        primaryActive: true,
        cacheMs: 0,
      },
    );
    if (outcome.state === "running" || outcome.state === "done") {
      logger.info(
        {
          clipId: clip.id,
          localQueue: {
            active: localQueue.active,
            waiting: localQueue.waiting,
            concurrency: localQueue.concurrency,
            yielding: localQueue.yielding,
          },
          backup: outcome.state,
        },
        "Overflowed local clip export to vps1",
      );
      return "handed-off";
    }
    const markedForLocal = await markOverflowForLocalFallback(clip.id);
    if (!markedForLocal) return "owned-elsewhere";
    localFallbackOwned.add(clip.id);
    logger.warn(
      { clipId: clip.id, backup: outcome.state },
      "vps1 did not accept the overflow export — returning it to the local queue",
    );
    return "local";
  } catch (err) {
    const markedForLocal = await markOverflowForLocalFallback(clip.id).catch((markErr) => {
      logger.error({ err: markErr, clipId: clip.id }, "Could not restore local fallback status");
      return false;
    });
    if (!markedForLocal) return "owned-elsewhere";
    localFallbackOwned.add(clip.id);
    logger.warn({ err, clipId: clip.id }, "vps1 overflow handoff failed — returning to the local queue");
    return "local";
  }
}

async function markOverflowForLocalFallback(clipId: number): Promise<boolean> {
  const updated = await db
    .update(userClipsTable)
    .set({ exportStatus: PENDING_LOCAL_FALLBACK })
    .where(and(
      eq(userClipsTable.id, clipId),
      eq(userClipsTable.exportStatus, PENDING_VPS1_OVERFLOW),
    ))
    .returning({ id: userClipsTable.id });
  return updated.length > 0;
}

function queueLocalBackgroundExport(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
  options: { exportRevision?: string; trackAdminFailure?: boolean } = {},
): void {
  void withRenderSlot(clip.id, () => runBackgroundExport(clip, options)).catch((err) => {
    logger.error({ err, clipId: clip.id }, "Queued background clip export escaped its error handler");
  });
}

async function fallbackOverflowToLocal(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
): Promise<void> {
  if (!(await markOverflowForLocalFallback(clip.id))) return;
  localFallbackOwned.add(clip.id);
  inFlight.add(clip.id);
  queueLocalBackgroundExport(
    { ...clip, exportStatus: PENDING_LOCAL_FALLBACK },
    localFallbackOptions(clip),
  );
  logger.warn({ clipId: clip.id }, "vps1 overflow export failed — queued a local render");
}

async function resumeLocalFallback(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
): Promise<void> {
  if (inFlight.has(clip.id) || localFallbackOwned.has(clip.id)) return;
  localFallbackOwned.add(clip.id);
  inFlight.add(clip.id);
  queueLocalBackgroundExport(
    { ...clip, exportStatus: PENDING_LOCAL_FALLBACK },
    localFallbackOptions(clip),
  );
  logger.warn({ clipId: clip.id }, "Resuming a local fallback export after process loss");
}

function localFallbackOptions(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
): { exportRevision?: string } {
  // If this was a re-render of an existing export, keep its object untouched
  // until the fallback render uploads successfully.
  return clip.exportedUrl
    ? { exportRevision: randomUUID().replace(/-/g, "") }
    : {};
}

async function runBackgroundExport(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
  options: { exportRevision?: string; trackAdminFailure?: boolean } = {},
): Promise<void> {
  const clipId = clip.id;
  const startTime = parseFloat(clip.startTime);
  const endTime = parseFloat(clip.endTime);
  const cropPath = (clip.cropPath ?? []) as { t: number; x: number; y: number; w: number; h: number }[];
  const videoId = clip.videoId;

    let tmpPath: string | null = null;
    let bufferTmpFile: string | null = null;
    const assetTmpFiles: string[] = [];
    let overlayUrlForBackup: string | null = null;
    notePrimaryStarted(clipId);
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

      const branding = await resolveBrandingForClip(
        clip.academyId,
        await fieldIdForClip(clipId),
        { academyId: clip.academyId, fieldId: await fieldIdForClip(clipId) },
      );
      overlayUrlForBackup = branding.overlayUrl ?? null;

      // Every branding asset is fetched here, with its own timeout and its own
      // HTTP status in the log, before FFmpeg starts. FFmpeg then only reads
      // local files for branding, and an asset that cannot be fetched is left
      // out rather than failing the clip. See lib/brandingFetch.ts.
      const [introPath, overlayPath, endCardPath] = await Promise.all([
        fetchBrandingAsset(introUrl, "intro", { referer: introReferer }),
        fetchBrandingAsset(branding.overlayUrl, "overlay", { referer: branding.brandingReferer }),
        fetchBrandingAsset(branding.endCardUrl, "end card", { referer: branding.brandingReferer }),
      ]);
      for (const [remote, local] of [[introUrl, introPath], [branding.overlayUrl, overlayPath], [branding.endCardUrl, endCardPath]] as const) {
        if (local && local !== remote) assetTmpFiles.push(local);
      }
      if (overlayPath || endCardPath || introPath) {
        logger.info(
          { clipId, intro: !!introPath, overlay: !!overlayPath, endCard: !!endCardPath },
          "Branding this export",
        );
      }

      exportProgress.set(clipId, "encoding");
      const renderOptions = {
        // Encode from the local buffer — no remote URL, no referer needed
        videoUrl: bufferPath,
        totalDuration: bufferedDuration,
        startTime: bufStartFraction,
        endTime: bufEndFraction,
        cropPath,
        aspectRatio: clip.aspectRatio,
        title: clip.title,
      };
      const branded = !!(introPath || overlayPath || endCardPath);
      try {
        tmpPath = await renderClip({
          ...renderOptions,
          introUrl: introPath ?? undefined,
          overlayUrl: overlayPath ?? undefined,
          endCardUrl: endCardPath ?? undefined,
        });
      } catch (renderErr) {
        if (!branded) throw renderErr;
        // A branded encode that fails gets one more try with no branding at
        // all: the clip is what the user asked for, the logo is ours.
        logger.error({ err: renderErr, clipId }, "Branded render failed — retrying the clip unbranded");
        tmpPath = await renderClip(renderOptions);
      }

      exportProgress.set(clipId, "uploading");
      const exportedUrl = await uploadToBunnyStorage(tmpPath, clipId, options.exportRevision);
      await db
        .update(userClipsTable)
        .set({ exportStatus: "done", exportedUrl })
        .where(and(
          eq(userClipsTable.id, clipId),
          inArray(userClipsTable.exportStatus, ["pending", PENDING_LOCAL_FALLBACK]),
        ));
      if (options.trackAdminFailure) adminClipFailureReasons.delete(clipId);
      logger.info({ clipId, exportedUrl, method: "primary" }, "Clip export complete");
    } catch (err) {
      logger.error({ err, clipId }, "Background clip export failed");
      if (options.trackAdminFailure) {
        rememberAdminClipFailure(
          clipId,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (classifyPortfolioSourceError(err) === "expired") {
        // The recording itself is gone from Bunny Stream. Method B reads the
        // same recording, so there is nothing to fail over to.
        await db
          .update(userClipsTable)
          .set({ exportStatus: "expired" })
          .where(and(
            eq(userClipsTable.id, clipId),
            inArray(userClipsTable.exportStatus, ["pending", PENDING_LOCAL_FALLBACK]),
          ));
      } else {
        await failOverToBackup(clip, overlayUrlForBackup, err);
      }
    } finally {
      inFlight.delete(clipId);
      localFallbackOwned.delete(clipId);
      exportProgress.delete(clipId);
      notePrimaryFinished(clipId);
      if (bufferTmpFile) cleanupTempFile(bufferTmpFile);
      if (tmpPath) cleanupTempFile(tmpPath);
      for (const f of assetTmpFiles) cleanupTempFile(f);
    }
}

/**
 * Queue an admin-triggered re-clip on the standard render queue. The revision
 * path keeps the currently published export object intact until the replacement
 * has uploaded successfully; the clip row and all clip metadata stay the same.
 */
export async function queueAdminClipReclip(
  clip: typeof import("@workspace/db").userClipsTable.$inferSelect,
): Promise<{ accepted: boolean; queuePosition: number | null }> {
  if (inFlight.has(clip.id) || isInternalPendingStatus(clip.exportStatus)) {
    return { accepted: false, queuePosition: queueStateFor(clip.id).position };
  }

  inFlight.add(clip.id);
  adminClipFailureReasons.delete(clip.id);
  try {
    // Keep exportedUrl while the replacement renders. It changes only after
    // Bunny Storage confirms the versioned replacement upload.
    await db
      .update(userClipsTable)
      .set({ exportStatus: "pending" })
      .where(eq(userClipsTable.id, clip.id));
  } catch (err) {
    inFlight.delete(clip.id);
    throw err;
  }

  startBackgroundExport(clip, {
    exportRevision: randomUUID().replace(/-/g, ""),
    trackAdminFailure: true,
  });
  return { accepted: true, queuePosition: queueStateFor(clip.id).position };
}

/**
 * Method A has failed for this clip: hand it to Method B (vps1) instead of
 * reporting a failure. The row stays `pending` while Method B works; the
 * export-status poll and the failover sweep move it to `done` when it lands.
 * Only when Method B is not configured does a Method A failure end the export.
 */
async function failOverToBackup(
  clip: typeof userClipsTable.$inferSelect,
  overlayUrl: string | null,
  cause: unknown,
): Promise<void> {
  if (!isBackupExportConfigured()) {
    await db
      .update(userClipsTable)
      .set({ exportStatus: "error" })
      .where(and(
        eq(userClipsTable.id, clip.id),
        inArray(userClipsTable.exportStatus, ["pending", PENDING_LOCAL_FALLBACK]),
      ));
    return;
  }
  try {
    const [claimed] = await db
      .update(userClipsTable)
      .set({ exportStatus: PENDING_VPS1_AFTER_PRIMARY })
      .where(and(
        eq(userClipsTable.id, clip.id),
        inArray(userClipsTable.exportStatus, ["pending", PENDING_LOCAL_FALLBACK]),
      ))
      .returning({ id: userClipsTable.id });
    if (!claimed) return;

    const outcome = await reconcileBackup(
      { ...clip, exportStatus: PENDING_VPS1_AFTER_PRIMARY },
      { overlayUrl, primaryActive: false, cacheMs: 0 },
    );
    logger.warn(
      { clipId: clip.id, backup: outcome.state, cause: String((cause as Error)?.message ?? cause).slice(0, 300) },
      "Primary export failed — handed to the backup renderer (vps1)",
    );
    // "failed" has already written the row; "done"/"running" keep it pending
    // or done; "unavailable" leaves it pending for the poll and the sweep to
    // retry, and they give up only after vps1 has stayed unreachable.
  } catch (err) {
    logger.error({ err, clipId: clip.id }, "Could not hand the export to the backup renderer");
  }
}

/** The overlay a clip's export would carry — what Method B is asked to burn in too. */
async function overlayUrlForClip(clip: typeof userClipsTable.$inferSelect): Promise<string | null> {
  try {
    const fieldId = await fieldIdForClip(clip.id);
    const branding = await resolveBrandingForClip(clip.academyId, fieldId, { academyId: clip.academyId, fieldId });
    return branding.overlayUrl ?? null;
  } catch {
    return null;
  }
}

// Rows orphaned by a restart, by another autoscale instance, or by a hung
// render are picked up here even when nobody is polling.
startExportFailoverSweep({
  isPrimaryInFlight: (clipId) => inFlight.has(clipId),
  resolveOverlayUrl: overlayUrlForClip,
  fallbackOverflowToLocal,
  resumeLocalFallback,
});

/**
 * Queue the existing MP4 export pipeline for a live capture after its Bunny
 * Stream source is ready. The persisted fractions must already be normalized
 * against the source duration before this is called.
 */
export async function queueUserClipExport(clip: typeof userClipsTable.$inferSelect): Promise<string | null> {
  if (isLiveVideoId(clip.videoId)) return null;
  if (clip.exportStatus === "done" && clip.exportedUrl) return "done";
  if (isInternalPendingStatus(clip.exportStatus)) return "pending";
  if (inFlight.has(clip.id)) return "pending";

  if (!isBunnyConfigured() || !isBunnyStorageConfigured()) {
    await db.update(userClipsTable)
      .set({ exportStatus: "error" })
      .where(eq(userClipsTable.id, clip.id));
    return "error";
  }

  inFlight.add(clip.id);
  try {
    await db.update(userClipsTable)
      .set({ exportStatus: "pending", exportedUrl: null })
      .where(eq(userClipsTable.id, clip.id));
    startBackgroundExport({ ...clip, exportStatus: "pending", exportedUrl: null });
    return "pending";
  } catch (error) {
    inFlight.delete(clip.id);
    throw error;
  }
}

/** Whether this API process is actively rendering a clip export right now. */
export function isUserClipExportInFlight(clipId: number): boolean {
  return inFlight.has(clipId);
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

  const hasOwnerShareToken = Boolean(body.data.ownerShareToken);
  const [account] = await db
    .select({ isGuest: usersTable.isGuest })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!account || account.isGuest) {
    res.status(hasOwnerShareToken ? 401 : 403).json({
      error: "Sign in with a real account to create clips",
    });
    return;
  }

  const { title, startTime, endTime, cropPath, visibility, aspectRatio, academyId } = body.data;
  const ownerShare = body.data.ownerShareToken
    ? await resolveOwnerShare(body.data.ownerShareToken)
    : null;
  if (body.data.ownerShareToken && !ownerShare) {
    res.status(404).json({ error: "This link is no longer available" });
    return;
  }

  // Owner-share clips must use the request's server-resolved Bunny source.
  // A client-supplied videoId is deliberately ignored in this branch.
  const videoId = ownerShare?.videoId ?? body.data.videoId;
  if (!videoId) {
    res.status(400).json({ error: "videoId is required unless ownerShareToken resolves an active share" });
    return;
  }
  const footageRequestId = ownerShare?.id ?? null;
  if (!(await canCreateClipFromVideo(req, videoId))) {
    res.status(403).json({ error: "You cannot create a clip from this video" });
    return;
  }

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
  if (!ownerShare && validAcademyId === null && videoId && !videoId.startsWith("live:")) {
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
      footageRequestId,
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
      showInPortfolio: row.showInPortfolio,
      isHidden: row.isHidden,
      hiddenReason: row.hiddenReason ?? null,
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
      footageRequestId: row.footageRequestId ?? null,
      matchCode: row.matchCode ?? null,
      liveClipStatus: row.liveClipStatus ?? null,
      liveClipError: row.liveClipError ?? null,
      liveClipPartial: row.liveClipPartial,
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
      showInPortfolio: row.showInPortfolio,
      isHidden: row.isHidden,
      hiddenReason: row.hiddenReason ?? null,
      aspectRatio: row.aspectRatio,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      shareCount: row.shareCount,
      score: row.score,
      thumbnailTime,
      thumbnailUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(row.videoId, thumbnailTime) : null,
      playbackUrl: !isLiveVideoId(row.videoId) && isBunnyConfigured() ? getBunnyProxiedPlaybackUrl(row.videoId) : null,
      exportStatus: publicExportStatus(row.exportStatus),
      exportedUrl: row.exportedUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      academyId: row.academyId ?? null,
      matchCode: row.matchCode ?? null,
      liveClipStatus: row.liveClipStatus ?? null,
      liveClipError: row.liveClipError ?? null,
      liveClipPartial: row.liveClipPartial,
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

  const updates: Partial<{ title: string; visibility: string; thumbnailTime: string | null; showInPortfolio: boolean }> = {};
  if (body.data.title !== undefined) updates.title = body.data.title;
  if (body.data.visibility !== undefined) updates.visibility = body.data.visibility;
  if (body.data.thumbnailTime !== undefined)
    updates.thumbnailTime = body.data.thumbnailTime != null ? String(body.data.thumbnailTime) : null;
  // A public portfolio can only contain public clips. Sharing promotes a clip
  // to public in the same mutation, while a later privacy change automatically
  // removes it from the portfolio instead of leaving an inconsistent flag.
  if (body.data.showInPortfolio === true) {
    updates.showInPortfolio = true;
    updates.visibility = "public";
  } else if (body.data.showInPortfolio === false) {
    updates.showInPortfolio = false;
  } else if (body.data.visibility !== undefined && body.data.visibility !== "public") {
    updates.showInPortfolio = false;
  }

  const [row] = await db
    .update(userClipsTable)
    .set(updates)
    .where(eq(userClipsTable.id, params.data.id))
    .returning();

  let responseExportStatus = publicExportStatus(row.exportStatus);
  if (body.data.showInPortfolio === true
    && row.showInPortfolio
    && row.visibility === "public"
    && !row.isHidden
    && !isLiveVideoId(row.videoId)
    && isBunnyConfigured()
    && isBunnyStorageConfigured()) {
    clearPortfolioExportQueueAttempt(row.id);
    try {
      responseExportStatus = await queueUserClipExport(row);
      if (responseExportStatus === "pending") {
        markPortfolioExportQueued(row.id);
      }
    } catch (error) {
      clearPortfolioExportQueueAttempt(row.id);
      logger.warn({ err: error, clipId: row.id }, "Could not queue portfolio clip export after sharing");
    }
  }

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
      showInPortfolio: row.showInPortfolio,
      isHidden: row.isHidden,
      hiddenReason: row.hiddenReason ?? null,
      aspectRatio: row.aspectRatio,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      shareCount: row.shareCount,
      score: row.score,
      thumbnailTime,
      thumbnailUrl,
      playbackUrl,
      exportStatus: responseExportStatus,
      exportedUrl: row.exportedUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      academyId: row.academyId ?? null,
      introVideoUrl,
      liveClipPartial: row.liveClipPartial,
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
  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, userClipId));
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  if (await isBlockedEitherWay(userId, clip.userId)
    || (clip.isHidden && clip.userId !== userId)) {
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
  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, userClipId));
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
  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, userClipId));
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
  const blockedIds = userId ? await blockedUserIdsFor(userId) : new Set<number>();

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
    if (blockedIds.has(row.creatorId)) return false;
    if ((row as { isHidden?: boolean }).isHidden) return false;
    if (row.visibility === "public") return true;
    if (row.visibility === "private") return row.creatorId === userId;
    // Match clips are seen by that match's players on the match page, not in the public feed.
    if (row.visibility === "match") return row.creatorId === userId;
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
    const socialLikerIds = followedIds.filter((id) => !blockedIds.has(id));
    if (socialLikerIds.length > 0) {
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
            inArray(likesTable.userId, socialLikerIds)
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
  // Already exported — return the cached URL immediately (no re-render)
  if (clip.exportStatus === "done" && clip.exportedUrl) {
    res.json({ status: "done", url: clip.exportedUrl });
    return;
  }
  if (isInternalPendingStatus(clip.exportStatus)) {
    res.json({ status: "pending" });
    return;
  }

  // Method A needs Bunny Stream's API and Bunny Storage configured on this
  // server. If either is missing, go straight to Method B rather than refusing:
  // Method B needs neither.
  if (!isBunnyConfigured() || !isBunnyStorageConfigured()) {
    if (!isBackupExportConfigured()) {
      res.status(400).json({ error: "Export is not configured on this server" });
      return;
    }
    logger.warn({ clipId, bunny: isBunnyConfigured(), storage: isBunnyStorageConfigured() }, "Primary export not configured — using the backup renderer");
    await db
      .update(userClipsTable)
      .set({ exportStatus: "pending", exportedUrl: null })
      .where(eq(userClipsTable.id, clipId));
    const outcome = await reconcileBackup({ ...clip, exportStatus: "pending", exportedUrl: null }, {
      overlayUrl: await overlayUrlForClip(clip),
      cacheMs: 0,
    });
    res.json(outcome.state === "done" ? { status: "done", url: outcome.url } : { status: "pending" });
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
  try {
    await db
      .update(userClipsTable)
      .set({ exportStatus: "pending", exportedUrl: null })
      .where(eq(userClipsTable.id, clipId));
  } catch (err) {
    // Without this the id stayed in inFlight for the life of the process and
    // every later /export for the clip answered "pending" forever.
    inFlight.delete(clipId);
    throw err;
  }
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

  const queue = queueStateFor(clip.id);
  const decided = await exportStatusFor(clip, { verify: req.query.verify === "1" });
  res.json({
    ...decided,
    // Queue position is additive and only meaningful while Method A is
    // pending. A spinner that says "3rd in line" is the difference between
    // waiting and giving up.
    queuePosition: decided.method === "primary" ? queue.position : null,
    queueWaiting: decided.method === "primary" ? queue.waiting : 0,
  });
});

/**
 * What the client should be told about a clip's export, and — because the
 * client polls this every two seconds — the place where a failed or lost
 * Method A is handed to Method B while someone is waiting for it.
 *
 * "error" is only returned when both methods have failed (or Method B is not
 * configured). `verify` additionally checks, right before the client downloads,
 * that a finished export can still be fetched; one that cannot is re-rendered
 * instead of handed over as a broken download.
 */
async function exportStatusFor(
  clip: typeof userClipsTable.$inferSelect,
  opts: { verify?: boolean } = {},
): Promise<{
  status: "idle" | "pending" | "done" | "error" | "expired";
  url: string | null;
  progress: string | null;
  method: "primary" | "backup" | null;
  backupProgress: number | null;
  backupStage: string | null;
  reason?: string;
}> {
  const primaryActive = inFlight.has(clip.id);
  const base = {
    url: null,
    progress: null,
    method: null,
    backupProgress: null,
    backupStage: null,
  } as const;

  if (clip.exportStatus === "done" && clip.exportedUrl) {
    if (!opts.verify || await isExportReachable(clip.exportedUrl)) {
      return { ...base, status: "done", url: clip.exportedUrl };
    }
    // The file is gone (deleted from storage, vps1 retention) or its host is
    // down. Re-render it rather than hand the user a failed download.
    const wasBackup = isBackupExportRef(clip.exportedUrl);
    logger.warn({ clipId: clip.id, backup: wasBackup }, "Finished export is not reachable — re-rendering");
    await db
      .update(userClipsTable)
      .set({ exportStatus: "pending", exportedUrl: null })
      .where(eq(userClipsTable.id, clip.id));
    clip = { ...clip, exportStatus: "pending", exportedUrl: null };
    // A lost Method A file is re-rendered by Method A (Method B takes over if
    // that fails); a lost Method B file goes straight back to Method B.
    if (!wasBackup && !primaryActive && isBunnyConfigured() && isBunnyStorageConfigured()) {
      inFlight.add(clip.id);
      startBackgroundExport(clip);
      return { ...base, status: "pending", progress: "fetching", method: "primary" };
    }
  }

  if (clip.exportStatus === "expired") {
    return { ...base, status: "error", reason: "expired" };
  }

  if (isLocalFallbackPendingStatus(clip.exportStatus)) {
    return {
      ...base,
      status: "pending",
      progress: primaryActive ? exportProgress.get(clip.id) ?? null : null,
      method: "primary",
    };
  }

  if (isVps1PendingStatus(clip.exportStatus)) {
    const isOverflow = clip.exportStatus === PENDING_VPS1_OVERFLOW;
    const outcome = await reconcileBackup(clip, {
      overlayUrl: await overlayUrlForClip(clip),
      primaryActive: isOverflow,
      cacheMs: 0,
    });
    switch (outcome.state) {
      case "done":
        return { ...base, status: "done", url: outcome.url, method: "backup", backupProgress: 100 };
      case "running":
        return {
          ...base,
          status: "pending",
          progress: "backup",
          method: "backup",
          backupProgress: outcome.progress,
          backupStage: outcome.stage,
        };
      case "failed":
        if (isOverflow) {
          await fallbackOverflowToLocal(clip);
          return { ...base, status: "pending", method: "primary" };
        }
        return { ...base, status: "error", reason: outcome.exportStatus };
      case "unavailable":
        if (isOverflow && (
          !isBackupExportConfigured() ||
          Date.now() - outcome.since > BACKUP_UNREACHABLE_GIVE_UP_MS
        )) {
          await fallbackOverflowToLocal(clip);
          return { ...base, status: "pending", method: "primary" };
        }
        if (!isOverflow && (
          !isBackupExportConfigured() ||
          Date.now() - outcome.since > BACKUP_UNREACHABLE_GIVE_UP_MS
        )) {
          await db
            .update(userClipsTable)
            .set({ exportStatus: "error" })
            .where(and(
              eq(userClipsTable.id, clip.id),
              eq(userClipsTable.exportStatus, PENDING_VPS1_AFTER_PRIMARY),
            ));
          return { ...base, status: "error", reason: "both_unavailable" };
        }
        return {
          ...base,
          status: "pending",
          progress: "backup",
          method: "backup",
          backupProgress: 0,
        };
    }
  }

  // Method A is working on it here and has not been going implausibly long:
  // report its progress.
  if (clip.exportStatus === "pending" && primaryActive) {
    return { ...base, status: "pending", progress: exportProgress.get(clip.id) ?? null, method: "primary" };
  }

  // A plain pending row with no local renderer may be stale (restart or another
  // instance). Keep the existing status-poll handoff for those legacy states.
  if (clip.exportStatus !== "pending" && clip.exportStatus !== "error") {
    return { ...base, status: "idle" };
  }
  if (!isBackupExportConfigured()) {
    return { ...base, status: clip.exportStatus === "error" ? "error" : "pending" };
  }

  const outcome: BackupOutcome = await reconcileBackup(clip, { overlayUrl: await overlayUrlForClip(clip) });
  switch (outcome.state) {
    case "done":
      return { ...base, status: "done", url: outcome.url, method: "backup", backupProgress: 100 };
    case "running":
      if (clip.exportStatus === "error") {
        // Method A had already given up; the row is live again while B works.
        await db
          .update(userClipsTable)
          .set({ exportStatus: "pending" })
          .where(and(eq(userClipsTable.id, clip.id), eq(userClipsTable.exportStatus, "error")));
      }
      return {
        ...base,
        status: "pending",
        progress: "backup",
        method: "backup",
        backupProgress: outcome.progress,
        backupStage: outcome.stage,
      };
    case "failed":
      return { ...base, status: "error", reason: outcome.exportStatus };
    case "unavailable": {
      const stuckFor = Date.now() - outcome.since;
      if (stuckFor > BACKUP_UNREACHABLE_GIVE_UP_MS) {
        // Method A is not rendering this clip and Method B cannot be reached.
        await db
          .update(userClipsTable)
          .set({ exportStatus: "error" })
          .where(and(eq(userClipsTable.id, clip.id), eq(userClipsTable.exportStatus, "pending")));
        return { ...base, status: "error", reason: "both_unavailable" };
      }
      return { ...base, status: "pending", progress: "backup", method: "backup", backupProgress: 0 };
    }
  }
}


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
      .select({ videoId: userClipsTable.videoId, fieldId: recordingsTable.fieldId })
      .from(userClipsTable)
      .innerJoin(recordingsTable, like(recordingsTable.videoUrl, sql`'%' || ${userClipsTable.videoId} || '%'`))
      .where(eq(userClipsTable.id, clipId))
      .limit(1);
    if (row?.fieldId != null) return row.fieldId;

    const [ownerRequest] = await db
      .select({ fieldId: footageRequestsTable.fieldId })
      .from(userClipsTable)
      .innerJoin(footageRequestsTable, eq(footageRequestsTable.videoId, userClipsTable.videoId))
      .where(eq(userClipsTable.id, clipId))
      .limit(1);
    return ownerRequest?.fieldId ?? null;
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

  const [clip] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, clipId));
  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
  if (await isBlockedEitherWay(userId, clip.userId)
    || (clip.isHidden && clip.userId !== userId)) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
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

  let upstream: Response | null = null;
  try {
    // Either method's file: Bunny Storage for Method A, vps1 for Method B.
    upstream = await fetchExportObject(clip.exportedUrl, { signal: abort.signal });
  } catch (err) {
    logger.error({ err, clipId, backup: isBackupExportRef(clip.exportedUrl) }, "Could not reach the finished export");
  }
  if (!upstream || !upstream.ok || !upstream.body) {
    await upstream?.body?.cancel().catch(() => {});
    // The finished file cannot be served. Put the clip back into the export
    // pipeline (Method A, with Method B behind it) instead of leaving a "done"
    // row that fails every download; the client sees "pending" and waits.
    if (!abort.signal.aborted) {
      logger.error({ clipId, status: upstream?.status ?? null }, "Finished export unavailable — re-rendering");
      await exportStatusFor(clip, { verify: true }).catch(() => {});
      if (!res.headersSent) res.status(503).json({ error: "Your clip is being prepared again. Try in a minute.", retry: true });
    }
    return;
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);
  forwardExportContentLength(res, upstream, false);

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
