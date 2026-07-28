import { Router, type IRouter } from "express";

const router: IRouter = Router();

const LIVE_PLAYBACK_BASE = "https://replayjo.b-cdn.net";
const VALID_CAMERAS = ["camera1", "camera2"];
/** A segment file name only: no slashes, no dot-segments, must end in .ts */
const SEGMENT_NAME_RE = /^[A-Za-z0-9_-]+\.ts$/;

/**
 * GET /api/live/:camera/index.m3u8
 * Proxy the HLS manifest, rewriting segment URLs to go through this server
 * so the browser avoids CORS restrictions on the CDN.
 */
router.get("/live/:camera/index.m3u8", async (req, res): Promise<void> => {
  const camera = req.params.camera as string;
  if (!VALID_CAMERAS.includes(camera)) {
    res.status(400).send("Invalid camera");
    return;
  }

  try {
    const upstream = await fetch(
      `${LIVE_PLAYBACK_BASE}/${camera}/index.m3u8`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!upstream.ok) {
      res.status(upstream.status).send("Stream unavailable");
      return;
    }

    const text = await upstream.text();

    // Rewrite relative segment URLs → /api/live/:camera/<segment>
    const rewritten = text.replace(
      /^(seg_[^\s]+\.ts)$/gm,
      `/api/live/${camera}/$1`,
    );

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-store");
    res.send(rewritten);
  } catch {
    res.status(503).send("Stream unavailable");
  }
});

/**
 * GET /api/live/:camera/:segment
 * Proxy individual .ts segments.
 */
router.get("/live/:camera/:segment", async (req, res): Promise<void> => {
  const camera = req.params.camera as string;
  const segment = req.params.segment as string;

  // Express decodes %2e%2f etc. before we see it, so an endsWith(".ts") check
  // alone still admits values like "../../other.ts" which fetch would resolve
  // outside the camera directory. Match the segment shape exactly instead.
  if (!VALID_CAMERAS.includes(camera) || !SEGMENT_NAME_RE.test(segment)) {
    res.status(400).send("Invalid request");
    return;
  }

  try {
    const upstream = await fetch(
      `${LIVE_PLAYBACK_BASE}/${camera}/${segment}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!upstream.ok) {
      res.status(upstream.status).send("Segment unavailable");
      return;
    }

    res.set("Content-Type", "video/mp2t");
    res.set("Cache-Control", "public, max-age=60");
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch {
    res.status(503).send("Segment unavailable");
  }
});

export default router;
