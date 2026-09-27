import { describe, expect, it } from "vitest";
import { BunnyVideoNotFoundError } from "./bunny";
import {
  classifyPortfolioSourceError,
  hasCompletedPortfolioExport,
  isPortfolioClipShared,
  planPortfolioPlayback,
} from "./portfolioPlayback";

describe("portfolio playback access rules", () => {
  const visibleClip = {
    visibility: "public",
    showInPortfolio: true,
    isHidden: false,
  };

  it("requires public visibility, an explicit portfolio share, and a non-hidden clip", () => {
    expect(isPortfolioClipShared(visibleClip)).toBe(true);
    expect(isPortfolioClipShared({ ...visibleClip, visibility: "private" })).toBe(false);
    expect(isPortfolioClipShared({ ...visibleClip, showInPortfolio: false })).toBe(false);
    expect(isPortfolioClipShared({ ...visibleClip, isHidden: true })).toBe(false);
  });

  it("requires a completed export before media can be streamed", () => {
    expect(hasCompletedPortfolioExport({ exportStatus: "done", exportedUrl: "https://cdn.test/clips/1.mp4" })).toBe(true);
    expect(hasCompletedPortfolioExport({ exportStatus: "processing", exportedUrl: "https://cdn.test/clips/1.mp4" })).toBe(false);
    expect(hasCompletedPortfolioExport({ exportStatus: "done", exportedUrl: null })).toBe(false);
  });

  it("uses the rendered MP4 without depending on the source recording", () => {
    expect(planPortfolioPlayback(
      { exportStatus: "done", exportedUrl: "https://storage.bunnycdn.com/zone/clips/1.mp4" },
      true,
    )).toEqual({ status: "ready" });
  });

  it("uses only persisted export state and never requests source checks during a portfolio read", () => {
    const missingExport = { exportStatus: null, exportedUrl: null };
    expect(planPortfolioPlayback(missingExport, true))
      .toEqual({ status: "unavailable" });
    expect(planPortfolioPlayback({ exportStatus: "pending", exportedUrl: null }, true))
      .toEqual({ status: "unavailable" });
    expect(planPortfolioPlayback({ exportStatus: "pending", exportedUrl: null }, true, true))
      .toEqual({ status: "processing" });
    expect(planPortfolioPlayback({ exportStatus: "expired", exportedUrl: null }, true))
      .toEqual({ status: "expired" });
  });

  it("distinguishes a deleted Bunny source from a temporary availability failure", () => {
    expect(classifyPortfolioSourceError(new BunnyVideoNotFoundError("source"))).toBe("expired");
    expect(classifyPortfolioSourceError(new Error("Bunny timed out"))).toBe("unavailable");
  });
});