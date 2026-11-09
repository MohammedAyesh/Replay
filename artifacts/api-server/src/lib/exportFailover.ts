/**
 * Failover between the two clip-export methods.
 *
 *   Method A — this server renders (ffmpegExport.ts) and uploads to Bunny Storage.
 *   Method B — vps1 renders and keeps the file (backupExport.ts).
 *
 * The rule is simple: a clip is only reported as failed when BOTH methods have
 * failed. Everything that can end Method A without a finished file hands the
 * clip to Method B:
 *
 *   - Method A threw (bad branding asset, FFmpeg error, upload refused, …);
 *   - Method A was lost — the process restarted, or the render is running on a
 *     different autoscale instance that this one cannot see — detected as a
 *     row left `pending` that no local render owns;
 *   - Method A is hung — still "in flight" long after any sane render ends;
 *   - Method A cannot even start (Bunny Stream or Storage not configured here).
 *
 * Method B is idempotent per clip and parameters on the vps1 side, so handing
 * off twice (two instances, two polls) is harmless: both land on the same job.
 * Whichever method finishes first writes `done`; the other's result is kept or
 * ignored, never an error.
 *
 * This module holds no database-free logic worth isolating, so the pure
 * decision function `decideBackupAction` is exported for tests and the rest is
 * thin I/O around it.
 */
import { createHash } from "crypto";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { db, renderSnapshotsTable, userClipsTable, type RenderSnapshotDocument } from "@workspace/db";
import { logger } from "./logger";
import {
  BACKUP_EXPORT_PREFIX,
  backupJobFromRef,
  backupExportRef,
  getBackupExportStatus,
  isBackupExportConfigured,
  validatedBackupStorageUrl,
  submitBackupExport,
  probeExportObject,
  type BackupExportSpec,
  type BackupExportStatus,
} from "./backupExport";
import {
  PENDING_LOCAL_FALLBACK,
  PENDING_VPS1_AFTER_PRIMARY,
  PENDING_VPS1_OVERFLOW,
} from "./userClipExportState";
import { contentAddressedHashPrefix } from "./renderSnapshots";

type ClipRow = typeof userClipsTable.$inferSelect;

/** How many times a transient Method B failure is relaunched before giving up. */
export const BACKUP_MAX_RELAUNCHES = 2;
/** A `pending` row nobody here is rendering, for this long, is handed to Method B. */
export const ORPHAN_PENDING_GRACE_MS = 3 * 60_000;
/** Method A still in flight after this long is hedged with Method B. */
export const PRIMARY_HEDGE_AFTER_MS = 12 * 60_000;
/** Do not hold a finished backup behind a drawn-branding primary for longer. */
export const PRIMARY_BRANDING_WAIT_MAX_MS = 10 * 60_000;
/** Method B unreachable for this long, with Method A already failed, is a real failure. */
export const BACKUP_UNREACHABLE_GIVE_UP_MS = 3 * 60_000;

export type BackupOutcome =
  | { state: "done"; url: string }
  | { state: "running"; progress: number; stage: string | null }
  | { state: "failed"; exportStatus: "error" | "expired"; reason: string }
  | { state: "unavailable"; reason: string; since: number };

/**
 * Pure: what to do with a Method B status. `relaunches` is how many times this
 * process has already relaunched the job.
 */
export function decideBackupAction(
  status: Pick<BackupExportStatus, "status" | "errorKind" | "progress" | "stage" | "error">,
  relaunches: number,
): "done" | "running" | "relaunch" | "expired" | "error" {
  if (status.status === "ready") return "done";
  if (status.status !== "failed") return "running";
  if (status.errorKind === "source_gone") return "expired";
  if (status.errorKind === "permanent") return "error";
  // transient, lost (worker died), disk: worth another go, a bounded number of times
  return relaunches < BACKUP_MAX_RELAUNCHES ? "relaunch" : "error";
}

// ── process-local bookkeeping (a hint, never the source of truth) ───────────
const relaunchCount = new Map<number, number>();
const unreachableSince = new Map<number, number>();
const lastOutcome = new Map<number, { at: number; outcome: BackupOutcome }>();
const orphanSeenAt = new Map<number, number>();
const primaryStartedAt = new Map<number, number>();
/** Clips this process has handed to Method B and not yet seen settle. */
const handedOff = new Set<number>();

