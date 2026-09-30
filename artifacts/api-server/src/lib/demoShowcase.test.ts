import { describe, expect, it } from "vitest";

import { hexToLab } from "./matchPlay";
import { labToHex, parseIdList, pickBroadcastWindow, playerLabels, whatsappDigits } from "./demoShowcase";

describe("labToHex", () => {
  it("inverts hexToLab closely enough to show a kit colour", () => {
    for (const hex of ["#ffffff", "#000000", "#d4ff4f", "#1e3a8a", "#c81e1e", "#7b5cff"]) {
      const back = labToHex(hexToLab(hex)!);
      const channels = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const diff = channels(hex).map((c, i) => Math.abs(c - channels(back)[i]));
      expect(Math.max(...diff)).toBeLessThanOrEqual(3);
    }
  });
});

describe("parseIdList", () => {
  it("keeps positive integers in order, once each", () => {
    expect(parseIdList("12, 40,x, 7 12  0 -3 4.5")).toEqual([12, 40, 7]);
    expect(parseIdList("")).toEqual([]);
  });
});

describe("playerLabels", () => {
  it("uses shirt numbers, and letters for players without one or with a repeated number", () => {
    expect(playerLabels(["7", null, "10", "7", null])).toEqual(["#7", "A", "#10", "B", "C"]);
  });
});

describe("whatsappDigits", () => {
  it("turns the ways an admin types a Jordanian number into wa.me digits", () => {
    expect(whatsappDigits("+962 79 000 0000")).toBe("962790000000");
    expect(whatsappDigits("00962790000000")).toBe("962790000000");
    expect(whatsappDigits("0790000000")).toBe("962790000000");
    expect(whatsappDigits("")).toBeNull();
    expect(whatsappDigits("12345")).toBeNull();
  });
});

describe("pickBroadcastWindow", () => {
  it("centres on the busiest goal and skips warm-up", () => {
    const moments = [
      { type: "goal" as const, t: 31, side: 0 as const },
      { type: "shot" as const, t: 1500, side: 0 as const },
      { type: "shot" as const, t: 1550, side: 1 as const },
      { type: "goal" as const, t: 1583, side: 0 as const },
      { type: "goal" as const, t: 2785, side: 1 as const },
    ];
    expect(pickBroadcastWindow(moments, 3600)).toEqual({ start: 1433, end: 1613 });
  });

  it("falls back to a fixed window when nothing was detected", () => {
    expect(pickBroadcastWindow([], 3600)).toEqual({ start: 600, end: 780 });
  });
});
