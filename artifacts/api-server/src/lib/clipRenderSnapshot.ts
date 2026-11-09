import type { RenderSnapshotDocument } from "@workspace/db";
import { isReplayableCamera4kClipSnapshot } from "./camera4kReclipEligibility";

export type BufferedClipSource = {
  bufferPath: string;
  sourceDurationSec: number;
  bufferedDuration: number;
  adjustedOffsetSec: number;
  sourceTimeOffsetSec: number;
  sourceDimensions: { width: number; height: number };
};

export function clipRenderOptionsFromSnapshot(
  snapshot: RenderSnapshotDocument,
  videoId: string,
  buffered: BufferedClipSource,
) {
  if (!isReplayableCamera4kClipSnapshot(snapshot, videoId)) {
    throw new Error("The clip presentation snapshot is incomplete or belongs to a different source.");
  }
  const window = snapshot.timeWindow;
  const content = snapshot.content;
  const close = (actual: number, expected: unknown, label: string) => {
    const value = Number(expected);
    if (!Number.isFinite(value) || Math.abs(actual - value) > 0.05) {
      throw new Error(`The saved ${label} no longer matches the camera-original buffer.`);
    }
  };
  close(buffered.sourceDimensions.width, snapshot.source.width, "source width");
  close(buffered.sourceDimensions.height, snapshot.source.height, "source height");
  close(buffered.sourceDurationSec, snapshot.source.durationSec, "source duration");
  close(buffered.bufferedDuration, window.bufferedDuration, "buffer duration");
  close(buffered.adjustedOffsetSec, window.adjustedOffsetSec, "buffer offset");
  close(buffered.sourceTimeOffsetSec, window.sourceTimeOffsetSec, "source time offset");
  const startTime = Number(window.bufferStartFraction);
  const endTime = Number(window.bufferEndFraction);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime > 1 || endTime <= startTime) {
    throw new Error("The saved clip trim is invalid.");
  }
  close((endTime - startTime) * buffered.bufferedDuration, window.clipDuration, "clip duration");
  if (!Array.isArray(content.cropPath) || typeof content.title !== "string" || typeof content.aspectRatio !== "string") {
    throw new Error("The saved clip presentation settings are incomplete.");
  }
  return {
    videoUrl: buffered.bufferPath,
    totalDuration: buffered.bufferedDuration,
    startTime,
    endTime,
    cropPath: content.cropPath as Array<{ t: number; x: number; y: number; w: number; h: number }>,
    aspectRatio: content.aspectRatio,
    title: content.title,
    sourceDimensions: buffered.sourceDimensions,
  };
}
