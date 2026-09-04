import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const {
  frameStats, scoreFrame, posterCandidateTimes, buildPosterFilter,
  generatePosterFrame, encodePosterFrame, sampleFrameStats, posterCropForClip, probeDuration,
  POSTER_WIDTH, POSTER_HEIGHT,
} = await import("./posterFrame");
const { cropRectAt } = await import("./ffmpegExport");

describe("frame statistics", () => {
  it("reads a flat black frame as zero mean and zero detail", () => {
    expect(frameStats(new Uint8Array(64 * 36))).toEqual({ mean: 0, stddev: 0 });
  });

  it("reads a half-black half-white frame as mid mean and maximum detail", () => {
    const px = new Uint8Array(100);
    px.fill(255, 50);
    const s = frameStats(px);
    expect(s.mean).toBeCloseTo(127.5, 5);
    expect(s.stddev).toBeCloseTo(127.5, 5);
  });

  it("handles an empty buffer rather than dividing by zero", () => {
    expect(frameStats(new Uint8Array(0))).toEqual({ mean: 0, stddev: 0 });
  });
});

describe("scoring", () => {
  it("rejects a black frame outright — this is the case that ships broken share cards", () => {
    expect(scoreFrame({ mean: 2, stddev: 1.5 })).toBe(0);
  });

  it("rejects the frame an H.264 black frame ACTUALLY decodes to", () => {
    // Measured, not assumed: a `color=c=black` clip encoded the way the archive
    // encodes decodes to mean 6.611 / stddev 1.603, not to zero. A naive
    // `mean < 6` floor passes it, and the share card is a black rectangle.
    expect(scoreFrame({ mean: 6.611, stddev: 1.603 })).toBe(0);
  });

  it("rejects a flat mid-grey, which a luma floor alone would pass", () => {
    // Lens cap, fogged dome, colour card: respectable mean, no content.
    expect(scoreFrame({ mean: 128, stddev: 1.1 })).toBe(0);
  });

  it("rejects a blown-out white frame", () => {
    expect(scoreFrame({ mean: 253, stddev: 2 })).toBe(0);
  });

  it("prefers the frame with more going on in it", () => {
    const busy = scoreFrame({ mean: 120, stddev: 55 });
    const flat = scoreFrame({ mean: 120, stddev: 9 });
    expect(busy).toBeGreaterThan(flat);
  });

  it("does not reject a legitimately dark night frame that still has detail", () => {
    // Floodlit pitch against a night sky: low mean, high stddev. Rejecting this
    // would throw away every night match.
    expect(scoreFrame({ mean: 42, stddev: 48 })).toBeGreaterThan(0);
  });
});

describe("candidate selection", () => {
  it("tries the midpoint first", () => {
    expect(posterCandidateTimes(100, 140)[0]).toBe(120);
  });

  it("walks outwards from the midpoint and stays inside the clip", () => {
    const times = posterCandidateTimes(0, 20, 4);
    expect(times[0]).toBe(10);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...times)).toBeLessThanOrEqual(20);
    expect(new Set(times).size).toBe(times.length);
  });

  it("keeps clear of the first and last moments, where fades and cuts live", () => {
    const times = posterCandidateTimes(0, 100, 6);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...times)).toBeLessThanOrEqual(99);
  });

  it("degenerates safely on a zero-length window", () => {
    expect(posterCandidateTimes(50, 50)).toEqual([50]);
  });
});

