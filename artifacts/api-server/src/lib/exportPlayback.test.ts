import { describe, expect, it } from "vitest";
import { ADMIN_PREVIEW_RANGE_MAX_BYTES, CLIP_PLAYBACK_RANGE_MAX_BYTES, planExportRange } from "./exportPlayback";
import { CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES } from "./backupExport";

describe("planExportRange", () => {
  const max = 1000;

  it("keeps every window under the host's fixed-length limit", () => {
    expect(ADMIN_PREVIEW_RANGE_MAX_BYTES).toBeLessThanOrEqual(CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES);
    expect(CLIP_PLAYBACK_RANGE_MAX_BYTES).toBeLessThanOrEqual(CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES);
  });

  it.each([
    [undefined, "bytes=0-999"],
    ["", "bytes=0-999"],
    ["bytes=0-", "bytes=0-999"],
    ["bytes=5000-", "bytes=5000-5999"],
    ["bytes=10-19", "bytes=10-19"],
    ["bytes=10-999999", "bytes=10-1009"],
    ["bytes=-200", "bytes=-200"],
    ["bytes=-999999", "bytes=-1000"],
    // Unreadable or multi-part ranges are treated as a request for the start.
    ["bytes=0-1,5-6", "bytes=0-999"],
    ["bytes=20-10", "bytes=0-999"],
    ["items=0-", "bytes=0-999"],
  ])("turns %j into the bounded upstream range %s", (header, expected) => {
    expect(planExportRange(header, max).upstreamRange).toBe(expected);
  });
});
