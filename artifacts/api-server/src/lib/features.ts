/**
 * CLIP_INTRO_ENABLED — set to "true" to re-enable the branding intro that plays before clips.
 *
 * Why it is off by default: the intro is stored on Bunny Storage, which is an
 * authenticated origin, so the browser cannot fetch it directly and every playback
 * had to stream the whole intro file through the API server first. This caused a
 * several-second black screen before the clip started with no visible controls,
 * making it look like the clip was broken. Doing this properly means serving a
 * short, pre-encoded intro from a public CDN pull zone, preloading it while the
 * clip's own stream is being prepared, and never blocking the clip on it.
 *
 * To re-enable: set CLIP_INTRO_ENABLED=true in the server environment and restart.
 */
export const INTRO_ENABLED = process.env.CLIP_INTRO_ENABLED === "true";
