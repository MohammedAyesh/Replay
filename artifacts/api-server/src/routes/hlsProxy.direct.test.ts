import { describe, expect, it } from "vitest";
import { wantsDirectSegments } from "./hlsProxy";

describe("wantsDirectSegments", () => {
  it("grants direct segments only when asked, from a page Bunny accepts", () => {
    expect(wantsDirectSegments({ direct: "1" }, "https://replayjo.com/my-clips", undefined)).toBe(true);
    expect(wantsDirectSegments({ direct: "1" }, undefined, "https://www.replayjo.com")).toBe(true);
    expect(wantsDirectSegments({}, "https://replayjo.com/", undefined)).toBe(false);
    expect(wantsDirectSegments({ direct: "1" }, "https://abc.kirk.replit.dev/", undefined)).toBe(false);
    expect(wantsDirectSegments({ direct: "1" }, "https://replayjo.com.evil.example/", undefined)).toBe(false);
    expect(wantsDirectSegments({ direct: "1" }, undefined, undefined)).toBe(false);
  });
});
