/**
 * Which kit each tracked person is wearing, read off their own crops.
 *
 * Step 1 of the claim flow asks "what were you wearing?", and nothing in the
 * tracking bundle records a team: the identity board groups people, not sides.
 * The offline pipeline solves this with a torso hue histogram (newfeat.py) and
 * a split on it (kitsplit, huesplit); this is the same idea done in the
 * browser on the crops that are already being downloaded for the gallery.
 *
 * It is deliberately conservative. Kit tiles are only worth showing when the
 * colours actually separate; when they do not -- one team in two shades of the
 * same blue, a match played in bibs over everything, a dark evening recording
 * -- `separated` comes back false and the flow skips step 1 rather than
 * inventing two teams. A wrong kit tile costs the claimant the whole gallery.
 */

export type TorsoColour = {
  /** 0-360, or null when the torso is too desaturated to have one */
  hue: number | null;
  /** 0-1 */
  saturation: number;
  /** 0-1 */
  lightness: number;
};

export type KitKey = string;

export type KitGroup = {
  key: KitKey;
  /** average colour of the members, as #rrggbb, for the tile swatch */
  swatch: string;
  memberIds: string[];
};

export type KitSplit = {
  separated: boolean;
  groups: KitGroup[];
  /** people whose colour could not be read at all */
  unreadableIds: string[];
};

/** Below this the torso has no usable hue: white, black, grey, or too dark. */
export const MIN_SATURATION = 0.18;
/** A kit tile with fewer members than this is noise, not a team. */
export const MIN_KIT_MEMBERS = 2;
/** More than this and the tiles stop being a choice. */
export const MAX_KITS = 4;
/** One bucket holding this much of the pitch means the colours did not split. */
export const DOMINANT_SHARE = 0.85;

export function rgbToHsl(r: number, g: number, b: number): TorsoColour {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: null, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === rn) hue = 60 * (((gn - bn) / delta) % 6);
  else if (max === gn) hue = 60 * ((bn - rn) / delta + 2);
  else hue = 60 * ((rn - gn) / delta + 4);
  if (hue < 0) hue += 360;
  return { hue, saturation, lightness };
}

function hslToHex(hue: number | null, saturation: number, lightness: number): string {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const h = ((hue ?? 0) % 360) / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] = h < 1 ? [c, x, 0]
    : h < 2 ? [x, c, 0]
    : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c]
    : h < 5 ? [x, 0, c]
    : [c, 0, x];
  const byte = (value: number) => Math.round(Math.min(255, Math.max(0, (value + m) * 255)))
    .toString(16)
    .padStart(2, "0");
  return `#${byte(hue === null ? 0 : r)}${byte(hue === null ? 0 : g)}${byte(hue === null ? 0 : b)}`;
}

/**
 * Circular mean: hue wraps, so a red kit read as 358 and 2 averages to 0, not
 * to 180. Getting this wrong turns one red team into a cyan team.
 */
export function averageHue(hues: number[]): number | null {
  if (hues.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const hue of hues) {
    x += Math.cos((hue * Math.PI) / 180);
    y += Math.sin((hue * Math.PI) / 180);
  }
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return null;
  const mean = (Math.atan2(y, x) * 180) / Math.PI;
  // Floating point puts the mean of 350 and 10 a hair below zero, and a plain
  // "+ 360" then returns 360 -- a value that is the same colour as 0 but lands
  // in a bucket of its own, splitting one red team in two.
  const wrapped = ((mean % 360) + 360) % 360;
  return wrapped >= 360 - 1e-9 ? 0 : wrapped;
}

/** The bucket a torso falls in. Achromatic kits split on lightness instead. */
export function bucketFor(colour: TorsoColour): KitKey {
  if (colour.saturation < MIN_SATURATION) {
    if (colour.lightness >= 0.6) return "light";
    if (colour.lightness <= 0.35) return "dark";
    return "grey";
  }
  const hue = (((colour.hue ?? 0) % 360) + 360) % 360;
  return `h${(Math.floor(hue / 30) * 30) % 360}`;
}

function isHueBucket(key: KitKey): boolean {
  return key.startsWith("h");
}

function hueOf(key: KitKey): number {
  return Number(key.slice(1));
}

