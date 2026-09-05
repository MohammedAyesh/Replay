import { describe, expect, it } from "vitest";
import { dvrWindowSeconds, formatBehindLive, nextPollMs, type LiveStatus } from "./liveSource";

const status = (over: Partial<LiveStatus>): LiveStatus => ({
  live: true, reason: "live", dvrSeconds: 900, behindSeconds: 2,
  liveEdgeAt: null, segmentCount: 200, ...over,
});

describe("how often to ask again", () => {
  it("polls slowly while the stream is up and quickly while it is down", () => {
    // Somebody is standing at a pitch waiting for it to come back, and a minute
    // of blank screen after the camera starts is a minute spent power-cycling
    // something that was about to work.
    expect(nextPollMs(status({ live: true }))).toBe(60_000);
    expect(nextPollMs(status({ live: false, reason: "stale" }))).toBe(15_000);
    expect(nextPollMs(null)).toBe(15_000);
  });
});

describe("the scrubbable window", () => {
  it("uses what the server measured, not a hardcoded guess", () => {
    // The VAR panel assumed 300 while the VPS kept 900 for the stream copy and
    // about 1800 for the transcode: two thirds of the window was unreachable.
    expect(dvrWindowSeconds(status({ dvrSeconds: 1800 }))).toBe(1800);
    expect(dvrWindowSeconds(status({ dvrSeconds: 900 }))).toBe(900);
  });

  it("falls back rather than collapsing to zero before the first poll", () => {
    expect(dvrWindowSeconds(null)).toBe(900);
    expect(dvrWindowSeconds(status({ dvrSeconds: 0 }))).toBe(900);
    expect(dvrWindowSeconds(status({ dvrSeconds: 4 }))).toBe(30);
  });
});

describe("how far behind live", () => {
  it("reads as live at the edge and as a duration behind it", () => {
    expect(formatBehindLive(0)).toBe("live");
    expect(formatBehindLive(2)).toBe("live");
    expect(formatBehindLive(45)).toBe("−0:45");
    expect(formatBehindLive(83)).toBe("−1:23");
  });

  it("never renders a negative duration", () => {
    // The edge routinely reads a second or two ahead of the client's clock.
    expect(formatBehindLive(-4)).toBe("live");
  });
});
