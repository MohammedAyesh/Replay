import { createHash } from "node:crypto";
import fs from "node:fs";
import { probeVideoDimensions, probeVideoTiming } from "./ffmpegExport";

export function saveRenderSnapshotBestEffort(
  save: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  void Promise.resolve()
    .then(save)
    .catch((error) => {
      try { onError(error); } catch { /* snapshot logging must not affect the render */ }
    });
}

export async function withRenderSnapshotTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = 2500,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(operation);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Snapshot asset storage exceeded ${timeoutMs}ms.`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function inspectRenderedPng(bytes: Buffer): {
  sha256: string;
  width: number;
  height: number;
  durationMs: null;
} {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Rendered still is not a valid PNG.");
  }
  return {
    sha256: sha256Buffer(bytes),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    durationMs: null,
  };
}

export async function inspectRenderedVideo(filePath: string): Promise<{
  sha256: string;
  width: number;
  height: number;
  durationMs: number | null;
}> {
  const [sha256, dimensions, timing] = await Promise.all([
    sha256File(filePath),
    probeVideoDimensions(filePath),
    probeVideoTiming(filePath).catch(() => null),
  ]);
  return {
    sha256,
    width: dimensions.width,
    height: dimensions.height,
    durationMs: timing?.duration == null ? null : Math.round(timing.duration * 1000),
  };
}

/** Content-addressed branding URLs use a 40-hex SHA-256 prefix in the path. */
export function contentAddressedHashPrefix(locator: string | null | undefined): string | null {
  if (!locator) return null;
  return /\/([0-9a-f]{40})\.[a-z0-9]+(?:[?#].*)?$/i.exec(locator)?.[1]?.toLowerCase() ?? null;
}
