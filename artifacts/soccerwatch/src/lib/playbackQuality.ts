import Hls from "hls.js";

export const DEFAULT_MAX_PLAYBACK_WIDTH = 1920;

/**
 * Build-time ceiling for automatic playback selection.
 *
 * Safari and iOS commonly report hls.js as unsupported and use native HLS
 * instead. Native browser ABR cannot be capped from JavaScript, so those
 * clients remain governed by the server-published ladder.
 */
const configuredMaxWidth = Number(import.meta.env.VITE_MAX_PLAYBACK_WIDTH);
export const MAX_PLAYBACK_WIDTH =
  Number.isFinite(configuredMaxWidth) && configuredMaxWidth > 0
    ? configuredMaxWidth
    : DEFAULT_MAX_PLAYBACK_WIDTH;

export type PlaybackLevel = {
  width?: number | null;
};

/**
 * Return the highest level index whose declared frame width is within the
 * pixel ceiling. Unknown and zero-width levels are deliberately ignored.
 *
 * -1 is hls.js's "no automatic cap" value. If no known level is within the
 * ceiling, leaving playback uncapped is safer than refusing playback or
 * pinning it to a rung that does not exist. This is currently expected for
 * recent videos that publish only one 3840x1080 level.
 */
export function getPlaybackQualityCapIndex(
  levels: ReadonlyArray<PlaybackLevel>,
  maxWidth = MAX_PLAYBACK_WIDTH,
): number {
  let capIndex = -1;
  for (const [index, level] of levels.entries()) {
    const width = level.width;
    if (
      typeof width === "number" &&
      Number.isFinite(width) &&
      width > 0 &&
      width <= maxWidth
    ) {
      capIndex = index;
    }
  }
  return capIndex;
}

/**
 * Apply the ceiling only to hls.js automatic selection. A manual
 * `currentLevel` choice remains a deliberate request and is not overridden.
 *
 * The current ladder's 3840x1080 and 1920x540 variants are both around the
 * same bitrate target, so this mechanism saves little today. It is still
 * important because future per-rung bitrate targets, and older 25.9 Mbps
 * rungs, must not reach free viewers by automatic selection.
 */
export function applyPlaybackQualityCeiling(
  hls: Pick<Hls, "levels" | "autoLevelCapping">,
  maxWidth = MAX_PLAYBACK_WIDTH,
): number {
  const capIndex = getPlaybackQualityCapIndex(hls.levels, maxWidth);
  hls.autoLevelCapping = capIndex;
  return capIndex;
}

/**
 * Keep the automatic ceiling in sync with the parsed and updated ladder.
 * hls.js destroys its event listeners with the player, so callers only need
 * to invoke this once immediately after constructing the instance.
 */
export function installPlaybackQualityCeiling(hls: Hls): void {
  const apply = () => {
    applyPlaybackQualityCeiling(hls);
  };

  hls.on(Hls.Events.MANIFEST_PARSED, apply);
  hls.on(Hls.Events.LEVELS_UPDATED, apply);
  hls.on(Hls.Events.LEVEL_SWITCHED, apply);
}