import { logger } from "./logger";
import { BUNNY_CDN_HOSTNAME, getBunnyDirectMp4Url, getBunnyPlaybackUrl } from "./bunny";

/**
 * Geometry of the rendition every export is calculated against.
 *
 * The camera records 4096x1152. Bunny Stream downscales that and
 * `KeepOriginalFiles` is false, so 4096 never leaves Bunny and nothing
 * downstream can ask for it. 3840x1080 is the real source geometry for crop
 * maths, and these two numbers are correct as they stand — they are NOT a bug
 * to be "fixed" up to 4096x1152.
 *
 * The danger runs the other way. Every crop keyframe is stored as a fraction of
 * the frame and multiplied by these constants to get pixels. Hand the exporter a
 * different rendition and the multiplication still succeeds and still produces a
 * plausible-looking crop rectangle — just the wrong one, at half scale,
 * silently, on every clip. There is no runtime symptom until somebody watches a
 * clip framed on the wrong part of the pitch.
 */
export const EXPORT_SOURCE_WIDTH = 3840;
export const EXPORT_SOURCE_HEIGHT = 1080;

/**
 * WHY THIS MODULE MATCHES ON RESOLUTION AND NOT ON A RENDITION NAME.
 *
 * The obvious implementation is to pin the export to the "2160p" rendition and
 * be done. That is wrong on this content, and the reason is worth writing down
 * because it is not guessable and it silently breaks either way you get it
 * wrong.
 *
 * Measured against library 694315 on 2026-09-04, two real videos:
 *
 *   cam1_2026-08-31_22:00   availableResolutions = "1080p"
 *     master playlist: RESOLUTION=3840x1080 -> 1080p/video.m3u8
 *     ffprobe 1080p/video.m3u8  ->  3840x1080
 *     2160p/video.m3u8          ->  HTTP 404
 *
 *   cam1_2026-08-22_01:00   availableResolutions = "1080p,2160p"
 *     master playlist: RESOLUTION=1920x540  -> 1080p/video.m3u8
 *                      RESOLUTION=3840x1080 -> 2160p/video.m3u8
 *     ffprobe 1080p/video.m3u8  ->  1920x540
 *     ffprobe 2160p/video.m3u8  ->  3840x1080
 *
 * The label "1080p" denotes 3840x1080 on the first video and 1920x540 on the
 * second. A rendition label on this source is a position in whatever ladder
 * Bunny happened to produce for that one video, not a statement about pixels —
 * the library has ScaleVideoUsingBothDimensions=false, so Bunny scales by height
 * and skips any rung it would have to upscale to, and which rungs survive
 * depends on the source geometry of that particular upload.
 *
 * So:
 *   - pinning to "2160p" breaks every video encoded since 2026-08-23 (404);
 *   - pinning to "highest label" happens to work today, but is one ladder
 *     change away from resolving to something that is not 3840x1080;
 *   - falling back to the master playlist is actively wrong today — FFmpeg's
 *     default stream selection on the second video above picks 1920x540.
 *
 * The only stable identifier is the geometry the playlist itself declares. This
 * module reads RESOLUTION out of the master playlist, picks the variant that
 * declares exactly EXPORT_SOURCE_WIDTH x EXPORT_SOURCE_HEIGHT, and refuses the
 * export if no variant does. That is correct before A2 adds a 480p rung, after
 * it, and after any future ladder change, without another edit here.
 */
export const EXPORT_SOURCE_LABEL = `${EXPORT_SOURCE_WIDTH}x${EXPORT_SOURCE_HEIGHT}`;

/**
 * Raised when no variant of the required geometry can be resolved.
 *
 * A distinct type so callers can tell "this video is not exportable" apart from
 * a transport failure, and so the message that reaches the logs names the
 * geometry rather than surfacing as a generic FFmpeg error 40 lines later.
 */
export class ExportSourceUnavailableError extends Error {
  readonly videoId: string;
  readonly availableResolutions: string;
  readonly variantsSeen: readonly HlsVariant[];

