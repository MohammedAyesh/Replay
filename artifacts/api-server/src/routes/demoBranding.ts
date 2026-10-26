import { Router, type IRouter } from "express";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { demoBrandLook } from "../lib/clipBranding/demoLook";
import { PREVIEW_DIMS, renderPreviewMp4, renderPreviewPng } from "../lib/clipBranding/preview";
import type { EndScreenKind } from "../lib/clipBranding/types";
import { ADMIN_PREVIEW_RANGE_MAX_BYTES, planExportRange } from "../lib/exportPlayback";

const router: IRouter = Router();
const PNG_WHATS = ["cornerCrest", "broadcastBar", "academyFrame", "signOff", "player", "match", "academy"] as const;
const MP4_KINDS: readonly EndScreenKind[] = ["signOff", "player", "match", "academy"];
const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = "#D4FF4F";
const PNG_CACHE_LIMIT = 200;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 40;

const pngCache = new Map<string, Buffer>();
const pngInFlight = new Map<string, Promise<Buffer>>();
const mp4InFlight = new Map<string, Promise<string>>();
const rateByIp = new Map<string, { startedAt: number; count: number }>();

type ValidRequestValues = {
  look: "galaxy" | "custom";
  persona: "pitch" | "academy";
  name: string;
  color: string;
  aspect: "9:16" | "16:9";
};

function isValidRequestValues(
  values: ReturnType<typeof requestValues>,
): values is ValidRequestValues {
  return values.look !== null && values.persona !== null && values.aspect !== null;
}

function allowRequest(ip: string): boolean {
  const now = Date.now();
  const current = rateByIp.get(ip);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateByIp.set(ip, { startedAt: now, count: 1 });
    if (rateByIp.size > 2_000) {
      for (const [key, value] of rateByIp) {
        if (now - value.startedAt >= RATE_WINDOW_MS) rateByIp.delete(key);
      }
    }
    return true;
  }
  if (current.count >= RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

function requestValues(query: Record<string, unknown>) {
  const look = query.look === "custom" ? "custom" : query.look === "galaxy" || query.look == null ? "galaxy" : null;
  const persona = query.persona === "academy" ? "academy" : query.persona === "pitch" || query.persona == null ? "pitch" : null;
  const rawName = typeof query.name === "string" ? query.name.trim().slice(0, 28) : "";
  const name = rawName || "YOUR PITCH";
  const color = typeof query.color === "string" && HEX.test(query.color) ? query.color.toUpperCase() : DEFAULT_COLOR;
  const aspect = query.aspect === "16:9" ? "16:9" : query.aspect === "9:16" || query.aspect == null ? "9:16" : null;
  return { look, persona, name, color, aspect };
}

export { demoBrandLook };

function previewKey(values: ValidRequestValues, what: string): string {
  const lookOptions = values.look === "galaxy" ? ["jordan-galaxy"] : [values.name, values.color];
  return JSON.stringify([values.look, values.persona, ...lookOptions, values.aspect, what, 22, 0.5]);
}

async function cachedPng(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
  const hit = pngCache.get(key);
  if (hit) {
    pngCache.delete(key);
    pngCache.set(key, hit);
    return hit;
  }
  let pending = pngInFlight.get(key);
  if (!pending) {
    pending = render();
    pngInFlight.set(key, pending);
  }
  try {
    const result = await pending;
    pngCache.set(key, result);
    while (pngCache.size > PNG_CACHE_LIMIT) {
      const oldest = pngCache.keys().next().value;
      if (oldest === undefined) break;
      pngCache.delete(oldest);
    }
    return result;
  } finally {
    pngInFlight.delete(key);
  }
}

router.get("/demo/branding/preview.png", async (req, res): Promise<void> => {
  const values = requestValues(req.query as Record<string, unknown>);
  // Only a typed name or colour can cost a fresh render. The preset is a fixed
  // set, warmed at start-up, and one video alone makes several range requests,
  // so counting it locked out phones behind a shared carrier address.
  if (values.look === "custom" && !allowRequest(req.ip || "unknown")) {
    res.status(429).json({ error: "Too many preview requests. Please wait a moment." });
    return;
  }
  const what = String(req.query.what ?? "signOff");
  if (!isValidRequestValues(values) || !(PNG_WHATS as readonly string[]).includes(what)) {
    res.status(400).json({ error: "Invalid branding preview options." });
    return;
  }
  if (typeof req.query.color === "string" && !HEX.test(req.query.color)) {
    res.status(400).json({ error: "Color must be a six-digit hex value." });
    return;
  }
  try {
    const key = previewKey(values, what);
    const png = await cachedPng(key, async () => {
      const look = await demoBrandLook(values);
      return renderPreviewPng({
        look,
        what: what as (typeof PNG_WHATS)[number],
        dims: PREVIEW_DIMS[values.aspect!],
        blur: 22,
        dim: 0.5,
      });
    });
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.setHeader("Vary", "Accept-Encoding");
    res.type("png").send(png);
  } catch (err) {
    req.log.error({ err, what }, "Public branding PNG preview failed");
    res.status(500).json({ error: "Could not render the branding preview." });
  }
});

/**
 * One key for a request and for the warm-up. They used to differ (the warm-up
 * keyed the preset by name and colour, a request by "jordan-galaxy"), so every
 * warmed video was rendered again on the first visit.
 */
function mp4LookKey(values: Pick<ValidRequestValues, "look" | "persona" | "name" | "color">): string {
  const lookOptions = values.look === "galaxy" ? ["jordan-galaxy"] : [values.name, values.color];
  return JSON.stringify([values.look, values.persona, ...lookOptions]);
}

const MP4_SETTINGS = { seconds: 3, blur: 22, dim: 0.5 } as const;

async function getMp4(values: ValidRequestValues, kind: EndScreenKind): Promise<string> {
  const lookKey = mp4LookKey(values);
  const key = JSON.stringify([lookKey, kind, values.aspect]);
  let pending = mp4InFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const look = await demoBrandLook(values);
      return renderPreviewMp4({
        look,
        lookKey,
        kind,
        dims: PREVIEW_DIMS[values.aspect!],
        ...MP4_SETTINGS,
        // The preset never changes: keep it for the life of the server.
        keepMs: values.look === "galaxy" ? Number.POSITIVE_INFINITY : undefined,
      });
    })();
    mp4InFlight.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    mp4InFlight.delete(key);
  }
}