export function notePrimaryStarted(clipId: number): void {
  primaryStartedAt.set(clipId, Date.now());
}
export function notePrimaryFinished(clipId: number): void {
  primaryStartedAt.delete(clipId);
}
export function primaryRunningForMs(clipId: number): number | null {
  const at = primaryStartedAt.get(clipId);
  return at == null ? null : Date.now() - at;
}

export function shouldWaitForPrimaryBranding(
  backupBrandingComplete: boolean,
  primaryIsLive: boolean,
  primaryElapsedMs: number | null,
): boolean {
  return !backupBrandingComplete
    && primaryIsLive
    && primaryElapsedMs != null
    && primaryElapsedMs < PRIMARY_BRANDING_WAIT_MAX_MS;
}

/**
 * Drawn branding for a clip handed to vps1 (overlay PNG + end screen card),
 * registered by the clip routes. Kept as a hook so this module stays free of
 * the drawing code and its dependencies.
 */
export type BackupBrandingProvider = (
  clip: ClipRow,
  uploadedOverlayUrl: string | null,
  exportRevision?: string,
) => Promise<{ overlayUrl: string | null; endScreen: BackupExportSpec["endScreen"]; complete: boolean }>;

let brandingProvider: BackupBrandingProvider | null = null;
export function setBackupBrandingProvider(provider: BackupBrandingProvider | null): void {
  brandingProvider = provider;
}

export async function prepareBackupBranding(
  clip: ClipRow,
  overlayUrl: string | null,
  exportRevision?: string,
): Promise<{ overlayUrl: string | null; endScreen: BackupExportSpec["endScreen"]; complete: boolean }> {
  if (!brandingProvider) return { overlayUrl, endScreen: null, complete: true };
  const provider = brandingProvider;
  try {
    // Do not submit a job until its branding is ready. In particular, never
    // turn a slow end-card encode into an unbranded vps1 hand-off.
    return await provider(clip, overlayUrl, exportRevision);
  } catch (err) {
    logger.warn({ err, clipId: clip.id }, "Could not prepare drawn branding for vps1 — using uploaded branding where available");
    return { overlayUrl, endScreen: null, complete: false };
  }
}

export function backupSpecFor(
  clip: ClipRow,
  overlayUrl?: string | null,
  exportRevision?: string,
  endScreen?: BackupExportSpec["endScreen"],
): BackupExportSpec {
  return {
    clipId: clip.id,
    videoId: clip.videoId,
    startTime: Number.parseFloat(clip.startTime),
    endTime: Number.parseFloat(clip.endTime),
    cropPath: Array.isArray(clip.cropPath) ? clip.cropPath : [],
    aspectRatio: clip.aspectRatio ?? "16:9",
    title: clip.title,
    overlayUrl: overlayUrl ?? null,
    ...(exportRevision ? { exportRevision } : {}),
    ...(endScreen ? { endScreen } : {}),
  };
}

/**
 * The revision that names a replacement render of a clip, derived from the
 * export it replaces. vps1 identifies a job by the clip's times and crop only,
 * so a re-render with the same times (a new end screen, an admin re-clip) is
 * told apart only by this revision. It used to be a random id held in one
 * request's memory: the failover sweep and the status poll then asked vps1
 * without it, got the old finished job back, and published the old file —
 * the real re-render finished later and was dropped ("first wins"). Deriving
 * it from the published URL makes every caller, in every process and after a
 * restart, ask for the same job. 2026-11-04.
 */
export function replacementRevision(clip: { id: number; exportedUrl: string | null }): string | undefined {
  if (!clip.exportedUrl) return undefined;
  return createHash("sha256").update(`${clip.id}\n${clip.exportedUrl}`).digest("hex").slice(0, 32);
}

/**
 * Hand a clip to Method B (or look at the job it already has) and move the
 * row forward if Method B has settled.
 *
 * `primaryActive` — Method A is still working on this clip in this process. In
 * that case a Method B failure is not written to the row: A may still succeed.
 */
