import fs from "node:fs";
import { Router, type IRouter } from "express";
import { FONT_LIBRARY_FAMILIES, libraryFileByName } from "@workspace/api-zod";
import { ensureLibraryFonts, libraryFontPath } from "../lib/creative/fonts";

/**
 * GET /api/creative/fonts/:file — a Creative hub library font (public).
 *
 * The console's @font-face rules point here so SceneCanvas sets text in the
 * very files the renderer registers. Only names in FONT_LIBRARY are served
 * (no paths, no other files); the files are OFL / Apache 2.0, so no sign-in.
 * A file name never changes content, so it caches for a year.
 */
const router: IRouter = Router();

if (process.env.NODE_ENV !== "test") {
  // Register the library with the canvas once, at startup.
  setTimeout(() => { ensureLibraryFonts(); }, 0).unref();
}

router.get("/creative/fonts", (_req, res): void => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({ families: FONT_LIBRARY_FAMILIES });
});

router.get("/creative/fonts/:file", (req, res): void => {
  const name = String(req.params.file ?? "");
  const entry = libraryFileByName(name);
  const file = entry ? libraryFontPath(name) : null;
  if (!entry || !file || !fs.existsSync(file)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.removeHeader("Vary");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("font/ttf");
  res.sendFile(file, { cacheControl: false, dotfiles: "deny" });
});

export default router;
