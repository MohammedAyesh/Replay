import { describe, expect, it } from "vitest";
import { isDirectEarlyPlayHost } from "./earlyPlay";

describe("early-play direct host gate", () => {
  it("accepts the exact public host from Host or the first forwarded host", () => {
    expect(isDirectEarlyPlayHost("replayjo.com")).toBe(true);
    expect(isDirectEarlyPlayHost("internal.replit.dev", "replayjo.com, proxy.replit.dev", true)).toBe(true);
  });
  it("rejects www, development hosts, and forwarded-host lookalikes", () => {
    expect(isDirectEarlyPlayHost("www.replayjo.com")).toBe(false);
    expect(isDirectEarlyPlayHost("replayjo.com", "www.replayjo.com", true)).toBe(false);
    expect(isDirectEarlyPlayHost("internal.replit.dev", "replayjo.com")).toBe(false);
    expect(isDirectEarlyPlayHost("replayjo.replit.dev")).toBe(false);
  });
});
