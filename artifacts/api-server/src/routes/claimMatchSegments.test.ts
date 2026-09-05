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
  it("parses a manifest plus segment files and namespaces local track IDs", () => {
    const manifest = {
      version: 1,
      label: "hour",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 4,
      duration: 0.16,
      segmentCount: 2,
      segments: [
        { index: 0, name: "one", startFrame: 0, endFrame: 1, startSeconds: 0, endSeconds: 0.08 },
        { index: 1, name: "two", startFrame: 2, endFrame: 3, startSeconds: 0.08, endSeconds: 0.16 },
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