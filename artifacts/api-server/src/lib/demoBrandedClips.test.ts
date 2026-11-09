import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stored: new Set<string>(),
  storageDown: false,
  renderFails: null as Error | null,
  fourKError: null as Error | null,
  savedAvailable: true,
  streamAvailable: false,
  renders: 0,
  sourceAttempts: 0,
  attempts: 0,
  renderArgs: null as any,
  snapshot: { active: 0, waiting: 0, yielding: 0, concurrency: 2, order: [] as string[] },
}));

vi.mock("./bunny", () => {
  class BunnyVideoNotFoundError extends Error {}
  return {
    BunnyVideoNotFoundError,
    BUNNY_CDN_HOSTNAME: "cdn.test",
    BUNNY_STORAGE_API_KEY: "k",
    BUNNY_STORAGE_HOSTNAME: "storage.test",
    BUNNY_STORAGE_ZONE: "zone",
    isBunnyConfigured: () => true,
    isBunnyStorageConfigured: () => true,
    getBunnyVideoInfo: vi.fn(async () => {
      h.attempts += 1;
      if (h.renderFails) throw h.renderFails;
      return { duration: 3600, hasMP4Fallback: true, availableResolutions: "1080p" };
    }),
    uploadFileToBunnyStoragePath: vi.fn(async (_file: string, remote: string) => { h.stored.add(remote); return remote; }),
    uploadBufferToBunnyStorage: vi.fn(async (_buf: Buffer, remote: string) => { h.stored.add(remote); return remote; }),
  };
});
vi.mock("./exportSource", () => {
  class ExportSourceUnavailableError extends Error {}
  return { ExportSourceUnavailableError, selectExportSource: vi.fn(async () => ({ url: "https://cdn.test/v.m3u8" })) };
});
vi.mock("./ffmpegExport", () => ({
  bufferRemoteClip: vi.fn(async () => ({ bufferPath: "/tmp/none-buffer.mp4", bufferedDuration: 20, adjustedOffsetSec: 0 })),
  bufferCameraHlsClip: vi.fn(async () => ({
    bufferPath: "/tmp/none-camera-buffer.mp4",
    bufferedDuration: 20,
    adjustedOffsetSec: 0,
    sourceDimensions: { width: 4096, height: 1152 },
    bufferDimensions: { width: 3840, height: 1080 },
    downloadedBytes: 1,
  })),
  cleanupTempFile: vi.fn(),
  getOutputDims: () => ({ w: 1920, h: 1080 }),
  probeVideoDimensions: vi.fn(async () => ({ width: 1920, height: 1080 })),
  renderClip: vi.fn(async (args: any) => {
    h.renders += 1;
    h.renderArgs = args;
    if (h.renderFails) throw h.renderFails;
    return "/tmp/none-render.mp4";
  }),
}));
vi.mock("./clipExportSource", () => ({
  waitForCamera4kSource: vi.fn(async () => {
    h.sourceAttempts += 1;
    throw h.fourKError ?? new Error("No camera 4K source is available");
  }),
}));
vi.mock("./creative/clipSpan", () => ({
  clipSpan: vi.fn(async () => h.streamAvailable ? { startSec: 10, endSec: 20, thumbSec: null, videoSeconds: 100 } : null),
}));
vi.mock("./creative/renderMedia", () => ({
  bufferStreamClip: vi.fn(async () => ({
    bufferPath: "/tmp/none-stream-buffer.mp4",
    bufferedDuration: 10,
    bufferDimensions: { width: 3840, height: 1080 },
  })),
  downloadSavedClip: vi.fn(async () => h.savedAvailable
    ? { path: "/tmp/none-saved-export.mp4", durationMs: 5_000, hasAudio: true }
    : null),
  playableStream: vi.fn(async () => h.streamAvailable
    ? { url: "https://cdn.test/stream.m3u8", referer: "https://cdn.test/" }
    : null),
}));
vi.mock("./renderQueue", () => ({
  renderQueue: {
    snapshot: () => h.snapshot,
    tryRunImmediately: vi.fn(async (_key: string, job: () => Promise<unknown>) => ({ started: true, snapshot: h.snapshot, completion: job() })),
  },
}));
vi.mock("./clipBranding/demoLook", () => ({ demoBrandLook: vi.fn(async () => ({ nameEn: "JG", nameAr: null, primaryColor: "#F4CF1F" })) }));
vi.mock("./clipBranding/assets", () => ({ loadLocalImage: vi.fn(async () => null), replayMarkPath: () => "/x" }));
vi.mock("./clipBranding/overlay", () => ({ renderOverlayPng: () => Buffer.from("png") }));
vi.mock("./clipBranding/plan", () => ({ dateLabelFromLocal: () => null, publicBase: () => "https://replayjo.com" }));
vi.mock("@workspace/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
  recordingsTable: {},
  userClipsTable: {},
}));
vi.mock("child_process", () => ({
  spawn: () => {
    const handlers: Record<string, (code?: number) => void> = {};
    setTimeout(() => handlers.close?.(0), 0);
    return { stderr: { on: () => {} }, on: (event: string, fn: (code?: number) => void) => { handlers[event] = fn; }, kill: () => {} };
  },
}));
vi.mock("fs", async (orig) => {
  const real = await orig<typeof import("fs")>();
  return {
    ...real,
    default: {
      ...real,
      unlink: (_p: string, cb: () => void) => cb(),
      promises: { ...real.promises, writeFile: async () => {}, readFile: async () => Buffer.from("jpg") },
    },
  };
});

