import fs from "node:fs";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { CREATIVE_FORMATS, CREATIVE_STYLES, TINT_MODES, isVideoScene, mediaSourceSchema, sceneForData, sceneSchema, type CreativeFormat, type ResolvedTint, type TintMode } from "@workspace/api-zod";
import { CREATIVE_BASE, creativeOwner, loadCreativeProject, publicProject } from "../lib/creative/projects";
import { logger } from "../lib/logger";
import { renderScenePng } from "../lib/creative/render";
import { isRendering, queueVideoRender, renderStillNow, sweepInterruptedRenders } from "../lib/creative/renderJobs";
import { backgroundPlates, browserMedia, browserPlaybackSources, CreativeRenderError, creativeImageResolver, loadCreativeContext, rescanPlates, serverData, tintedStill } from "../lib/creative/renderMedia";
import { sendOutput } from "../lib/creative/renderStore";
import { styleAllowedFor } from "../lib/creative/packs";
import type { ConcreteSource } from "../lib/creative/render";

/**
 * Creative hub → Render (owner only; see routes/academyCreative.ts).
 *
 *   POST …/projects/:projectId/render   still: drawn now → { project } done | failed
 *                                       video: queued    → { project } queued (poll the project)
 *   GET  …/projects/:projectId/output   the stored PNG / MP4 (Range for video; ?download=1 = attachment)
 *   POST …/preview                      { scene, data?, width?, timeMs? } → PNG (thumbnails; ≤ 1080 wide)
 *   GET  …/media?src=<MediaSource JSON>&want=still|video[&sources=1][&format=post|square|story][&tint=<hex>&tintMode=&tintAmount=&size=<px>]
 *                                       something the browser can load for a scene source;
 *                                       sources=1 returns immediate HLS choices for recording moments;
 *                                       format picks a background plate's post/story file;
 *                                       tint returns the still recoloured as the renderer does (PNG)
 *   GET  …/artwork/backgrounds?style=<style>
 *                                       { style, plates: [{ key: "bg/<style>/<n>", n, aspects }] } (empty when none)
 *
 * Academy facts and names are filled on the server (renderMedia.serverData),
 * whatever the browser sent; every media source is checked against the academy.
 */
const router: IRouter = Router();
const base = CREATIVE_BASE;

if (process.env.NODE_ENV !== "test") {
  // A render a previous process was running is not running any more.
  setTimeout(() => { void sweepInterruptedRenders(); }, 5_000).unref();
  // The background plates shipped with this build.
  rescanPlates();
}

const queryString = (v: unknown): string | null => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null);

