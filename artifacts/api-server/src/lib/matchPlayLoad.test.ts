import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackingManifest } from "@workspace/db";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  cameraForRecording: vi.fn(),
  manifestWithPitchModel: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { select: mocks.select },
  recordingTrackingBundlesTable: { recordingId: "recordingId" },
  recordingTrackingSegmentsTable: { bundleId: "bundleId", segmentIndex: "segmentIndex" },
}));
vi.mock("drizzle-orm", () => ({ asc: vi.fn(() => null), eq: vi.fn(() => null) }));
vi.mock("./cameraPitchModel", () => ({
  cameraForRecording: mocks.cameraForRecording,
  manifestWithPitchModel: mocks.manifestWithPitchModel,
}));
vi.mock("./claimMatchStorage", () => ({ readClaimSegment: vi.fn() }));

import { loadRecordingPlay, playCache, withFreshManifest, type RecordingPlay } from "./matchPlayLoad";

describe("cached recording play manifests", () => {
  beforeEach(() => {
    playCache.clear();
    vi.clearAllMocks();
    mocks.cameraForRecording.mockResolvedValue({ cameraId: "camera-1", pitchModel: null });
    mocks.manifestWithPitchModel.mockImplementation((manifest) => manifest);
  });

  it("returns cached derived play with the freshly read manifest", () => {
    const oldManifest = { identities: [{ id: "old" }] } as unknown as TrackingManifest;
    const freshManifest = { identities: [{ id: "claimed" }] } as unknown as TrackingManifest;
    const cached = {
      manifest: oldManifest,
      recordingId: 393,
      touches: [],
    } as unknown as RecordingPlay;

    const result = withFreshManifest(cached, freshManifest);

    expect(result).not.toBe(cached);
    expect(result.manifest).toBe(freshManifest);
    expect(cached.manifest).toBe(oldManifest);
    expect(result.touches).toBe(cached.touches);
  });

  it("loadRecordingPlay returns the newly read manifest on a cache hit", async () => {
    const firstManifest = {
      frameRate: 20,
      segments: [],
      identities: [{ id: "before-claim" }],
      pitchModel: null,
      provenance: null,
    } as unknown as TrackingManifest;
    const refreshedManifest = {
      ...firstManifest,
      identities: [{ id: "after-claim" }],
    } as unknown as TrackingManifest;
    const bundle = {
      id: "bundle-1",
      updatedAt: new Date("2026-10-12T00:00:00.000Z"),
      manifest: firstManifest,
    };
    let currentBundle = bundle;
    mocks.select.mockImplementation(() => ({
      from: () => ({ where: async () => [currentBundle] }),
    }));

    const initial = await loadRecordingPlay(991);
    expect(initial?.manifest).toBe(firstManifest);

    currentBundle = { ...bundle, manifest: refreshedManifest };
    const refreshed = await loadRecordingPlay(991);

    expect(playCache.get(991)?.data).toBe(initial);
    expect(refreshed).not.toBe(initial);
    expect(refreshed?.manifest).toBe(refreshedManifest);
    expect(refreshed?.touches).toBe(initial?.touches);
  });
});
