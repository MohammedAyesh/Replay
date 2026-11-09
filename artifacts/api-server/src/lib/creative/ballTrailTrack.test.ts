import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BallTrailSample, CreativeBrand, Scene } from "@workspace/api-zod";
import { prepareBallTrail, probeFrameTimes, trailWindow } from "./ballTrailTrack";
import { renderSceneMp4 } from "./renderVideo";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ball-trail-test-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const BRAND: CreativeBrand = { primary: "#F4CF1F", accent: "#D4FF4F", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "GALAXY", nameAr: null };

function frameAt(file: string, t: number, x: number, y: number): number[] {
  const raw = execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", `crop=2:2:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...raw.subarray(0, 3)];
}
const isRed = (px: number[]) => px[0] > 150 && px[1] < 110 && px[2] < 110;

/** A ball rolling left to right across the middle: x 0.2 → 0.8 over match seconds 100 → 104, 4 per second. */
const SAMPLES: BallTrailSample[] = Array.from({ length: 17 }, (_, i) => [100 + i / 4, 0.2 + (0.6 * i) / 16, 0.5]);
const ballX = (matchSec: number) => 0.2 + (0.6 * (matchSec - 100)) / 4;

describe("trailWindow", () => {
  it("matches framingCrop: the box's shape at zoom of the width, centred on the keys, kept inside", () => {
    const win = trailWindow({ w: 1920, h: 1080, framing: { zoom: 0.3, keys: [[0, 0.1, 0.5], [2000, 0.9, 0.5]] } }, 1, 3840, 1080);
    expect(win.w).toBe(1152); // trunc(min(3840·0.3, 1080·16/9)/2)·2
    expect(win.h).toBe(648);
    expect(win.at(1).x).toBe(0); // centre 0.1 → clamped at the left edge
    expect(win.at(3).x).toBe(3840 - 1152); // centre 0.9 → clamped at the right edge
    expect(win.at(2).x).toBeCloseTo(0.5 * 3840 - 576, 6);
    expect(trailWindow({ w: 1080, h: 1920 }, 0, 4096, 1152)).toMatchObject({ w: 4096, h: 1152 });
  });
});

describe("ball trail in Creative hub videos", () => {
  // 4 s of plain grass-grey panorama at 20 fps; file 0 is match second 100.
  const pano = path.join(work, "pano.mp4");
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x406040:s=1920x540:r=20:d=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", pano]);
  const videos = async () => ({
    path: pano, zeroAtSec: 0, durationMs: 4000, hasAudio: false,
    sourceDimensions: { width: 1920, height: 540 },
    trailSource: { videoId: "vid-1", fromSec: 100 },
  });
  const scene = (ballTrail: boolean): Scene => ({
    v: 1, format: "wide", durationMs: 3500, background: "#000000", locale: "en",
    layers: [{
      id: "vid", kind: "video", src: { type: "recording", recordingId: 1, fromMs: 0, toMs: 3500 }, x: 0, y: 0, w: 1920, h: 1080, fit: "cover",
      trimInMs: 0, speed: 1, muted: true, ballTrail,
      // The whole width: the trail is drawn where the ball is on the panorama.
      framing: { zoom: 1, keys: [[0, 0.5, 0.5]] },
    }],
  });

  it("draws one frame per footage frame, on the file's clock, with a blank before the ball shows", async () => {
    const times = await probeFrameTimes(pano);
    expect(times.length).toBeGreaterThanOrEqual(80);
    const track = await prepareBallTrail({
      layer: { id: "vid", w: 1920, h: 1080 }, file: { path: pano, zeroAtSec: 0, sourceDimensions: { width: 1920, height: 540 } },
      samples: SAMPLES, fileStartSec: 100, usedFrom: 0, usedTo: 3.5, workDir: work, frameTimes: times,
    });
    expect(track).not.toBeNull();
    expect(track!.drawn).toBeGreaterThan(60);
    const list = fs.readFileSync(track!.list, "utf8");
    expect(list.startsWith("ffconcat version 1.0")).toBe(true);
    expect(list).toContain("blank.png");
  });

  it("lays a red streak behind the ball, ending on it, and none without the switch", async () => {
    const out = path.join(work, "trail.mp4");
    await renderSceneMp4({ scene: scene(true), brand: BRAND, data: {}, videos, workDir: work, out, ballSamples: async () => SAMPLES });
    // Output 1920×1080 shows the whole 1920×540 panorama scaled to cover: the ball at 2 s is at x = ballX(102)·1920.
    // The scene is cover-cropped from a 32:9 window into 16:9, so map through the window the framing gives:
    // zoom 1 on 16:9 fits by height: the window is 960×540 centred → output x = (ballX·1920 − 480)·2.
    const t = 2;
    const headOut = (ballX(100 + t) * 1920 - 480) * 2;
    const behind = frameAt(out, t, Math.round(headOut - 120), 540);
    const ahead = frameAt(out, t, Math.round(headOut + 160), 540);
    expect(isRed(behind)).toBe(true);
    expect(isRed(ahead)).toBe(false);

    const plain = path.join(work, "plain.mp4");
    await renderSceneMp4({ scene: scene(false), brand: BRAND, data: {}, videos, workDir: work, out: plain, ballSamples: async () => SAMPLES });
    expect(isRed(frameAt(plain, t, Math.round(headOut - 120), 540))).toBe(false);
  }, 90_000);

  it("renders the video without a trail when the match has no ball path", async () => {
    const out = path.join(work, "nopath.mp4");
    await renderSceneMp4({ scene: scene(true), brand: BRAND, data: {}, videos, workDir: work, out, ballSamples: async () => null });
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  }, 60_000);
});
