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
