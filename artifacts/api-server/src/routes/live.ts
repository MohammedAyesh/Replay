import { Router, type IRouter } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { logger } from "../lib/logger";
import { describeLive, formatAge, parseLiveManifest, type LiveStatus } from "../lib/liveManifest";

const router: IRouter = Router();

/**
 * Live playback.
 *
 * THE VPS SIDE WAS ALREADY BUILT FOR THIS AND THE APP WAS NOT USING IT.
 *
 * `livehttp.py` on vps1 serves the HLS trees with `Access-Control-Allow-Origin:
 * *`, `Cache-Control: public, max-age=1` on playlists and `immutable` on
 * segments, over HTTP/1.1 keep-alive — every one of those is there so a CDN can
 * sit in front of it, and its own comments say so. The Bunny pull zone
 * `livejordangalaxy` fronts it and answers 200.
 *
 * This module used to point at `http://169.58.73.17:8088` and relay every
 * segment through `res.send(Buffer.from(await upstream.arrayBuffer()))`. So the
 * CDN was bypassed, the VPS served one copy per viewer rather than one copy per
 * segment, and a 1.5–4 MB buffer was allocated per viewer per four seconds in
 * the API process.
 *
 * Now the app hands the browser a CDN URL and gets out of the byte path. What
 * it keeps is the thing only it can do: telling the client whether there is
 * anything to watch.
 */

/** Where viewers fetch from. The pull zone, not the origin. */
const CDN_BASE = (process.env.LIVE_CDN_BASE || "https://livejordangalaxy.b-cdn.net").replace(/\/$/, "");
/**
 * The origin, used only for the health read. Deliberately not the CDN: a
 * `max-age=1` playlist read through the edge can be a second stale, which is
 * irrelevant for playback and confusing in a freshness check.
 */
const ORIGIN_BASE = (process.env.LIVE_ORIGIN_BASE || "http://169.58.73.17:8088").replace(/\/$/, "");

/**
 * Two renditions exist per camera on the VPS: `hls` is transcoded H.264,
 * `hevc` is a stream copy that costs about a fortieth of the CPU. Only `hls`
 * plays everywhere, so it stays the default; `hevc` is selectable because it
 * exists and someone will want to compare them on a running match, which is
 * what it was built for.
 */
const VARIANTS = ["hls", "hevc"] as const;
export type LiveVariant = (typeof VARIANTS)[number];
const isVariant = (v: string): v is LiveVariant => (VARIANTS as readonly string[]).includes(v);

/**
 * camera1/camera2 in the API map to cam1/cam2 on disk. Kept as an explicit
 * allowlist rather than a pattern: these names are interpolated into a URL
 * path, and an allowlist is the shortest correct answer to that.
 */
const CAMERAS = (process.env.LIVE_CAMERAS || "camera1:cam1,camera2:cam2")
  .split(",")
  .map((pair) => pair.split(":"))
  .filter((parts): parts is [string, string] => parts.length === 2 && !!parts[0] && !!parts[1]);
const UPSTREAM = new Map(CAMERAS.map(([api, disk]) => [api, disk]));

/** A segment file name only: no slashes, no dot-segments. */
const SEGMENT_NAME_RE = /^[A-Za-z0-9_-]+\.(ts|m4s|mp4)$/;

function variantOf(req: { query: Record<string, unknown> }): LiveVariant {
  const raw = typeof req.query.variant === "string" ? req.query.variant : "";
  return isVariant(raw) ? raw : "hls";
}

export function playlistUrl(base: string, disk: string, variant: LiveVariant): string {
  return `${base}/${disk}/${variant}/live.m3u8`;
}

/**
 * GET /api/live/:camera/source
 *
 * Where to play from, and whether there is anything there. The second half is
 * the point: when no camera is pushing, the origin keeps serving the playlist
 * it last wrote, so the fetch succeeds and the player attaches to a stream
 * whose newest frame is days old. cam1 sat in exactly that state for four days.
 * A 200 is not evidence of a live stream.
 */
