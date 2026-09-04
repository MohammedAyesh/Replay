import Hls from "hls.js";

/**
 * Playback quality ceiling.
 *
 * WHY THIS EXISTS
 *
 * Delivery is the largest variable cost in the business, and ABR left alone
 * always climbs to the top rung. Measured against library 694315 on 2026-09-04
 * by sampling real segments:
 *
 *   rendition folder   declared        measured    per footage-hour
 *   1080p (new videos) 3840x1080        7.57 Mbps   3.41 GB
 *   1080p (old videos) 1920x540         7.29 Mbps   3.28 GB
 *   2160p (old videos) 3840x1080       25.90 Mbps  11.65 GB
 *
 * Two things follow, and both are counter-intuitive enough to be worth stating.
 *
 * First, the rendition FOLDER NAME does not tell you the geometry: "1080p" is
 * 3840x1080 on videos encoded after 2026-08-22 and 1920x540 on videos encoded
 * before it. So a ceiling can only be expressed in pixels, never in a label.
 *
 * Second, on the ladder as it stands today the middle rung is NOT meaningfully
 * cheaper — 7.29 vs 7.57 Mbps is a 4% saving, not the order of magnitude the
 * bitrate ladder implies, because both rungs are pinned to the same
 * Bitrate1080p=5000 target and overshoot it similarly. Capping only pays once
 * the library's per-rung bitrate targets are set apart (see the A2 decision).
 *
 * So this module is deliberately a mechanism, not a saving. It makes the
 * ceiling exist and be enforced so that the moment a genuinely cheaper middle
 * rung is published, playback uses it without another code change — and so that
 * a 25.9 Mbps rung can never be served to a free viewer by accident.
 */

/**
 * Widest frame ordinary playback may select, in pixels.
 *
 * Expressed as a width because the content is a 3.55:1 panorama: matching on
 * height would put 3840x1080 and 1920x540 in the wrong order relative to any
 * conventional 16:9 rung.
 */
export const PLAYBACK_MAX_WIDTH = Number(
  import.meta.env?.VITE_PLAYBACK_MAX_WIDTH ?? 1920,
);

/**
 * Apply the playback ceiling to an hls.js instance.
 *
 * Call this immediately after `new Hls(...)`, before or after `loadSource` —
 * it binds to MANIFEST_PARSED and also applies straight away if levels are
 * already known.
 *
 * Behaviour worth knowing:
 *
 * - If NO level is at or below the ceiling, no cap is applied. A ladder with a
 *   single 3840x1080 rung — which is exactly today's state for new videos —
 *   must still play. Refusing to play is never the better failure.
 * - The cap bounds automatic selection only (`autoLevelCapping`). A manual
 *   quality picker, where one exists, can still select above it; that is a
 *   deliberate user choice rather than ABR spending money on its own.
 * - Native HLS (Safari/iOS, where `Hls.isSupported()` is false) does its own
 *   ABR and cannot be capped from JavaScript. Those clients are uncapped. The
 *   only server-side lever there is the ladder itself.
 */
export function capPlaybackQuality(hls: Hls, maxWidth = PLAYBACK_MAX_WIDTH): void {
  const apply = () => {
    const levels = hls.levels;
    if (!levels || levels.length === 0) return;

    let capIndex = -1;
    for (let i = 0; i < levels.length; i++) {
      const w = levels[i]?.width ?? 0;
      // Levels are ordered ascending by bitrate; take the highest index whose
      // width is within the ceiling. Width 0 means the manifest omitted
      // RESOLUTION — treat that as unknown and do not let it raise the cap.
      if (w > 0 && w <= maxWidth) capIndex = i;
    }

    // No rung fits under the ceiling: leave ABR alone rather than pinning the
    // viewer to a rung that does not exist.
    hls.autoLevelCapping = capIndex;
  };

  hls.on(Hls.Events.MANIFEST_PARSED, apply);
  hls.on(Hls.Events.LEVEL_SWITCHED, apply);
  apply();
}
