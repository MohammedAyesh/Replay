import { describe, expect, it } from "vitest";
import { assertCameraSourceGeometry, buildCropCommands, cropRectAt } from "./ffmpegExport";

describe("camera source geometry", () => {
  it.each([
    { width: 3840, height: 1080 },
    { width: 4096, height: 1152 },
  ])("accepts 32:9 source geometry $width×$height", (dims) => {
    expect(() => assertCameraSourceGeometry(dims, "test source")).not.toThrow();
  });

  it("rejects sources below the panorama baseline or outside 32:9", () => {
    expect(() => assertCameraSourceGeometry({ width: 3838, height: 1080 }, "test source"))
      .toThrow("at least 3840px wide and 32:9");
    expect(() => assertCameraSourceGeometry({ width: 4096, height: 1080 }, "test source"))
      .toThrow("at least 3840px wide and 32:9");
  });

  it("scales stored crop fractions against the probed source pixels", () => {
    const path = [{ t: 0, x: 0.2, y: 0, w: 0.5, h: 1 }];
    expect(cropRectAt(path, "16:9", 0, { width: 3840, height: 1080 }))
      .toEqual({ x: 768, y: 0, w: 1920, h: 1080 });
    expect(cropRectAt(path, "16:9", 0, { width: 4096, height: 1152 }))
      .toEqual({ x: 819, y: 0, w: 2048, h: 1152 });
    expect(buildCropCommands(path, 6, false, { width: 4096, height: 1152 }).filter)
      .toContain("crop=2048:1152");
  });
});
