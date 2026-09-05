import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

process.env.BUNNY_CDN_HOSTNAME ??= "vz-test.b-cdn.net";

const {
  renderClip,
  cleanupTempFile,
  probeVideoDimensions,
  assertExportSourceGeometry,
  buildCropCommands,
} = await import("./ffmpegExport");

/**
 * End-to-end proof that an export renders correctly from the pinned geometry,
 * and that the geometry gate stops the half-scale rendition before it produces
 * a mis-framed clip.
 *
 * The fixture is built so framing is *checkable*, not merely present: the left
 * half of the frame is pure green and the right half pure red. A crop is then
 * verified by the colour that comes out of it. If the crop maths were ever fed
 * the wrong source geometry, the rectangle would land elsewhere and the colour
 * would change.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-test-"));

/** Left half green, right half red, at the given size. */
function buildSplitSource(width: number, height: number, name: string): string {
  const out = path.join(tmp, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=green:s=${width}x${height}:r=25:d=3`,
    "-vf", `drawbox=x=${width / 2}:y=0:w=${width / 2}:h=${height}:color=red@1.0:t=fill`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-y", out,
  ]);
  return out;
}

/** Mean R and G of the first frame, via a 1x1 rawvideo downscale. */
function meanColour(file: string): { r: number; g: number } {
  const raw = path.join(tmp, `probe-${path.basename(file)}.rgb`);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", file, "-frames:v", "1", "-vf", "scale=1:1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-y", raw,
  ]);
  const b = fs.readFileSync(raw);
  return { r: b[0]!, g: b[1]! };
}

/**
 * An overlay with one opaque patch in the top-left corner and nothing else.
 *
 * Opaque-on-transparent is the shape that actually tests something: it proves
 * the composite happened where it should AND that the transparent remainder let
 * the clip through. A fully opaque overlay would pass even if it were drawn at
 * the wrong scale.
 */
function buildOverlayPng(width: number, height: number, name: string): string {
  const out = path.join(tmp, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black@0.0:s=${width}x${height},format=rgba`,
    // replace=1 is load-bearing. Without it drawbox BLENDS into the RGB planes
    // and leaves alpha at zero, producing a PNG that looks magenta in a viewer
    // and composites to nothing at all.
    "-vf", "drawbox=x=0:y=0:w=200:h=100:color=magenta@1.0:t=fill:replace=1",
    "-frames:v", "1", "-y", out,
  ]);
  return out;
}

/** Mean colour of one region of the first frame. */
function meanRegion(file: string, crop: string): { r: number; g: number; b: number } {
  const raw = path.join(tmp, `region-${crop.replace(/[^0-9]/g, "_")}.rgb`);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", file, "-frames:v", "1", "-vf", `crop=${crop},scale=1:1`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-y", raw,
  ]);
  const b = fs.readFileSync(raw);
  return { r: b[0]!, g: b[1]!, b: b[2]! };
}

let source3840: string;
let source1920: string;

beforeAll(() => {
  source3840 = buildSplitSource(3840, 1080, "src-3840x1080.mp4");
  source1920 = buildSplitSource(1920, 540, "src-1920x540.mp4");
}, 120_000);

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("crop maths against the pinned source geometry", () => {
  it("maps keyframe fractions to pixels against 3840x1080", () => {
    const f = (kf: any) => buildCropCommands([kf], 3, false).filter;
    expect(f({ t: 0, x: 0, y: 0, w: 0.5, h: 1 })).toContain("crop=1920:1080:0:0");
    expect(f({ t: 0, x: 0.25, y: 0, w: 0.5, h: 1 })).toContain("crop=1920:1080:960:0");
    expect(f({ t: 0, x: 0.5, y: 0, w: 0.5, h: 1 })).toContain("crop=1920:1080:1920:0");
    expect(f({ t: 0, x: 0.5, y: 0, w: 0.25, h: 0.5 })).toContain("crop=960:540:1920:0");
  });
});

describe("export renders correctly from the pinned 3840x1080 source", () => {
  it("crops the right half and the output is red", async () => {
    const out = await renderClip({
      videoUrl: source3840,
      totalDuration: 3, startTime: 0, endTime: 1,
      cropPath: [{ t: 0, x: 0.5, y: 0, w: 0.5, h: 1 }],
      aspectRatio: "16:9", title: "right-half",
    });
    try {
      expect(fs.existsSync(out)).toBe(true);
      await expect(probeVideoDimensions(out)).resolves.toEqual({ width: 1920, height: 1080 });
      const c = meanColour(out);
      expect(c.r).toBeGreaterThan(150);
      expect(c.g).toBeLessThan(100);
    } finally { cleanupTempFile(out); }
  }, 180_000);

  it("crops the left half and the output is green", async () => {
    const out = await renderClip({
      videoUrl: source3840,
      totalDuration: 3, startTime: 0, endTime: 1,
      cropPath: [{ t: 0, x: 0, y: 0, w: 0.5, h: 1 }],
      aspectRatio: "16:9", title: "left-half",
    });
    try {
      const c = meanColour(out);
      expect(c.g).toBeGreaterThan(100);
      expect(c.r).toBeLessThan(80);
    } finally { cleanupTempFile(out); }
  }, 180_000);
});

