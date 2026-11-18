import { logger } from "./logger";
import {
  getUhdPlaylist,
  normalizeUhdVideoGuid,
  storageH264Or4kSource,
  UhdPlaylistRequestError,
  uhdPlaylistUrl,
  type H264Or4kStorageSource,
} from "./uhdPlayback";
import { hlsPlaylistDuration, parseHlsByteRangePlan } from "./uhdHlsRanges";

export type Camera4kExportSource = {
  kind: "camera-4k";
  url: string;
  playlist: string;
  path: "camera-original-H.264-or-4K HLS";
  duration: number;
  renditionLabel: null;
  rendition: "h264" | "4k";
};

export class Camera4kNotReadyError extends Error {
  constructor(readonly videoId: string, readonly waitedMs: number) {
    super(`Camera 4K original was not published within ${Math.round(waitedMs / 1000)} seconds`);
    this.name = "Camera4kNotReadyError";
  }
}

const SOURCE_WAIT_MS = 45 * 60_000;
const SOURCE_POLL_MS = 30_000;

/**
 * Wait for the camera-original fMP4 playlist. Prefer H.264 and use 4K only
 * when H.264 is missing. Clip files must never fall back to Bunny Stream.
 */
export async function waitForCamera4kSource(
  videoId: string,
  dependencies: {
    getSource?: (videoId: string) => Promise<H264Or4kStorageSource | null>;
    /** Legacy test seam for a 4K-only source. */
    getPlaylist?: typeof getUhdPlaylist;
    buildPlaylistUrl?: typeof uhdPlaylistUrl;
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onWaiting?: (elapsedMs: number, timeoutMs: number) => void;
  } = {},
): Promise<Camera4kExportSource> {
  const guid = normalizeUhdVideoGuid(videoId);
  if (!guid) throw new Error(`No camera 4K source is available for video ${videoId}`);

  const buildPlaylistUrl = dependencies.buildPlaylistUrl ?? uhdPlaylistUrl;
  const getSource = dependencies.getSource ?? (dependencies.getPlaylist
    ? async (sourceId) => {
      const playlist = await dependencies.getPlaylist!(sourceId);
      return playlist
        ? { videoGuid: guid, rendition: "4k" as const, url: buildPlaylistUrl(guid), playlist }
        : null;
    }
    : storageH264Or4kSource);
  const timeoutMs = Math.max(0, dependencies.timeoutMs ?? SOURCE_WAIT_MS);
  const pollIntervalMs = Math.max(1, dependencies.pollIntervalMs ?? SOURCE_POLL_MS);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  while (true) {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= timeoutMs) throw new Camera4kNotReadyError(guid, elapsedMs);

    try {
      const source = await getSource(guid);
      if (source) {
        const duration = hlsPlaylistDuration(source.playlist);
        // Validate that this is the byte-ranged fMP4 form the exporter assembles.
        parseHlsByteRangePlan(source.playlist, source.url, 0, Math.min(duration, 1), {
          prerollSeconds: 0,
          postrollSeconds: 0,
        });
        return {
          kind: "camera-4k",
          url: source.url,
          playlist: source.playlist,
          path: "camera-original-H.264-or-4K HLS",
          duration,
          renditionLabel: null,
          rendition: source.rendition,
        };
      }
    } catch (err) {
      if (
        err instanceof UhdPlaylistRequestError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 404 &&
        err.status !== 410 &&
        err.status !== 429
      ) {
        throw err;
      }
      logger.warn(
        { err, videoId: guid, elapsedMs },
        "Camera 4K source is not ready — keeping the clip pending",
      );
    }

    const remainingMs = timeoutMs - Math.max(0, now() - startedAt);
    if (remainingMs <= 0) {
      throw new Camera4kNotReadyError(guid, Math.max(0, now() - startedAt));
    }
    dependencies.onWaiting?.(Math.max(0, now() - startedAt), timeoutMs);
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}
