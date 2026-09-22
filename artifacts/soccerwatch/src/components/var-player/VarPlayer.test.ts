import { describe, expect, it } from "vitest";
import { formatVarWallClock, getVarManifestUrl } from "./VarPlayer";

describe("VarPlayer helpers", () => {
  it("switches the shared proxy manifest between standard and full-detail variants", () => {
    const standard = "/api/admin/var/camera1/hls/playlist.m3u8";
    expect(getVarManifestUrl(standard, "hls")).toBe(standard);
    expect(getVarManifestUrl(standard, "hevc")).toBe(
      "/api/admin/var/camera1/hevc/playlist.m3u8",
    );
  });

  it("formats program-date-time in Amman with hundredths of a second", () => {
    expect(formatVarWallClock(Date.parse("2026-09-21T06:07:08.340Z"))).toBe(
      "09:07:08.34",
    );
  });
});