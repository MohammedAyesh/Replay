import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import demoBrandingRouter from "./demoBranding";
import { renderPreviewMp4 } from "../lib/clipBranding/preview";

const app = express();
app.use("/api", demoBrandingRouter);

const originalTmpDir = process.env.TMPDIR;
const renderTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-branding-render-test-"));

function runFfprobe(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_frames",
      "-show_entries", "format=format_name,duration:stream=codec_name,width,height:frame=key_frame,best_effort_timestamp_time",
      "-of", "json",
      file,
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe failed with code ${code}: ${stderr}`));
    });
  });
}

beforeAll(() => {
  process.env.TMPDIR = renderTempDir;
});

afterAll(() => {
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  fs.rmSync(renderTempDir, { recursive: true, force: true });
  expect(fs.existsSync(renderTempDir)).toBe(false);
});

describe("real public demo branding MP4 preview", () => {
  it("renders the bundled landscape sample to an 8-second MP4 and serves byte ranges", async () => {
    const look = {
      nameEn: "Demo preview",
      nameAr: null,
      taglineAr: null,
      primaryColor: "#AABBCC",
      accentColor: null,
      bookingPhone: null,
      instagram: null,
      crest: null,
      isAcademy: false,
    };
    const previewFile = await renderPreviewMp4({
      look,
      lookKey: JSON.stringify(["custom", "pitch", "Demo preview", "#AABBCC"]),
      kind: "signOff",
      dims: { w: 1920, h: 1080 },
      seconds: 3,
      blur: 22,
      dim: 0.5,
    });
    const probe = JSON.parse(await runFfprobe(previewFile)) as {
      format: { format_name: string; duration: string };
      streams: Array<{ codec_name: string; width?: number; height?: number }>;
      frames: Array<{ key_frame: number; best_effort_timestamp_time: string }>;
    };

    expect(probe.format.format_name).toContain("mp4");
    expect(Number(probe.format.duration)).toBeCloseTo(8, 1);
    expect(probe.frames.some((frame) =>
      frame.key_frame === 1 && Math.abs(Number(frame.best_effort_timestamp_time) - 5) < 1 / 30
    )).toBe(true);
    expect(probe.streams).toContainEqual(expect.objectContaining({
      codec_name: "h264",
      width: 1920,
      height: 1080,
    }));
    expect(probe.streams).toContainEqual(expect.objectContaining({ codec_name: "aac" }));

    const firstBytes = fs.readFileSync(previewFile).subarray(0, 32);
    const response = await request(app)
      .get("/api/demo/branding/preview.mp4?look=custom&name=Demo%20preview&color=%23AABBCC&kind=signOff&aspect=16%3A9")
      .set("Range", "bytes=0-31")
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(206);

    expect(response.headers["content-type"]).toMatch(/video\/mp4/);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-range"]).toBe(`bytes 0-31/${fs.statSync(previewFile).size}`);
    expect(response.body).toEqual(firstBytes);
  }, 300_000);
});
