import { describe, expect, it } from "vitest";
import {
  findBufferedHoleStart,
  programTimeAtPlaylistEnd,
  programTimeAtPosition,
  type TimelineFragment,
} from "@/components/HlsPlayer";
import { formatVarWallClock, getVarLiveEdgeTarget, getVarManifestUrl } from "./VarPlayer";

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

  it("uses HLS's live-sync position for Go live", () => {
    expect(getVarLiveEdgeTarget(100)).toBe(100);
    expect(getVarLiveEdgeTarget(100, 95)).toBe(95);
    expect(getVarLiveEdgeTarget(100, 98)).toBe(98);
  });

  it("maps gapped playback to the active fragment's program date time", () => {
    const fragments: TimelineFragment[] = [
      { start: 100, duration: 5, programDateTime: 1_000_000 },
      { start: 105, duration: 5 },
      { start: 110, duration: 5, programDateTime: 1_020_000 },
    ];
    expect(programTimeAtPosition(fragments, 107)).toBe(1_007_000);
    expect(programTimeAtPosition(fragments, 112)).toBe(1_022_000);
    expect(programTimeAtPlaylistEnd(fragments)).toBe(1_025_000);
  });

  it("only finds a buffered range within the short recovery threshold", () => {
    expect(findBufferedHoleStart(10, [{ start: 0, end: 5 }, { start: 14, end: 30 }])).toBe(14);
    expect(findBufferedHoleStart(10, [{ start: 0, end: 5 }, { start: 20, end: 30 }])).toBeNull();
    expect(findBufferedHoleStart(10, [{ start: 0, end: 5 }, { start: 71, end: 80 }])).toBeNull();
    expect(findBufferedHoleStart(10, [{ start: 0, end: 20 }, { start: 25, end: 30 }])).toBeNull();
  });
});