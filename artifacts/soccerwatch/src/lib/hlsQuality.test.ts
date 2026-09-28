import { describe, expect, it, vi } from "vitest";
import {
  capBelowFailedLevel,
  capPlaybackQuality,
  getAllowedHlsLevelIndexes,
} from "./hlsQuality";

const levels = [
  { width: 1706, height: 480, bitrate: 2_000_000, frameRate: 30, videoCodec: "avc1.4d401f" },
  { width: 2560, height: 720, bitrate: 5_000_000, frameRate: 30, videoCodec: "avc1.4d401f" },
  { width: 3840, height: 1080, bitrate: 12_000_000, frameRate: 30, videoCodec: "avc1.4d401f" },
];

function capabilities(unsupported: number[] = []) {
  return {
    decodingInfo: vi.fn(async (configuration: MediaDecodingConfiguration) => ({
      supported: !unsupported.includes(configuration.video?.width ?? 0),
      smooth: !unsupported.includes(configuration.video?.width ?? 0),
      powerEfficient: true,
    })),
  } as unknown as MediaCapabilities;
}

describe("hls quality selection", () => {
  it("caps at the highest supported level when the top level is unsupported", async () => {
    await expect(getAllowedHlsLevelIndexes(levels, {
      mediaCapabilities: capabilities([3840]),
    })).resolves.toEqual([0, 1]);
  });

  it("preserves an all-supported ladder without a cap", async () => {
    await expect(getAllowedHlsLevelIndexes(levels, {
      mediaCapabilities: capabilities(),
    })).resolves.toEqual([0, 1, 2]);
  });

  it("uses positive bitrate and frame-rate fallbacks for incomplete metadata", async () => {
    const decodingInfo = vi.fn(async (_configuration: MediaDecodingConfiguration) => ({
      supported: true,
      smooth: true,
      powerEfficient: true,
    }));

    await expect(getAllowedHlsLevelIndexes([{
      width: 2560,
      height: 720,
      bitrate: 0,
      videoCodec: "avc1.640032",
    }], {
      mediaCapabilities: { decodingInfo } as unknown as MediaCapabilities,
    })).resolves.toEqual([0]);

    expect(decodingInfo).toHaveBeenCalledWith(expect.objectContaining({
      video: expect.objectContaining({
        bitrate: 1_000_000,
        framerate: 30,
      }),
    }));
  });

  it("keeps levels with missing dimensions without querying MediaCapabilities", async () => {
    const decodingInfo = vi.fn(async (_configuration: MediaDecodingConfiguration) => ({
      supported: true,
      smooth: true,
      powerEfficient: true,
    }));

    await expect(getAllowedHlsLevelIndexes([
      levels[0],
      { height: 720, bitrate: 5_000_000 },
      { width: 3840, bitrate: 8_000_000 },
    ], {
      mediaCapabilities: { decodingInfo } as unknown as MediaCapabilities,
    })).resolves.toEqual([0, 1, 2]);

    expect(decodingInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps a level when the MediaCapabilities query throws", async () => {
    const decodingInfo = vi.fn(async (configuration: MediaDecodingConfiguration) => {
      if (configuration.video?.width === 2560) {
        throw new TypeError("decoder capability query unavailable");
      }
      return {
        supported: true,
        smooth: true,
        powerEfficient: true,
      };
    });

    await expect(getAllowedHlsLevelIndexes(levels.slice(0, 2), {
      mediaCapabilities: { decodingInfo } as unknown as MediaCapabilities,
    })).resolves.toEqual([0, 1]);
  });

  it("keeps both Bunny rungs when the master playlist omits FRAME-RATE", async () => {
    const bunnyLevels = [
      { width: 2560, height: 720, bitrate: 8_000_000, videoCodec: "avc1.640032" },
      { width: 3840, height: 1080, bitrate: 8_000_000, videoCodec: "avc1.640032" },
    ];
    const decodingInfo = vi.fn(async (configuration: MediaDecodingConfiguration) => {
      if ((configuration.video?.framerate ?? 0) <= 0) {
        throw new TypeError("framerate must be positive");
      }
      return {
        supported: true,
        smooth: true,
        powerEfficient: true,
      };
    });

    await expect(getAllowedHlsLevelIndexes(bunnyLevels, {
      mediaCapabilities: { decodingInfo } as unknown as MediaCapabilities,
    })).resolves.toEqual([0, 1]);

    expect(decodingInfo).toHaveBeenCalledTimes(2);
    expect(decodingInfo.mock.calls.map(([configuration]) => configuration.video?.framerate))
      .toEqual([30, 30]);
  });

  it("does not capability-cap when MediaCapabilities is unavailable", async () => {
    await expect(getAllowedHlsLevelIndexes(levels, {
      mediaCapabilities: undefined,
    })).resolves.toEqual([0, 1, 2]);
  });

  it("always keeps the lowest recovery level", async () => {
    await expect(getAllowedHlsLevelIndexes(levels, {
      maxWidth: 1000,
      mediaCapabilities: capabilities([1706, 2560, 3840]),
    })).resolves.toEqual([0]);
  });

  it("caps one rung below a failed level", () => {
    const hls = { autoLevelCapping: -1 };
    expect(capBelowFailedLevel(hls as never, 2)).toBe(1);
    expect(hls.autoLevelCapping).toBe(1);
    expect(capBelowFailedLevel(hls as never, 0)).toBe(0);

    const alreadyCapped = { autoLevelCapping: 0 };
    expect(capBelowFailedLevel(alreadyCapped as never, 3)).toBe(0);
  });

  it("does not lift a fatal-error cap when capability filtering finishes", async () => {
    const hls = {
      levels,
      autoLevelCapping: 0,
      startLevel: 0,
      on: vi.fn(),
    };

    capPlaybackQuality(hls as never);
    await Promise.resolve();

    expect(hls.autoLevelCapping).toBe(0);
  });

  it("does not apply an async quality cap after the player is disposed", async () => {
    const hls = {
      levels,
      autoLevelCapping: -1,
      startLevel: -1,
      on: vi.fn(),
      off: vi.fn(),
    };

    const dispose = capPlaybackQuality(hls as never, 1000);
    dispose();
    await Promise.resolve();

    expect(hls.autoLevelCapping).toBe(-1);
    expect(hls.off).toHaveBeenCalledTimes(2);
  });
});