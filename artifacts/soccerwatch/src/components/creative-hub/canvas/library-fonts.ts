import { FONT_LIBRARY, faceAlias, libraryFiles } from "@workspace/api-zod";
import { apiBase } from "@/lib/academy-studio-api";
import type { LibraryFace } from "./layout";

/**
 * The Creative font library (creativeFonts.ts) in the browser.
 *
 * One @font-face per library file, named by its alias exactly as the API
 * registers it with the canvas, pointing at GET /api/creative/fonts/<file>
 * (the same bytes the renderer draws with). fontFace() in layout.ts already
 * picked the file, so the rule's own weight/style never take part in matching:
 * the CSS font string asks for that one family at that file's weight.
 *
 * The browser fetches a face only when something uses it. A face that isn't
 * loaded yet measures in the fallback stack, so text layers re-measure when it
 * arrives (useLibraryFontsVersion).
 */

const STYLE_ID = "replay-creative-library-fonts";

/** The @font-face rules for every library file. */
export function libraryFontFaceCss(base: string = apiBase): string {
  return libraryFiles().map(({ face }) => [
    "@font-face {",
    `  font-family: "${faceAlias(face)}";`,
    `  src: url("${base}/creative/fonts/${encodeURIComponent(face.file)}") format("truetype");`,
    `  font-weight: ${face.weight};`,
    "  font-style: normal;",
    "  font-display: block;",
    "}",
  ].join("\n")).join("\n");
}

/** Add the rules to the page once. */
export function installLibraryFontFaces(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = libraryFontFaceCss();
  document.head.appendChild(style);
}

/** CSS font shorthand for a library face: its alias, then the family's fallback stack. */
export function libraryCssFont(face: LibraryFace, size: number): string {
  const fallback = FONT_LIBRARY[face.name]?.fallback ?? "sans-serif";
  return `${face.weight} ${size}px "${face.alias}", ${fallback}`;
}

let version = 0;
const listeners = new Set<() => void>();
const requested = new Set<string>();

/** Start loading a face the first time it is used; listeners hear when it arrives. */
export function requestLibraryFace(face: LibraryFace): void {
  if (requested.has(face.alias) || typeof document === "undefined" || !document.fonts) return;
  requested.add(face.alias);
  installLibraryFontFaces();
  void document.fonts.load(`${face.weight} 40px "${face.alias}"`)
    .catch(() => [])
    .finally(() => { version += 1; listeners.forEach((l) => l()); });
}

export function subscribeLibraryFonts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const libraryFontsVersion = () => version;
