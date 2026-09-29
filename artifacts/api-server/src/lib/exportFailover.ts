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
import { and, eq, inArray } from "drizzle-orm";
import { db, userClipsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  backupExportRef,
  isBackupExportConfigured,
  submitBackupExport,
  type BackupExportSpec,
  type BackupExportStatus,
} from "./backupExport";

type ClipRow = typeof userClipsTable.$inferSelect;

/** How many times a transient Method B failure is relaunched before giving up. */
export const BACKUP_MAX_RELAUNCHES = 2;
/** A `pending` row nobody here is rendering, for this long, is handed to Method B. */
export const ORPHAN_PENDING_GRACE_MS = 3 * 60_000;
/** Method A still in flight after this long is hedged with Method B. */
export const PRIMARY_HEDGE_AFTER_MS = 12 * 60_000;
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

export function backupSpecFor(clip: ClipRow, overlayUrl?: string | null): BackupExportSpec {
  return {
    clipId: clip.id,
    videoId: clip.videoId,
    startTime: Number.parseFloat(clip.startTime),
    endTime: Number.parseFloat(clip.endTime),
    cropPath: Array.isArray(clip.cropPath) ? clip.cropPath : [],
    aspectRatio: clip.aspectRatio ?? "16:9",
    title: clip.title,
    overlayUrl: overlayUrl ?? null,
  };
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
  opts: { overlayUrl?: string | null; primaryActive?: boolean; cacheMs?: number } = {},
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
  opts: { overlayUrl?: string | null; primaryActive?: boolean },
): Promise<BackupOutcome> {
  const spec = backupSpecFor(clip, opts.overlayUrl);
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
      const url = backupExportRef(status.job);
      // Never overwrite a finished Method A export; both are valid, first wins.
      const updated = await db
        .update(userClipsTable)
        .set({ exportStatus: "done", exportedUrl: url })
        .where(and(
          eq(userClipsTable.id, clip.id),
          inArray(userClipsTable.exportStatus, ["pending", "error"]),
        ))
        .returning({ id: userClipsTable.id });
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
      const exportStatus = action === "expired" ? "expired" : "error";
      handedOff.delete(clip.id);
      if (!opts.primaryActive) {
        await db
          .update(userClipsTable)
          .set({ exportStatus })
          .where(and(eq(userClipsTable.id, clip.id), eq(userClipsTable.exportStatus, "pending")));
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
export function startExportFailoverSweep(deps: {
  isPrimaryInFlight: (clipId: number) => boolean;
  resolveOverlayUrl: (clip: ClipRow) => Promise<string | null>;
  intervalMs?: number;
}): () => void {
  if (process.env.NODE_ENV === "test") return () => {};
  const tick = async () => {
    try {
      const rows = await db
        .select()
        .from(userClipsTable)
        .where(eq(userClipsTable.exportStatus, "pending"))
        .limit(100);
      const now = Date.now();
      const seen = new Set<number>();
      for (const clip of rows) {
        seen.add(clip.id);
        if (clip.videoId.startsWith("live:")) continue;
        const primary = deps.isPrimaryInFlight(clip.id);
        const runningFor = primaryRunningForMs(clip.id);
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
        const outcome = await reconcileBackup(clip, { overlayUrl, primaryActive: primary, cacheMs: 0 });
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
  };
  const handle = setInterval(() => { void tick(); }, deps.intervalMs ?? 30_000);
  handle.unref?.();
  // First pass shortly after boot: this is exactly when rows orphaned by a
  // restart are waiting.
  const first = setTimeout(() => { void tick(); }, 20_000);
  first.unref?.();
  return () => { clearInterval(handle); clearTimeout(first); };
}
