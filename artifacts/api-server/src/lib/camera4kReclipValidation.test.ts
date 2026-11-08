import { describe, expect, it } from "vitest";
import {
  assertCamera4kReclipMediaPair,
  assertCamera4kUploadedSize,
} from "./camera4kReclipValidation";
import type { LocalMediaProbe } from "./ffmpegExport";

const validMedia: LocalMediaProbe = {
  durationSeconds: 12,
  width: 1920,
  height: 1080,
  hasAudio: true,
  frameCount: 360,
};

describe("camera 4K re-clip validation", () => {
  it("accepts a matching, decodable replacement and exact uploaded size", () => {
    expect(() => assertCamera4kReclipMediaPair(validMedia, {
      ...validMedia,
      durationSeconds: 12.49,
    }, 200_000, 250_000)).not.toThrow();
    expect(() => assertCamera4kUploadedSize(250_000, 250_000)).not.toThrow();
  });

  it("rejects duration, geometry, audio, and suspicious size changes", () => {
    expect(() => assertCamera4kReclipMediaPair(
      validMedia, { ...validMedia, durationSeconds: 12.51 }, 200_000, 250_000,
    )).toThrow(/duration differs/);
    expect(() => assertCamera4kReclipMediaPair(
      validMedia, { ...validMedia, width: 1280 }, 200_000, 250_000,
    )).toThrow(/dimensions changed/);
    expect(() => assertCamera4kReclipMediaPair(
      validMedia, { ...validMedia, hasAudio: false }, 200_000, 250_000,
    )).toThrow(/audio stream/);
    expect(() => assertCamera4kReclipMediaPair(
      validMedia, validMedia, 200_000, 20_000,
    )).toThrow(/too small/);
  });

  it("fails closed when the uploaded object size cannot be confirmed", () => {
    expect(() => assertCamera4kUploadedSize(250_000, null)).toThrow(/could not be verified/);
    expect(() => assertCamera4kUploadedSize(250_000, 249_999)).toThrow(/could not be verified/);
  });
});
