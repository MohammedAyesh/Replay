import { BunnyVideoNotFoundError, isBunnyStorageUrl } from "./bunny";

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
  return clip.exportStatus === "done"
    && typeof clip.exportedUrl === "string"
    && clip.exportedUrl.length > 0;
}

export function planPortfolioPlayback(
  clip: PortfolioClipExport,
  storageReady: boolean,
  exportInFlight = false,
): PortfolioPlaybackPlan {
  if (clip.exportStatus === "expired") return { status: "expired" };
  if (!storageReady) {
    return { status: "unavailable" };
  }

  if (clip.exportStatus === "pending") {
    return { status: exportInFlight ? "processing" : "unavailable" };
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
