import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger";
import { EXPORT_ENCODE_ARGS } from "./ffmpegExport";

/**
 * Clip branding: field logos, a CTA end card, and the free-tier watermark.
 *
 * WHY THERE IS NO drawtext ANYWHERE IN THIS FILE.
 *
 * FFmpeg's text rendering needs fribidi for bidirectional text and harfbuzz for
 * shaping, and even correctly built it handles Arabic ligatures unreliably — you
 * get disconnected letterforms or reversed word order. This project has already
 * been burned by Arabic text rendering in generated images. So no text is drawn
 * at render time at all. Every piece of text is baked into a PNG by a designer,
 * once, and composited.
 *
 * That has a second benefit worth stating: changing the CTA becomes replacing a
 * file, with no re-render of anything.
 *
 * ASSET LAYOUT
 *
 *   <BRANDING_ROOT>/overlays/<fieldKey>/<lang>/<W>x<H>.png
 *   <BRANDING_ROOT>/endcards/<fieldKey>/<lang>/<W>x<H>.mp4
 *   <BRANDING_ROOT>/watermark/<lang>/<W>x<H>.png
 *
 * `fieldKey` is `field-<id>`, falling back to `_default`. A field with no logo
 * yet degrades to generic Replay branding rather than blocking the render —
 * every field is supposed to hand over a transparent-background logo during
 * router deployment (B1 §2.3), and in practice some will not have.
 *
 * The dimensions are in the path because a pre-built overlay only works against
 * a known frame size. 16:9 exports are 1920x1080 and 9:16 exports are 608x1080,
 * so an asset set needs one file per aspect it supports.
 *
 * WHY THE CTA IS AN END CARD AND NOT A PERSISTENT OVERLAY
 *
 * A persistent CTA competes with the football on a 20-second clip, and a
 * watermark that ruins the clip stops it being shared — which defeats the point
 * of putting it there. So the CTA is two seconds at the end, pre-encoded once per
 * field with parameters identical to the export, and concatenated with `-c copy`.
 * Zero marginal CPU, and changing the CTA never requires re-rendering a clip.
 *
 * Logos stay persistent but small — about 8% of frame height, semi-transparent,
 * in a corner, never across the action. That is a property of the PNG, not of
 * this code.
 */

export const BRANDING_ROOT = process.env.BRANDING_ROOT ?? "/opt/replay/branding";

/** Languages we keep asset sets for. `en` is the fallback. */
export type BrandingLang = "en" | "ar";

export interface BrandingAssets {
  /** Persistent logo layer. Null when neither the field nor the default has one. */
  overlay: string | null;
  /** 2-second CTA card, already encoded to the export spec. */
  endCard: string | null;
  /** Free-tier-only extra watermark, composited above the logo layer. */
  watermark: string | null;
  /** Which key each asset actually resolved from, for logging. */
  resolvedFrom: { overlay?: string; endCard?: string; watermark?: string };
}

export interface BrandingRequest {
  fieldId: number | null;
  lang: BrandingLang;
  width: number;
  height: number;
  /** Pro downloads ship clean: no watermark, no CTA, no logos. */
  tier: "free" | "pro";
}

function fieldKey(fieldId: number | null): string {
  return fieldId == null ? "_default" : `field-${fieldId}`;
}

function firstExisting(candidates: string[]): { path: string; from: string } | null {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return { path: c, from: c };
    } catch {
      // not there; try the next fallback
    }
  }
  return null;
}

/**
 * Resolve the asset set for one export.
 *
 * Fallback order is field+lang → field+en → default+lang → default+en. A missing
 * asset is null, never an error: branding must never be the reason a user's clip
 * fails to render.
 */
export function resolveBrandingAssets(req: BrandingRequest): BrandingAssets {
  const empty: BrandingAssets = {
    overlay: null, endCard: null, watermark: null, resolvedFrom: {},
  };

  // Pro downloads are clean by definition — nothing to resolve.
  if (req.tier === "pro") return empty;

  const dims = `${req.width}x${req.height}`;
  const keys = [fieldKey(req.fieldId), "_default"];
  const langs: BrandingLang[] = req.lang === "en" ? ["en"] : [req.lang, "en"];

  const overlayCandidates: string[] = [];
  const endCardCandidates: string[] = [];
  for (const k of keys) {
    for (const l of langs) {
      overlayCandidates.push(path.join(BRANDING_ROOT, "overlays", k, l, `${dims}.png`));
      endCardCandidates.push(path.join(BRANDING_ROOT, "endcards", k, l, `${dims}.mp4`));
    }
  }
  const watermarkCandidates = langs.map((l) =>
    path.join(BRANDING_ROOT, "watermark", l, `${dims}.png`),
  );

  const overlay = firstExisting(overlayCandidates);
  const endCard = firstExisting(endCardCandidates);
  const watermark = firstExisting(watermarkCandidates);

  const assets: BrandingAssets = {
    overlay: overlay?.path ?? null,
    endCard: endCard?.path ?? null,
    watermark: watermark?.path ?? null,
    resolvedFrom: {
      ...(overlay ? { overlay: overlay.from } : {}),
      ...(endCard ? { endCard: endCard.from } : {}),
      ...(watermark ? { watermark: watermark.from } : {}),
    },
  };

  if (!overlay && !endCard && !watermark) {
    logger.warn(
      { fieldId: req.fieldId, lang: req.lang, dims, root: BRANDING_ROOT },
      "No branding assets found at any fallback level — clip will render unbranded",
    );
  }
  return assets;
}

