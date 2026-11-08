import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  decodeLocalMedia,
  probeLocalMedia,
  type LocalMediaProbe,
} from "./ffmpegExport";
import { fetchExportObject, isBackupExportRef } from "./backupExport";
import { cleanupTempFile } from "./ffmpegExport";
import { getPortfolioClipStoragePath, isBunnyStorageUrl } from "./bunny";

export type Camera4kReclipValidation = {
  oldDurationSeconds: number;
  newDurationSeconds: number;
  oldBytes: number;
  newBytes: number;
  width: number;
  height: number;
  oldHasAudio: boolean;
  newHasAudio: boolean;
  frameCount: number;
};

const MAX_RECLIP_BYTES = 1_500_000_000;

export function assertCamera4kReclipMediaPair(
  previous: LocalMediaProbe,
  replacement: LocalMediaProbe,
  previousBytes: number,
  replacementBytes: number,
): void {
  if (Math.abs(previous.durationSeconds - replacement.durationSeconds) > 0.5) {
    throw new Error(
      `Replacement duration differs by more than 0.5s (${previous.durationSeconds.toFixed(3)}s vs ${replacement.durationSeconds.toFixed(3)}s)`,
    );
  }
  if (previous.width !== replacement.width || previous.height !== replacement.height) {
    throw new Error(
      `Replacement picture dimensions changed (${previous.width}x${previous.height} to ${replacement.width}x${replacement.height})`,
    );
  }
  if (previous.hasAudio && !replacement.hasAudio) {
    throw new Error("Replacement is missing the previous export's audio stream");
  }
  if (!Number.isSafeInteger(previousBytes) || previousBytes <= 0) {
    throw new Error("Previous export has no verifiable file size");
  }
  const minimumBytes = Math.max(32_768, Math.ceil(replacement.durationSeconds * 10_000));
  if (!Number.isSafeInteger(replacementBytes) || replacementBytes < minimumBytes) {
    throw new Error(`Replacement file is too small (${replacementBytes} bytes; minimum ${minimumBytes})`);
  }
  if (replacementBytes > MAX_RECLIP_BYTES) {
    throw new Error(`Replacement exceeds the 1.5 GB size limit (${replacementBytes} bytes)`);
  }
}

/**
 * Compare a locally rendered replacement with the currently published export.
 * The old file is streamed to a temporary file and never changed by validation.
 */
export async function validateCamera4kReclip(
  clipId: number,
  previousUrl: string,
  replacementPath: string,
): Promise<Camera4kReclipValidation> {
  if (!isBackupExportRef(previousUrl)
    && (!isBunnyStorageUrl(previousUrl) || !getPortfolioClipStoragePath(clipId, previousUrl))) {
    throw new Error("Previous export URL is not a trusted clip-storage object");
  }

  const oldPath = path.join(os.tmpdir(), `camera-4k-reclip-old-${randomUUID()}.mp4`);
  try {
    const response = await fetchExportObject(previousUrl, {
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Could not read the previous export (HTTP ${response.status})`);
    }
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      fs.createWriteStream(oldPath),
    );

    const [previous, replacement, previousStat, replacementStat] = await Promise.all([
      probeLocalMedia(oldPath),
      probeLocalMedia(replacementPath),
      fs.promises.stat(oldPath),
      fs.promises.stat(replacementPath),
    ]);
    assertCamera4kReclipMediaPair(previous, replacement, previousStat.size, replacementStat.size);
    await decodeLocalMedia(replacementPath);
    return {
      oldDurationSeconds: previous.durationSeconds,
      newDurationSeconds: replacement.durationSeconds,
      oldBytes: previousStat.size,
      newBytes: replacementStat.size,
      width: replacement.width,
      height: replacement.height,
      oldHasAudio: previous.hasAudio,
      newHasAudio: replacement.hasAudio,
      frameCount: replacement.frameCount,
    };
  } finally {
    cleanupTempFile(oldPath);
  }
}

export function assertCamera4kUploadedSize(
  expectedBytes: number,
  uploadedBytes: number | null,
): void {
  if (uploadedBytes === null || uploadedBytes !== expectedBytes) {
    throw new Error(
      `Uploaded file size could not be verified (${uploadedBytes ?? "unknown"} bytes; expected ${expectedBytes})`,
    );
  }
}
