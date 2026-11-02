import fs from "node:fs";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { isVideoScene, mediaSourceSchema, sceneSchema } from "@workspace/api-zod";
import { CREATIVE_BASE, creativeOwner, loadCreativeProject, publicProject } from "../lib/creative/projects";
import { logger } from "../lib/logger";
import { renderScenePng } from "../lib/creative/render";
import { isRendering, queueVideoRender, renderStillNow, sweepInterruptedRenders } from "../lib/creative/renderJobs";
import { browserMedia, creativeImageResolver, loadCreativeContext, serverData } from "../lib/creative/renderMedia";
import { sendOutput } from "../lib/creative/renderStore";
import type { ConcreteSource } from "../lib/creative/render";

/**
 * Creative hub → Render (owner only; see routes/academyCreative.ts).
 *
 *   POST …/projects/:projectId/render   still: drawn now → { project } done | failed
 *                                       video: queued    → { project } queued (poll the project)
 *   GET  …/projects/:projectId/output   the stored PNG / MP4 (Range for video; ?download=1 = attachment)
 *   POST …/preview                      { scene, data?, width?, timeMs? } → PNG (thumbnails; ≤ 1080 wide)
 *   GET  …/media?src=<MediaSource JSON>&want=still|video
 *                                       something the browser can load for a scene source
 *
 * Academy facts and names are filled on the server (renderMedia.serverData),
 * whatever the browser sent; every media source is checked against the academy.
 */
const router: IRouter = Router();
const base = CREATIVE_BASE;

if (process.env.NODE_ENV !== "test") {
  // A render a previous process was running is not running any more.
  setTimeout(() => { void sweepInterruptedRenders(); }, 5_000).unref();
}

router.post(`${base}/projects/:projectId/render`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  if (isRendering(row.id)) {
    // Already being made: the same answer as starting it, so the console just keeps polling.
    res.status(202).json({ project: publicProject(row) });
    return;
  }
  const parsed = sceneSchema.safeParse(row.scene);
  try {
    const video = parsed.success ? isVideoScene(parsed.data) : row.kind === "video";
    const updated = video ? await queueVideoRender(access, row) : await renderStillNow(access, row);
    res.status(video && updated.renderStatus === "queued" ? 202 : 200).json({ project: publicProject(updated) });
  } catch (err) {
    logger.error({ err, projectId: row.id }, "Creative render request failed");
    res.status(500).json({ error: "Couldn't start the render. Try again." });
  }
});

router.get(`${base}/projects/:projectId/output`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  try {
    await sendOutput(req, res, row);
  } catch (err) {
    logger.error({ err, projectId: row.id }, "Creative output failed");
    if (!res.headersSent) res.status(500).json({ error: "Couldn't send the file" });
  }
});

const MAX_PREVIEW_BODY = 512 * 1024;
const MAX_PREVIEWS = 3;
let previews = 0;

const previewBody = z.object({
  scene: sceneSchema,
  data: z.record(z.unknown()).nullish(),
  width: z.number().int().min(64).max(1080).default(540),
  timeMs: z.number().min(0).max(180_000).optional(),
});

router.post(`${base}/preview`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > MAX_PREVIEW_BODY) {
    res.status(413).json({ error: "That design is too big to preview." });
    return;
  }
  const parsed = previewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid scene", issues: parsed.error.issues.slice(0, 5) });
    return;
  }
  if (previews >= MAX_PREVIEWS) {
    res.setHeader("Retry-After", "1");
    res.status(429).json({ error: "Busy drawing previews. Try again in a second." });
    return;
  }
  previews++;
  const temps: string[] = [];
  try {
    const b = parsed.data;
    const ctx = await loadCreativeContext(access, temps);
    const png = await renderScenePng({
      scene: b.scene, brand: ctx.brand, data: serverData(access, ctx, b.data),
      images: creativeImageResolver(access.academyId, ctx.look),
      width: b.width,
      t: b.timeMs ?? null,
      entrances: b.timeMs !== undefined,
    });
    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(png);
  } catch (err) {
    logger.error({ err, academyId: access.academyId }, "Creative preview failed");
    if (!res.headersSent) res.status(500).json({ error: "Couldn't draw that. Try again." });
  } finally {
    previews--;
    for (const t of temps) fs.unlink(t, () => {});
  }
});

router.get(`${base}/media`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  let src: ConcreteSource | null = null;
  try {
    const parsed = mediaSourceSchema.safeParse(JSON.parse(String(req.query.src ?? "")));
    if (parsed.success && parsed.data.type !== "binding") src = parsed.data;
  } catch { /* falls through to 400 */ }
  if (!src) { res.status(400).json({ error: "Invalid media source" }); return; }
  const want = req.query.want === "video" ? "video" : "still";
  const temps: string[] = [];
  try {
    const media = await browserMedia(access, src, want, temps);
    if (!media) { res.status(404).json({ error: "Not found" }); return; }
    res.setHeader("Cache-Control", "private, max-age=300");
    if ("redirect" in media) { res.redirect(302, media.redirect); return; }
    if ("buffer" in media) { res.type(media.type).send(media.buffer); return; }
    await new Promise<void>((resolve) => {
      res.sendFile(media.file, { headers: { "Content-Type": media.type }, cacheControl: false }, (err) => {
        if (err && !res.headersSent) res.status(500).json({ error: "Couldn't send the file" });
        resolve();
      });
    });
  } catch (err) {
    logger.warn({ err, academyId: access.academyId, src }, "Creative media failed");
    if (!res.headersSent) res.status(502).json({ error: "That picture or video isn't available right now." });
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
});

export default router;
