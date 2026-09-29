import { BunnyVideoNotFoundError, isBunnyStorageUrl } from "./bunny";
import { isBackupExportRef } from "./backupExport";
import { publicExportStatus } from "./userClipExportState";

export type PortfolioClipVisibility = {
  visibility: unknown;
  showInPortfolio: unknown;
  isHidden: unknown;
};

export type PortfolioClipExport = {
  exportStatus: unknown;
  exportedUrl: unknown;
};

export type PortfolioPlaybackStatus = "ready" | "processing" | "expired" | "unavailable";

export type PortfolioPlaybackPlan = {
  status: PortfolioPlaybackStatus;
};

const EXPORT_QUEUE_COOLDOWN_MS = 60_000;
const exportQueueAttempts = new Map<number, number>();

export function isPortfolioClipShared(clip: PortfolioClipVisibility): boolean {
  return clip.visibility === "public" && clip.showInPortfolio === true && clip.isHidden === false;
}

export function hasCompletedPortfolioExport(
  clip: PortfolioClipExport,
): clip is PortfolioClipExport & { exportStatus: "done"; exportedUrl: string } {
  const status = typeof clip.exportStatus === "string"
    ? publicExportStatus(clip.exportStatus)
    : null;
  return status === "done"
    && typeof clip.exportedUrl === "string"
    && clip.exportedUrl.length > 0;
}

export function planPortfolioPlayback(
  clip: PortfolioClipExport,
  storageReady: boolean,
  exportInFlight = false,
): PortfolioPlaybackPlan {
  const status = typeof clip.exportStatus === "string"
    ? publicExportStatus(clip.exportStatus)
    : null;
  if (status === "expired") return { status: "expired" };
  // A backup-renderer (vps1) export is served by this server's own proxy and
  // does not depend on Bunny Storage being configured.
  if (hasCompletedPortfolioExport(clip) && isBackupExportRef(clip.exportedUrl)) {
    return { status: "ready" };
  }
  // Pending means one of the two export methods is working on it: either this
  // process (exportInFlight) or the backup renderer / another instance, which
  // the failover sweep keeps moving. Either way it is on its way.
  if (status === "pending") {
    return { status: exportInFlight || storageReady ? "processing" : "unavailable" };
  }
  if (!storageReady) {
    return { status: "unavailable" };
  }
  if (hasCompletedPortfolioExport(clip)) {
    return isBunnyStorageUrl(clip.exportedUrl)
      ? { status: "ready" }
      : { status: "unavailable" };
  }

  return { status: "unavailable" };
}

export function markPortfolioExportQueued(clipId: number): void {
  exportQueueAttempts.set(clipId, Date.now() + EXPORT_QUEUE_COOLDOWN_MS);
}

export function clearPortfolioExportQueueAttempt(clipId: number): void {
  exportQueueAttempts.delete(clipId);
}

export function classifyPortfolioSourceError(error: unknown): "expired" | "unavailable" {
  return error instanceof BunnyVideoNotFoundError ? "expired" : "unavailable";
}
