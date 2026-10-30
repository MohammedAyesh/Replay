import { describe, expect, it } from "vitest";
import {
  HEVC_TYPE, canDecodeHevc, initialSource, interpretProbe, loadKey, mediaMessage, offlineMessage,
  onFirstFrameTimeout, onStall, planForMediaError, pollFailedMessage, probeMessage, reasonMessage,
  savedPosition, showCard, sourceUrl, stallMessage,
  type EarlyPlayReason, type EarlyPlayStatus, type ProbeOutcome,
} from "./earlyPlayLogic";

const STREAM = "/api/matches/ABC123/early-play/video";
const DIRECT = "https://vz-03425ccd-3d0.b-cdn.net/5f83ad1e/original";
const early = (over: Partial<EarlyPlayStatus> = {}): EarlyPlayStatus => ({ state: "early", streamUrl: STREAM, encodeProgress: 12, ...over });
const ARABIC = /[؀-ۿ]/;

describe("HEVC capability gate", () => {
  it("uses the exact hvc1 Level 5.0 type string", () => {
    expect(HEVC_TYPE).toBe('video/mp4; codecs="hvc1.1.6.L150.B0"');
  });
  it.each(["probably", "maybe"])("canPlayType %s → yes", (answer) => {
    expect(canDecodeHevc({ canPlayType: () => answer }, undefined)).toBe(true);
  });
  it("canPlayType empty and no MediaSource → no", () => {
    expect(canDecodeHevc({ canPlayType: () => "" }, undefined)).toBe(false);
  });
  it("canPlayType empty but MediaSource supports it → yes", () => {
    expect(canDecodeHevc({ canPlayType: () => "" }, { isTypeSupported: () => true })).toBe(true);
  });
  it("canPlayType empty and MediaSource says no → no", () => {
    expect(canDecodeHevc({ canPlayType: () => "" }, { isTypeSupported: () => false })).toBe(false);
  });
  it("engines that throw on the codec string count as unsupported, not as a crash", () => {
    const throwing = { canPlayType: () => { throw new Error("bad"); } };
    expect(canDecodeHevc(throwing, { isTypeSupported: () => { throw new Error("bad"); } })).toBe(false);
    expect(canDecodeHevc(throwing, { isTypeSupported: () => true })).toBe(true);
  });
});

describe("card visibility", () => {
  it("hidden before the first status, when ready, and when an admin turned it off", () => {
    expect(showCard(null)).toBe(false);
    expect(showCard({ state: "ready" })).toBe(false);
    expect(showCard({ state: "unavailable", reasonCode: "disabled" })).toBe(false);
  });
  it("shown for waiting, early and every other unavailable reason", () => {
    expect(showCard({ state: "waiting" })).toBe(true);
    expect(showCard(early())).toBe(true);
    for (const code of ["early_play_off", "bunny_failed", "bunny_not_found", "bunny_error", "vps_unreachable", "request_cancelled"] as const) {
      expect(showCard({ state: "unavailable", reasonCode: code })).toBe(true);
    }
  });
});

describe("source selection", () => {
  it("starts on the direct URL only when the server sent one", () => {
    expect(initialSource(early({ directUrl: DIRECT }))).toBe("direct");
    expect(initialSource(early())).toBe("proxy");
  });
  it("direct uses directUrl; proxy uses streamUrl; direct without a directUrl uses streamUrl", () => {
    expect(sourceUrl(early({ directUrl: DIRECT }), "direct")).toBe(DIRECT);
    expect(sourceUrl(early({ directUrl: DIRECT }), "proxy")).toBe(STREAM);
    expect(sourceUrl(early(), "direct")).toBe(STREAM);
  });
  it("no URL unless the state is early with a streamUrl", () => {
    expect(sourceUrl(null, "proxy")).toBeNull();
    expect(sourceUrl({ state: "waiting" }, "proxy")).toBeNull();
    expect(sourceUrl({ state: "early" }, "proxy")).toBeNull();
  });
});

describe("reload key (regression: the first build reloaded on every timeupdate and every poll)", () => {
  it("a 30 s poll with the same URLs but new progress does not change the key", () => {
    const a = loadKey(early({ encodeProgress: 10 }), "proxy", 0, true);
    const b = loadKey(early({ encodeProgress: 55, durationSec: 1801 }), "proxy", 0, true);
    expect(a).not.toBe("");
    expect(b).toBe(a);
  });
  it("changes on fallback, on retry, and when the URL changes", () => {
    const base = loadKey(early({ directUrl: DIRECT }), "direct", 0, true);
    expect(loadKey(early({ directUrl: DIRECT }), "proxy", 0, true)).not.toBe(base);
    expect(loadKey(early({ directUrl: DIRECT }), "direct", 1, true)).not.toBe(base);
    expect(loadKey(early({ directUrl: DIRECT, streamUrl: "/other" }), "proxy", 0, true)).not.toBe(loadKey(early({ directUrl: DIRECT }), "proxy", 0, true));
  });
  it("is empty while the player is closed or there is nothing to play", () => {
    expect(loadKey(early(), "proxy", 0, false)).toBe("");
    expect(loadKey({ state: "waiting" }, "proxy", 0, true)).toBe("");
  });
});

describe("MediaError plan", () => {
  it("any error on the direct URL falls back to the proxy first", () => {
    for (const code of [1, 2, 3, 4]) expect(planForMediaError("direct", code, early({ directUrl: DIRECT }))).toEqual({ kind: "fallback" });
  });
  it("MediaError 4 on the proxy → probe before blaming the phone", () => {
    expect(planForMediaError("proxy", 4, early())).toEqual({ kind: "probe" });
  });
  it.each([1, 2, 3])("MediaError %i on the proxy → its own message", (code) => {
    expect(planForMediaError("proxy", code, early())).toEqual({ kind: "message", mediaCode: code });
  });
  it("a missing or unknown code is treated as a network error (2)", () => {
    expect(planForMediaError("proxy", undefined, early())).toEqual({ kind: "message", mediaCode: 2 });
    expect(planForMediaError("proxy", 9, early())).toEqual({ kind: "message", mediaCode: 2 });
  });
});

describe("MediaError 4 probe interpretation", () => {
  const cases: Array<[string, EarlyPlayStatus | null, number | null, EarlyPlayReason | undefined, ProbeOutcome["kind"]]> = [
    ["still early + 206 → the phone can't decode it", early(), 206, undefined, "unsupported"],
    ["still early + 404 → gone, not the phone", early(), 404, undefined, "gone"],
    ["still early + 410 → gone", early(), 410, undefined, "gone"],
    ["still early + 403 → not allowed", early(), 403, undefined, "not_allowed"],
    ["still early + 401 → not allowed", early(), 401, undefined, "not_allowed"],
    ["still early + 409 → ready now", early(), 409, undefined, "ready"],
    ["still early + 503 → the server's reason", early(), 503, "bunny_error", "reason"],
    ["still early + 502 → network", early(), 502, undefined, "network"],
    ["still early + probe threw → network", early(), null, undefined, "network"],
    ["status now ready → ready", { state: "ready" }, null, undefined, "ready"],
    ["status now unavailable → its reason", { state: "unavailable", reasonCode: "bunny_not_found" }, null, undefined, "reason"],
    ["status request failed → network", null, null, undefined, "network"],
  ];