import {
  demoBrandedReadyIds,
  isDemoBrandedReady,
  resetDemoBrandedState,
  setDemoIdlePollMs,
} from "./demoBrandedClips";

const clip = (id: number) => ({ id, videoId: `v${id}`, aspectRatio: "16:9", startTime: "0.1", endTime: "0.11", cropPath: [] }) as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  h.stored.clear();
  h.storageDown = false;
  h.renderFails = null;
  h.fourKError = null;
  h.savedAvailable = true;
  h.streamAvailable = false;
  h.renders = 0;
  h.sourceAttempts = 0;
  h.attempts = 0;
  h.renderArgs = null;
  h.snapshot = { active: 0, waiting: 0, yielding: 0, concurrency: 2, order: [] };
  resetDemoBrandedState();
  setDemoIdlePollMs(5);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (h.storageDown) return new Response(null, { status: 503 });
    const path = url.replace("https://storage.test/zone/", "");
    return new Response(h.stored.has(path) ? "x" : null, { status: h.stored.has(path) ? 206 : 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo branded copies", () => {
  it("renders a missing copy once, then serves it", async () => {
    expect((await demoBrandedReadyIds([clip(1)])).size).toBe(0);
    await settle();
    expect(h.renders).toBe(1);
    expect(isDemoBrandedReady(1)).toBe(true);
    expect([...(await demoBrandedReadyIds([clip(1)]))]).toEqual([1]);
    await settle();
    expect(h.renders).toBe(1);
  });

  it("uses a copy already in Storage without rendering", async () => {
    h.stored.add("demo/branded/galaxy-v1/c2.mp4");
    h.stored.add("demo/branded/galaxy-v1/c2.jpg");
    expect([...(await demoBrandedReadyIds([clip(2)]))]).toEqual([2]);
    await settle();
    expect(h.renders).toBe(0);
  });

  it("renders nothing when Storage cannot say whether the copy exists", async () => {
    h.storageDown = true;
    await demoBrandedReadyIds([clip(3)]);
    await settle();
    expect(h.renders).toBe(0);
  });

  it("waits while players' exports are using the renderer", async () => {
    h.snapshot = { ...h.snapshot, active: 1 };
    await demoBrandedReadyIds([clip(4)]);
    await settle();
    expect(h.renders).toBe(0);
    h.snapshot = { ...h.snapshot, active: 0 };
    await settle();
    expect(h.renders).toBe(1);
  });

  it("retries when camera 4K and fallback sources are temporarily unavailable", async () => {
    h.fourKError = new Error("No camera 4K source is available");
    h.savedAvailable = false;
    let now = Date.now();
    for (let i = 0; i < 5; i++) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      await demoBrandedReadyIds([clip(5)]);
      vi.useRealTimers();
      await settle();
      now += 31 * 60 * 1000;
    }
    expect(h.sourceAttempts).toBe(3);
    expect(h.renders).toBe(0);
  });

  it("gives up on other failures after three tries, half an hour apart", async () => {
    h.renderFails = new Error("encode failed");
    let now = Date.now();
    for (let i = 0; i < 5; i++) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      await demoBrandedReadyIds([clip(6)]);
      vi.useRealTimers();
      await settle();
      now += 31 * 60 * 1000;
    }
    expect(h.renders).toBe(3);
  });

  it("uses a saved export before trying Stream when camera 4K is unavailable", async () => {
    h.streamAvailable = true;
    await demoBrandedReadyIds([clip(8)]);
    await settle();
    expect(h.renders).toBe(1);
    expect(h.renderArgs).toMatchObject({
      videoUrl: "/tmp/none-saved-export.mp4",
      startTime: 0,
      endTime: 1,
      cropPath: [],
      sourceDimensions: { width: 1920, height: 1080 },
    });
  });

  it("buffers the selected Stream window when no saved export exists", async () => {
    h.savedAvailable = false;
    h.streamAvailable = true;
    await demoBrandedReadyIds([clip(9)]);
    await settle();
    expect(h.renders).toBe(1);
    expect(h.renderArgs).toMatchObject({
      videoUrl: "/tmp/none-stream-buffer.mp4",
      startTime: 0,
      endTime: 1,
      sourceDimensions: { width: 3840, height: 1080 },
    });
  });

  it("keeps the academy view's copies apart from the pitch view's", async () => {
    h.stored.add("demo/branded/galaxy-v1/c7.mp4");
    h.stored.add("demo/branded/galaxy-v1/c7.jpg");
    expect([...(await demoBrandedReadyIds([clip(7)]))]).toEqual([7]);
    expect((await demoBrandedReadyIds([clip(7)], "academy")).size).toBe(0);
    await settle();
    expect(h.renders).toBe(1);
    expect(h.stored.has("demo/branded/jufa-v1/c7.mp4")).toBe(true);
    expect([...(await demoBrandedReadyIds([clip(7)], "academy"))]).toEqual([7]);
  });
});
