import { logger } from "./logger";
import type { ExportSource } from "./exportSource";
import { getUhdPlaylist, uhdPlaylistUrl } from "./uhdPlayback";

export const CAMERA_EXPORT_WIDTH = 4096;
export const CAMERA_EXPORT_HEIGHT = 1152;

export type ClipExportSource =
  | (ExportSource & { kind: "stream" })
  | {
      kind: "camera-4k";
      url: string;
      path: "camera-original-4k HLS";
      width: typeof CAMERA_EXPORT_WIDTH;
      height: typeof CAMERA_EXPORT_HEIGHT;
      renditionLabel: null;
    };

/** Select camera 4K only after the same cached playlist check used by playback. */
export async function selectClipExportSource(
  videoId: string,
  streamSource: ExportSource,
): Promise<ClipExportSource> {
  try {
    if (await getUhdPlaylist(videoId)) {
      return {
        kind: "camera-4k",
        url: uhdPlaylistUrl(videoId),
        path: "camera-original-4k HLS",
        width: CAMERA_EXPORT_WIDTH,
        height: CAMERA_EXPORT_HEIGHT,
        renditionLabel: null,
      };
    }
  } catch (err) {
    logger.warn({ err, videoId }, "Camera 4K playlist check failed — using Bunny Stream");
  }
  return { ...streamSource, kind: "stream" };
}

/**
 * A failed 4K buffer, geometry probe, or encode gets one complete retry from
 * Stream before the caller can hand the export to its backup renderer.
 */
export async function renderWithStreamFallback<T>(
  preferred: ClipExportSource,
  streamSource: ClipExportSource,
  render: (source: ClipExportSource) => Promise<T>,
): Promise<{ result: T; source: ClipExportSource }> {
  try {
    return { result: await render(preferred), source: preferred };
  } catch (err) {
    if (preferred.kind !== "camera-4k") throw err;
    logger.error(
      { err, videoId: preferred.url },
      "Camera 4K clip export failed — retrying from Bunny Stream",
    );
    return { result: await render(streamSource), source: streamSource };
  }
}
