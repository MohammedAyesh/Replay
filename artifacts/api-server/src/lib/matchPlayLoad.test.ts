import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackingManifest } from "@workspace/db";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  cameraForRecording: vi.fn(),
  manifestWithPitchModel: vi.fn(),
  readClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
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
vi.mock("./claimMatchStorage", () => ({
  readClaimSegment: mocks.readClaimSegment,
  writeClaimSegment: mocks.writeClaimSegment,
  claimObjectPath: (relativePath: string) => `/objects/claim-match/${relativePath}`,
}));

import { recordingTrackingSegmentsTable } from "@workspace/db";
import {
  fromSnapshotData,
  jsonSafe,
  loadRecordingPlay,
  playCache,
  snapshotPath,
  toSnapshotData,
  withFreshManifest,
  type RecordingPlay,
} from "./matchPlayLoad";

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

describe("saved compact plays", () => {
  // one segment with a ball touch, so deriving the play reads the segment
  const manifest = {
    frameRate: 20,
    duration: 600,
    pitchModel: null,
    provenance: null,
    segments: [{ index: 0, ballPath: "/objects/claim-match/ball/0.json" }],
  } as unknown as TrackingManifest;
  const sidecar = {
    v: 1, fps: 20,
    touches: [[200, 100, 100, 140, 200, 0.9, null, 0]],
    ball: [[200, 120, 190], [205, 125, 190]],
    kits: { t1: [160, 129, 123, 300] },
  };
  const segment = {
    tracks: [{ id: "s0:t1", boxes: [{ frame: 200, x: 100, y: 100, w: 40, h: 100 }] }],
    events: [{ type: "goal", time: 12 }],
    inPlaySpans: [{ start: 0, end: 300 }],
  };
  const bundle = { id: 7, updatedAt: new Date("2026-11-01T00:00:00.000Z"), manifest };
  let stored: Map<string, string>;

  beforeEach(() => {
    playCache.clear();
    vi.clearAllMocks();
    stored = new Map();
    mocks.cameraForRecording.mockResolvedValue({ cameraId: "camera-1", pitchModel: null });
    mocks.manifestWithPitchModel.mockImplementation((m) => m);
    mocks.select.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: () => table === recordingTrackingSegmentsTable
          ? { orderBy: async () => [{ objectPath: "/objects/claim-match/seg/0.json" }] }
          : Promise.resolve([bundle]),
      }),
    }));
    mocks.readClaimSegment.mockImplementation(async (path: string) => {
      if (path === "/objects/claim-match/ball/0.json") return Buffer.from(JSON.stringify(sidecar));
      if (path === "/objects/claim-match/seg/0.json") return Buffer.from(JSON.stringify(segment));
      const saved = stored.get(path);
      if (saved === undefined) throw new Error("No such object");
      return Buffer.from(saved);
    });
    mocks.writeClaimSegment.mockImplementation(async (relativePath: string, payload: unknown) => {
      const body = JSON.stringify(payload);
      stored.set(`/objects/claim-match/${relativePath}`, body);
      return { objectPath: `/objects/claim-match/${relativePath}`, compressedBytes: body.length };
    });
  });

  afterEach(() => {
    delete process.env.PLAY_DERIVE_SOURCE;
  });

  const segmentReads = () => mocks.readClaimSegment.mock.calls.filter(([path]) => path === "/objects/claim-match/seg/0.json").length;

  it("saves a derived play, and a cold instance reads it back equal without reading the segments", async () => {
    process.env.PLAY_DERIVE_SOURCE = "code-a";
    const derived = (await loadRecordingPlay(410))!;
    expect(segmentReads()).toBe(1);
    expect(derived.hasBall).toBe(true);
    await vi.waitFor(() => expect(mocks.writeClaimSegment).toHaveBeenCalledTimes(1));
    const [relativePath] = mocks.writeClaimSegment.mock.calls[0];
    expect(relativePath).toMatch(/^play-snapshots\/410\/[0-9a-f]{32}\.json$/);

    playCache.clear(); // another instance, or this one after a restart
    mocks.readClaimSegment.mockClear();
    const refreshed = { ...manifest, identities: [{ id: "claimed since" }] } as unknown as TrackingManifest;
    bundle.manifest = refreshed;
    try {
      const saved = (await loadRecordingPlay(410))!;
      expect(segmentReads()).toBe(0);
      expect(mocks.readClaimSegment).toHaveBeenCalledTimes(1);
      expect(saved.manifest).toBe(refreshed);
      expect(saved.segments).toBeNull();
      expect(saved.kits).toEqual(derived.kits);
      expect(toSnapshotData(saved)).toEqual(toSnapshotData(derived));
      expect(saved.touches).toEqual(derived.touches);
      expect(saved.events).toEqual(derived.events);
      expect(saved.inPlay).toEqual(derived.inPlay);
      expect(mocks.writeClaimSegment).toHaveBeenCalledTimes(1);
      // and it is the cached play from then on
      expect(playCache.get(410)?.data.touches).toEqual(derived.touches);
    } finally {
      bundle.manifest = manifest;
    }
  });

  it("derives afresh after a code change (a different PLAY_DERIVE_SOURCE)", async () => {
    process.env.PLAY_DERIVE_SOURCE = "code-a";
    await loadRecordingPlay(410);
    await vi.waitFor(() => expect(mocks.writeClaimSegment).toHaveBeenCalledTimes(1));
    playCache.clear();
    process.env.PLAY_DERIVE_SOURCE = "code-b";
    await loadRecordingPlay(410);
    expect(segmentReads()).toBe(2);
    await vi.waitFor(() => expect(mocks.writeClaimSegment).toHaveBeenCalledTimes(2));
    expect(snapshotPath(410, "k", "code-a")).not.toBe(snapshotPath(410, "k", "code-b"));
  });

  it("never saves or reads one for a load that keeps the segments", async () => {
    process.env.PLAY_DERIVE_SOURCE = "code-a";
    const play = (await loadRecordingPlay(410, { keepSegments: true }))!;
    expect(play.segments).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.writeClaimSegment).not.toHaveBeenCalled();
    expect(mocks.readClaimSegment.mock.calls.every(([path]) => !String(path).includes("play-snapshots"))).toBe(true);
  });

  it("saves and reads nothing without PLAY_DERIVE_SOURCE (tests, a bare run)", async () => {
    await loadRecordingPlay(410);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.writeClaimSegment).not.toHaveBeenCalled();
    expect(mocks.readClaimSegment.mock.calls.every(([path]) => !String(path).includes("play-snapshots"))).toBe(true);
  });

  it("ignores a saved play written for another key", async () => {
    process.env.PLAY_DERIVE_SOURCE = "code-a";
    await loadRecordingPlay(410);
    await vi.waitFor(() => expect(mocks.writeClaimSegment).toHaveBeenCalledTimes(1));
    const [path] = [...stored.keys()];
    const body = JSON.parse(stored.get(path)!);
    stored.set(path, JSON.stringify({ ...body, key: "something else" }));
    playCache.clear();
    await loadRecordingPlay(410);
    expect(segmentReads()).toBe(2);
  });

  it("only saves what JSON keeps exactly", () => {
    expect(jsonSafe({ a: [1, 2.5, null, "x", true], b: { c: [[1, 2]] }, d: undefined })).toBe(true);
    expect(jsonSafe({ a: Number.NaN })).toBe(false);
    expect(jsonSafe({ a: [Infinity] })).toBe(false);
    expect(jsonSafe({ a: [1, undefined] })).toBe(false);
    expect(jsonSafe({ a: new Date() })).toBe(false);
    expect(jsonSafe({ a: new Map() })).toBe(false);
    const play = {
      recordingId: 1, manifest, fps: 20, hasBall: false, hasPitch: false, hasKits: false,
      sidecars: [], touches: [], rejected: { noTrack: 0, tooFar: 0 }, kitOptions: [], bib: null,
      segments: null, kits: new Map(), events: [], dribbles: [], teleports: 0, inPlay: null, phases: null,
      direction: null,
    } as RecordingPlay;
    expect(toSnapshotData(play)).not.toBeNull();
    expect(toSnapshotData({ ...play, teleports: Number.NaN })).toBeNull();
    // a direction without its data cannot be saved
    expect(toSnapshotData({ ...play, direction: { kits: [[1, 1, 1], [2, 2, 2]], sideOf: () => 0, attacking: () => null } })).toBeNull();
    const back = fromSnapshotData(toSnapshotData(play)!, manifest);
    expect(back.kits).toBeInstanceOf(Map);
    expect(back.direction).toBeNull();
  });
});
