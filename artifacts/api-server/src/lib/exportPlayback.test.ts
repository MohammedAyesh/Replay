import { describe, expect, it } from "vitest";
import { boundedExportRange, EXPORT_PLAYBACK_MAX_RANGE_BYTES } from "./exportPlayback";

describe("boundedExportRange", () => {
  it("caps open and oversized ranges to 8 MiB", () => {
    expect(boundedExportRange("bytes=0-")).toBe(`bytes=0-${EXPORT_PLAYBACK_MAX_RANGE_BYTES - 1}`);
    expect(boundedExportRange("bytes=100-")).toBe(`bytes=100-${100 + EXPORT_PLAYBACK_MAX_RANGE_BYTES - 1}`);
  });

  it("preserves a smaller range and leaves unsupported ranges unchanged", () => {
    expect(boundedExportRange("bytes=10-20")).toBe("bytes=10-20");
    expect(boundedExportRange("bytes=0-1,10-20")).toBe("bytes=0-1,10-20");
  });
});
