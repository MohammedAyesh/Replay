import type { RenderSnapshotDocument } from "@workspace/db";

export const MISSING_ORIGINAL_SETTINGS_REASON =
  "Skipped safely: the original export's captions, overlays, and end-card settings were not saved, so an exact replacement cannot be reproduced. The existing export was kept.";

export function createLegacyReclipSkipItem(input: {
  batchId: number;
  clipId: number;
  videoId: string;
  recordingId: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return {
    batchId: input.batchId,
    clipId: input.clipId,
    videoId: input.videoId,
    recordingId: input.recordingId,
    status: "skipped" as const,
    failureReason: MISSING_ORIGINAL_SETTINGS_REASON,
    completedAt: now,
    updatedAt: now,
  };
}

export function isReplayableCamera4kClipSnapshot(
  value: unknown,
  videoId: string,
): value is RenderSnapshotDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<RenderSnapshotDocument>;
  const source = snapshot.source;
  const window = snapshot.timeWindow;
  const content = snapshot.content;
  return snapshot.schemaVersion === 1
    && snapshot.renderKind === "user_clip"
    && snapshot.replayable === true
    && source?.kind === "camera-4k"
    && source.videoId === videoId
    && Number.isFinite(Number(source.width)) && Number(source.width) > 0
    && Number.isFinite(Number(source.height)) && Number(source.height) > 0
    && Number.isFinite(Number(source.durationSec)) && Number(source.durationSec) > 0
    && Number.isFinite(Number(window?.startSec))
    && Number.isFinite(Number(window?.endSec))
    && Number.isFinite(Number(window?.clipDuration))
    && !!content && Array.isArray(content.cropPath)
    && snapshot.assets?.every((asset) => !!asset.locator && !!asset.sha256) === true;
}