describe("the poster filter", () => {
  it("covers and trims a wide crop", () => {
    const f = buildPosterFilter({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(f.complex).toBe(false);
    expect(f.filter).toContain("crop=1920:1080:0:0");
    expect(f.filter).toContain("force_original_aspect_ratio=increase");
    expect(f.filter).toContain(`crop=${POSTER_WIDTH}:${POSTER_HEIGHT}`);
  });

  it("letterboxes a tall crop onto a blurred copy rather than cropping the player out", () => {
    const f = buildPosterFilter({ x: 100, y: 0, w: 608, h: 1080 });
    expect(f.complex).toBe(true);
    expect(f.filter).toContain("gblur");
    expect(f.filter).toContain("overlay=(W-w)/2:0");
    expect(f.filter.endsWith("[out]")).toBe(true);
  });
});

describe("cropRectAt", () => {
  it("centres a 16:9 crop when the clip has no pan path", () => {
    expect(cropRectAt([], "16:9", 0.5)).toEqual({ x: 960, y: 0, w: 1920, h: 1080 });
  });

  it("interpolates between keyframes", () => {
    const path = [
      { t: 0, x: 0, y: 0, w: 0.5, h: 1 },
      { t: 1, x: 0.5, y: 0, w: 0.5, h: 1 },
    ];
    expect(cropRectAt(path, "16:9", 0).x).toBe(0);
    expect(cropRectAt(path, "16:9", 1).x).toBe(1920);
    expect(cropRectAt(path, "16:9", 0.5).x).toBe(960);
  });

  it("clamps inside the source so a poster never carries black bars", () => {
    // The render path pads the canvas for this keyframe and produces bars.
    // A share card must not.
    const r = cropRectAt([{ t: 0, x: -0.3, y: 0, w: 0.5, h: 1 }], "16:9", 0);
    expect(r.x).toBe(0);
    expect(r.x + r.w).toBeLessThanOrEqual(3840);
    expect(r.y + r.h).toBeLessThanOrEqual(1080);
  });
});

/**
 * The rest runs real FFmpeg against a real file whose first eight seconds are
 * black — the exact shape of an archive hour that opens on black, which is the
 * failure this module exists to avoid.
 */
describe("against a real video", () => {
  let dir: string;
  let src: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-"));
    src = path.join(dir, "source.mp4");
    const black = path.join(dir, "black.mp4");
    const content = path.join(dir, "content.mp4");
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25", "-y"];

    // 3840x1080, the real source geometry.
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=black:s=3840x1080:r=25:d=8", ...enc, black]);
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi",
      "-i", "testsrc2=s=3840x1080:r=25:d=6", ...enc, content]);

    const list = path.join(dir, "list.txt");
    fs.writeFileSync(list, `file '${black}'\nfile '${content}'\n`);
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "concat", "-safe", "0",
      "-i", list, "-c", "copy", "-y", src]);
  }, 120_000);

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const dimsOf = (jpeg: Buffer) => {
    const p = path.join(dir, `probe-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(p, jpeg);
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", p]).toString().trim();
    return out;
  };

  const meanOf = (jpeg: Buffer) => {
    const p = path.join(dir, `mean-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(p, jpeg);
    const raw = execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", p,
      "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
    return frameStats(new Uint8Array(raw)).mean;
  };

  it("scores the black head of the file at zero and the content after it above zero", async () => {
    const crop = { x: 960, y: 0, w: 1920, h: 1080 };
    const dark = await sampleFrameStats({ sourceUrl: src, crop, atSec: 4 });
    const lit = await sampleFrameStats({ sourceUrl: src, crop, atSec: 11 });
    expect(scoreFrame(dark)).toBe(0);
    expect(scoreFrame(lit)).toBeGreaterThan(10);
  }, 60_000);

  it("walks away from a black midpoint instead of publishing a black tile", async () => {
    // Clip 0-14s: the midpoint at 7s is inside the black head.
    const result = await generatePosterFrame({
      sourceUrl: src, startSec: 0, endSec: 14,
      crop: posterCropForClip([], "16:9"),
    });

    expect(result.candidates[0]!.atSec).toBe(7);         // midpoint tried first
    expect(result.candidates[0]!.score).toBe(0);          // and rejected
    expect(result.atSec).toBeGreaterThan(8);              // settled in the content
    expect(result.degraded).toBe(false);
    expect(dimsOf(result.buffer)).toBe(`${POSTER_WIDTH}x${POSTER_HEIGHT}`);
    expect(meanOf(result.buffer)).toBeGreaterThan(20);    // not a black tile
  }, 120_000);

  it("takes the midpoint and stops when the midpoint is fine", async () => {
    const result = await generatePosterFrame({
      sourceUrl: src, startSec: 9, endSec: 13,
      crop: posterCropForClip([], "16:9"),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.atSec).toBe(11);
    expect(dimsOf(result.buffer)).toBe(`${POSTER_WIDTH}x${POSTER_HEIGHT}`);
  }, 120_000);

  it("produces a 1200x630 card for a 9:16 clip via the blurred-fill path", async () => {
    const crop = cropRectAt([{ t: 0, x: 0.4, y: 0, w: 0.158, h: 1 }], "9:16", 0);
    expect(crop.w / crop.h).toBeLessThan(1);
    const jpeg = await encodePosterFrame({ sourceUrl: src, crop, atSec: 11 });
    expect(dimsOf(jpeg)).toBe(`${POSTER_WIDTH}x${POSTER_HEIGHT}`);
    expect(meanOf(jpeg)).toBeGreaterThan(20);
  }, 120_000);

  it("takes the whole frame when crop is null — the rendered-export path", async () => {
    const jpeg = await encodePosterFrame({ sourceUrl: src, crop: null, atSec: 11, sourceAspect: 3840 / 1080 });
    expect(dimsOf(jpeg)).toBe(`${POSTER_WIDTH}x${POSTER_HEIGHT}`);
  }, 120_000);

  it("reads the duration of the source", async () => {
    expect(await probeDuration(src)).toBeCloseTo(14, 0);
  }, 60_000);

  it("renders the crop it is given, not the whole panorama", async () => {
    // Left third vs right third of testsrc2 are visibly different frames.
    const left = await encodePosterFrame({ sourceUrl: src, crop: { x: 0, y: 0, w: 1280, h: 1080 }, atSec: 11 });
    const right = await encodePosterFrame({ sourceUrl: src, crop: { x: 2560, y: 0, w: 1280, h: 1080 }, atSec: 11 });
    expect(Buffer.compare(left, right)).not.toBe(0);
    expect(Math.abs(meanOf(left) - meanOf(right))).toBeGreaterThan(1);
  }, 120_000);
});
