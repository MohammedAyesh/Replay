import Hls from "hls.js";

/**
 * An explicit width ceiling is useful for controlled deployments, but playback
 * is otherwise allowed to use the complete ladder.  In particular, do not
 * default this to 1920: the current Bunny ladder contains a 3840-wide level.
 */
export const PLAYBACK_MAX_WIDTH: number | undefined = (() => {
  const value = import.meta.env?.VITE_PLAYBACK_MAX_WIDTH;
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
})();

export type HlsQualityLevel = {
  width?: number;
  height?: number;
  bitrate?: number;
  videoCodec?: string;
  frameRate?: number;
};

export type AllowedLevelOptions = {
  maxWidth?: number;
  mediaCapabilities?: MediaCapabilities;
};

/**
 * Return the original hls.js indexes that are suitable for this browser.
 *
 * The lowest level is always retained as a recovery rung, even when its
 * metadata is incomplete or the optional width override would exclude it.
 * A browser without MediaCapabilities is deliberately treated as capable:
 * hls.js/native decoding remains the source of truth in that case.
 */
export async function getAllowedHlsLevelIndexes(
  levels: readonly HlsQualityLevel[],
  options: AllowedLevelOptions = {},
): Promise<number[]> {
  if (levels.length === 0) return [];

  const mediaCapabilities = options.mediaCapabilities
    ?? (typeof navigator !== "undefined" ? navigator.mediaCapabilities : undefined);
  const canCheckDecoding = Boolean(mediaCapabilities?.decodingInfo);
  const maxWidth = options.maxWidth;
  const allowed: number[] = [];

  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    let supported = true;
    if (maxWidth != null && Number.isFinite(maxWidth) && (level.width ?? 0) > maxWidth) {
      supported = false;
    }
    if (supported && canCheckDecoding) {
      const codec = level.videoCodec || "avc1.4d401f";
      try {
        const info = await mediaCapabilities!.decodingInfo({
          type: "media-source",
          video: {
            contentType: `video/mp4; codecs="${codec}"`,
            width: level.width ?? 0,
            height: level.height ?? 0,
            bitrate: level.bitrate ?? 0,
            framerate: level.frameRate ?? 0,
          },
        });
        supported = info.supported && info.smooth;
      } catch {
        supported = false;
      }
    }
    if (supported) allowed.push(index);
  }

  // A lowest rung is better than an error screen, even if it failed the
  // optional capability/width check.
  if (!allowed.includes(0)) allowed.unshift(0);
  return allowed;
}

/**
 * Cap automatic ABR selection below a level that produced a fatal media
 * error.  Keeping level zero available lets hls.js recover on constrained
 * devices instead of immediately falling through to another source.
 */
export function capBelowFailedLevel(hls: Pick<Hls, "autoLevelCapping">, failedLevel: number): number {
  const belowFailed = Math.max(0, Math.floor(failedLevel) - 1);
  const cap = hls.autoLevelCapping >= 0
    ? Math.min(hls.autoLevelCapping, belowFailed)
    : belowFailed;
  hls.autoLevelCapping = cap;
  return cap;
}

/**
 * Apply the capability/optional deployment cap to an hls.js instance.
 *
 * The work is asynchronous because decodingInfo is asynchronous.  Callers do
 * not need to await this function; the manifest event is the synchronization
 * point.  ABR remains enabled and starts in automatic mode throughout.
 */
export function capPlaybackQuality(hls: Hls, maxWidth = PLAYBACK_MAX_WIDTH): void {
  hls.startLevel = -1;

  const apply = () => {
    void getAllowedHlsLevelIndexes(hls.levels, {
      maxWidth,
    }).then((allowed) => {
      if (allowed.length === 0 || allowed.length === hls.levels.length) {
        if (hls.autoLevelCapping < 0) hls.autoLevelCapping = -1;
        hls.startLevel = -1;
        return;
      }
      const allowedCap = Math.max(...allowed);
      hls.autoLevelCapping = hls.autoLevelCapping >= 0
        ? Math.min(hls.autoLevelCapping, allowedCap)
        : allowedCap;
      hls.startLevel = -1;
    });
  };

  hls.on(Hls.Events.MANIFEST_PARSED, apply);
  apply();
}