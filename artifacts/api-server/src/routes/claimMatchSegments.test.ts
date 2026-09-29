import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseUploadedBundleDetailed, parseZipBundle, parseZipBundleDetailed, validateUploadBundle } from "./claimMatch";

function makeZip(manifest: Record<string, unknown>, segments: Record<string, unknown>) {
  return Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    ...Object.fromEntries(Object.entries(segments).map(([name, value]) => [
      `segments/${name}.json`,
      strToU8(JSON.stringify(value)),
    ])),
  }));
}

describe("claim match segmented bundles", () => {
  it("resolves match roster segment/track pairs from the stored segment bounds without offsetting", () => {
    const manifest = {
      version: 1,
      label: "rostered match",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 200,
      duration: 8,
      segmentCount: 1,
      segments: [
        { index: 0, name: "c2", startFrame: 100, endFrame: 199, startSeconds: 4, endSeconds: 8 },
      ],
    };
    const payload = {
      tracks: [{
        id: "t12",
        startFrame: 105,
        endFrame: 150,
        boxes: [
          { frame: 105, x: 1, y: 1, w: 10, h: 20 },
          { frame: 150, x: 2, y: 2, w: 10, h: 20 },
        ],
      }],
      crossings: [],
      inPlaySpans: [],
      events: [],
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "segments/c2.json": strToU8(JSON.stringify(payload)),
      "people/match.json": strToU8(JSON.stringify({
        players: [{
          id: "player-12",
          name: "Sam",
          number: 12,
          minutes: 38,
          parts: [["c2", "t12"]],
        }],
      })),
    });

    const result = parseZipBundleDetailed(Buffer.from(zip));

    expect(result.error).toBeNull();
    expect(result.upload?.matchRoster?.players[0].parts).toEqual([{
      segmentIndex: 0,
      segmentName: "c2",
      trackId: "s0:t12",
      fromFrame: 105,
      toFrame: 150,
    }]);
  });

  it("parses a manifest plus segment files and namespaces local track IDs", () => {
    const manifest = {
      version: 1,
      label: "hour",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 20,
      duration: 0.8,
      segmentCount: 2,
      segments: [
        { index: 0, name: "one", startFrame: 0, endFrame: 9, startSeconds: 0, endSeconds: 0.4 },
        { index: 1, name: "two", startFrame: 10, endFrame: 19, startSeconds: 0.4, endSeconds: 0.8 },
      ],
    };
    const payload = {
      tracks: [{ id: "player-1", startFrame: 0, endFrame: 1, boxes: [{ frame: 0, x: 1, y: 1, w: 10, h: 20 }] }],
      crossings: [],
      inPlaySpans: [{ start: 0, end: 0.08 }],
      events: [],
    };
    const upload = parseZipBundle(makeZip(manifest, { one: payload, two: payload }));
    expect(upload).not.toBeNull();
    expect(upload?.segments[0].tracks[0].id).toBe("s0:player-1");
    expect(upload?.segments[1].tracks[0].id).toBe("s1:player-1");
    expect(validateUploadBundle(upload!)).toBeNull();
  });

  it("accepts one sprite file when the segment name is its positional name", () => {
    const manifest = {
      version: 1,
      label: "positional segment",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 2,
      duration: 0.08,
      segmentCount: 1,
      segments: [
        { index: 0, name: "segment-01", startFrame: 0, endFrame: 1, startSeconds: 0, endSeconds: 0.08 },
      ],
    };
    const payload = {
      tracks: [{ id: "player-1", startFrame: 0, endFrame: 1, boxes: [{ frame: 0, x: 1, y: 1, w: 10, h: 20 }] }],
      crossings: [],
      inPlaySpans: [{ start: 0, end: 0.08 }],
      events: [],
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "segments/segment-01.json": strToU8(JSON.stringify(payload)),
      "sprites/segment-01.json": strToU8(JSON.stringify({
        "player-1": [{ f: 0, j: "base64-jpeg" }],
      })),
    });

    const result = parseZipBundleDetailed(Buffer.from(zip));

    expect(result.error).toBeNull();
    expect(result.upload?.sprites?.[0]).toEqual({
      "s0:player-1": [{ f: 0, j: "base64-jpeg" }],
    });
  });

  it("reads jersey sidecars for every segment in a two-segment bundle", () => {
    const manifest = {
      version: 1,
      label: "two segments with jerseys",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 20,
      duration: 0.8,
      segmentCount: 2,
      segments: [
        { index: 0, name: "one", startFrame: 0, endFrame: 9, startSeconds: 0, endSeconds: 0.4 },
        { index: 1, name: "two", startFrame: 10, endFrame: 19, startSeconds: 0.4, endSeconds: 0.8 },
      ],
    };
    const payload = { tracks: [], crossings: [], inPlaySpans: [], events: [] };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "segments/one.json": strToU8(JSON.stringify(payload)),
      "segments/two.json": strToU8(JSON.stringify(payload)),
      "jersey/one.json": strToU8(JSON.stringify({
        tracks: { t7: { number: "7", seenFrames: 3, confidence: 0.8, frames: [0, 1, 2] } },
      })),
      "jersey/two.json": strToU8(JSON.stringify({
        tracks: { t7: { number: "7", seenFrames: 3, confidence: 0.9, frames: [0, 1, 2] } },
      })),
    });

    const result = parseZipBundleDetailed(Buffer.from(zip));

    expect(result.error).toBeNull();
    expect(result.upload?.jersey?.[0].tracks["s0:t7"].frames).toEqual([0, 1, 2]);
    expect(result.upload?.jersey?.[1].tracks["s1:t7"].frames).toEqual([10, 11, 12]);
    expect(result.upload?.jersey?.[0].numbers).toEqual({ "7": ["s0:t7"] });
    expect(result.upload?.jersey?.[1].numbers).toEqual({ "7": ["s1:t7"] });
  });

  it("rejects gaps between segment frame ranges", () => {
    const upload = {
      manifest: {
        version: 1,
        label: "broken",
        width: 1920,
        height: 1080,
        frameRate: 25,
        frameCount: 5,
        duration: 1,
        matchOffset: 0,
        segmentCount: 2,
        segments: [
          { index: 0, name: "one", startFrame: 0, endFrame: 1, startSeconds: 0, endSeconds: 0.08, objectPath: "" },
          { index: 1, name: "two", startFrame: 3, endFrame: 4, startSeconds: 0.12, endSeconds: 0.2, objectPath: "" },
        ],
      },
      segments: [
        { segmentIndex: 0, name: "one", startFrame: 0, endFrame: 1, startSeconds: 0, endSeconds: 0.08, version: 1, tracks: [], crossings: [], inPlaySpans: [], events: [] },
        { segmentIndex: 1, name: "two", startFrame: 3, endFrame: 4, startSeconds: 0.12, endSeconds: 0.2, version: 1, tracks: [], crossings: [], inPlaySpans: [], events: [] },
      ],
    } as never;
    expect(validateUploadBundle(upload)).toContain("continuous");
  });

  it("accepts documentation files alongside the tracking entries", () => {
    const manifest = {
      version: 1,
      label: "unexpected",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 2,
      duration: 0.08,
      segmentCount: 1,
      segments: [
        { index: 0, name: "one", startFrame: 0, endFrame: 1, startSeconds: 0, endSeconds: 0.08 },
      ],
    };
    const payload = {
      tracks: [],
      crossings: [],
      inPlaySpans: [],
      events: [],
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "segments/one.json": strToU8(JSON.stringify(payload)),
      "notes.txt": strToU8("not tracking data"),
    });

    expect(parseZipBundle(Buffer.from(zip))).not.toBeNull();
  });

  it("rejects archives that exceed the entry-count limit before parsing segments", () => {
    const zip = zipSync(Object.fromEntries([
      ["manifest.json", strToU8("{}")],
      ...Array.from({ length: 512 }, (_, index) => [`extra-${index}.txt`, strToU8("x")]),
    ]));

    expect(parseZipBundle(Buffer.from(zip))).toBeNull();
  });

  it("reports which required metadata is missing on JSON and ZIP uploads", () => {
    const bodyResult = parseUploadedBundleDetailed({
      width: 1920,
      height: 1080,
      frameCount: 1,
      duration: 0.05,
      tracks: [],
      crossings: [],
      inPlaySpans: [],
      events: [],
    });
    expect(bodyResult.error).toBe("Manifest frame rate is required");

    const manifest = {
      version: 1, label: "missing fps", width: 1920, height: 1080,
      frameCount: 2, duration: 0.08, segmentCount: 1,
      segments: [{ index: 0, name: "one", startFrame: 0, endFrame: 1, startSeconds: 0, endSeconds: 0.08 }],
    };
    const payload = { tracks: [], crossings: [], inPlaySpans: [], events: [] };
    const zipResult = parseZipBundleDetailed(makeZip(manifest, { one: payload }));
    expect(zipResult.error).toBe("Manifest frame rate is required");
  });
});