/** Adjacent 30-degree hue buckets are one kit: a shirt reads 115 and 130. */
function mergeAdjacentHueBuckets(counts: Map<KitKey, string[]>): Map<KitKey, string[]> {
  const hueKeys = [...counts.keys()].filter(isHueBucket).sort((a, b) => hueOf(a) - hueOf(b));
  const merged = new Map(counts);
  for (let index = 0; index < hueKeys.length; index++) {
    const key = hueKeys[index];
    const next = hueKeys[(index + 1) % hueKeys.length];
    if (key === next) continue;
    const gap = (hueOf(next) - hueOf(key) + 360) % 360;
    if (gap !== 30) continue;
    const from = merged.get(key);
    const to = merged.get(next);
    if (!from || !to) continue;
    // Fold the smaller into the larger so the surviving key names the
    // dominant shade rather than whichever came first round the circle.
    if (from.length >= to.length) {
      merged.set(key, [...from, ...to]);
      merged.delete(next);
    } else {
      merged.set(next, [...to, ...from]);
      merged.delete(key);
    }
  }
  return merged;
}

export function splitKits(colours: Array<{ id: string; colour: TorsoColour | null }>): KitSplit {
  const unreadableIds = colours.filter((entry) => entry.colour === null).map((entry) => entry.id);
  const readable = colours.filter(
    (entry): entry is { id: string; colour: TorsoColour } => entry.colour !== null,
  );

  const buckets = new Map<KitKey, string[]>();
  const coloursById = new Map<string, TorsoColour>();
  for (const entry of readable) {
    coloursById.set(entry.id, entry.colour);
    const key = bucketFor(entry.colour);
    buckets.set(key, [...(buckets.get(key) ?? []), entry.id]);
  }

  const merged = mergeAdjacentHueBuckets(buckets);
  const ordered = [...merged.entries()]
    .filter(([, ids]) => ids.length >= MIN_KIT_MEMBERS)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_KITS);

  const groups: KitGroup[] = ordered.map(([key, ids]) => {
    const members = ids.map((id) => coloursById.get(id)!).filter(Boolean);
    const hue = averageHue(
      members.map((colour) => colour.hue).filter((value): value is number => value !== null),
    );
    const saturation = members.reduce((total, colour) => total + colour.saturation, 0) / members.length;
    const lightness = members.reduce((total, colour) => total + colour.lightness, 0) / members.length;
    return {
      key,
      swatch: hslToHex(saturation < MIN_SATURATION ? null : hue, saturation, lightness),
      memberIds: ids,
    };
  });

  const placed = groups.reduce((total, group) => total + group.memberIds.length, 0);
  const largest = groups[0]?.memberIds.length ?? 0;
  const separated = groups.length >= 2
    && placed > 0
    && largest / placed < DOMINANT_SHARE;

  return { separated, groups, unreadableIds };
}

/**
 * The torso colour of one crop.
 *
 * The sample window is the middle of the box: shoulders to waist, and the
 * central half horizontally, which keeps arms, grass either side, the head and
 * the shorts out of it. Pixels that are nearly black or nearly white are
 * dropped before averaging -- a shadowed crop is mostly shadow, and averaging
 * it in drags every kit toward the same grey.
 */
export function torsoColourFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): TorsoColour | null {
  const x0 = Math.floor(width * 0.25);
  const x1 = Math.ceil(width * 0.75);
  const y0 = Math.floor(height * 0.3);
  const y1 = Math.ceil(height * 0.62);
  const hues: number[] = [];
  let saturationTotal = 0;
  let lightnessTotal = 0;
  let counted = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] < 128) continue;
      const colour = rgbToHsl(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if (colour.lightness < 0.08 || colour.lightness > 0.95) continue;
      counted++;
      saturationTotal += colour.saturation;
      lightnessTotal += colour.lightness;
      if (colour.saturation >= MIN_SATURATION && colour.hue !== null) hues.push(colour.hue);
    }
  }
  if (counted < 20) return null;
  const saturation = saturationTotal / counted;
  return {
    hue: hues.length >= counted * 0.25 ? averageHue(hues) : null,
    saturation,
    lightness: lightnessTotal / counted,
  };
}

/** Decode one base64 JPEG crop and read its torso colour. Browser only. */
export async function torsoColourFromJpeg(jpegBase64: string): Promise<TorsoColour | null> {
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
    const { data } = context.getImageData(0, 0, width, height);
    return torsoColourFromPixels(data, width, height);
  } catch {
    return null;
  }
}

/** The colour of a person: the median-ish reading across several of their crops. */
export function combineColours(colours: Array<TorsoColour | null>): TorsoColour | null {
  const readable = colours.filter((colour): colour is TorsoColour => colour !== null);
  if (readable.length === 0) return null;
  return {
    hue: averageHue(readable.map((c) => c.hue).filter((v): v is number => v !== null)),
    saturation: readable.reduce((total, c) => total + c.saturation, 0) / readable.length,
    lightness: readable.reduce((total, c) => total + c.lightness, 0) / readable.length,
  };
}
