import { Router, type IRouter } from "express";

import { isBunnyStorageConfigured } from "../lib/bunny";
import { demoBrandedPosterPath, demoBrandedVideoPath, onDemoBrandedReady } from "../lib/demoBrandedClips";
import { buildDemoReport, buildDemoShowcase, type DemoReport, type DemoShowcase } from "../lib/demoShowcase";
import { logger } from "../lib/logger";
import { proxyStorageObject } from "./share";

const router: IRouter = Router();

/**
 * The public sales demo reads two endpoints, both anonymous:
 *
 *   GET /demo/showcase         counts, the match to play, player clips (fast)
 *   GET /demo/showcase/report  the AI match report for that match (slow the
 *                              first time: it reads the whole analysis bundle)
 *
 * Both are cached in memory. The page is shown to prospects, often several
 * times in a row on a pitch-side phone, and none of it changes by the minute.
 */
const SHOWCASE_TTL_MS = 5 * 60 * 1000;
const REPORT_TTL_MS = 6 * 60 * 60 * 1000;

let showcaseCache: { at: number; data: DemoShowcase } | null = null;
let showcaseInFlight: Promise<DemoShowcase> | null = null;
const reportCache = new Map<number, { at: number; data: DemoReport | null }>();
const reportInFlight = new Map<number, Promise<DemoReport | null>>();

// A branded copy that just finished should show on the next visit, not in five minutes.
onDemoBrandedReady(() => {
  showcaseCache = null;
});

export function resetDemoShowcaseCache(): void {
  showcaseCache = null;
  showcaseInFlight = null;
  reportCache.clear();
  reportInFlight.clear();
}

async function showcase(): Promise<DemoShowcase> {
  if (showcaseCache && Date.now() - showcaseCache.at < SHOWCASE_TTL_MS) return showcaseCache.data;
  if (!showcaseInFlight) {
    showcaseInFlight = buildDemoShowcase()
      .then((data) => {
        showcaseCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        showcaseInFlight = null;
      });
  }
  return showcaseInFlight;
}

async function report(recordingId: number): Promise<DemoReport | null> {
  const cached = reportCache.get(recordingId);
  if (cached && Date.now() - cached.at < REPORT_TTL_MS) return cached.data;
  let pending = reportInFlight.get(recordingId);
  if (!pending) {
    pending = buildDemoReport(recordingId)
      .then((data) => {
        reportCache.set(recordingId, { at: Date.now(), data });
        return data;
      })
      .finally(() => {
        reportInFlight.delete(recordingId);
      });
    reportInFlight.set(recordingId, pending);
  }
  return pending;
}

router.get("/demo/showcase", async (_req, res): Promise<void> => {
  try {
    const data = await showcase();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, "demo showcase failed");
    res.status(500).json({ error: "Could not load the demo" });
  }
});

router.get("/demo/showcase/report", async (_req, res): Promise<void> => {
  try {
    const current = await showcase();
    if (!current.match?.analysed) {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ available: false, report: null });
      return;
    }
    const data = await report(current.match.recordingId);
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.json({ available: Boolean(data), report: data });
  } catch (error) {
    logger.error({ err: error }, "demo report failed");
    res.status(500).json({ error: "Could not build the match report" });
  }
});

/**
 * The demo's branded copies (lib/demoBrandedClips.ts). Only clips the demo is
 * showing right now are served, so this is not a way to read any clip.
 */
router.get("/demo/clips/:file", async (req, res): Promise<void> => {
  const match = /^(\d{1,9})\.(mp4|jpg)$/.exec(String(req.params.file ?? ""));
  if (!match) {
    res.status(404).end();
    return;
  }
  const id = Number(match[1]);
  const kind = match[2] as "mp4" | "jpg";
  try {
    const current = await showcase();
    const shown = [...current.clips, ...current.socialClips].some((clip) => clip.id === id && clip.branded);
    if (!shown || !isBunnyStorageConfigured()) {
      res.status(404).end();
      return;
    }
    await proxyStorageObject(
      req,
      res,
      kind === "mp4" ? demoBrandedVideoPath(id) : demoBrandedPosterPath(id),
      kind === "mp4" ? "video/mp4" : "image/jpeg",
      86400,
      "public, max-age=86400",
    );
  } catch (error) {
    logger.error({ err: error, id }, "demo clip copy failed");
    if (!res.headersSent) res.status(500).end();
  }
});

export default router;
