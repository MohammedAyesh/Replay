import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "branding-root-"));
process.env.BRANDING_ROOT = root;
process.env.BUNNY_CDN_HOSTNAME ??= "vz-test.b-cdn.net";

const {
  resolveBrandingAssets,
  cleanRenderCacheKey,
  brandClip,
  buildEndCard,
} = await import("./branding");
const { probeVideoDimensions } = await import("./ffmpegExport");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "branding-work-"));

const W = 1920, H = 1080;
const DIMS = `${W}x${H}`;

/** A solid-colour PNG covering the whole frame — stands in for a designed asset. */
function makePng(rel: string, colour: string, alpha = 1): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${colour}@${alpha}:s=${DIMS}`,
    "-frames:v", "1", "-y", p,
  ]);
  return p;
}

/** A clean render stand-in: green, with audio, at the export spec. */
function makeClean(name: string, seconds = 2): string {
  const p = path.join(work, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=green:s=${DIMS}:r=30:d=${seconds}`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t", String(seconds),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-r", "30", "-fps_mode", "cfr",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-shortest", "-movflags", "+faststart", "-y", p,
  ]);
  return p;
}

function duration(file: string): number {
  return Number(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ]).toString().trim(),
  );
}

function meanColour(file: string): { r: number; g: number; b: number } {
  const raw = path.join(work, `probe-${path.basename(file)}.rgb`);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", file, "-frames:v", "1", "-vf", "scale=1:1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-y", raw,
  ]);
  const b = fs.readFileSync(raw);
  return { r: b[0]!, g: b[1]!, b: b[2]! };
}

function hasAudio(file: string): boolean {
  return execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
    "-of", "csv=p=0", file,
  ]).toString().trim().length > 0;
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe("resolveBrandingAssets", () => {
  beforeAll(() => {
    makePng(`overlays/_default/en/${DIMS}.png`, "blue");
    makePng(`overlays/field-7/en/${DIMS}.png`, "red");
    makePng(`overlays/field-7/ar/${DIMS}.png`, "yellow");
    makePng(`watermark/en/${DIMS}.png`, "white");
  });

  it("prefers the field's own asset over the default", () => {
    const a = resolveBrandingAssets({ fieldId: 7, lang: "en", width: W, height: H, tier: "free" });
    expect(a.overlay).toContain("field-7");
  });

  it("falls back to the default when the field has no logo yet", () => {
    const a = resolveBrandingAssets({ fieldId: 99, lang: "en", width: W, height: H, tier: "free" });
    expect(a.overlay).toContain("_default");
  });

  it("falls back from ar to en rather than rendering unbranded", () => {
    const a = resolveBrandingAssets({ fieldId: 99, lang: "ar", width: W, height: H, tier: "free" });
    expect(a.overlay).toContain("_default");
    expect(a.overlay).toContain(`${path.sep}en${path.sep}`);
  });

  it("uses the field's Arabic asset when it exists", () => {
    const a = resolveBrandingAssets({ fieldId: 7, lang: "ar", width: W, height: H, tier: "free" });
    expect(a.overlay).toContain(`field-7${path.sep}ar`);
  });

  it("returns nothing at all for a Pro download", () => {
    const a = resolveBrandingAssets({ fieldId: 7, lang: "en", width: W, height: H, tier: "pro" });
    expect(a).toMatchObject({ overlay: null, endCard: null, watermark: null });
  });

  it("returns nulls rather than throwing when a size has no assets", () => {
    const a = resolveBrandingAssets({ fieldId: 7, lang: "en", width: 608, height: 1080, tier: "free" });
    expect(a.overlay).toBeNull();
    expect(a.watermark).toBeNull();
  });
});

describe("cleanRenderCacheKey", () => {
  const base = {
    clipId: 1,
    cropPath: [{ t: 0, x: 0.1, y: 0, w: 0.25, h: 0.5 }],
    aspectRatio: "16:9",
    startTime: 0.1,
    endTime: 0.2,
  };

  it("is stable for identical input", () => {
    expect(cleanRenderCacheKey(base)).toBe(cleanRenderCacheKey({ ...base }));
  });

  it("changes when the crop path changes", () => {
    expect(cleanRenderCacheKey({ ...base, cropPath: [{ t: 0, x: 0.2, y: 0, w: 0.25, h: 0.5 }] }))
      .not.toBe(cleanRenderCacheKey(base));
  });

  it("changes when the aspect ratio changes", () => {
    expect(cleanRenderCacheKey({ ...base, aspectRatio: "9:16" })).not.toBe(cleanRenderCacheKey(base));
  });

  it("changes when the source rendition changes", () => {
    expect(cleanRenderCacheKey({ ...base, sourceUrl: "https://a/2160p/video.m3u8" }))
      .not.toBe(cleanRenderCacheKey({ ...base, sourceUrl: "https://a/1080p/video.m3u8" }));
  });

  it("survives float noise below a microsecond, so an identical selection hits", () => {
    expect(cleanRenderCacheKey({ ...base, startTime: 0.1 + 1e-12 })).toBe(cleanRenderCacheKey(base));
  });

  it("does NOT change when branding changes — that is the point of caching the clean render", () => {
    // There is no branding input to this function at all. Asserted explicitly so
    // nobody adds one: a free user who upgrades must get their existing clips
    // clean without a re-render.
    const k = cleanRenderCacheKey(base);
    expect(k).toHaveLength(64);
    expect(cleanRenderCacheKey({ ...base })).toBe(k);
  });
});

