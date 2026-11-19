import { describe, expect, it } from "vitest";
import {
  availableSourceQualityOptions,
  qualityLevelDisplay,
  shouldShowSourceQualityButton,
  shouldShowQualityPicker,
  sourceQualityButtonLabel,
} from "./qualityPicker";

describe("recorded-video quality picker", () => {
  it("requires multiple levels and at least one real resolution", () => {
    expect(shouldShowQualityPicker([])).toBe(false);
    expect(shouldShowQualityPicker([{ index: 0, width: 1920, height: 1080 }])).toBe(false);
    expect(shouldShowQualityPicker([
      { index: 0, width: 0, height: 0 },
      { index: 1, width: 0, height: 0 },
    ])).toBe(false);
    expect(shouldShowQualityPicker([
      { index: 0, width: 0, height: 0 },
      { index: 1, width: 1920, height: 1080 },
    ])).toBe(true);
  });

  it("uses video dimensions when a level has no size and omits unknown bitrate", () => {
    expect(qualityLevelDisplay(
      { index: 0, width: 0, height: 0, bitrate: 0 },
      { width: 1920, height: 1080 },
    )).toEqual({ label: "1080p", details: "1920×1080" });
  });

  it("never formats missing dimensions or a rounded zero bitrate as placeholders", () => {
    expect(qualityLevelDisplay({ index: 0, bitrate: 1 })).toEqual({
      label: null,
      details: null,
    });
    expect(qualityLevelDisplay({ index: 1, width: 0, height: 0, bitrate: Number.NaN })).toEqual({
      label: null,
      details: null,
    });
  });

  it("offers only available H.264 and 4K choices for Storage recordings", () => {
    const bothAvailable = availableSourceQualityOptions({
      streamlessStorage: true,
      eightKAvailable: true,
      uhdAvailable: true,
      h264Available: true,
    });
    expect(bothAvailable).toEqual(["4k", "hd"]);
    expect(shouldShowSourceQualityButton(bothAvailable, true, "h264")).toBe(true);
    expect(shouldShowSourceQualityButton(bothAvailable, true, "stream")).toBe(false);
    const h264Only = availableSourceQualityOptions({
      streamlessStorage: true,
      eightKAvailable: true,
      uhdAvailable: false,
      h264Available: true,
    });
    expect(h264Only).toEqual(["hd"]);
    expect(shouldShowSourceQualityButton(h264Only, true, "h264")).toBe(false);
    expect(availableSourceQualityOptions({
      streamlessStorage: true,
      eightKAvailable: true,
      uhdAvailable: false,
      h264Available: false,
    })).toEqual([]);
  });

  it("labels streamless H.264 as HD and 4K as 4K", () => {
    expect(sourceQualityButtonLabel("h264", true)).toBe("HD");
    expect(sourceQualityButtonLabel("uhd", true)).toBe("4K");
    expect(sourceQualityButtonLabel("h264", false)).toBe("H.264");
  });

  it("keeps standard source choices for non-Storage recordings", () => {
    expect(availableSourceQualityOptions({
      streamlessStorage: false,
      eightKAvailable: true,
      uhdAvailable: true,
      h264Available: true,
    })).toEqual(["8k", "4k", "hd", "stream"]);
  });
});
