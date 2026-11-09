import { describe, expect, it } from "vitest";
import { isReplayableCamera4kClipSnapshot } from "./camera4kReclipEligibility";
import { camera4kReclipRevision, isCamera4kReclipWindow } from "./camera4kReclipBatch";

describe("camera 4K re-clip batch timing", () => {
  it("allows only the 22:00–06:00 UTC window", () => {
    expect(isCamera4kReclipWindow(new Date("2026-11-08T21:59:59.999Z"))).toBe(false);
    expect(isCamera4kReclipWindow(new Date("2026-11-08T22:00:00.000Z"))).toBe(true);
    expect(isCamera4kReclipWindow(new Date("2026-11-09T05:59:59.999Z"))).toBe(true);
    expect(isCamera4kReclipWindow(new Date("2026-11-09T06:00:00.000Z"))).toBe(false);
  });

  it("uses a stable revision for safe restart checks", () => {
    expect(camera4kReclipRevision(1126)).toBe("camera4k-20261108-1126");
  });

  it("admits only a complete camera-original presentation snapshot", () => {
    const snapshot = {
      schemaVersion: 1,
      renderKind: "user_clip",
      renderer: { name: "camera-original-clip-export", version: "camera-clip-v1" },
      renderedAt: "2026-11-09T00:00:00.000Z",
      source: { kind: "camera-4k", videoId: "video-guid", width: 4096, height: 1152, durationSec: 90 },
      timeWindow: {
        startSec: 10, endSec: 20, clipDuration: 10,
        bufferedDuration: 60, adjustedOffsetSec: 0, sourceTimeOffsetSec: 0,
      },
      crop: [],
      output: { mimeType: "video/mp4", width: 1920, height: 1080, durationMs: 10_000 },
      text: { title: "Goal" },
      branding: { applied: false },
      endCard: null,
      music: { kind: "source-audio" },
      template: { id: null, version: "clip-export-v1" },
      content: { cropPath: [] },
      assets: [],
      replayable: true,
      replayabilityReason: null,
    };
    expect(isReplayableCamera4kClipSnapshot(snapshot, "video-guid")).toBe(true);
    expect(isReplayableCamera4kClipSnapshot({ ...snapshot, replayable: false }, "video-guid")).toBe(false);
    expect(isReplayableCamera4kClipSnapshot(snapshot, "different-video")).toBe(false);
    expect(isReplayableCamera4kClipSnapshot({
      ...snapshot,
      assets: [{ kind: "overlay", locator: null, sha256: null }],
    }, "video-guid")).toBe(false);
  });
});
