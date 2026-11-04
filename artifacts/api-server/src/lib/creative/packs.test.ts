import { describe, expect, it } from "vitest";
import { styleAllowedFor } from "./packs";

describe("styleAllowedFor", () => {
  it("lets a field (kind 'venue') save field pack designs, and no academy", () => {
    expect(styleAllowedFor({ creativePack: null, kind: "venue" }, "field")).toBe(true);
    expect(styleAllowedFor({ creativePack: null, kind: "academy" }, "field")).toBe(false);
    expect(styleAllowedFor({ creativePack: null }, "field")).toBe(false);
  });
  it("still allows house styles to everyone and a pack only to its academy", () => {
    expect(styleAllowedFor({ creativePack: null, kind: "venue" }, "broadcast")).toBe(true);
    expect(styleAllowedFor({ creativePack: null }, null)).toBe(true);
    expect(styleAllowedFor({ creativePack: "iris" }, "iris")).toBe(true);
    expect(styleAllowedFor({ creativePack: null }, "iris")).toBe(false);
  });
});
