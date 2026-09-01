import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseZipBundle, validateUploadBundle } from "./claimMatch";

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

  it("rejects ZIPs with files that are not declared by the manifest", () => {
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

    expect(parseZipBundle(Buffer.from(zip))).toBeNull();
  });

  it("rejects archives that exceed the entry-count limit before parsing segments", () => {
    const zip = zipSync(Object.fromEntries([
      ["manifest.json", strToU8("{}")],
      ...Array.from({ length: 512 }, (_, index) => [`extra-${index}.txt`, strToU8("x")]),
    ]));

    expect(parseZipBundle(Buffer.from(zip))).toBeNull();
  });

  it("rejects segment ranges outside the manifest frame and duration bounds", () => {
    const upload = {
      manifest: {
        version: 1,
        label: "out of bounds",
        width: 1920,
        height: 1080,
        frameRate: 25,
        frameCount: 4,
        duration: 0.16,
        matchOffset: 0,
        videoStartSeconds: 0,
        segmentCount: 1,
        segments: [
          { index: 0, name: "one", startFrame: 0, endFrame: 4, startSeconds: 0, endSeconds: 0.2, objectPath: "" },
        ],
      },
      segments: [
        { segmentIndex: 0, name: "one", startFrame: 0, endFrame: 4, startSeconds: 0, endSeconds: 0.2, version: 1, tracks: [], crossings: [], inPlaySpans: [], events: [] },
      ],
    } as never;

    expect(validateUploadBundle(upload)).toContain("outside the manifest bounds");
  });
});