export async function reconcileBackup(
  clip: ClipRow,
  opts: {
    overlayUrl?: string | null;
    primaryActive?: boolean;
    primaryRunningForMs?: number | null;
    cacheMs?: number;
    exportRevision?: string;
  } = {},
): Promise<BackupOutcome> {
  const now = Date.now();
  if (!isBackupExportConfigured()) {
    return { state: "unavailable", reason: "backup export not configured", since: now };
  }
  const cached = lastOutcome.get(clip.id);
  if (cached && now - cached.at < (opts.cacheMs ?? 5_000)) return cached.outcome;

  const outcome = await reconcileUncached(clip, opts);
  lastOutcome.set(clip.id, { at: Date.now(), outcome });
  return outcome;
}

async function reconcileUncached(
  clip: ClipRow,
  opts: {
    overlayUrl?: string | null;
    primaryActive?: boolean;
    primaryRunningForMs?: number | null;
    exportRevision?: string;
  },
): Promise<BackupOutcome> {
  const exportRevision = opts.exportRevision ?? replacementRevision(clip);
  const branding = await prepareBackupBranding(clip, opts.overlayUrl ?? null, exportRevision);
  const spec = backupSpecFor(clip, branding.overlayUrl, exportRevision, branding.endScreen);
  let status: BackupExportStatus;
  try {
    status = await submitBackupExport(spec);
    unreachableSince.delete(clip.id);
    handedOff.add(clip.id);
  } catch (err) {
    const since = unreachableSince.get(clip.id) ?? Date.now();
    unreachableSince.set(clip.id, since);
    logger.warn({ err, clipId: clip.id }, "Backup export (vps1) unreachable");
    return { state: "unavailable", reason: String((err as Error)?.message ?? err), since };
  }

  const action = decideBackupAction(status, relaunchCount.get(clip.id) ?? 0);
  switch (action) {
    case "done": {
      const url = validatedBackupStorageUrl(status) ?? backupExportRef(status.job);
      if (status.storageUrl && url === backupExportRef(status.job)) {
        logger.warn(
          { clipId: clip.id, job: status.job },
          "Ignoring an invalid vps1 Bunny Storage URL; keeping the vps1 export reference",
        );
      }
      // A backup job receives the exact prepared assets. Its ready result is
      // authoritative when that plan is complete; only wait for a live primary
      // when vps1 could not include a planned drawn asset, and never >10 minutes.
      if (shouldWaitForPrimaryBranding(
        branding.complete,
        opts.primaryActive === true,
        opts.primaryRunningForMs ?? null,
      )) {
        logger.info(
          {
            clipId: clip.id,
            job: status.job,
            primaryRunningForMs: opts.primaryRunningForMs,
            brandingComplete: branding.complete,
          },
          "Backup export is ready; waiting for the active primary render",
        );
        return { state: "running", progress: 100, stage: "waiting_for_primary" };
      }
      // Never overwrite a finished Method A export; both are valid, first wins.
      const output = status.output;
      const snapshot: RenderSnapshotDocument = {
        schemaVersion: 1,
        renderKind: "user_clip",
        renderer: { name: "vps1-clip-export", version: "source-report-unavailable" },
        renderedAt: new Date().toISOString(),
        source: {
          kind: "vps1",
          selection: "not reported by worker",
          videoId: spec.videoId,
          width: null,
          height: null,
          durationSec: output?.duration ?? null,
        },
        timeWindow: {
          startTime: spec.startTime,
          endTime: spec.endTime,
          clipDuration: output?.duration ?? null,
        },
        crop: spec.cropPath,
        output: {
          mimeType: "video/mp4",
          width: output?.width ?? null,
          height: output?.height ?? null,
          durationMs: output?.duration ? Math.round(output.duration * 1000) : null,
        },
        text: { title: spec.title },
        branding: {
          applied: !!(spec.overlayUrl || spec.endScreen),
          overlayUrl: spec.overlayUrl,
          endCardUrl: spec.endScreen?.cardUrl ?? null,
        },
        endCard: spec.endScreen,
        music: { kind: "source-audio", addedTrackId: null },
        template: { id: spec.endScreen?.kind ?? null, version: "vps1-end-card-v1" },
        content: {
          title: spec.title,
          aspectRatio: spec.aspectRatio,
          cropPath: spec.cropPath,
          startTime: spec.startTime,
          endTime: spec.endTime,
          backupSpec: spec,
        },
        assets: [
          ...(spec.overlayUrl ? [{
            kind: "overlay",
            locator: spec.overlayUrl,
            sha256: contentAddressedHashPrefix(spec.overlayUrl),
          }] : []),
          ...(spec.endScreen?.cardUrl ? [{
            kind: "end_card",
            locator: spec.endScreen.cardUrl,
            sha256: contentAddressedHashPrefix(spec.endScreen.cardUrl),
          }] : []),
        ],
        replayable: false,
        replayabilityReason: "VPS1 did not report the selected input source or its dimensions.",
      };
      const updated = await db.transaction(async (tx) => {
        const rows = await tx
          .update(userClipsTable)
          .set({ exportStatus: "done", exportedUrl: url })
          .where(and(
            eq(userClipsTable.id, clip.id),
            inArray(userClipsTable.exportStatus, [
              "pending",
              "error",
              PENDING_VPS1_OVERFLOW,
              PENDING_LOCAL_FALLBACK,
              PENDING_VPS1_AFTER_PRIMARY,
            ]),
          ))
          .returning({ id: userClipsTable.id });
        if (rows.length) {
          await tx.insert(renderSnapshotsTable).values({
            artifactKey: `user_clip:${clip.id}`,
            outputLocator: url,
            outputSha256: null,
            snapshot,
          }).onConflictDoUpdate({
            target: [renderSnapshotsTable.artifactKey, renderSnapshotsTable.outputLocator],
            set: { snapshot, createdAt: new Date() },
          });
        }
        return rows;
      });
      if (updated.length) {
        logger.info({ clipId: clip.id, job: status.job, output: status.output }, "Clip export completed by the backup renderer (vps1)");
      }
      relaunchCount.delete(clip.id);
      handedOff.delete(clip.id);
      return { state: "done", url };
    }
    case "running":
      return { state: "running", progress: status.progress, stage: status.stage };
    case "relaunch": {
      relaunchCount.set(clip.id, (relaunchCount.get(clip.id) ?? 0) + 1);
      logger.warn({ clipId: clip.id, job: status.job, error: status.error, kind: status.errorKind }, "Relaunching failed backup export");
      try {
        const again = await submitBackupExport(spec, { retry: true });
        return { state: "running", progress: again.progress, stage: again.stage };
      } catch (err) {
        return { state: "unavailable", reason: String((err as Error)?.message ?? err), since: Date.now() };
      }
    }
    case "expired":
    case "error": {
      if (action === "expired" && clip.exportedUrl) {
        const exportProbe = await probeExportObject(clip.exportedUrl);
        if (exportProbe.state === "exists") {
          await db.update(userClipsTable)
            .set({ exportStatus: "done", exportedUrl: exportProbe.url })
            .where(eq(userClipsTable.id, clip.id));
          return { state: "done", url: exportProbe.url };
        }
        if (exportProbe.state === "unverified") {
          return { state: "unavailable", reason: "Existing export could not be verified", since: Date.now() };
        }
      }
      const exportStatus = action === "expired" ? "expired" : "error";
      handedOff.delete(clip.id);
      if (!opts.primaryActive) {
        await db
          .update(userClipsTable)
          .set({ exportStatus })
          .where(and(
            eq(userClipsTable.id, clip.id),
            inArray(userClipsTable.exportStatus, ["pending", PENDING_VPS1_AFTER_PRIMARY]),
          ));
      }
      logger.error({ clipId: clip.id, job: status.job, error: status.error, kind: status.errorKind }, "Backup export failed");
      return { state: "failed", exportStatus, reason: status.error ?? status.errorKind ?? "failed" };
    }
  }
}