  constructor(
    videoId: string,
    availableResolutions: string,
    detail: string,
    variantsSeen: readonly HlsVariant[] = [],
  ) {
    const seen = variantsSeen.length
      ? variantsSeen.map((v) => `${v.width}x${v.height} (${v.uri})`).join(", ")
      : "none";
    super(
      `Export source unavailable for video ${videoId}: ${detail}. ` +
        `The exporter requires a variant declaring exactly ${EXPORT_SOURCE_LABEL} and will ` +
        `not fall back to another rendition or to the master playlist, because every crop ` +
        `calculation is scaled to that geometry. ` +
        `variants=[${seen}] availableResolutions=${JSON.stringify(availableResolutions)}`,
    );
    this.name = "ExportSourceUnavailableError";
    this.videoId = videoId;
    this.availableResolutions = availableResolutions;
    this.variantsSeen = variantsSeen;
  }
}

export type ExportSourcePath =
  | "HEAD-verified direct MP4"
  | "resolution-matched HLS variant";

export interface HlsVariant {
  width: number;
  height: number;
  /** Variant playlist URI exactly as the master playlist wrote it. */
  uri: string;
  /**
   * Bunny's rendition folder name for this variant ("1080p", "2160p"), taken
   * from the URI rather than assumed. Used only to build the direct-MP4 URL.
   */
  label: string | null;
  bandwidth: number | null;
}

/**
 * Parse `#EXT-X-STREAM-INF` entries out of an HLS master playlist.
 *
 * Attribute order is not fixed — Bunny emits RESOLUTION last on some videos and
 * mid-list on others (both forms appear in the measurements above) — so this
 * matches the attribute by name and never by position.
 */
export function parseMasterPlaylist(body: string): HlsVariant[] {
  const lines = body.split(/\r?\n/);
  const variants: HlsVariant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attrs = line.slice("#EXT-X-STREAM-INF:".length);
    const res = /(?:^|,)RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
    const bw = /(?:^|,)BANDWIDTH=(\d+)/i.exec(attrs);

    // The URI is the next non-blank, non-comment line. Bunny emits a blank line
    // between the tag and the URI on some videos, so "i + 1" is not safe.
    let uri: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]?.trim() ?? "";
      if (!candidate) continue;
      if (candidate.startsWith("#")) break;
      uri = candidate;
      break;
    }
    if (!uri || !res) continue;

    const label = uri.includes("/") ? (uri.split("/")[0] || null) : null;
    variants.push({
      width: Number.parseInt(res[1]!, 10),
      height: Number.parseInt(res[2]!, 10),
      uri,
      label,
      bandwidth: bw ? Number.parseInt(bw[1]!, 10) : null,
    });
  }
  return variants;
}

/** A media playlist Bunny actually served, as opposed to an error page. */
function looksLikePlaylist(body: string): boolean {
  return body.trimStart().startsWith("#EXTM3U");
}

export interface ExportSource {
  url: string;
  path: ExportSourcePath;
  width: number;
  height: number;
  /** Bunny's folder name for the chosen rung, for logs only. Never branch on it. */
  renditionLabel: string | null;
}

/**
 * Resolve the export source for a video, pinned by declared resolution.
 *
 * Reads the master playlist, selects the variant declaring exactly
 * EXPORT_SOURCE_WIDTH x EXPORT_SOURCE_HEIGHT, verifies it over the network, and
 * returns its absolute URL. Throws ExportSourceUnavailableError if no such
 * variant exists. The master playlist URL itself is never returned.
 *
 * The Stream pull zone rejects requests with no Referer (measured: 403), so the
 * caller passes one; https://iframe.mediadelivery.net/, https://replayjo.com/
 * and the CDN origin itself all measured 200.
 */
