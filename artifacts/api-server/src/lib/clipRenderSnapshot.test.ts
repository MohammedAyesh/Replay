import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import type { RenderSnapshotDocument } from "@workspace/db";
import { cleanupTempFile, probeVideoDimensions, probeVideoTiming, renderClip } from "./ffmpegExport";
import { clipRenderOptionsFromSnapshot } from "./clipRenderSnapshot";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "clip-snapshot-replay-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe("clip presentation snapshot replay", () => {
  it("re-renders the saved crop and trim with matching duration and decoded frames", async () => {
    const source = path.join(work, "camera-original.mp4");
    execFileSync("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=2",
      "-vf", "drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", source,
    ]);
    const videoId = "snapshot-test-camera-original";
    const buffered = {
      bufferPath: source,
      sourceDurationSec: 2,
      bufferedDuration: 2,
      adjustedOffsetSec: 0,
      sourceTimeOffsetSec: 0,
      sourceDimensions: { width: 640, height: 360 },
    };
    const presentation: RenderSnapshotDocument = {
      schemaVersion: 1,
      renderKind: "user_clip",
      renderer: { name: "camera-original-clip-export", version: "camera-clip-v1" },
      renderedAt: new Date(0).toISOString(),
      source: { kind: "camera-4k", videoId, width: 640, height: 360, durationSec: 2 },
      timeWindow: {
        startSec: 0, endSec: 2, clipDuration: 2,
        bufferedDuration: 2, adjustedOffsetSec: 0, sourceTimeOffsetSec: 0,
        bufferStartFraction: 0, bufferEndFraction: 1,
      },
      crop: [],
      output: { mimeType: "video/mp4", width: 1920, height: 1080, durationMs: 2000 },
      text: { title: "Snapshot replay" },
      branding: { applied: false },
      endCard: null,
      music: { kind: "source-audio" },
      template: { id: null, version: "clip-export-v1" },
      content: { cropPath: [], aspectRatio: "16:9", title: "Snapshot replay" },
      assets: [],
      replayable: true,
      replayabilityReason: null,
    };
    const original = await renderClip({
      videoUrl: source,
      totalDuration: 2,
      startTime: 0,
      endTime: 1,
      cropPath: [],
      aspectRatio: "16:9",
      title: "Snapshot replay",
      sourceDimensions: buffered.sourceDimensions,
    });
    try {
      const replay = await renderClip(clipRenderOptionsFromSnapshot(presentation, videoId, buffered));
      try {
        const [originalTiming, replayTiming] = await Promise.all([probeVideoTiming(original), probeVideoTiming(replay)]);
        expect(Math.abs((originalTiming.duration ?? 0) - (replayTiming.duration ?? 0))).toBeLessThan(0.02);
        expect(await probeVideoDimensions(replay)).toEqual(await probeVideoDimensions(original));
        const decodedFrame = (file: string) => execFileSync("ffmpeg", [
          "-nostdin", "-loglevel", "error", "-ss", "0.6", "-i", file,
          "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ], { maxBuffer: 16 * 1024 * 1024 });
        expect(decodedFrame(replay)).toEqual(decodedFrame(original));
      } finally {
        cleanupTempFile(replay);
      }
    } finally {
      cleanupTempFile(original);
    }
  }, 120_000);
});