/** ?tint=<#RRGGBB or RRGGBB>&tintMode=color|multiply|screen&tintAmount=0..1 → a tint, or null (none / invalid). */
export function tintFromQuery(q: Record<string, unknown>): ResolvedTint | null {
  const hex = queryString(q.tint);
  if (!hex || !/^#?[0-9a-fA-F]{6}$/.test(hex)) return null;
  const modeRaw = queryString(q.tintMode);
  const mode: TintMode = modeRaw && (TINT_MODES as readonly string[]).includes(modeRaw) ? (modeRaw as TintMode) : "color";
  const amountRaw = queryString(q.tintAmount);
  const amount = amountRaw === null || amountRaw === "" ? 1 : Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { color: `#${hex.replace(/^#/, "").toUpperCase()}`, mode, amount: Math.min(1, amount) };
}

function formatFromQuery(v: unknown): CreativeFormat | undefined {
  const f = queryString(v);
  return f && f in CREATIVE_FORMATS ? (f as CreativeFormat) : undefined;
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

const playbackTelemetryBody = z.object({
  sessionId: z.string().min(8).max(64).regex(/^[a-zA-Z0-9-]+$/),
  event: z.enum([
    "opened", "capability", "source-load", "source-clear", "window-offset", "loadstart",
    "seek", "seeking", "seeked", "loadedmetadata", "playing", "waiting", "stalled",
    "error", "hls-error", "sample",
  ]),
  elapsedMs: z.number().int().min(0).max(86_400_000),
  engine: z.enum(["native-hls", "hls.js", "mms", "unknown"]),
  sourceType: z.enum(["camera-4k-window", "camera-4k-full", "stream", "none"]),
  hevcSupported: z.boolean().nullable(),
  detail: z.object({
    fromMs: z.number().finite().min(0).max(86_400_000).optional(),
    toMs: z.number().finite().min(0).max(86_400_000).optional(),
    offsetMs: z.number().finite().min(0).max(86_400_000).optional(),
    targetSec: z.number().finite().min(0).max(86_400).optional(),
    currentTime: z.number().finite().min(0).max(86_400).optional(),
    duration: z.number().finite().min(0).max(86_400).optional(),
    readyState: z.number().int().min(0).max(4).optional(),
    networkState: z.number().int().min(0).max(3).optional(),
    paused: z.boolean().optional(),
    seeking: z.boolean().optional(),
    buffered: z.array(z.tuple([
      z.number().finite().min(0).max(86_400),
      z.number().finite().min(0).max(86_400),
    ])).max(8).optional(),
    loadOrdinal: z.number().int().min(1).max(100).optional(),
    reason: z.enum(["window-start", "window-loop", "play-from-start", "nudge", "record-start", "clip-start"]).optional(),
    errorType: z.string().max(60).optional(),
    errorDetail: z.string().max(100).optional(),
    fatal: z.boolean().optional(),
    responseCode: z.number().int().min(0).max(999).optional(),
  }).strict().optional(),
}).strict();

const playbackTelemetryRate = new Map<string, { startedAt: number; count: number }>();

function allowPlaybackTelemetry(key: string, now = Date.now()): boolean {
  let entry = playbackTelemetryRate.get(key);
  if (!entry || now - entry.startedAt >= 60_000) {
    entry = { startedAt: now, count: 0 };
    playbackTelemetryRate.set(key, entry);
  }
  entry.count++;
  if (playbackTelemetryRate.size > 10_000) {
    for (const [candidate, value] of playbackTelemetryRate) {
      if (now - value.startedAt >= 120_000) playbackTelemetryRate.delete(candidate);
    }
  }
  return entry.count <= 60;
}

router.post(`${base}/playback-telemetry`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const parsed = playbackTelemetryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid playback telemetry" });
    return;
  }
  if (!allowPlaybackTelemetry(`${access.academyId}:${parsed.data.sessionId}`)) {
    res.setHeader("Retry-After", "60");
    res.status(429).end();
    return;
  }
  logger.info({ academyId: access.academyId, ...parsed.data }, "[creative-framer-playback]");
  res.status(204).end();
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
    const data = serverData(access, ctx, b.data);
    const png = await renderScenePng({
      scene: sceneForData(b.scene, data), brand: ctx.brand, data,
      images: creativeImageResolver(access.academyId, ctx.look, 1_000, temps),
      width: b.width,
      t: b.timeMs ?? null,
      entrances: b.timeMs !== undefined,
    });
    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(png);
  } catch (err) {
    logger.error({ err, academyId: access.academyId }, "Creative preview failed");
    if (!res.headersSent) {
      res.status(err instanceof CreativeRenderError ? err.status : 500).json({
        error: err instanceof CreativeRenderError ? err.message : "Couldn't draw that. Try again.",
      });
    }
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
  if (queryString(req.query.sources) === "1") {
    if (want !== "video" || src.type !== "recording") {
      res.status(400).json({ error: "Playback sources are only available for recording video." });
      return;
    }
    const sources = await browserPlaybackSources(access, src);
    if (!sources) { res.status(404).json({ error: "Recording video not found" }); return; }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ sources });
    return;
  }
  const format = formatFromQuery(req.query.format);
  const tint = want === "still" ? tintFromQuery(req.query as Record<string, unknown>) : null;
  const temps: string[] = [];
  try {
    if (tint) {
      const size = Number(queryString(req.query.size));
      const png = await tintedStill(access, src, format, tint, temps, Number.isFinite(size) && size >= 64 ? size : undefined);
      if (png) {
        res.setHeader("Cache-Control", "private, max-age=300");
        res.type("png").send(png);
        return;
      }
      // Not loadable here (a crest drawn as initials): the untinted picture, as the export draws it.
    }
    const media = await browserMedia(access, src, want, temps, format);
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
    if (!res.headersSent) {
      const status = err instanceof CreativeRenderError ? err.status : 409;
      const message = err instanceof Error ? err.message : "That picture or video isn't available right now.";
      res.status(status).json({ error: message });
    }
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
});

router.get(`${base}/artwork/backgrounds`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const style = queryString(req.query.style);
  if (!style || !(CREATIVE_STYLES as readonly string[]).includes(style) || !styleAllowedFor(access.academy, style)) {
    res.status(400).json({ error: "Unknown style" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=300");
  res.json({ style, plates: backgroundPlates(style) });
});

export default router;
