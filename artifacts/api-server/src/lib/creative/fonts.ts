import fs from "node:fs";
import path from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";
import { faceAlias, libraryFileByName, libraryFiles } from "@workspace/api-zod";
import { brandingAssetDir } from "../clipBranding/assets";
import { logger } from "../logger";

/**
 * The Creative hub font library (lib/api-zod/src/creativeFonts.ts) on the
 * server: every file registered with @napi-rs/canvas under its alias, once,
 * and the path the public font route serves.
 *
 * A file that is missing or fails to register is left out; fontFace() then
 * falls back to the layer's house `font` for it (libraryFaceAvailable).
 */

/** assets/creative/fonts (CREATIVE_FONTS_DIR overrides it, for tests). */
export function creativeFontsDir(): string {
  return process.env.CREATIVE_FONTS_DIR || path.join(path.dirname(brandingAssetDir()), "creative", "fonts");
}

/** The file on disk for a library file name, or null when it isn't a library file. */
export function libraryFontPath(file: string): string | null {
  const entry = libraryFileByName(file);
  if (!entry) return null;
  return path.join(creativeFontsDir(), entry.font.slug, entry.face.file);
}

const registered = new Set<string>();
let attempted = false;

/** Register every library face (idempotent). Called at startup and before each draw. */
export function ensureLibraryFonts(): void {
  if (attempted) return;
  attempted = true;
  let dir: string;
  try {
    dir = creativeFontsDir();
  } catch (err) {
    logger.warn({ err }, "Creative font library not found; scenes use the house fonts");
    return;
  }
  const missing: string[] = [];
  for (const { font, face } of libraryFiles()) {
    const file = path.join(dir, font.slug, face.file);
    if (!fs.existsSync(file)) { missing.push(face.file); continue; }
    try {
      if (GlobalFonts.registerFromPath(file, faceAlias(face))) registered.add(face.file);
      else missing.push(face.file);
    } catch {
      missing.push(face.file);
    }
  }
  if (missing.length) logger.warn({ missing: missing.slice(0, 20), count: missing.length }, "Some Creative library fonts could not be registered");
}

/** Can the renderer draw this library file? */
export function libraryFaceAvailable(file: string): boolean {
  ensureLibraryFonts();
  return registered.has(file);
}

/** For tests: forget what was registered (GlobalFonts keeps the faces). */
export function resetLibraryFontsForTest(): void {
  attempted = false;
  registered.clear();
}
