import { Router, type IRouter } from "express";

const router: IRouter = Router();

const LIVE_PLAYBACK_BASE = "https://replayjo.b-cdn.net";
const VALID_CAMERAS = ["camera1", "camera2"];

/**
 * GET /api/live/status/:camera
 * Server-side HEAD ping to the CDN m3u8 — avoids browser CORS restrictions.
 */
router.get("/live/status/:camera", async (req, res): Promise<void> => {
  const camera = req.params.camera as string;
  if (!VALID_CAMERAS.includes(camera)) {
    res.status(400).json({ live: false, error: "Invalid camera" });
    return;
  }

  const url = `${LIVE_PLAYBACK_BASE}/${camera}/index.m3u8`;

  try {
    const upstream = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    res.json({ live: upstream.ok, status: upstream.status });
  } catch {
    res.json({ live: false });
  }
});

export default router;