/**
 * Cache key for a CLEAN render — the crop/pan output before any branding.
 *
 * Branding is a cheap second pass over a finished MP4 (roughly a fifth of the
 * CPU of decoding the 4K source again), so the expensive part is cached once and
 * both tiers are served from it. Two consequences worth having deliberately:
 *
 *   - a free user who upgrades gets their existing clips clean with no re-render;
 *   - changing a CTA or a logo never invalidates this key, because neither is
 *     part of the clean render.
 *
 * Everything that changes the pixels of the clean render is in the key. Nothing
 * else is.
 */
export function cleanRenderCacheKey(input: {
  clipId: number;
  cropPath: unknown;
  aspectRatio: string;
  startTime: number;
  endTime: number;
  /** Source URL matters: the same clip re-cut from a different rendition differs. */
  sourceUrl?: string;
  introUrl?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        clipId: input.clipId,
        cropPath: input.cropPath,
        aspectRatio: input.aspectRatio,
        // Round to milliseconds: float noise in the last places must not
        // produce a cache miss on an identical selection.
        startTime: Math.round(input.startTime * 1e6) / 1e6,
        endTime: Math.round(input.endTime * 1e6) / 1e6,
        sourceUrl: input.sourceUrl ?? null,
        introUrl: input.introUrl ?? null,
      }),
    )
    .digest("hex");
}

function run(bin: string, args: string[], timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = "";
    let timedOut = false;
    proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1000)}`));
      resolve();
    });
  });
}

/**
 * Composite the branding layers onto a finished clean render, then append the
 * end card.
 *
 * Returns a NEW file path, or the input path unchanged when there is nothing to
 * apply — so the caller can always treat the return value as "the file to
 * serve", and must not assume it owns the result for deletion. Check identity
 * before cleaning up.
 *
 * Two passes, deliberately:
 *
 *  1. one `overlay` filter chain (logo, then watermark above it) with the video
 *     re-encoded and the AUDIO STREAM-COPIED — audio is untouched by branding, so
 *     re-encoding it would be pure waste and a second generation of loss;
 *  2. concat demuxer with `-c copy` for the end card, which costs nothing.
 *
 * Step 2 only works because the end card was encoded with EXPORT_ENCODE_ARGS —
 * the same constant step 1 uses. If those ever diverge the concat fails loudly
 * rather than producing a broken file, which is the behaviour we want.
 */
export async function brandClip(
  inputPath: string,
  assets: BrandingAssets,
): Promise<string> {
  const layers = [assets.overlay, assets.watermark].filter(Boolean) as string[];

  if (layers.length === 0 && !assets.endCard) {
    logger.info({ inputPath }, "No branding to apply — serving the clean render");
    return inputPath;
  }

  let current = inputPath;
  let composited: string | null = null;

  if (layers.length > 0) {
    composited = path.join(os.tmpdir(), `soccerwatch-branded-${randomUUID()}.mp4`);
    // One filter_complex, one decode, one encode — regardless of layer count.
    // `overlay=0:0` because each PNG is authored at full output resolution, so
    // position is the designer's decision and not a number in this file.
    const chain = layers
      .map((_, i) => (i === 0 ? "[0:v][1:v]overlay=0:0" : `[v${i}][${i + 1}:v]overlay=0:0`))
      .map((expr, i) => (i === layers.length - 1 ? `${expr}[vout]` : `${expr}[v${i + 1}]`))
      .join(";");

    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", current,
      ...layers.flatMap((l) => ["-i", l]),
      "-filter_complex", chain,
      "-map", "[vout]",
      // Audio is untouched by branding.
      "-map", "0:a?", "-c:a", "copy",
      ...EXPORT_ENCODE_ARGS.video,
      "-movflags", "+faststart",
      "-y", composited,
    ];
    try {
      await run("ffmpeg", args);
      current = composited;
    } catch (err) {
      // Branding must never be the reason a user cannot download their clip.
      logger.error({ err, inputPath, layers }, "Branding composite failed — serving the clean render");
      if (composited) fs.unlink(composited, () => {});
      return inputPath;
    }
  }

  if (assets.endCard) {
    const listPath = path.join(os.tmpdir(), `soccerwatch-brandlist-${randomUUID()}.txt`);
    const outPath = path.join(os.tmpdir(), `soccerwatch-branded-final-${randomUUID()}.mp4`);
    try {
      await fs.promises.writeFile(
        listPath,
        `file '${current}'\nfile '${assets.endCard}'\n`,
        "utf8",
      );
      await run("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart",
        "-y", outPath,
      ]);
      if (composited && composited !== inputPath) fs.unlink(composited, () => {});
      return outPath;
    } catch (err) {
      logger.error({ err, endCard: assets.endCard }, "End-card concat failed — serving without it");
      fs.unlink(outPath, () => {});
      return current;
    } finally {
      fs.unlink(listPath, () => {});
    }
  }

  return current;
}

/**
 * Encode a 2-second end card from a still PNG, to exactly the export spec.
 *
 * Run once per field per language per aspect, at onboarding. The output is what
 * `brandClip` concatenates with `-c copy`, so it must match the export spec
 * exactly — which is why this uses the same EXPORT_ENCODE_ARGS constant rather
 * than a hand-written argument list that could drift.
 *
 * Silent audio is added because the concat demuxer requires a matching stream
 * layout across parts, and a clip with audio followed by a card without it
 * drops the audio track partway through playback.
 */
export async function buildEndCard(options: {
  stillPng: string;
  outPath: string;
  seconds?: number;
}): Promise<string> {
  const seconds = options.seconds ?? 2;
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-loop", "1", "-i", options.stillPng,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t", String(seconds),
    "-vf", "format=yuv420p",
    ...EXPORT_ENCODE_ARGS.video,
    ...EXPORT_ENCODE_ARGS.audio,
    "-shortest", "-movflags", "+faststart",
    "-y", options.outPath,
  ]);
  return options.outPath;
}