/**
 * The sweep. Runs in every API process; cheap when there is nothing to do.
 *
 * Finds rows whose export is `pending` but which no local render owns, waits a
 * grace period (another instance may be rendering it), then hands them to
 * Method B and moves them to `done` when it finishes. Also hedges a local
 * Method A render that has been running implausibly long.
 */
export async function runExportFailoverSweepOnce(deps: {
  isPrimaryInFlight: (clipId: number) => boolean;
  resolveOverlayUrl: (clip: ClipRow) => Promise<string | null>;
  fallbackOverflowToLocal: (clip: ClipRow) => Promise<void>;
  resumeLocalFallback: (clip: ClipRow) => Promise<void>;
  intervalMs?: number;
  clipIds?: number[];
}): Promise<void> {
  try {
      const rows = await db
        .select()
        .from(userClipsTable)
        .where(and(
          inArray(userClipsTable.exportStatus, [
            "pending",
            PENDING_VPS1_OVERFLOW,
            PENDING_LOCAL_FALLBACK,
            PENDING_VPS1_AFTER_PRIMARY,
          ]),
          ...(deps.clipIds ? [inArray(userClipsTable.id, deps.clipIds)] : []),
        ))
        .limit(100);
      const now = Date.now();
      const seen = new Set<number>();
      for (const clip of rows) {
        seen.add(clip.id);
        if (clip.videoId.startsWith("live:")) continue;
        const primary = deps.isPrimaryInFlight(clip.id);
        const runningFor = primaryRunningForMs(clip.id);
        const primaryRenderActive = primary && runningFor != null;

        if (clip.exportStatus === PENDING_VPS1_OVERFLOW) {
          const overlayUrl = await deps.resolveOverlayUrl(clip).catch(() => null);
          const outcome = await reconcileBackup(clip, {
            overlayUrl,
            primaryActive: primaryRenderActive,
            primaryRunningForMs: runningFor,
            cacheMs: 0,
          });
          if (
            outcome.state === "failed" ||
            (outcome.state === "unavailable" &&
              (!isBackupExportConfigured() || now - outcome.since > BACKUP_UNREACHABLE_GIVE_UP_MS))
          ) {
            await deps.fallbackOverflowToLocal(clip);
          }
          orphanSeenAt.delete(clip.id);
          continue;
        }

        if (clip.exportStatus === PENDING_LOCAL_FALLBACK) {
          if (primary && (runningFor == null || runningFor < PRIMARY_HEDGE_AFTER_MS)) {
            orphanSeenAt.delete(clip.id);
            continue;
          }
          const first = orphanSeenAt.get(clip.id) ?? now;
          orphanSeenAt.set(clip.id, first);
          if (!primary && now - first >= ORPHAN_PENDING_GRACE_MS) {
            await deps.resumeLocalFallback(clip);
          }
          continue;
        }

        if (clip.exportStatus === PENDING_VPS1_AFTER_PRIMARY) {
          const overlayUrl = await deps.resolveOverlayUrl(clip).catch(() => null);
          const outcome = await reconcileBackup(clip, {
            overlayUrl,
            primaryActive: false,
            cacheMs: 0,
          });
          if (
            outcome.state === "unavailable" &&
            (!isBackupExportConfigured() || now - outcome.since > BACKUP_UNREACHABLE_GIVE_UP_MS)
          ) {
            await db
              .update(userClipsTable)
              .set({ exportStatus: "error" })
              .where(and(
                eq(userClipsTable.id, clip.id),
                eq(userClipsTable.exportStatus, PENDING_VPS1_AFTER_PRIMARY),
              ));
            logger.error(
              { clipId: clip.id, reason: outcome.reason },
              "Export failed: primary failed and backup unreachable",
            );
          }
          orphanSeenAt.delete(clip.id);
          continue;
        }

        if (primary && (runningFor == null || runningFor < PRIMARY_HEDGE_AFTER_MS)) {
          orphanSeenAt.delete(clip.id);
          continue;
        }
        if (!primary && !handedOff.has(clip.id)) {
          // Not ours and not known to be with Method B: another instance may
          // be rendering it. Give that a few minutes before stepping in.
          const first = orphanSeenAt.get(clip.id) ?? now;
          orphanSeenAt.set(clip.id, first);
          if (now - first < ORPHAN_PENDING_GRACE_MS) continue;
        }
        const overlayUrl = await deps.resolveOverlayUrl(clip).catch(() => null);
        const outcome = await reconcileBackup(clip, {
          overlayUrl,
          primaryActive: primaryRenderActive,
          primaryRunningForMs: runningFor,
          cacheMs: 0,
        });
        if (outcome.state === "unavailable" && !primary && now - outcome.since > BACKUP_UNREACHABLE_GIVE_UP_MS * 5) {
          // Both methods are out: nobody is rendering and vps1 has been
          // unreachable for 15+ minutes. Stop pretending.
          await db
            .update(userClipsTable)
            .set({ exportStatus: "error" })
            .where(and(eq(userClipsTable.id, clip.id), eq(userClipsTable.exportStatus, "pending")));
          logger.error({ clipId: clip.id, reason: outcome.reason }, "Export failed: primary lost and backup unreachable");
        }
      }
      for (const id of orphanSeenAt.keys()) if (!seen.has(id)) orphanSeenAt.delete(id);
  } catch (err) {
    logger.error({ err }, "Export failover sweep failed");
  }
}

