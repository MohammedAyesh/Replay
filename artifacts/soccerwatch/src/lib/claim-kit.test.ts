import { describe, expect, it } from "vitest";
import { averageHue, bucketFor, rgbToHsl, splitKits, torsoColourFromPixels } from "./claim-kit";

const colour = (hue: number | null, saturation = 0.7, lightness = 0.45) =>
  ({ hue, saturation, lightness });

describe("averageHue", () => {
  it("wraps rather than averaging red to cyan", () => {
    expect(averageHue([358, 2])).toBeCloseTo(0, 1);
    expect(averageHue([350, 10])).toBeCloseTo(0, 1);
  });

  it("averages normally away from the seam", () => {
    expect(averageHue([100, 120])).toBeCloseTo(110, 1);
  });

  it("has no answer for an empty or perfectly opposed set", () => {
    expect(averageHue([])).toBeNull();
    expect(averageHue([0, 180])).toBeNull();
  });
});

describe("bucketFor", () => {
  it("sends washed-out torsos to lightness buckets, not hue ones", () => {
    expect(bucketFor(colour(210, 0.05, 0.8))).toBe("light");
    expect(bucketFor(colour(210, 0.05, 0.2))).toBe("dark");
    expect(bucketFor(colour(210, 0.05, 0.5))).toBe("grey");
  });

  it("buckets saturated torsos in 30-degree bands", () => {
    expect(bucketFor(colour(115))).toBe("h90");
    expect(bucketFor(colour(95))).toBe("h90");
    expect(bucketFor(colour(125))).toBe("h120");
  });
});

describe("splitKits", () => {
  it("separates two real teams", () => {
    const split = splitKits([
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `blue${n}`, colour: colour(220) })),
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `red${n}`, colour: colour(5) })),
    ]);
    expect(split.separated).toBe(true);
    expect(split.groups).toHaveLength(2);
    expect(split.groups[0].memberIds).toHaveLength(5);
  });

  it("merges two shades of one shirt into one kit", () => {
    const split = splitKits([
      ...[1, 2, 3].map((n) => ({ id: `a${n}`, colour: colour(115) })),
      ...[1, 2, 3, 4].map((n) => ({ id: `b${n}`, colour: colour(131) })),
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, colour: colour(10) })),
    ]);
    const green = split.groups.find((group) => group.memberIds.some((id) => id.startsWith("a")));
    expect(green?.memberIds).toHaveLength(7);
  });

  it("refuses to invent teams when one colour dominates", () => {
    const split = splitKits([
      ...Array.from({ length: 18 }, (_, n) => ({ id: `blue${n}`, colour: colour(220) })),
      ...[1, 2].map((n) => ({ id: `red${n}`, colour: colour(5) })),
    ]);
    expect(split.separated).toBe(false);
  });

  it("refuses when there is only one kit at all", () => {
    const split = splitKits(
      Array.from({ length: 10 }, (_, n) => ({ id: `p${n}`, colour: colour(220) })),
    );
    expect(split.separated).toBe(false);
  });

  /**
   * Measured on a real sprite file: 121 tracks, mean saturation 0.10, and the
   * buckets came out light 10 / grey 82 / dark 15 / hue 14 -- brightness bands,
   * not two teams. The old 0.85 dominance test passed it.
   */
  it("refuses a match whose crops carry no colour at all", () => {
    const washed = (lightness: number) => ({ hue: 30, saturation: 0.1, lightness });
    const split = splitKits([
      ...Array.from({ length: 82 }, (_, n) => ({ id: `g${n}`, colour: washed(0.46) })),
      ...Array.from({ length: 15 }, (_, n) => ({ id: `d${n}`, colour: washed(0.31) })),
      ...Array.from({ length: 10 }, (_, n) => ({ id: `l${n}`, colour: washed(0.67) })),
    ]);
    expect(split.meanSaturation).toBeLessThan(0.2);
    expect(split.separated).toBe(false);
  });

  it("never offers grey as a kit, and refuses when the kits cover too few", () => {
    const split = splitKits([
      ...Array.from({ length: 20 }, (_, n) => ({ id: `g${n}`, colour: colour(null, 0.05, 0.5) })),
      ...[1, 2, 3].map((n) => ({ id: `blue${n}`, colour: colour(220, 0.6) })),
      ...[1, 2, 3].map((n) => ({ id: `red${n}`, colour: colour(5, 0.6) })),
    ]);
    expect(split.groups.map((group) => group.key)).not.toContain("grey");
    expect(split.coverage).toBeLessThan(0.6);
    expect(split.separated).toBe(false);
  });

  it("separates a white kit from a black one, where lightness is the signal", () => {
    const split = splitKits([
      ...Array.from({ length: 6 }, (_, n) => ({ id: `w${n}`, colour: colour(null, 0.3, 0.78) })),
      ...Array.from({ length: 6 }, (_, n) => ({ id: `b${n}`, colour: colour(null, 0.3, 0.2) })),
    ]);
    expect(split.separated).toBe(true);
    expect(split.groups.map((group) => group.key).sort()).toEqual(["dark", "light"]);
  });

  it("names everyone the kits do not cover, so nobody is quietly dropped", () => {
    const split = splitKits([
      ...Array.from({ length: 6 }, (_, n) => ({ id: `blue${n}`, colour: colour(220, 0.6) })),
      ...Array.from({ length: 6 }, (_, n) => ({ id: `red${n}`, colour: colour(5, 0.6) })),
      { id: "lonely", colour: colour(120, 0.6) },
    ]);
    expect(split.separated).toBe(true);
    expect(split.unreadableIds).toContain("lonely");
  });

  it("keeps unreadable people out of the kits and names them", () => {
    const split = splitKits([
      ...[1, 2, 3].map((n) => ({ id: `blue${n}`, colour: colour(220) })),
      ...[1, 2, 3].map((n) => ({ id: `red${n}`, colour: colour(5) })),
      { id: "dark1", colour: null },
    ]);
    expect(split.unreadableIds).toEqual(["dark1"]);
    expect(split.groups.flatMap((group) => group.memberIds)).not.toContain("dark1");
  });
});

