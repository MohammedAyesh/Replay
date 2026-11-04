import { describe, expect, it } from "vitest";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import {
  isPackStyle, packPlate,
  CREATIVE_STYLES,
  PLATE_LAYER_ID,
  buildTemplateScene,
  resolveTint,
  sceneSchema,
  templatePlateLayer,
  templateSampleData,
  type CreativeBrand,
  type Scene,
} from "@workspace/api-zod";
import { renderScenePng } from "./render";
import { tintPicture } from "./renderTint";

const BRAND: CreativeBrand = {
  primary: "#C8102E", accent: "#FFD100", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "Al Wehdat", nameAr: null,
};

/** A 256-wide greyscale ramp, black on the left to white on the right. */
function ramp(h = 4): Canvas {
  const c = createCanvas(256, h);
  const x = c.getContext("2d");
  for (let i = 0; i < 256; i++) {
    x.fillStyle = `rgb(${i},${i},${i})`;
    x.fillRect(i, 0, 1, h);
  }
  return c;
}

const rgbAt = (c: Canvas, x: number, y = 1) => [...c.getContext("2d").getImageData(x, y, 1, 1).data];

function hue([r, g, b]: number[]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe("tint", () => {
  it("color mode keeps white white and black black and puts the tint's red in the mids", () => {
    const out = tintPicture(ramp(), { color: "#C8102E", mode: "color", amount: 1 });
    const [r0, g0, b0] = rgbAt(out, 0);
    expect(r0 + g0 + b0).toBeLessThanOrEqual(6);
    const [r1, g1, b1] = rgbAt(out, 255);
    expect(Math.min(r1, g1, b1)).toBeGreaterThanOrEqual(249);
    for (const x of [96, 128, 160]) {
      const px = rgbAt(out, x);
      expect(px[0], `x=${x}`).toBeGreaterThan(px[1] + 60);
      expect(px[0], `x=${x}`).toBeGreaterThan(px[2] + 40);
      const h = hue(px);
      // #C8102E is ~351°: a red, a touch towards crimson.
      expect(h > 330 || h < 10, `x=${x} hue ${h}`).toBe(true);
    }
    // Luminosity follows the plate: brighter in, brighter out.
    const lum = (p: number[]) => 0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2];
    expect(lum(rgbAt(out, 64))).toBeLessThan(lum(rgbAt(out, 128)));
    expect(lum(rgbAt(out, 128))).toBeLessThan(lum(rgbAt(out, 192)));
  });

  it("keeps the picture's alpha, and amount blends with the original", () => {
    const src = createCanvas(4, 4);
    const x = src.getContext("2d");
    x.fillStyle = "#808080";
    x.fillRect(0, 0, 2, 4); // right half transparent
    const full = tintPicture(src, { color: "#C8102E", mode: "color", amount: 1 });
    expect(rgbAt(full, 3)[3]).toBe(0);
    expect(rgbAt(full, 0)[3]).toBe(255);
    const half = tintPicture(src, { color: "#C8102E", mode: "color", amount: 0.5 });
    const [r, g] = rgbAt(half, 0);
    const [fr, fg] = rgbAt(full, 0);
    expect(r).toBeGreaterThan(128);
    expect(r).toBeLessThan(fr);
    expect(g).toBeLessThan(128);
    expect(g).toBeGreaterThan(fg);
  });

  it("multiply darkens towards the colour and screen lightens towards it", () => {
    const m = tintPicture(ramp(), { color: "#C8102E", mode: "multiply", amount: 1 });
    expect(rgbAt(m, 255).slice(0, 3)).toEqual([0xc8, 0x10, 0x2e]);
    expect(rgbAt(m, 0).slice(0, 3)).toEqual([0, 0, 0]);
    const s = tintPicture(ramp(), { color: "#C8102E", mode: "screen", amount: 1 });
    expect(rgbAt(s, 0).slice(0, 3)).toEqual([0xc8, 0x10, 0x2e]);
    expect(rgbAt(s, 255).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it("shrinks to maxSide", () => {
    const big = createCanvas(4000, 2000);
    const out = tintPicture(big, { color: "#C8102E", mode: "color", amount: 1 }, 1000);
    expect([out.width, out.height]).toEqual([1000, 500]);
  });

  it("resolves brand tokens and defaults", () => {
    expect(resolveTint({ color: "@primary" }, BRAND)).toEqual({ color: "#C8102E", mode: "color", amount: 1 });
    expect(resolveTint({ color: "#00ff0080", mode: "screen", amount: 0.4 }, BRAND)).toEqual({ color: "#00FF00", mode: "screen", amount: 0.4 });
    expect(resolveTint({ color: "@accent", amount: 0 }, BRAND)).toBeNull();
    expect(resolveTint(undefined, BRAND)).toBeNull();
  });
});

describe("tinted image layers in the renderer", () => {
  it("draws a greyscale plate in the academy colour", async () => {
    const scene: Scene = {
      v: 1, format: "square", background: "#000000", locale: "en",
      layers: [{ id: "plate", kind: "image", src: { type: "artwork", key: "bg/broadcast/1" }, fit: "cover", x: 0, y: 0, w: 1080, h: 1080, tint: { color: "@primary" } }],
    };
    const seen: string[] = [];
    const png = await renderScenePng({
      scene, brand: BRAND, images: async (_layer, _src, s) => { seen.push(s.format); return ramp(256); },
    });
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    c.getContext("2d").drawImage(img, 0, 0);
    expect(seen).toEqual(["square"]);
    const mid = rgbAt(c, 540, 540);
    expect(mid[0]).toBeGreaterThan(mid[1] + 60);
    expect(rgbAt(c, 2, 540).slice(0, 3).reduce((a, b) => a + b, 0)).toBeLessThan(12);
    expect(Math.min(...rgbAt(c, 1077, 540).slice(0, 3))).toBeGreaterThan(245);
  });
});

describe("background plates in the catalogue", () => {
  // The fields' style borrows the broadcast plates for academy templates (its own pack draws no plate).
  it("every style's templates start with the same tinted plate layer", () => {
    for (const style of CREATIVE_STYLES) {
      for (const format of ["post", "square", "story"] as const) {
        const scene = buildTemplateScene("fulltime", style, format, "en");
        const plate = scene.layers.find((l) => l.id === PLATE_LAYER_ID);
        expect(plate, style).toMatchObject({
          kind: "image", name: "bleed", src: { type: "artwork", key: isPackStyle(style) ? packPlate(style, "fulltime") : `bg/${style === "field" || style === "club" ? "broadcast" : style}/1` }, fit: "cover",
          x: 0, y: 0, w: 1080, tint: { color: "@primary", mode: "color" },
        });
        expect(templatePlateLayer(style, format, "fulltime")).toEqual(plate);
        expect(() => sceneSchema.parse(scene)).not.toThrow();
      }
    }
  });

  it("the seams under fading photos change nothing over a plain background", async () => {
    for (const style of CREATIVE_STYLES) {
      for (const key of ["fulltime", "matchday", "freetrial", "lineup"]) {
        for (const format of ["post", "story"] as const) {
          const scene = buildTemplateScene(key, style, format, "en");
          const plain: Scene = { ...scene, layers: scene.layers.filter((l) => l.id !== PLATE_LAYER_ID) };
          const noSeam: Scene = { ...plain, layers: plain.layers.filter((l) => !l.id.endsWith("-seam")) };
          if (noSeam.layers.length === plain.layers.length) continue;
          const data = templateSampleData(key, "en");
          const a = await renderScenePng({ scene: plain, brand: BRAND, data, images: async () => null, width: 540 });
          const b = await renderScenePng({ scene: noSeam, brand: BRAND, data, images: async () => null, width: 540 });
          expect(a.equals(b), `${key}/${style}/${format}`).toBe(true);
        }
      }
    }
  }, 60_000);

  it("a missing plate file draws exactly what the template drew without it", async () => {
    for (const style of CREATIVE_STYLES) {
      const scene = buildTemplateScene("fulltime", style, "post", "en");
      const without: Scene = { ...scene, layers: scene.layers.filter((l) => l.id !== PLATE_LAYER_ID) };
      const data = templateSampleData("fulltime", "en");
      const images = async () => null;
      const a = await renderScenePng({ scene, brand: BRAND, data, images, width: 270 });
      const b = await renderScenePng({ scene: without, brand: BRAND, data, images, width: 270 });
      expect(a.equals(b), style).toBe(true);
    }
  });
});
