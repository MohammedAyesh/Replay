/**
 * Replay's font library for the Creative hub: the typefaces brand packs
 * (creativePacks.ts) name, shipped with the API so an export never depends on
 * a network call or a system face.
 *
 * Files live in artifacts/api-server/assets/creative/fonts/<slug>/<file>, with
 * the family's licence (OFL.txt; Permanent Marker is Apache 2.0, LICENSE.txt).
 * Every file is a static face: Google's variable fonts were cut into static
 * instances (fontTools instancer; Inter at opsz 32, Cairo at slnt 0) and all
 * files subset to Latin + Arabic + punctuation. Static faces make the server
 * (@napi-rs/canvas ignores the weight axis) and the browser (which applies
 * optical sizing on its own) draw exactly the same glyphs.
 *
 * Both renderers register each file under its own name (faceAlias): the API
 * with GlobalFonts, the console with an @font-face rule pointing at
 * GET /api/creative/fonts/<file>. Picking the face is done here
 * (matchLibraryFace), never left to a font matcher, so the two agree.
 *
 * A text layer names a family with `family` (creativeScene.ts); see
 * fontFace() in renderLayout.ts for how it overrides `font`.
 */

export type LibraryFontFile = {
  /** File name, unique across the library (also the URL path segment). */
  file: string;
  weight: number;
  italic: boolean;
};

export type LibraryFont = {
  family: string;
  /** Directory under assets/creative/fonts. */
  slug: string;
  files: readonly LibraryFontFile[];
  /** Has Arabic glyphs and shaping, so it may set Arabic text. */
  isArabic: boolean;
  /** CSS fallback stack after the library face (browser only). */
  fallback: string;
  license: "OFL-1.1" | "Apache-2.0";
  licenseFile: "OFL.txt" | "LICENSE.txt";
};

const faces = (name: string, upright: number[], italic: number[] = []): LibraryFontFile[] => [
  ...upright.map((weight) => ({ file: `${name}-${weight}.ttf`, weight, italic: false })),
  ...italic.map((weight) => ({ file: `${name}-${weight}i.ttf`, weight, italic: true })),
];

const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const ARABIC_SANS = "Cairo, 'Noto Sans Arabic', Tahoma, sans-serif";

const font = (
  family: string, slug: string, files: LibraryFontFile[], isArabic: boolean, fallback: string,
  license: LibraryFont["license"] = "OFL-1.1",
): LibraryFont => ({ family, slug, files, isArabic, fallback, license, licenseFile: license === "OFL-1.1" ? "OFL.txt" : "LICENSE.txt" });

export const FONT_LIBRARY: Readonly<Record<string, LibraryFont>> = {
  "Bebas Neue": font("Bebas Neue", "bebasneue", faces("BebasNeue", [400]), false, `Impact, 'Arial Narrow', ${SANS}`),
  Inter: font("Inter", "inter", faces("Inter", [400, 600, 700, 800, 900], [400, 700]), false, SANS),
  Cairo: font("Cairo", "cairo", faces("Cairo", [400, 600, 700, 800, 900]), true, ARABIC_SANS),
  "Kaushan Script": font("Kaushan Script", "kaushanscript", faces("KaushanScript", [400]), false, "'Brush Script MT', cursive"),
  Montserrat: font("Montserrat", "montserrat", faces("Montserrat", [400, 600, 700, 800, 900], [700, 900]), false, SANS),
  "Barlow Condensed": font("Barlow Condensed", "barlowcondensed", faces("BarlowCondensed", [400, 600, 700, 800, 900], [400, 700, 900]), false, `'Arial Narrow', ${SANS}`),
  Barlow: font("Barlow", "barlow", faces("Barlow", [400, 600, 700, 800, 900], [400, 700]), false, SANS),
  Tajawal: font("Tajawal", "tajawal", faces("Tajawal", [400, 500, 700, 800, 900]), true, ARABIC_SANS),
  "Archivo Black": font("Archivo Black", "archivoblack", faces("ArchivoBlack", [400]), false, `'Arial Black', ${SANS}`),
  "Archivo Narrow": font("Archivo Narrow", "archivonarrow", faces("ArchivoNarrow", [400, 500, 600, 700], [400, 700]), false, `'Arial Narrow', ${SANS}`),
  "IBM Plex Sans Arabic": font("IBM Plex Sans Arabic", "ibmplexsansarabic", faces("IBMPlexSansArabic", [400, 500, 600, 700]), true, ARABIC_SANS),
  "Permanent Marker": font("Permanent Marker", "permanentmarker", faces("PermanentMarker", [400]), false, "'Marker Felt', cursive", "Apache-2.0"),
  "Baloo 2": font("Baloo 2", "baloo2", faces("Baloo2", [400, 500, 600, 700, 800]), false, SANS),
  "Baloo Bhaijaan 2": font("Baloo Bhaijaan 2", "baloobhaijaan2", faces("BalooBhaijaan2", [400, 500, 600, 700, 800]), true, ARABIC_SANS),
};

export const FONT_LIBRARY_FAMILIES = Object.keys(FONT_LIBRARY);

/** The library entry for a family name (exact, as creativePacks.ts writes it), or null. */
export function libraryFont(family: string | undefined | null): LibraryFont | null {
  if (!family) return null;
  return Object.prototype.hasOwnProperty.call(FONT_LIBRARY, family) ? FONT_LIBRARY[family] : null;
}

/** The name a face is registered under on both sides: letters and digits only, so no quoting trouble. */
export function faceAlias(file: LibraryFontFile | string): string {
  const name = typeof file === "string" ? file : file.file;
  return `ReplayLib${name.replace(/\.ttf$/, "").replace(/[^A-Za-z0-9]/g, "")}`;
}

/** Every file in the library with its family, for registration and for the font route. */
export function libraryFiles(): Array<{ font: LibraryFont; face: LibraryFontFile }> {
  return Object.values(FONT_LIBRARY).flatMap((f) => f.files.map((face) => ({ font: f, face })));
}

/** A library file by its file name (the URL segment), or null: only library files are ever served. */
export function libraryFileByName(file: string): { font: LibraryFont; face: LibraryFontFile } | null {
  return libraryFiles().find((x) => x.face.file === file) ?? null;
}

/** CSS Fonts 4 weight matching over the weights on offer. */
export function matchWeight(available: readonly number[], desired: number): number {
  const ws = [...new Set(available)].sort((a, b) => a - b);
  if (!ws.length) return desired;
  if (ws.includes(desired)) return desired;
  const below = ws.filter((w) => w < desired).reverse();
  const above = ws.filter((w) => w > desired);
  if (desired >= 400 && desired <= 500) {
    const upTo500 = above.filter((w) => w <= 500);
    if (upTo500.length) return upTo500[0];
    if (below.length) return below[0];
    return above[0];
  }
  if (desired < 400) return below.length ? below[0] : above[0];
  return above.length ? above[0] : below[0];
}

/**
 * The face to draw a family at a weight. Italic uses the family's own italic
 * when it has one; otherwise the upright face is slanted (synthItalic), as the
 * house fonts are.
 */
export function matchLibraryFace(font: LibraryFont, weight: number, italic: boolean): { face: LibraryFontFile; synthItalic: boolean } {
  const italics = font.files.filter((f) => f.italic);
  const pool = italic && italics.length ? italics : font.files.filter((f) => !f.italic);
  const w = matchWeight(pool.map((f) => f.weight), weight);
  const face = pool.find((f) => f.weight === w) ?? font.files[0];
  return { face, synthItalic: italic && !face.italic };
}
