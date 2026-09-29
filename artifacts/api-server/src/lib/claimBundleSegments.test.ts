import { describe, expect, it, vi } from "vitest";
import type { TrackingSegmentPayload } from "@workspace/db";

import { captureDecisionGeometry, normaliseChain } from "./claimChain";
import { loadClaimBundleSegments } from "./claimBundleSegments";
import { logger } from "./logger";

let testKey = 0;
const uniqueKey = (name: string) => `${name}-${testKey++}`;

function fixture(trackId: string): TrackingSegmentPayload[] {
  return [{
    segmentIndex: 0,
    startFrame: 0,
    endFrame: 10,
    startSeconds: 0,
    endSeconds: 0.4,
    tracks: [{
      id: trackId,
      label: null,
      startFrame: 0,
      endFrame: 10,
      boxes: [{ frame: 0, x: 10, y: 20, w: 5, h: 10 }],
    }],
    crossings: [],
    inPlaySpans: [{ start: 0, end: 10 }],
    events: [],
  } as unknown as TrackingSegmentPayload];
}

describe("claim bundle segment cache", () => {
  it("reuses parsed segments and the track index on sequential requests", async () => {
    const key = uniqueKey("same-bundle");
    const load = vi.fn(async () => fixture("track-a"));

    const first = await loadClaimBundleSegments(key, load);
    const second = await loadClaimBundleSegments(key, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second.tracksById.get("track-a")).toBe(first.segments[0].tracks[0]);
  });

  it("shares one in-flight read between concurrent requests", async () => {
    const key = uniqueKey("concurrent-bundle");
    let resolve!: (segments: TrackingSegmentPayload[]) => void;
    const read = new Promise<TrackingSegmentPayload[]>((done) => { resolve = done; });
    const load = vi.fn(() => read);

    const requests = Array.from({ length: 8 }, () => loadClaimBundleSegments(key, load));
    resolve(fixture("track-b"));
    const results = await Promise.all(requests);

    expect(load).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === results[0])).toBe(true);
  });

  it("reloads after a replacement uses a new bundle-version key", async () => {
    const oldKey = uniqueKey("bundle-old");
    const replacementKey = uniqueKey("bundle-new");
    const loadOld = vi.fn(async () => fixture("old-track"));
    const loadReplacement = vi.fn(async () => fixture("new-track"));

    const oldBundle = await loadClaimBundleSegments(oldKey, loadOld);
    const replacement = await loadClaimBundleSegments(replacementKey, loadReplacement);

    expect(loadOld).toHaveBeenCalledTimes(1);
    expect(loadReplacement).toHaveBeenCalledTimes(1);
    expect(replacement).not.toBe(oldBundle);
    expect(replacement.tracksById.has("old-track")).toBe(false);
    expect(replacement.tracksById.has("new-track")).toBe(true);
  });

  it("keeps only two bundles and evicts the least-recently-used entry", async () => {
    const a = uniqueKey("lru-a");
    const b = uniqueKey("lru-b");
    const c = uniqueKey("lru-c");
    const loadA = vi.fn(async () => fixture("track-a"));
    const loadB = vi.fn(async () => fixture("track-b"));
    const loadC = vi.fn(async () => fixture("track-c"));

    await loadClaimBundleSegments(a, loadA);
    await loadClaimBundleSegments(b, loadB);
    await loadClaimBundleSegments(a, loadA); // promote A; B becomes least recent
    await loadClaimBundleSegments(c, loadC); // evict B
    await loadClaimBundleSegments(a, loadA);
    await loadClaimBundleSegments(b, loadB);

    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(2);
    expect(loadC).toHaveBeenCalledTimes(1);
  });

  it("evicts before starting a new read, even while that read is still pending", async () => {
    const a = uniqueKey("preload-a");
    const b = uniqueKey("preload-b");
    const c = uniqueKey("preload-c");
    let markReloadAStarted!: () => void;
    const reloadAStarted = new Promise<void>((resolve) => { markReloadAStarted = resolve; });
    const loadA = vi.fn(async () => {
      if (loadA.mock.calls.length === 2) markReloadAStarted();
      return fixture("track-a");
    });
    const loadB = vi.fn(async () => fixture("track-b"));
    await loadClaimBundleSegments(a, loadA);
    await loadClaimBundleSegments(b, loadB);

    let resolveC!: (segments: TrackingSegmentPayload[]) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pendingC = new Promise<TrackingSegmentPayload[]>((resolve) => { resolveC = resolve; });
    const loadC = vi.fn(() => {
      markStarted();
      return pendingC;
    });
    const requestC = loadClaimBundleSegments(c, loadC);
    await started;

    const requestA = loadClaimBundleSegments(a, loadA);
    const reloadedBeforeCFinished = await Promise.race([
      reloadAStarted.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 50); }),
    ]);

    resolveC(fixture("track-c"));
    await Promise.all([requestA, requestC]);
    expect(reloadedBeforeCFinished).toBe(true);
  });

  it("keeps concurrent cached and in-flight bundles within the two-entry limit", async () => {
    const a = uniqueKey("bounded-a");
    const b = uniqueKey("bounded-b");
    const c = uniqueKey("bounded-c");
    let resolveA!: (segments: TrackingSegmentPayload[]) => void;
    let resolveB!: (segments: TrackingSegmentPayload[]) => void;
    let resolveC!: (segments: TrackingSegmentPayload[]) => void;
    let markAStarted!: () => void;
    let markBStarted!: () => void;
    let markCStarted!: () => void;
    const startedA = new Promise<void>((resolve) => { markAStarted = resolve; });
    const startedB = new Promise<void>((resolve) => { markBStarted = resolve; });
    const startedC = new Promise<void>((resolve) => { markCStarted = resolve; });
    const loadA = vi.fn(() => new Promise<TrackingSegmentPayload[]>((resolve) => {
      resolveA = resolve;
      markAStarted();
    }));
    const loadB = vi.fn(() => new Promise<TrackingSegmentPayload[]>((resolve) => {
      resolveB = resolve;
      markBStarted();
    }));
    const loadC = vi.fn(() => new Promise<TrackingSegmentPayload[]>((resolve) => {
      resolveC = resolve;
      markCStarted();
    }));

    const requestA = loadClaimBundleSegments(a, loadA);
    await startedA;
    const requestB = loadClaimBundleSegments(b, loadB);
    await startedB;
    const requestC = loadClaimBundleSegments(c, loadC);
    await Promise.resolve();
    expect(loadC).not.toHaveBeenCalled();

    resolveA(fixture("track-a"));
    await startedC;
    expect(loadC).toHaveBeenCalledTimes(1);
    resolveB(fixture("track-b"));
    resolveC(fixture("track-c"));
    await Promise.all([requestA, requestB, requestC]);
  });

  it("logs the bundle ID, load duration, and heap usage for each read", async () => {
    const log = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      await loadClaimBundleSegments(
        uniqueKey("logged"),
        async () => fixture("logged-track"),
        "bundle-123",
      );

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleId: "bundle-123",
          loadDurationMs: expect.any(Number),
          heapUsedMB: expect.any(Number),
        }),
        "Claim bundle segments loaded",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("does not mutate shared segments or tracks during claim calculations", async () => {
    const source = fixture("readonly-track");
    const before = JSON.stringify(source);
    const data = await loadClaimBundleSegments(uniqueKey("readonly"), async () => source);

    const chain = normaliseChain(
      [{ trackId: "readonly-track", fromFrame: 0, toFrame: 10 }],
      data.tracksById,
    );
    captureDecisionGeometry(data.tracksById, 0, {
      frameRate: 25,
      chosenTrackId: "readonly-track",
    });

    expect(chain).toHaveLength(1);
    expect(JSON.stringify(data.segments)).toBe(before);
  });
});