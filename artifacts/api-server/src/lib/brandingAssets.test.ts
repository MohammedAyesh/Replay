import { describe, expect, it } from "vitest";
import {
  buildOverlayFilterComplex,
  chooseBrandingAsset,
  overlayFits,
  type BrandingCandidate,
} from "./brandingAssets";

const asset = (
  scopeType: BrandingCandidate["scopeType"],
  scopeId: number,
  kind: BrandingCandidate["kind"],
): BrandingCandidate => ({
  scopeType,
  scopeId,
  kind,
  assetUrl: `${scopeType}-${scopeId}-${kind}`,
  width: 1920,
  height: 1080,
});

describe("which branding a clip gets", () => {
  const all = [
    asset("global", 0, "overlay"),
    asset("global", 0, "endCard"),
    asset("field", 7, "overlay"),
    asset("academy", 3, "overlay"),
  ];

  it("prefers the academy's own overlay", () => {
    const chosen = chooseBrandingAsset(all, "overlay", { academyId: 3, fieldId: 7 });
    expect(chosen?.scopeType).toBe("academy");
  });

  it("falls back to the field when the academy has none", () => {
    const chosen = chooseBrandingAsset(all, "overlay", { academyId: 99, fieldId: 7 });
    expect(chosen?.scopeType).toBe("field");
  });

  it("falls back to global when neither has one", () => {
    const chosen = chooseBrandingAsset(all, "overlay", { academyId: 99, fieldId: 99 });
    expect(chosen?.scopeType).toBe("global");
  });

  it("degrades one piece at a time, not as a set", () => {
    // The academy has an overlay but no end card. It should still get the
    // global end card: a clip with the academy's logo and no sign-off is worse
    // than one that mixes tiers.
    const overlay = chooseBrandingAsset(all, "overlay", { academyId: 3, fieldId: 7 });
    const endCard = chooseBrandingAsset(all, "endCard", { academyId: 3, fieldId: 7 });
    expect(overlay?.scopeType).toBe("academy");
    expect(endCard?.scopeType).toBe("global");
  });

  it("returns null rather than guessing when nothing is configured", () => {
    expect(chooseBrandingAsset([], "overlay", { academyId: 3, fieldId: 7 })).toBeNull();
    expect(chooseBrandingAsset(all, "endCard", { academyId: null, fieldId: null })?.scopeType).toBe("global");
  });

  it("ignores a scoped asset when the clip has no such scope", () => {
    const fieldOnly = [asset("field", 7, "overlay")];
    expect(chooseBrandingAsset(fieldOnly, "overlay", { academyId: null, fieldId: null })).toBeNull();
    expect(chooseBrandingAsset(fieldOnly, "overlay", { academyId: null, fieldId: 7 })?.scopeType).toBe("field");
  });
});

describe("overlay geometry", () => {
  it("accepts an overlay authored at the output size", () => {
    expect(overlayFits({ width: 1920, height: 1080 }, { w: 1920, h: 1080 })).toBe(true);
  });

  it("rejects one authored at any other size", () => {
    // Not corrected by scaling: a brand mark that changes proportion or moves
    // between a 16:9 and a 9:16 export is worse than one that is missing.
    expect(overlayFits({ width: 1280, height: 720 }, { w: 1920, h: 1080 })).toBe(false);
    expect(overlayFits({ width: 1080, height: 1920 }, { w: 1920, h: 1080 })).toBe(false);
  });

  it("trusts an unprobed asset rather than blocking it", () => {
    expect(overlayFits({ width: null, height: null }, { w: 1920, h: 1080 })).toBe(true);
  });
});

describe("splicing the overlay into the crop chain", () => {
  it("keeps the crop chain byte-for-byte and draws over its result", () => {
    // The crop chain is the one thing that must not be rewritten: every
    // keyframe is a fraction multiplied by the source geometry, so any edit
    // here produces a mis-framed clip that looks like bad tracking.
    const crop = "pad=3840:1080:0:0,crop=1920:1080:100:0,scale=1920:1080";
    const complex = buildOverlayFilterComplex(crop);
    expect(complex).toBe(`[0:v]${crop}[base];[base][1:v]overlay=0:0:format=auto[v]`);
    expect(complex).toContain(crop);
  });

  it("survives a chain containing the semicolons and brackets of a zoompan", () => {
    const crop = "zoompan=z='1.0':x='if(gte(t,0),100,0)':d=1:s=1920x1080,setsar=1";
    expect(buildOverlayFilterComplex(crop)).toContain(crop);
  });
});