export async function selectExportSource(options: {
  videoId: string;
  hasMP4Fallback: boolean;
  availableResolutions: string;
  referer: string;
}): Promise<ExportSource> {
  const { videoId, hasMP4Fallback, availableResolutions, referer } = options;
  const masterUrl = getBunnyPlaybackUrl(videoId);

  let masterBody: string;
  try {
    const response = await fetch(masterUrl, { headers: { Referer: referer } });
    masterBody = await response.text();
    if (!response.ok || !looksLikePlaylist(masterBody)) {
      throw new ExportSourceUnavailableError(
        videoId,
        availableResolutions,
        `master playlist HTTP ${response.status}` +
          (response.ok ? " but the body was not an HLS playlist" : ""),
      );
    }
  } catch (err) {
    if (err instanceof ExportSourceUnavailableError) throw err;
    throw new ExportSourceUnavailableError(
      videoId,
      availableResolutions,
      `master playlist fetch failed: ${(err as Error).message}`,
    );
  }

  const variants = parseMasterPlaylist(masterBody);
  const match = variants.find(
    (v) => v.width === EXPORT_SOURCE_WIDTH && v.height === EXPORT_SOURCE_HEIGHT,
  );

  if (!match) {
    throw new ExportSourceUnavailableError(
      videoId,
      availableResolutions,
      `no variant declares ${EXPORT_SOURCE_LABEL}`,
      variants,
    );
  }

  // Direct MP4 is preferred where it exists because seeking a plain MP4 is
  // cheaper than seeking HLS. It is addressed by rendition folder name, so the
  // name is taken from the matched variant's own URI — never assumed — and the
  // result is HEAD-verified before use.
  //
  // (Library 694315 has EnableMP4Fallback=false as of 2026-09-04, so in practice
  // this branch does not run there. It is kept because the flag is a per-library
  // setting somebody may reasonably turn on.)
  if (hasMP4Fallback && match.label) {
    const height = Number.parseInt(match.label.replace(/p$/i, ""), 10);
    if (Number.isFinite(height) && height > 0) {
      const directUrl = getBunnyDirectMp4Url(videoId, height);
      try {
        const response = await fetch(directUrl, {
          method: "HEAD",
          headers: { Referer: referer },
        });
        if (response.status === 200 || response.status === 206) {
          logger.info(
            { videoId, directUrl, ...pick(match) },
            "Export source pinned to direct MP4 of the resolution-matched rendition",
          );
          return {
            url: directUrl,
            path: "HEAD-verified direct MP4",
            width: match.width,
            height: match.height,
            renditionLabel: match.label,
          };
        }
        logger.warn(
          { videoId, directUrl, status: response.status },
          "Direct MP4 not available; using the resolution-matched HLS variant",
        );
      } catch (err) {
        logger.warn(
          { err, videoId, directUrl },
          "Direct MP4 check errored; using the resolution-matched HLS variant",
        );
      }
    }
  }

  const variantUrl = new URL(match.uri, masterUrl).toString();
  try {
    const response = await fetch(variantUrl, { headers: { Referer: referer } });
    const body = await response.text();
    if (!response.ok || !looksLikePlaylist(body)) {
      throw new ExportSourceUnavailableError(
        videoId,
        availableResolutions,
        `variant ${match.uri} declared ${EXPORT_SOURCE_LABEL} but returned HTTP ${response.status}` +
          (response.ok ? " with a non-playlist body" : ""),
        variants,
      );
    }
  } catch (err) {
    if (err instanceof ExportSourceUnavailableError) throw err;
    throw new ExportSourceUnavailableError(
      videoId,
      availableResolutions,
      `variant ${match.uri} fetch failed: ${(err as Error).message}`,
      variants,
    );
  }

  logger.info(
    { videoId, variantUrl, ...pick(match) },
    "Export source pinned to resolution-matched HLS variant",
  );
  return {
    url: variantUrl,
    path: "resolution-matched HLS variant",
    width: match.width,
    height: match.height,
    renditionLabel: match.label,
  };
}

function pick(v: HlsVariant) {
  return { width: v.width, height: v.height, renditionLabel: v.label };
}