router.get("/live/:camera/source", async (req, res): Promise<void> => {
  const camera = String(req.params.camera);
  const disk = UPSTREAM.get(camera);
  if (!disk) { res.status(404).json({ error: "Unknown camera" }); return; }
  const variant = variantOf(req);

  let status: LiveStatus | null = null;
  try {
    const upstream = await fetch(playlistUrl(ORIGIN_BASE, disk, variant), {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (upstream.ok) {
      status = describeLive(parseLiveManifest(await upstream.text()), new Date());
    } else if (upstream.status !== 404) {
      logger.warn({ camera, variant, status: upstream.status }, "Live origin returned an error");
    }
  } catch (err) {
    // Unreachable origin is reported as "cannot tell", not as "not live": the
    // CDN may still be serving cached segments perfectly well.
    logger.warn({ camera, variant, err }, "Could not read the live playlist from the origin");
  }

  res.set("Cache-Control", "no-store");
  res.json({
    camera,
    variant,
    url: playlistUrl(CDN_BASE, disk, variant),
    /** The same stream through this server, for a client that cannot reach the CDN. */
    proxyUrl: `/api/live/${camera}/index.m3u8?variant=${variant}`,
    status: status ?? { live: false, reason: "unreachable", dvrSeconds: 0, behindSeconds: null, liveEdgeAt: null, segmentCount: 0 },
    message: status && !status.live
      ? status.reason === "stale" && status.behindSeconds !== null
        ? `No live feed — the last frame arrived ${formatAge(status.behindSeconds)}.`
        : status.reason === "empty"
          ? "No live feed — the camera has not pushed anything yet."
          : status.reason === "ended"
            ? "This stream has finished."
            : "No live feed."
      : null,
  });
});

/** GET /api/live/:camera/status — the health half on its own, for the console. */
router.get("/live/:camera/status", async (req, res): Promise<void> => {
  const camera = String(req.params.camera);
  const disk = UPSTREAM.get(camera);
  if (!disk) { res.status(404).json({ error: "Unknown camera" }); return; }
  const variant = variantOf(req);
  try {
    const upstream = await fetch(playlistUrl(ORIGIN_BASE, disk, variant), {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!upstream.ok) { res.status(502).json({ error: `Origin returned ${upstream.status}` }); return; }
    res.set("Cache-Control", "no-store");
    res.json(describeLive(parseLiveManifest(await upstream.text()), new Date()));
  } catch {
    res.status(504).json({ error: "Could not reach the live origin" });
  }
});

export function rewriteLiveManifest(manifest: string, camera: string, variant: LiveVariant): string {
  return manifest.replace(
    /^([A-Za-z0-9_-]+\.(?:ts|m4s|mp4))(\r?)$/gm,
    (_line, segment: string, cr: string) => `/api/live/${camera}/${segment}?variant=${variant}${cr}`,
  );
}

/**
 * GET /api/live/:camera/index.m3u8
 *
 * The fallback path, for a client that cannot reach the CDN directly. Kept
 * because it costs little and the alternative is a viewer with no picture, but
 * it is not the route anyone should be on: every byte crosses this process.
 */
router.get("/live/:camera/index.m3u8", async (req, res): Promise<void> => {
  const camera = String(req.params.camera);
  const disk = UPSTREAM.get(camera);
  if (!disk) { res.status(400).send("Invalid camera"); return; }
  const variant = variantOf(req);

  try {
    const upstream = await fetch(playlistUrl(CDN_BASE, disk, variant), {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!upstream.ok) { res.status(upstream.status).send("Stream unavailable"); return; }
    // Rewrite only bare segment names. Tag lines, EXT-X-PROGRAM-DATE-TIME above
    // all, are never touched: VAR reads wall-clock out of them.
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-store");
    res.send(rewriteLiveManifest(await upstream.text(), camera, variant));
  } catch {
    res.status(503).send("Stream unavailable");
  }
});

/**
 * GET /api/live/:camera/:segment
 *
 * Streamed, not buffered. The previous version did
 * `res.send(Buffer.from(await upstream.arrayBuffer()))`, which allocates the
 * whole segment — 1.5 to 4 MB — per viewer per four seconds.
 */
router.get("/live/:camera/:segment", async (req, res): Promise<void> => {
  const camera = String(req.params.camera);
  const segment = String(req.params.segment);
  const disk = UPSTREAM.get(camera);

  // Express decodes %2e%2f before this sees it, so an endsWith check alone
  // still admits "../../other.ts". Match the shape exactly instead.
  if (!disk || !SEGMENT_NAME_RE.test(segment)) { res.status(400).send("Invalid request"); return; }
  const variant = variantOf(req);

  try {
    const upstream = await fetch(`${CDN_BASE}/${disk}/${variant}/${segment}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok || !upstream.body) { res.status(upstream.status || 502).send("Segment unavailable"); return; }
    res.set("Content-Type", segment.endsWith(".ts") ? "video/mp2t" : "video/mp4");
    // Segment names are never reused, so this is safe to cache hard — the same
    // reasoning livehttp.py applies at the origin.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    const length = upstream.headers.get("content-length");
    if (length) res.set("Content-Length", length);
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
  } catch (err) {
    if (!res.headersSent) res.status(503).send("Segment unavailable");
  }
});

export default router;
