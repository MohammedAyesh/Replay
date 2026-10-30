import { afterEach, describe, expect, it, vi } from "vitest";
import { earlyReasonMessage, mediaErrorMessage, supportsEarlyHevc } from "./EarlyPlay";

afterEach(() => vi.unstubAllGlobals());

describe("early-play client helpers", () => {
  it("detects HEVC support from either video or MediaSource", () => {
    const video = { canPlayType: vi.fn().mockReturnValue("probably") };
    vi.stubGlobal("document", { createElement: () => video });
    vi.stubGlobal("MediaSource", { isTypeSupported: vi.fn().mockReturnValue(false) });
    expect(supportsEarlyHevc()).toBe(true);

    video.canPlayType.mockReturnValue("");
    expect(supportsEarlyHevc()).toBe(false);
    vi.stubGlobal("MediaSource", { isTypeSupported: vi.fn().mockReturnValue(true) });
    expect(supportsEarlyHevc()).toBe(true);
  });

  it("provides a distinct English and Arabic sentence for every reason code", () => {
    const codes = ["early_play_off", "bunny_failed", "bunny_not_found", "bunny_error", "vps_unreachable", "request_cancelled"] as const;
    for (const code of codes) {
      const en = earlyReasonMessage(code, "en");
      const ar = earlyReasonMessage(code, "ar");
      expect(en.length).toBeGreaterThan(8);
      expect(ar.length).toBeGreaterThan(8);
      expect(en).not.toBe(ar);
    }
  });

  it("maps each MediaError code to its own English and Arabic message", () => {
    for (const code of [1, 2, 3, 4]) {
      expect(mediaErrorMessage(code, "en").length).toBeGreaterThan(8);
      expect(mediaErrorMessage(code, "ar").length).toBeGreaterThan(8);
    }
    expect(new Set([1, 2, 3, 4].map((code) => mediaErrorMessage(code, "en"))).size).toBe(4);
  });
});
