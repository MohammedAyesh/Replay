import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { CREATIVE_STYLES, CREATIVE_TEMPLATES, buildTemplateScene, templateSampleData, type CreativeBrand, type Scene } from "@workspace/api-zod";
import { renderScenePng } from "./render";
import { fitRect, gradientPoints, layoutText, slantPoints, sourceTimeAt, videoParts, wrapLines } from "./renderLayout";

const BRAND: CreativeBrand = {
  primary: "#2B3DA8", accent: "#3DB54A", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "JUFA", nameAr: null,
};

async function pixels(png: Buffer) {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

/** Pixels in a rectangle that differ from `rgb` by more than a little. */
function countNot(px: { w: number; data: Uint8ClampedArray }, rgb: [number, number, number], x0: number, y0: number, x1: number, y1: number) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * px.w + x) * 4;
      if (Math.abs(px.data[i] - rgb[0]) + Math.abs(px.data[i + 1] - rgb[1]) + Math.abs(px.data[i + 2] - rgb[2]) > 30) n++;
    }
  }
  return n;
}

const at = (px: { w: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const i = (y * px.w + x) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
};

describe("creative still renderer", () => {
  it("renders the fulltime template at the scene's size, with content drawn", async () => {
    for (const format of ["post", "square", "story"] as const) {
      for (const locale of ["en", "ar"] as const) {
        const scene = buildTemplateScene("fulltime", "broadcast", format, locale);
        const png = await renderScenePng({ scene, brand: BRAND, data: templateSampleData("fulltime", locale) });
        const px = await pixels(png);
        const h = { post: 1350, square: 1080, story: 1920 }[format];
        expect([px.w, px.h]).toEqual([1080, h]);
        // Not a flat fill: a real share of the canvas differs from its corner colour.
        const corner = at(px, 2, 2).slice(0, 3) as [number, number, number];
        expect(countNot(px, corner, 0, 0, 1080, h)).toBeGreaterThan(1080 * h * 0.02);
      }
    }
  });

  it("renders every template in every style and format without throwing", async () => {
    for (const t of CREATIVE_TEMPLATES) {
      for (const style of CREATIVE_STYLES) {
        for (const format of t.formats) {
          const scene = buildTemplateScene(t.key, style, format, "ar");
          const px = await pixels(await renderScenePng({ scene, brand: BRAND, data: templateSampleData(t.key, "ar"), width: 108 }));
          expect(px.w).toBe(108);
        }
      }
    }
  }, 120_000);

  it("scales the output for thumbnails", async () => {
    const scene = buildTemplateScene("fulltime", "broadcast", "story", "en");
    const px = await pixels(await renderScenePng({ scene, brand: BRAND, data: {}, width: 270 }));
    expect([px.w, px.h]).toEqual([270, 480]);
  });

  it("draws every layer kind and honours hidden, opacity, rotation and timing", async () => {
    const red = createCanvas(40, 20);
    const rctx = red.getContext("2d");
    rctx.fillStyle = "#FF0000";
    rctx.fillRect(0, 0, 40, 20);
    const scene: Scene = {
      v: 1, format: "square", background: "#000000", locale: "en",
      layers: [
        { id: "grad", kind: "shape", shape: "rect", x: 0, y: 0, w: 1080, h: 100, gradient: { from: "#FF0000", to: "#0000FF", angle: 90 } },
        { id: "pill", kind: "text", text: "Hello {{player.name}}", font: "display", size: 80, weight: 700, color: "#000000", align: "center", dir: "auto",
          x: 100, y: 200, w: 880, h: 160, background: { color: "@accent", padding: 20, radius: 40 }, stroke: { color: "#FFFFFF", width: 2 }, uppercase: true, letterSpacing: 4 },
        { id: "ellipse", kind: "shape", shape: "ellipse", x: 100, y: 400, w: 200, h: 200, fill: "@primary", stroke: { color: "#FFFFFF", width: 10 } },
        { id: "slant", kind: "shape", shape: "slant", x: 400, y: 400, w: 200, h: 200, fill: "#00FF00", skew: 20 },
        { id: "line", kind: "shape", shape: "line", x: 700, y: 400, w: 300, h: 10, fill: "#FFFFFF" },
        { id: "img", kind: "image", src: { type: "upload", mediaId: 1 }, x: 100, y: 700, w: 300, h: 300, fit: "cover", radius: 30 },
        { id: "contain", kind: "image", src: { type: "upload", mediaId: 2 }, x: 500, y: 700, w: 300, h: 300, fit: "contain" },
        { id: "hidden", kind: "shape", shape: "rect", x: 900, y: 700, w: 100, h: 100, fill: "#FFFFFF", hidden: true },
        { id: "faint", kind: "shape", shape: "rect", x: 900, y: 850, w: 100, h: 100, fill: "#FFFFFF", opacity: 0.5 },
        { id: "rot", kind: "shape", shape: "rect", x: 850, y: 100, w: 200, h: 20, fill: "#FFFFFF", rotation: 90 },
        { id: "arabic", kind: "text", text: "نهاية المباراة 3 – 1", font: "arabic-display", size: 70, weight: 900, color: "#FFFFFF", align: "start", dir: "auto",
          x: 100, y: 1000, w: 880, h: 80, fit: true, shadow: { color: "#000000", blur: 8, x: 0, y: 4 } },
      ],
    };
    const px = await pixels(await renderScenePng({
      scene, brand: BRAND, data: { player: { name: "Omar" } },
      images: async () => red,
    }));
    // Gradient left → right.
    expect(at(px, 2, 50)[0]).toBeGreaterThan(240);
    expect(at(px, 1077, 50)[2]).toBeGreaterThan(240);
    // Pill in the accent colour around the text.
    expect(countNot(px, [0, 0, 0], 100, 200, 980, 360)).toBeGreaterThan(20000);
    // Ellipse fill in @primary, white ring.
    expect(at(px, 200, 500).slice(0, 3)).toEqual([0x2b, 0x3d, 0xa8]);
    expect(at(px, 200, 403).slice(0, 3)).toEqual([255, 255, 255]);
    // Slant: the top-left corner is cut away, the middle is green.
    expect(at(px, 402, 402).slice(0, 3)).toEqual([0, 0, 0]);
    expect(at(px, 500, 500).slice(0, 3)).toEqual([0, 255, 0]);
    // Line through the middle of its box.
    expect(at(px, 850, 405).slice(0, 3)).toEqual([255, 255, 255]);
    // Cover image fills the box; rounded corner leaves the background.
    expect(at(px, 250, 850).slice(0, 3)).toEqual([255, 0, 0]);
    expect(at(px, 101, 701).slice(0, 3)).toEqual([0, 0, 0]);
    // Contain (2:1 into a square) letterboxes top and bottom.
    expect(at(px, 650, 710).slice(0, 3)).toEqual([0, 0, 0]);
    expect(at(px, 650, 850).slice(0, 3)).toEqual([255, 0, 0]);
    // Hidden draws nothing; half opacity draws grey.
    expect(at(px, 950, 750).slice(0, 3)).toEqual([0, 0, 0]);
    const grey = at(px, 950, 900)[0];
    expect(grey).toBeGreaterThan(110);
    expect(grey).toBeLessThan(145);
    // Rotated 90°: the 200×20 bar stands upright around its centre (950, 110).
    expect(at(px, 950, 30).slice(0, 3)).toEqual([255, 255, 255]);
    expect(at(px, 870, 110).slice(0, 3)).toEqual([0, 0, 0]);
    // Arabic text drawn (Cairo), right-aligned for start in RTL.
    expect(countNot(px, [0, 0, 0], 540, 1000, 980, 1080)).toBeGreaterThan(1000);
  });

  it("draws only the layers visible at time t", async () => {
    const scene: Scene = {
      v: 1, format: "square", background: "#000000", locale: "en", durationMs: 4000,
      layers: [
        { id: "early", kind: "shape", shape: "rect", x: 0, y: 0, w: 100, h: 100, fill: "#FFFFFF", endMs: 1000 },
        { id: "late", kind: "shape", shape: "rect", x: 200, y: 0, w: 100, h: 100, fill: "#FFFFFF", startMs: 1000 },
      ],
    };
    const early = await pixels(await renderScenePng({ scene, brand: BRAND, t: 500 }));
    expect(at(early, 50, 50)[0]).toBe(255);
    expect(at(early, 250, 50)[0]).toBe(0);
    const late = await pixels(await renderScenePng({ scene, brand: BRAND, t: 1000 }));
    expect(at(late, 50, 50)[0]).toBe(0);
    expect(at(late, 250, 50)[0]).toBe(255);
  });
});

describe("creative layout maths", () => {
  const mono = (s: string, size: number) => s.length * size * 0.5;

  it("wraps on words and keeps newlines", () => {
    expect(wrapLines("one two three", 7 * 5, (s) => s.length * 5)).toEqual(["one two", "three"]);
    expect(wrapLines("a\n\nb", 100, (s) => s.length)).toEqual(["a", "", "b"]);
  });

  it("fit shrinks until the block fits, centring it in the box", () => {
    const layer = { size: 100, w: 500, h: 120, fit: true, align: "center" as const, lineHeight: 1 };
    const out = layoutText(layer, "FULL TIME TODAY", "ltr", false, mono);
    expect(out.size).toBeLessThan(100);
    expect(out.lines.length * out.lineHeight).toBeLessThanOrEqual(120.5);
    expect(Math.max(...out.widths)).toBeLessThanOrEqual(500.5);
    expect(out.block.y).toBeCloseTo((120 - out.block.h) / 2);
    const rtl = layoutText({ ...layer, fit: false, align: "start" as const }, "ab", "rtl", true, mono);
    expect(rtl.positions[0].x + rtl.widths[0]).toBeCloseTo(500);
  });

  it("gradient points follow CSS angles", () => {
    const down = gradientPoints(100, 200, 180);
    expect([down.x0, down.y0, down.x1, down.y1].map((v) => Math.round(v))).toEqual([50, 0, 50, 200]);
    const p = gradientPoints(100, 200, 90);
    expect(p.x0).toBeCloseTo(0);
    expect(p.x1).toBeCloseTo(100);
  });

  it("slant and fit rectangles", () => {
    expect(slantPoints(100, 100, 45)[0][0]).toBeCloseTo(100);
    expect(fitRect("contain", 200, 100, 100, 100)).toMatchObject({ dw: 100, dh: 50, dy: 25 });
    expect(fitRect("cover", 200, 100, 100, 100)).toMatchObject({ sx: 50, sw: 100, sh: 100 });
  });

  it("video timeline: trim, speed and slow motion", () => {
    const parts = videoParts({ trimInMs: 1000, trimOutMs: 7000, speed: 2, slowMo: { fromMs: 3000, toMs: 4000, speed: 0.25 } }, 10_000, 5000);
    expect(parts.map((p) => [p.srcFrom, p.srcTo, p.speed])).toEqual([[1000, 3000, 2], [3000, 4000, 0.5], [4000, 7000, 2]]);
    expect(parts[parts.length - 1].outTo).toBeCloseTo(1000 + 2000 + 1500);
    expect(sourceTimeAt(parts, 1500).srcMs).toBeCloseTo(3000 + 500 * 0.5);
    expect(sourceTimeAt(parts, 99_999)).toMatchObject({ srcMs: 7000, ended: true });
    // No trim-out and no known length: plays for the layer's window.
    expect(videoParts({ trimInMs: 0, speed: 1 }, null, 3000)).toEqual([{ srcFrom: 0, srcTo: 3000, speed: 1, outFrom: 0, outTo: 3000 }]);
  });
});
