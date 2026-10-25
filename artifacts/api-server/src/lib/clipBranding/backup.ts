import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import { logger } from "../logger";
import {
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  isBunnyStorageConfigured,
  uploadBufferToBunnyStorage,
} from "../bunny";
import { getOutputDims } from "../ffmpegExport";
import type { SettingsContext } from "../settings";
import { FPS, ffmpegWithCard, type EndScreenJob } from "./endScreenVideo";
import { clipWantsDrawnBranding, planClipBranding, type BrandingClip } from "./plan";
import type { Dims } from "./types";

/**
 * Drawn branding for a clip the vps1 backup renderer (Method B) is rendering.
 *
 * vps1 cannot draw: it has neither the fonts nor this code. So this side draws
 * what an export here would draw — the overlay as a PNG, the end screen's card
 * as a short video with an alpha channel — puts both in Bunny Storage, and hands
 * vps1 their origin URLs. vps1 composites them exactly as an export here would
 * (clip_export/endscreen.py on vps1 mirrors endScreenVideo.ts).
 *
 * Content-addressed paths: the same card is uploaded once however often the
 * failover polls. Everything is best effort; any failure hands vps1 what it
 * had before (the uploaded overlay, no end screen).
 */

export type BackupEndScreen = {
  cardUrl: string;
  seconds: number;
  blur: number;
  dim: number;
  kind: string;
};

export type BackupBranding = {
  overlayUrl: string | null;
  endScreen: BackupEndScreen | null;
};

const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; value: Promise<BackupBranding> }>();

/** vps1 sends its Storage key only to the Storage origin, never the pull zone. */
function storageOriginUrl(remotePath: string): string {
  return `https://${BUNNY_STORAGE_HOSTNAME}/${[BUNNY_STORAGE_ZONE, remotePath].filter(Boolean).join("/")}`;
}

async function uploadContentAddressed(buffer: Buffer, folder: string, ext: string, contentType: string): Promise<string> {
  const key = createHash("sha256").update(buffer).digest("hex").slice(0, 40);
  const remote = `branding/${folder}/${key}.${ext}`;
  await uploadBufferToBunnyStorage(buffer, remote, contentType);
  return storageOriginUrl(remote);
}

/** The card alone (transparent where the footage shows), as a small video. */
export async function encodeCard(job: EndScreenJob, dims: Dims): Promise<{ buffer: Buffer; ext: "webm" | "mov" }> {
  // VP9 with alpha is ~0.3 MB for a 3 s portrait card. QuickTime RLE is the
  // fallback for an FFmpeg built without libvpx: lossless, ~10x larger.
  const variants: Array<{ ext: "webm" | "mov"; args: string[] }> = [
    { ext: "webm", args: ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "22",
      "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-f", "webm"] },
    { ext: "mov", args: ["-c:v", "qtrle", "-pix_fmt", "argb", "-f", "mov"] },
  ];
  let lastErr: unknown = null;
  for (const v of variants) {
    const out = `${os.tmpdir()}/soccerwatch-card-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${v.ext}`;
    try {
      await ffmpegWithCard([
        "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${dims.w}x${dims.h}`, "-framerate", String(FPS), "-i", "pipe:0",
        ...v.args, out,
      ], job, dims, 120_000);
      const buffer = await fs.promises.readFile(out);
      return { buffer, ext: v.ext };
    } catch (err) {
      lastErr = err;
    } finally {
      fs.unlink(out, () => {});
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function compute(
  clip: BrandingClip,
  portrait: boolean,
  fieldId: number | null,
  uploadedOverlayUrl: string | null,
): Promise<BackupBranding> {
  const plain: BackupBranding = { overlayUrl: uploadedOverlayUrl, endScreen: null };
  const ctx: SettingsContext = { academyId: clip.academyId, fieldId, userId: clip.userId };
  if (!(await clipWantsDrawnBranding(ctx))) return plain;
  if (!isBunnyStorageConfigured()) {
    logger.warn({ clipId: clip.id }, "Drawn branding for vps1 needs Bunny Storage — handing over the uploaded branding only");
    return plain;
  }

  const plan = await planClipBranding(clip, fieldId, portrait, ctx);
  const result: BackupBranding = { ...plain };
  try {
    if (plan.overlayPath) {
      try {
        const png = await fs.promises.readFile(plan.overlayPath);
        result.overlayUrl = await uploadContentAddressed(png, "drawn", "png", "image/png");
      } catch (err) {
        logger.warn({ err, clipId: clip.id }, "Could not hand the drawn overlay to vps1 — using the uploaded one");
      }
    }
    if (plan.endScreen) {
      try {
        const dims = getOutputDims(portrait);
        const card = await encodeCard(plan.endScreen, dims);
        result.endScreen = {
          cardUrl: await uploadContentAddressed(card.buffer, "endscreens", card.ext, card.ext === "webm" ? "video/webm" : "video/quicktime"),
          seconds: plan.endScreen.seconds,
          blur: plan.endScreen.blur,
          dim: plan.endScreen.dim,
          kind: plan.endScreen.spec.kind,
        };
      } catch (err) {
        logger.warn({ err, clipId: clip.id }, "Could not hand the end screen to vps1 — it renders without one");
      }
    }
  } finally {
    for (const t of plan.temps) fs.unlink(t, () => {});
  }
  if (result.overlayUrl !== uploadedOverlayUrl || result.endScreen) {
    logger.info(
      { clipId: clip.id, overlay: result.overlayUrl !== uploadedOverlayUrl, endScreen: result.endScreen?.kind ?? null },
      "Drawn branding prepared for the backup renderer (vps1)",
    );
  }
  return result;
}

/**
 * What to hand vps1 for this clip. Cached per clip (and re-clip revision) for
 * half an hour, so the failover's polling never redraws the card. Never throws.
 */
export function backupBrandingFor(
  clip: BrandingClip,
  portrait: boolean,
  fieldId: number | null,
  uploadedOverlayUrl: string | null,
  exportRevision?: string,
): Promise<BackupBranding> {
  const key = `${clip.id}:${exportRevision ?? ""}:${portrait ? "p" : "l"}`;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.value;
  const value = compute(clip, portrait, fieldId, uploadedOverlayUrl).catch((err) => {
    logger.error({ err, clipId: clip.id }, "Could not prepare drawn branding for vps1");
    cache.delete(key);
    return { overlayUrl: uploadedOverlayUrl, endScreen: null } as BackupBranding;
  });
  cache.set(key, { at: now, value });
  return value;
}

/** For tests. */
export function clearBackupBrandingCache(): void {
  cache.clear();
}
