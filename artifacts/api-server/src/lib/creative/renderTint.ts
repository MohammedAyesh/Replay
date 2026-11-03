import { createCanvas, type Canvas, type Image } from "@napi-rs/canvas";
import type { ResolvedTint } from "@workspace/api-zod";

/**
 * Creative hub engine: recolour a picture (an image layer's `tint`).
 *
 * Used by the still renderer (and so by the MP4 overlays) and by GET
 * …/creative/media?tint=…, which is what SceneCanvas shows, so the preview is
 * the export: both run this function on the source picture before it is
 * fitted into its box.
 *
 *   1. draw the picture on an offscreen canvas;
 *   2. fill it with the tint colour using the blend mode — "color" keeps the
 *      picture's luminosity and takes the tint's hue and saturation (W3C /
 *      Photoshop "Color"), so white stays white and black stays black;
 *      "multiply" darkens towards the colour, "screen" lightens towards it;
 *   3. put the picture's own alpha back (destination-in), since the fill
 *      covered transparent pixels too;
 *   4. amount < 1: lay the tinted picture over the original at that alpha.
 */

type Picture = Image | Canvas;

export function tintPicture(img: Picture, tint: ResolvedTint, maxSide?: number): Canvas {
  const k = maxSide && maxSide > 0 ? Math.min(1, maxSide / Math.max(img.width, img.height)) : 1;
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const tinted = createCanvas(w, h);
  const t = tinted.getContext("2d");
  t.drawImage(img as Image, 0, 0, w, h);
  t.globalCompositeOperation = tint.mode;
  t.fillStyle = tint.color;
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = "destination-in";
  t.drawImage(img as Image, 0, 0, w, h);
  t.globalCompositeOperation = "source-over";
  if (tint.amount >= 1) return tinted;
  const out = createCanvas(w, h);
  const o = out.getContext("2d");
  o.drawImage(img as Image, 0, 0, w, h);
  o.globalAlpha = Math.max(0, tint.amount);
  o.drawImage(tinted, 0, 0);
  return out;
}

/** Cache key part for a tint ("" for none). */
export const tintKey = (tint: ResolvedTint | null) => (tint ? `${tint.color}:${tint.mode}:${tint.amount.toFixed(3)}` : "");
