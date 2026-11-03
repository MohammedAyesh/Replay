import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { FONT_LIBRARY, faceAlias, libraryFiles } from "@workspace/api-zod";
import { fontFace } from "./layout";
import { libraryCssFont, libraryFontFaceCss } from "./library-fonts";
import { offeredStyles } from "@/lib/creative-styles";

type TextLayer = Parameters<typeof fontFace>[0];
const layer = (over: Partial<TextLayer> = {}): TextLayer => ({ font: "body", weight: 700, ...over });

describe("Creative font library in the browser", () => {
  it("declares one @font-face per library file, named like the server registers it, served by the API", () => {
    const css = libraryFontFaceCss("/api");
    const faces = css.match(/@font-face/g) ?? [];
    expect(faces).toHaveLength(libraryFiles().length);
    expect(css).toContain(`font-family: "${faceAlias("BarlowCondensed-900i.ttf")}";`);
    expect(css).toContain('src: url("/api/creative/fonts/BarlowCondensed-900i.ttf") format("truetype");');
  });

  it("asks CSS for exactly the file layout.ts picked, then the family's fallbacks", () => {
    const face = fontFace(layer({ family: "Barlow Condensed", weight: 900, italic: true }), "GOAL");
    expect(face).toMatchObject({ family: "library", file: "BarlowCondensed-900i.ttf", italic: false });
    if (face.family !== "library") throw new Error("expected a library face");
    expect(libraryCssFont(face, 80)).toBe(`900 80px "${faceAlias("BarlowCondensed-900i.ttf")}", ${FONT_LIBRARY["Barlow Condensed"].fallback}`);
    // Latin-only family with Arabic text: the house Cairo, as on the server.
    expect(fontFace(layer({ family: "Bebas Neue" }), "يوم المباراة").family).toBe("cairo");
  });

  it("keeps canvas/layout.ts a copy of the API's renderLayout.ts", () => {
    const browser = fs.readFileSync(new URL("./layout.ts", import.meta.url), "utf8");
    const server = fs.readFileSync(new URL("../../../../../api-server/src/lib/creative/renderLayout.ts", import.meta.url), "utf8");
    const strip = (s: string) => s.split("\n").filter((l) => !/COPY of artifacts|^ \*$/.test(l)).join("\n");
    expect(strip(browser)).toBe(strip(server));
  });
});

describe("Creative styles on offer", () => {
  it("offers the house styles, plus the academy's own pack first, never another pack", () => {
    expect(offeredStyles(null)).toEqual(["broadcast", "street", "editorial", "luxury", "playful", "cinematic", "stadium"]);
    const iris = offeredStyles({ key: "iris", name: "IRIS International Sports", franchise: false });
    expect(iris[0]).toBe("iris");
    expect(iris).toHaveLength(8);
    expect(iris.filter((s) => ["souqar", "barca", "juventus", "knights", "jufa"].includes(s))).toEqual([]);
  });
});