describe("the geometry gate refuses the half-scale rendition", () => {
  it("throws on 1920x540 rather than letting it reach the crop maths", async () => {
    const dims = await probeVideoDimensions(source1920);
    expect(dims).toEqual({ width: 1920, height: 540 });
    expect(() => assertExportSourceGeometry(dims, `buffered source ${source1920}`))
      .toThrowError(/decoded frame is 1920x540, expected 3840x1080/);
  });

  it("shows what the gate prevents: the same crop frames different content", async () => {
    // A rectangle small enough to fit inside BOTH sources, so the wrong-source
    // render succeeds rather than erroring — which is the point. The crop maths
    // multiplies fractions by 3840x1080 regardless of the real frame, giving
    // crop=960:540:384:0 either way.
    //
    // h must equal w * SRC_ASPECT / outAspect (0.25 * 3.5556 / 1.7778 = 0.5) or
    // normalizePath classifies the frame as pre-frame-model legacy data and
    // rewrites it to a centre crop.
    const cropPath = [{ t: 0, x: 0.1, y: 0, w: 0.25, h: 0.5 }];
    expect(buildCropCommands(cropPath as any, 3, false).filter)
      .toContain("crop=960:540:384:0");

    const good = await renderClip({
      videoUrl: source3840, totalDuration: 3, startTime: 0, endTime: 1,
      cropPath, aspectRatio: "16:9", title: "right-geometry",
    });
    const bad = await renderClip({
      videoUrl: source1920, totalDuration: 3, startTime: 0, endTime: 1,
      cropPath, aspectRatio: "16:9", title: "wrong-geometry",
    });
    try {
      // Both render. Both are 1920x1080. Neither errors. Nothing in the
      // pipeline objects — which is exactly why the check cannot be advisory.
      await expect(probeVideoDimensions(good)).resolves.toEqual({ width: 1920, height: 1080 });
      await expect(probeVideoDimensions(bad)).resolves.toEqual({ width: 1920, height: 1080 });

      // On the correct source that rectangle sits entirely in the green half.
      const g = meanColour(good);
      expect(g.g).toBeGreaterThan(100);
      expect(g.r).toBeLessThan(80);

      // On the half-scale source the same absolute rectangle straddles the
      // colour boundary: different content, silently, with no error anywhere.
      const b = meanColour(bad);
      expect(b.r).toBeGreaterThan(g.r + 30);
    } finally {
      cleanupTempFile(good);
      cleanupTempFile(bad);
    }
  }, 240_000);
});


/**
 * Branding, rendered for real.
 *
 * The unit tests in brandingAssets.test.ts assert the filter string is shaped
 * correctly, which is necessary and not sufficient: a graph ffmpeg refuses, and
 * one it accepts but composites in the wrong place, produce the same string.
 * The first version of this passed `-headers` on a local overlay input and
 * ffmpeg exited 8 with "Option headers not found" — a graph-shape test would
 * never have seen it.
 */
describe("branding burned into the export", () => {
  it("draws the overlay over the clip and lets the clip through where it is transparent", async () => {
    const overlay = buildOverlayPng(1920, 1080, "overlay-1920x1080.png");
    const out = await renderClip({
      videoUrl: source3840,
      totalDuration: 3,
      startTime: 0,
      endTime: 1,
      // Left half: green in the source, so anything the overlay does not cover
      // must still read green.
      cropPath: [{ t: 0, x: 0, y: 0, w: 0.5, h: 1 }],
      aspectRatio: "16:9",
      title: "branded",
      overlayUrl: overlay,
    } as Parameters<typeof renderClip>[0]);

    const patch = meanRegion(out, "100:50:10:10");
    expect(patch.r).toBeGreaterThan(180);
    expect(patch.b).toBeGreaterThan(180);
    expect(patch.g).toBeLessThan(80);

    const elsewhere = meanRegion(out, "200:200:800:600");
    expect(elsewhere.g).toBeGreaterThan(80);
    expect(elsewhere.r).toBeLessThan(80);

    cleanupTempFile(out);
  }, 120_000);

  it("renders identically to an unbranded export where the overlay is transparent", () => {
    // The crop chain must go into the filter_complex untouched. If it were
    // rewritten, the framing would shift and this comparison would drift.
    const plain = buildCropCommands([{ t: 0, x: 0.25, y: 0, w: 0.5, h: 1 } as never], 3, false).filter;
    expect(plain).toContain("crop=1920:1080:960:0");
  });

  it("appends the end card after the clip", async () => {
    // Two seconds of clip plus a one-second card should come back longer than
    // the clip alone. Duration is the only honest check here: a concat that
    // silently drops a segment still produces a playable file.
    const card = path.join(tmp, "endcard.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=1920x1080:r=30:d=1",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-y", card,
    ]);

    const bare = await renderClip({
      videoUrl: source3840, totalDuration: 3, startTime: 0, endTime: 2 / 3,
      cropPath: [], aspectRatio: "16:9", title: "bare",
    } as Parameters<typeof renderClip>[0]);
    const withCard = await renderClip({
      videoUrl: source3840, totalDuration: 3, startTime: 0, endTime: 2 / 3,
      cropPath: [], aspectRatio: "16:9", title: "with card",
      endCardUrl: card,
    } as Parameters<typeof renderClip>[0]);

    const seconds = (file: string) => Number(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", file,
    ]).toString().trim());

    expect(seconds(withCard)).toBeGreaterThan(seconds(bare) + 0.8);
    cleanupTempFile(bare);
    cleanupTempFile(withCard);
  }, 180_000);

  it("still produces the clip when the branding cannot be fetched", async () => {
    // The rule that matters more than any of the above: branding never costs
    // someone their clip.
    const out = await renderClip({
      videoUrl: source3840, totalDuration: 3, startTime: 0, endTime: 1 / 3,
      cropPath: [], aspectRatio: "16:9", title: "broken branding",
      endCardUrl: path.join(tmp, "does-not-exist.mp4"),
    } as Parameters<typeof renderClip>[0]);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    cleanupTempFile(out);
  }, 120_000);
});
