import type { Appearance } from "./model";

/**
 * What a player looks like, read off the crop strips.
 *
 * The prototype ranked people with a colour profile the offline pipeline
 * measured (torso Lab, shorts Lab, a torso histogram, height). Replay's bundle
 * carries only the crops, so the same four measurements are taken here, in the
 * browser, from those crops -- and in the same units, so the same distance
 * formula and thresholds read the same way:
 *
 *   to  mean torso colour, OpenCV 8-bit Lab (L*255/100, a+128, b+128)
 *   sh  mean shorts colour, same space
 *   hi  32-bin torso histogram: 8 hues x 2 saturations x 2 values
 *   hr  height against other players standing at the same image row
 */

type Rgb = [number, number, number];

const TORSO = { x0: 0.3, x1: 0.7, y0: 0.24, y1: 0.52 };
const SHORTS = { x0: 0.3, x1: 0.7, y0: 0.55, y1: 0.7 };

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0-255) to OpenCV-style 8-bit Lab. */
export function rgbToLab8(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(Y) - 16;
  const A = 500 * (f(X) - f(Y));
  const Bb = 200 * (f(Y) - f(Z));
  return [(L * 255) / 100, A + 128, Bb + 128];
}

/** OpenCV-style 8-bit Lab back to sRGB (0-255), for swatches. */
export function lab8ToRgb(L8: number, a8: number, b8: number): [number, number, number] {
  const L = (L8 * 100) / 255;
  const a = a8 - 128;
  const b = b8 - 128;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = f(fx) * 0.95047;
  const Y = f(fy);
  const Z = f(fz) * 1.08883;
  const g = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return [g(3.2406 * X - 1.5372 * Y - 0.4986 * Z), g(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), g(0.0557 * X - 0.204 * Y + 1.057 * Z)];
}

function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max / 255];
}

function region(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: { x0: number; x1: number; y0: number; y1: number },
  visit: (rgb: Rgb) => void,
): number {
  const x0 = Math.floor(width * box.x0);
  const x1 = Math.max(x0 + 1, Math.ceil(width * box.x1));
  const y0 = Math.floor(height * box.y0);
  const y1 = Math.max(y0 + 1, Math.ceil(height * box.y1));
  let n = 0;
  for (let y = y0; y < Math.min(height, y1); y++) {
    for (let x = x0; x < Math.min(width, x1); x++) {
      const o = (y * width + x) * 4;
      if (pixels[o + 3] < 128) continue;
      visit([pixels[o], pixels[o + 1], pixels[o + 2]]);
      n++;
    }
  }
  return n;
}

export type CropFeature = { to: [number, number, number]; sh: [number, number, number]; hi: number[] };

/** One crop's colour measurements, from RGBA pixels. Null when the crop is too small. */
export function featureFromPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): CropFeature | null {
  if (width < 4 || height < 8) return null;
  const to = [0, 0, 0];
  const hi = new Array<number>(32).fill(0);
  const nt = region(pixels, width, height, TORSO, ([r, g, b]) => {
    const lab = rgbToLab8(r, g, b);
    to[0] += lab[0]; to[1] += lab[1]; to[2] += lab[2];
    const [h, s, v] = hsv(r, g, b);
    const bin = (Math.min(7, Math.floor(h / 45)) * 4) + (s >= 0.35 ? 2 : 0) + (v >= 0.5 ? 1 : 0);
    hi[bin]++;
  });
  const sh = [0, 0, 0];
  const ns = region(pixels, width, height, SHORTS, ([r, g, b]) => {
    const lab = rgbToLab8(r, g, b);
    sh[0] += lab[0]; sh[1] += lab[1]; sh[2] += lab[2];
  });
  if (nt < 6 || ns < 3) return null;
  return {
    to: [to[0] / nt, to[1] / nt, to[2] / nt],
    sh: [sh[0] / ns, sh[1] / ns, sh[2] / ns],
    hi: hi.map((v) => v / nt),
  };
}

/** Average several crops into one piece profile. */
export function combineFeatures(features: Array<CropFeature | null>, hr: number): Appearance | null {
  const ok = features.filter((f): f is CropFeature => f !== null);
  if (!ok.length) return null;
  const mean3 = (key: "to" | "sh") =>
    [0, 1, 2].map((i) => ok.reduce((s, f) => s + f[key][i], 0) / ok.length) as [number, number, number];
  const hi = new Array<number>(32).fill(0).map((_, i) => ok.reduce((s, f) => s + f.hi[i], 0) / ok.length);
  return { to: mean3("to"), sh: mean3("sh"), hi, hr: hr > 0 ? hr : 1 };
}

/** Weighted mean of several profiles (weights: crop counts), the prototype's profile(). */
export function averageProfiles(items: Array<{ feat: Appearance; w: number }>): Appearance | null {
  if (!items.length) return null;
  const W = items.reduce((s, x) => s + x.w, 0) || 1;
  const avg = (key: "to" | "sh" | "hi") =>
    items[0].feat[key].map((_, i) => items.reduce((s, x) => s + x.feat[key][i] * x.w, 0) / W);
  return {
    to: avg("to") as [number, number, number],
    sh: avg("sh") as [number, number, number],
    hi: avg("hi"),
    hr: Math.exp(items.reduce((s, x) => s + Math.log(Math.max(1e-3, x.feat.hr)) * x.w, 0) / W),
  };
}

function scaledNorm(x: number[], y: number[], sc: number[]): number {
  return Math.sqrt(x.reduce((s, v, i) => s + ((v - y[i]) / sc[i]) ** 2, 0));
}

function bhattacharyya(x: number[], y: number[]): number {
  return -Math.log(Math.max(x.reduce((s, v, i) => s + Math.sqrt(Math.max(0, v) * Math.max(0, y[i])), 0), 1e-6));
}

/**
 * How unlike two profiles are. The prototype's formula, unchanged: torso and
 * shorts colour scaled so a unit is "clearly different", the torso histogram
 * by Bhattacharyya distance, and height as a log ratio.
 */
export function dist(c: Appearance, q: Appearance): number {
  return 0.45 * scaledNorm(c.to, q.to, [14, 6, 6])
    + 0.25 * scaledNorm(c.sh, q.sh, [14, 6, 6])
    + 3 * bhattacharyya(c.hi, q.hi)
    + (0.3 * Math.abs(Math.log(c.hr / q.hr))) / 0.15;
}

/**
 * A near-black shirt under floodlights carries almost no colour, so a colour
 * match proves little. The prototype refuses to auto-add look-alikes on it.
 */
export const isWeakColour = (p: Appearance | null) => !!p && p.to[0] < 45;

/** Decode a base64 JPEG crop and measure it. Browser only. */
export async function featureFromJpeg(jpegBase64: string): Promise<CropFeature | null> {
  if (typeof document === "undefined") return null;
  const image = new Image();
  image.src = `data:image/jpeg;base64,${jpegBase64}`;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  try {
    return featureFromPixels(context.getImageData(0, 0, width, height).data, width, height);
  } catch {
    return null;
  }
}