describe("torsoColourFromPixels", () => {
  function solid(width: number, height: number, rgb: [number, number, number]) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
      pixels[index * 4] = rgb[0];
      pixels[index * 4 + 1] = rgb[1];
      pixels[index * 4 + 2] = rgb[2];
      pixels[index * 4 + 3] = 255;
    }
    return { pixels, width, height };
  }

  it("reads a solid shirt", () => {
    const { pixels, width, height } = solid(40, 80, [30, 60, 200]);
    const read = torsoColourFromPixels(pixels, width, height);
    expect(read?.hue).toBeCloseTo(rgbToHsl(30, 60, 200).hue!, 0);
  });

  it("gives up rather than guessing on a crop that is too small to read", () => {
    const { pixels, width, height } = solid(4, 6, [30, 60, 200]);
    expect(torsoColourFromPixels(pixels, width, height)).toBeNull();
  });

  it("ignores the head and the legs", () => {
    // Yellow shirt, black shorts and black hair. A whole-box average reads
    // olive; the torso window must read yellow.
    const width = 40;
    const height = 100;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const shirt = y >= height * 0.28 && y < height * 0.64;
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        pixels[offset] = shirt ? 230 : 20;
        pixels[offset + 1] = shirt ? 215 : 20;
        pixels[offset + 2] = shirt ? 40 : 22;
        pixels[offset + 3] = 255;
      }
    }
    const read = torsoColourFromPixels(pixels, width, height)!;
    expect(read.hue).toBeGreaterThan(40);
    expect(read.hue).toBeLessThan(70);
    expect(read.saturation).toBeGreaterThan(0.5);
  });
});