export function startExportFailoverSweep(deps: {
  isPrimaryInFlight: (clipId: number) => boolean;
  resolveOverlayUrl: (clip: ClipRow) => Promise<string | null>;
  fallbackOverflowToLocal: (clip: ClipRow) => Promise<void>;
  resumeLocalFallback: (clip: ClipRow) => Promise<void>;
  intervalMs?: number;
}): () => void {
  if (process.env.NODE_ENV === "test") return () => {};
  const tick = () => { void runExportFailoverSweepOnce(deps); };
  const handle = setInterval(() => { void tick(); }, deps.intervalMs ?? 30_000);
  handle.unref?.();
  // First pass shortly after boot: this is exactly when rows orphaned by a
  // restart are waiting.
  const first = setTimeout(() => { void tick(); }, 20_000);
  first.unref?.();
  return () => { clearInterval(handle); clearTimeout(first); };
}

/**
 * Upgrade completed legacy vps1 references to their permanent Bunny Storage
 * copies as those copies become available. Keep the vps1 URL untouched until
 * the status response contains a validated object URL.
 */
export function startBackupStorageUrlUpgradeSweep(intervalMs = 5 * 60_000): () => void {
  if (process.env.NODE_ENV === "test") return () => {};

  const tick = async () => {
    if (!isBackupExportConfigured()) return;
    try {
      const rows = await db
        .select({
          id: userClipsTable.id,
          exportStatus: userClipsTable.exportStatus,
          exportedUrl: userClipsTable.exportedUrl,
        })
        .from(userClipsTable)
        .where(and(
          eq(userClipsTable.exportStatus, "done"),
          like(userClipsTable.exportedUrl, `${BACKUP_EXPORT_PREFIX}%`),
        ))
        .orderBy(asc(userClipsTable.id))
        .limit(8);

      await Promise.all(rows.map(async (clip) => {
        if (!clip.exportedUrl) return;
        const job = backupJobFromRef(clip.exportedUrl);
        if (!job) return;
        try {
          const status = await getBackupExportStatus(job);
          if (!status || status.status !== "ready") return;
          const storageUrl = validatedBackupStorageUrl(status);
          if (!storageUrl) return;
          await db
            .update(userClipsTable)
            .set({ exportedUrl: storageUrl })
            .where(and(
              eq(userClipsTable.id, clip.id),
              eq(userClipsTable.exportStatus, "done"),
              eq(userClipsTable.exportedUrl, clip.exportedUrl),
            ));
        } catch (err) {
          logger.warn({ err, clipId: clip.id, job }, "Could not upgrade a vps1 export to Bunny Storage");
        }
      }));
    } catch (err) {
      logger.error({ err }, "vps1 Bunny Storage URL upgrade sweep failed");
    }
  };

  const interval = setInterval(() => { void tick(); }, intervalMs);
  interval.unref?.();
  const first = setTimeout(() => { void tick(); }, 30_000);
  first.unref?.();
  return () => {
    clearInterval(interval);
    clearTimeout(first);
  };
}