router.get("/demo/branding/preview.mp4", async (req, res): Promise<void> => {
  const values = requestValues(req.query as Record<string, unknown>);
  // Only a typed name or colour can cost a fresh render. The preset is a fixed
  // set, warmed at start-up, and one video alone makes several range requests,
  // so counting it locked out phones behind a shared carrier address.
  if (values.look === "custom" && !allowRequest(req.ip || "unknown")) {
    res.status(429).json({ error: "Too many preview requests. Please wait a moment." });
    return;
  }
  const kind = String(req.query.kind ?? "signOff");
  if (!isValidRequestValues(values) || !(MP4_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: "Invalid branding video preview options." });
    return;
  }
  if (typeof req.query.color === "string" && !HEX.test(req.query.color)) {
    res.status(400).json({ error: "Color must be a six-digit hex value." });
    return;
  }
  if (values.look === "custom" && values.aspect === "9:16") {
    res.status(400).json({ error: "Custom branding video previews are available in landscape only." });
    return;
  }

  try {
    const file = await getMp4(values, kind as EndScreenKind);
    const stat = await fs.promises.stat(file);
    const range = planExportRange(req.headers.range, ADMIN_PREVIEW_RANGE_MAX_BYTES);
    const start = range.start ?? Math.max(0, stat.size - (range.suffix ?? range.maxBytes));
    if (start >= stat.size) {
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.status(416).end();
      return;
    }
    const end = Math.min(stat.size - 1, range.end ?? stat.size - 1, start + range.maxBytes - 1);
    res.status(206);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    res.setHeader("Cache-Control", "public, max-age=900");
    res.setHeader("Vary", "Accept-Encoding");
    await pipeline(createReadStream(file, { start, end }), res);
  } catch (err) {
    if (!res.headersSent) {
      req.log.error({ err, kind }, "Public branding MP4 preview failed");
      res.status(500).json({ error: "Could not render the branding video preview." });
    }
  }
});

/**
 * Pre-render everything the demo shows for the bundled preset, in series:
 * the stills first (fast, and the first thing a visitor scrolls to), then the
 * story's videos. Both go through the same caches and keys as a request.
 */
export async function warmDemoBrandingPreviews(): Promise<void> {
  const personas = ["pitch", "academy"] as const;
  for (const persona of personas) {
    const values = { look: "galaxy" as const, name: "YOUR PITCH", color: DEFAULT_COLOR, persona };
    const look = await demoBrandLook(values);
    const whats: Array<(typeof PNG_WHATS)[number]> = persona === "academy"
      ? ["academyFrame", "broadcastBar", "signOff", "player", "academy"]
      : ["cornerCrest", "broadcastBar", "signOff", "player", "match"];
    for (const aspect of ["9:16", "16:9"] as const) {
      for (const what of whats) {
        await cachedPng(previewKey({ ...values, aspect }, what), () => renderPreviewPng({
          look,
          what,
          dims: PREVIEW_DIMS[aspect],
          blur: 22,
          dim: 0.5,
        }));
      }
    }
  }
  for (const persona of personas) {
    // The story shows the preset in portrait only (StoryTab.tsx).
    const kinds: EndScreenKind[] = persona === "academy" ? ["signOff", "player", "academy"] : ["signOff", "player", "match", "academy"];
    for (const kind of kinds) {
      await getMp4({ look: "galaxy", name: "YOUR PITCH", color: DEFAULT_COLOR, persona, aspect: "9:16" }, kind);
    }
  }
}

export function resetDemoBrandingPreviewCache(): void {
  pngCache.clear();
  pngInFlight.clear();
  mp4InFlight.clear();
  rateByIp.clear();
}

export default router;