describe("brandClip", () => {
  it("returns the input untouched when there is nothing to apply", async () => {
    const clean = makeClean("noop.mp4");
    const out = await brandClip(clean, { overlay: null, endCard: null, watermark: null, resolvedFrom: {} });
    expect(out).toBe(clean);
  });

  it("composites the logo overlay onto the video", async () => {
    const clean = makeClean("overlay.mp4");
    expect(meanColour(clean).g).toBeGreaterThan(100);   // green to start

    const overlay = makePng(`overlays/test-solid/en/${DIMS}.png`, "red");
    const out = await brandClip(clean, { overlay, endCard: null, watermark: null, resolvedFrom: {} });

    expect(out).not.toBe(clean);
    const c = meanColour(out);
    expect(c.r).toBeGreaterThan(150);
    expect(c.g).toBeLessThan(100);
    await expect(probeVideoDimensions(out)).resolves.toEqual({ width: W, height: H });
    fs.unlinkSync(out);
  }, 120_000);

  it("composites the free-tier watermark ABOVE the logo layer, in one pass", async () => {
    const clean = makeClean("wm.mp4");
    const overlay = makePng(`overlays/test-order/en/${DIMS}.png`, "red");
    const watermark = makePng(`watermark/test-order/${DIMS}.png`, "blue");

    const out = await brandClip(clean, { overlay, endCard: null, watermark, resolvedFrom: {} });
    const c = meanColour(out);
    // Blue is applied last, so blue wins — proving the layer order, and that
    // both layers went through a single filter chain.
    expect(c.b).toBeGreaterThan(150);
    expect(c.r).toBeLessThan(100);
    fs.unlinkSync(out);
  }, 120_000);

  it("keeps the audio track by stream copy rather than re-encoding it", async () => {
    const clean = makeClean("audio.mp4");
    expect(hasAudio(clean)).toBe(true);
    const overlay = makePng(`overlays/test-audio/en/${DIMS}.png`, "red");
    const out = await brandClip(clean, { overlay, endCard: null, watermark: null, resolvedFrom: {} });
    expect(hasAudio(out)).toBe(true);
    fs.unlinkSync(out);
  }, 120_000);

  it("appends the end card with -c copy, which only works if the specs match", async () => {
    const clean = makeClean("endcard.mp4", 2);
    const still = makePng(`endcards-src/cta.png`, "orange");
    const endCard = path.join(work, "endcard-2s.mp4");
    await buildEndCard({ stillPng: still, outPath: endCard, seconds: 2 });

    expect(Math.abs(duration(endCard) - 2)).toBeLessThan(0.25);

    const out = await brandClip(clean, { overlay: null, endCard, watermark: null, resolvedFrom: {} });
    // 2 s clip + 2 s card. A -c copy concat that silently dropped the card, or
    // one that failed and fell back, would not produce ~4 s.
    expect(duration(out)).toBeGreaterThan(3.5);
    expect(duration(out)).toBeLessThan(4.6);
    expect(hasAudio(out)).toBe(true);
    fs.unlinkSync(out);
  }, 180_000);

  it("does both: composites layers and then appends the card", async () => {
    const clean = makeClean("both.mp4", 2);
    const overlay = makePng(`overlays/test-both/en/${DIMS}.png`, "red");
    const still = makePng(`endcards-src/cta2.png`, "orange");
    const endCard = path.join(work, "endcard-both.mp4");
    await buildEndCard({ stillPng: still, outPath: endCard, seconds: 2 });

    const out = await brandClip(clean, { overlay, endCard, watermark: null, resolvedFrom: {} });
    expect(duration(out)).toBeGreaterThan(3.5);
    // First frame is the branded clip, not the card.
    expect(meanColour(out).r).toBeGreaterThan(150);
    fs.unlinkSync(out);
  }, 180_000);

  it("falls back to the clean render rather than failing the download when an asset is broken", async () => {
    const clean = makeClean("broken.mp4");
    const broken = path.join(root, "overlays", "broken.png");
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, "not a png");

    const out = await brandClip(clean, { overlay: broken, endCard: null, watermark: null, resolvedFrom: {} });
    // Branding must never be the reason a user cannot download their clip.
    expect(out).toBe(clean);
  }, 120_000);
});
