import { logger } from "./logger";
import {
  getUhdPlaylist,
  normalizeUhdVideoGuid,
  UhdPlaylistRequestError,
  uhdPlaylistUrl,
} from "./uhdPlayback";
import { hlsPlaylistDuration, parseHlsByteRangePlan } from "./uhdHlsRanges";

export type Camera4kExportSource = {
  kind: "camera-4k";
  url: string;
  playlist: string;
  path: "camera-original-4k HLS";
  duration: number;
  renditionLabel: null;
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
 * Wait for the camera-original fMP4 playlist. Clip files must never fall back
 * to a Bunny Stream rendition, including after a transient 4K fetch failure.
 */
export async function waitForCamera4kSource(
  videoId: string,
  dependencies: {
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

  const getPlaylist = dependencies.getPlaylist ?? getUhdPlaylist;
  const buildPlaylistUrl = dependencies.buildPlaylistUrl ?? uhdPlaylistUrl;
  const timeoutMs = Math.max(0, dependencies.timeoutMs ?? SOURCE_WAIT_MS);
  const pollIntervalMs = Math.max(1, dependencies.pollIntervalMs ?? SOURCE_POLL_MS);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  while (true) {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= timeoutMs) throw new Camera4kNotReadyError(guid, elapsedMs);

    const url = buildPlaylistUrl(guid);
    try {
      const playlist = await getPlaylist(guid);
      if (playlist) {
        const duration = hlsPlaylistDuration(playlist);
        // Validate that this is the byte-ranged fMP4 form the exporter assembles.
        parseHlsByteRangePlan(playlist, url, 0, Math.min(duration, 1), {
          prerollSeconds: 0,
          postrollSeconds: 0,
        });
        return {
          kind: "camera-4k",
          url,
          playlist,
          path: "camera-original-4k HLS",
          duration,
          renditionLabel: null,
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
