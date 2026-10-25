import fs from "fs";
import path from "path";
import { GlobalFonts, loadImage, type Image } from "@napi-rs/canvas";
import { logger } from "../logger";

/**
 * Fonts, the Replay mark and the bundled venue presets.
 *
 * They ship inside the api-server artifact (assets/branding) rather than being
 * fetched, because the export must not depend on a network call for its type:
 * a missing font silently falls back to a system face with no Arabic shaping,
 * and the end screen would come out with disconnected letters.
 *
 * The bundle is a single file in dist/, the sources live in src/lib/…, and the
 * tests run from src — so the directory is found by walking up from wherever
 * this module ended up, rather than by one fixed relative path.
 */

let assetDirCache: string | null = null;

export function brandingAssetDir(): string {
  if (assetDirCache) return assetDirCache;
  const starts = [
    typeof __dirname === "string" ? __dirname : process.cwd(),
    process.cwd(),
  ];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "assets", "branding");
      if (fs.existsSync(path.join(candidate, "fonts"))) {
        assetDirCache = candidate;
        return candidate;
      }
      const nested = path.join(dir, "artifacts", "api-server", "assets", "branding");
      if (fs.existsSync(path.join(nested, "fonts"))) {
        assetDirCache = nested;
        return nested;
      }
      dir = path.dirname(dir);
    }
  }
  throw new Error("Branding assets directory (assets/branding) not found");
}

/** Font family names as registered. Named, not guessed, so a lookup never lands on a system face. */
export const FONT = {
  display: "ReplayRajdhani700",
  displaySemi: "ReplayRajdhani600",
  arabicBold: "ReplayCairo700",
  arabicBlack: "ReplayCairo900",
} as const;

let fontsReady = false;

export function ensureBrandingFonts(): void {
  if (fontsReady) return;
  const dir = path.join(brandingAssetDir(), "fonts");
  const files: Array<[string, string]> = [
    ["Rajdhani-Bold.ttf", FONT.display],
    ["Rajdhani-SemiBold.ttf", FONT.displaySemi],
    ["Cairo-700.ttf", FONT.arabicBold],
    ["Cairo-900.ttf", FONT.arabicBlack],
  ];
  for (const [file, family] of files) {
    const ok = GlobalFonts.registerFromPath(path.join(dir, file), family);
    if (!ok) logger.warn({ file }, "Could not register a branding font");
  }
  fontsReady = true;
}

const imageCache = new Map<string, Promise<Image | null>>();

/** Load an image from a local path, once. Null (logged) when it cannot be read. */
export function loadLocalImage(filePath: string): Promise<Image | null> {
  let pending = imageCache.get(filePath);
  if (!pending) {
    pending = loadImage(filePath).catch((err: unknown) => {
      logger.warn({ err, filePath }, "Could not load a branding image");
      imageCache.delete(filePath);
      return null;
    });
    imageCache.set(filePath, pending);
  }
  return pending;
}

export function replayMarkPath(): string {
  return path.join(brandingAssetDir(), "replay-mark.svg");
}

/**
 * Real venues, taken from their own public pages on 2026-10-25, so the console
 * can set them up in one click. The crests were cut out of the profile images
 * those pages publish; the colours were sampled from the crests.
 */
export type BrandingPreset = {
  key: string;
  label: string;
  source: string;
  nameEn: string;
  nameAr: string | null;
  taglineAr: string | null;
  primaryColor: string;
  accentColor: string | null;
  bookingPhone: string | null;
  instagram: string | null;
  crestFile: string;
};

export const BRANDING_PRESETS: readonly BrandingPreset[] = [
  {
    key: "jordan-galaxy",
    label: "Jordan Galaxy Stadium",
    source: "facebook.com/JORDANGALAXY0",
    nameEn: "JORDAN GALAXY",
    nameAr: "ملاعب جوردن جلاكسي",
    taglineAr: "كل ماتش هون متصوّر",
    primaryColor: "#F4CF1F",
    accentColor: null,
    bookingPhone: "07 9920 4098",
    instagram: null,
    crestFile: "jordan-galaxy-crest.png",
  },
  {
    key: "jufa",
    label: "Jordan United Football Academy (JUFA)",
    source: "facebook.com/JordanUnitedFootballAcademy · instagram.com/jufa_academy",
    nameEn: "JUFA",
    // Their pages give no Arabic name, so none is invented here.
    nameAr: null,
    taglineAr: "ملاعب جالاكسي · الظهير",
    primaryColor: "#2B3DA8",
    accentColor: "#3DB54A",
    bookingPhone: "07 9543 3320",
    instagram: "jufa_academy",
    crestFile: "jufa-crest.png",
  },
];

export function presetCrestPath(preset: BrandingPreset): string {
  return path.join(brandingAssetDir(), "presets", preset.crestFile);
}
