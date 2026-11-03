import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  CREATIVE_PACKS, FONT_LIBRARY, faceAlias, libraryFiles, matchLibraryFace, matchWeight,
  type CreativeBrand, type Scene, type SceneLayer,
} from "@workspace/api-zod";
import { creativeFontsDir, ensureLibraryFonts, libraryFaceAvailable, libraryFontPath } from "./fonts";
import { fontString, renderScenePng } from "./render";
import { fontFace } from "./renderLayout";

const BRAND: CreativeBrand = {
  primary: "#2B3DA8", accent: "#3DB54A", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "JUFA", nameAr: null,
};

type TextLayer = Extract<SceneLayer, { kind: "text" }>;
const text = (over: Partial<TextLayer> = {}): TextLayer => ({
  id: "t", kind: "text", x: 40, y: 200, w: 1000, h: 300, text: "MATCHDAY", font: "body", size: 160, weight: 700,
  color: "#000000", align: "start", dir: "auto", ...over,
});

function width(layer: TextLayer, s: string): number {
  ensureLibraryFonts();
  const ctx = createCanvas(10, 10).getContext("2d");
  ctx.font = fontString(fontFace(layer, s, libraryFaceAvailable), layer.size);
  return ctx.measureText(s).width;
}

/** Leftmost and rightmost inked column of a PNG (anything darker than mid-grey). */
async function inkSpan(png: Buffer): Promise<[number, number]> {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let lo = img.width;
  let hi = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (data[(y * img.width + x) * 4] < 128) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    }
  }
  return [lo, hi];
}

describe("Creative font library", () => {
  it("ships every library file, with its licence, and every pack family is in the library", () => {
    const dir = creativeFontsDir();
    for (const { font, face } of libraryFiles()) {
      expect(fs.existsSync(path.join(dir, font.slug, face.file)), face.file).toBe(true);
      expect(fs.existsSync(path.join(dir, font.slug, font.licenseFile)), `${font.slug} licence`).toBe(true);
    }
    for (const pack of Object.values(CREATIVE_PACKS)) {
      for (const family of Object.values(pack.fonts)) expect(FONT_LIBRARY[family], `${pack.key}: ${family}`).toBeTruthy();
    }
    // File names are unique (they are the URL), and only library names resolve to a path.
    const names = libraryFiles().map((x) => x.face.file);
    expect(new Set(names).size).toBe(names.length);
    expect(libraryFontPath("../../package.json")).toBeNull();
    expect(libraryFontPath("Inter-700.ttf")).toMatch(/inter\/Inter-700\.ttf$/);
  });

  it("registers every face with the canvas", () => {
    ensureLibraryFonts();
    for (const { face } of libraryFiles()) expect(libraryFaceAvailable(face.file), face.file).toBe(true);
  });

  it("matches weights the CSS way", () => {
    expect(matchWeight([400, 600, 700, 800, 900], 700)).toBe(700);
    expect(matchWeight([400, 600, 700, 800, 900], 650)).toBe(700);
    expect(matchWeight([400, 600, 700, 800, 900], 500)).toBe(400);
    expect(matchWeight([400, 500, 700], 450)).toBe(500);
    expect(matchWeight([400], 900)).toBe(400);
    expect(matchWeight([400, 600, 700], 300)).toBe(400);
    expect(matchWeight([400, 500, 600, 700, 800], 900)).toBe(800);
    // Barlow Condensed has a real 900 italic; Bebas Neue is slanted.
    const bc = matchLibraryFace(FONT_LIBRARY["Barlow Condensed"], 900, true);
    expect([bc.face.file, bc.synthItalic]).toEqual(["BarlowCondensed-900i.ttf", false]);
    const bebas = matchLibraryFace(FONT_LIBRARY["Bebas Neue"], 700, true);
    expect([bebas.face.file, bebas.synthItalic]).toEqual(["BebasNeue-400.ttf", true]);
  });

  it("picks the library face for `family`, the house face otherwise (Arabic rules)", () => {
    const bebas = fontFace(text({ family: "Bebas Neue" }), "MATCHDAY", libraryFaceAvailable);
    expect(bebas).toMatchObject({ family: "library", name: "Bebas Neue", file: "BebasNeue-400.ttf", alias: faceAlias("BebasNeue-400.ttf"), italic: false, arabic: false });
    // script does not slant a library face; italic does when there's no italic file.
    expect(fontFace(text({ family: "Bebas Neue", font: "script" }), "GO").italic).toBe(false);
    // A Latin-only family with Arabic text: the house Cairo.
    expect(fontFace(text({ family: "Bebas Neue" }), "يوم المباراة")).toMatchObject({ family: "cairo", arabic: true });
    // An Arabic family sets Arabic text, and Latin text too.
    expect(fontFace(text({ family: "Tajawal", font: "arabic", weight: 900 }), "يوم المباراة")).toMatchObject({ family: "library", file: "Tajawal-900.ttf", arabic: true });
    expect(fontFace(text({ family: "Cairo" }), "MATCHDAY")).toMatchObject({ family: "library", file: "Cairo-700.ttf", arabic: false });
    // Unknown family, or a file that isn't there: the layer's `font`.
    expect(fontFace(text({ family: "Comic Sans" }), "MATCHDAY")).toMatchObject({ family: "rajdhani", weight: 700 });
    expect(fontFace(text({ family: "Inter" }), "MATCHDAY", () => false)).toMatchObject({ family: "rajdhani" });
  });

  it("measures and draws a `family` text in that font, not the fallback", async () => {
    const house = width(text(), "MATCHDAY");
    const bebas = width(text({ family: "Bebas Neue" }), "MATCHDAY");
    const montserrat = width(text({ family: "Montserrat", weight: 900 }), "MATCHDAY");
    const montserrat400 = width(text({ family: "Montserrat", weight: 400 }), "MATCHDAY");
    // Bebas Neue is much narrower than Rajdhani, Montserrat Black much wider; weights are real faces.
    expect(Math.abs(bebas - house) / house).toBeGreaterThan(0.05);
    expect(montserrat).toBeGreaterThan(house * 1.1);
    expect(montserrat).toBeGreaterThan(montserrat400 * 1.03);
    // Arabic in an Arabic library family is shaped (joined glyphs are narrower than isolated forms).
    const joined = width(text({ family: "Tajawal", font: "arabic" }), "مباراة");
    const isolated = width(text({ family: "Tajawal", font: "arabic" }), "م ب ا ر ا ة".replace(/ /g, "‌"));
    expect(joined).toBeLessThan(isolated);

    const scene = (layer: TextLayer): Scene => ({ v: 1, format: "square", background: "#FFFFFF", layers: [layer], locale: "en" });
    const [, houseRight] = await inkSpan(await renderScenePng({ scene: scene(text()), brand: BRAND }));
    const [, bebasRight] = await inkSpan(await renderScenePng({ scene: scene(text({ family: "Bebas Neue" })), brand: BRAND }));
    expect(houseRight).toBeGreaterThan(0);
    expect(Math.abs(bebasRight - houseRight)).toBeGreaterThan(30);
  });
});
