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
  /** people with no kit tile to be found under: unread, or in no kept group */
  unreadableIds: string[];
  /** mean chroma across everyone read, for the gate below */
  meanSaturation: number;
  /** share of readable people the kept kits cover */
  coverage: number;
};

/** Below this the torso has no usable hue: white, black, grey, or too dark. */
export const MIN_SATURATION = 0.18;
/** A kit tile with fewer members than this is noise, not a team. */
export const MIN_KIT_MEMBERS = 2;
/** More than this and the tiles stop being a choice. */
export const MAX_KITS = 4;
/**
 * One bucket holding this much of the pitch means the colours did not split.
 *
 * Two real sides are roughly half and half, so a legitimate split puts the
 * largest kit around 0.5-0.6. 0.85 was far too generous: it passed a reading of
 * a real match in which 68% of everyone landed in one bucket.
 */
export const DOMINANT_SHARE = 0.7;
/**
 * Kit tiles that between them cover less of the pitch than this are not a way
 * through the gallery, they are a way past two thirds of it.
 */
export const MIN_KIT_COVERAGE = 0.6;
/**
 * Mean chroma below this means the crops carry no colour at all -- distance,
 * compression and floodlight, not two teams in grey.
 *
 * Measured on a real sprite file (cam1, 121 tracks): mean saturation 0.10
 * across every bucket, and the light/grey/dark split was reading brightness,
 * not kit. Without this gate the screen offers four "kits" that are really
 * exposure bands.
 */
export const MIN_MEAN_SATURATION = 0.2;

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
  // hue === null has to send it here too, not only low saturation. A reading
  // can be saturated on average and still have no agreed hue -- a white kit
  // under floodlight, or crops whose hues never reached the quarter-of-pixels
  // bar -- and `hue ?? 0` would then file every one of those under red.
  if (colour.hue === null || colour.saturation < MIN_SATURATION) {
    if (colour.lightness >= 0.6) return "light";
    if (colour.lightness <= 0.35) return "dark";
    return "grey";
  }
  const hue = ((colour.hue % 360) + 360) % 360;
  return `h${(Math.floor(hue / 30) * 30) % 360}`;
}

function isHueBucket(key: KitKey): boolean {
  return key.startsWith("h");
}

/**
 * "grey" is never a kit.
 *
 * A torso with no hue and a middling lightness is one the reader failed on, not
 * a team in grey. "light" and "dark" ARE kits -- white against black is a real
 * and common pairing, and lightness is the whole signal there -- but the middle
 * is the bin for everything that could not be read, and offering it as a tile
 * sends the claimant into a pile of strangers.
 */
function isKitBucket(key: KitKey): boolean {
  return key !== "grey";
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
    .filter(([key, ids]) => isKitBucket(key) && ids.length >= MIN_KIT_MEMBERS)
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
  const meanSaturation = readable.length === 0
    ? 0
    : readable.reduce((total, entry) => total + entry.colour.saturation, 0) / readable.length;
  const separated = groups.length >= 2
    && placed > 0
    && readable.length > 0
    && meanSaturation >= MIN_MEAN_SATURATION
    && placed / readable.length >= MIN_KIT_COVERAGE
    && largest / placed < DOMINANT_SHARE;

  // Anyone the kits do not cover has no kit tile to be found under, so they are
  // reported as unreadable rather than quietly dropped.
  const inAKit = new Set(groups.flatMap((group) => group.memberIds));
  const uncovered = readable
    .map((entry) => entry.id)
    .filter((id) => !inAKit.has(id));

  return {
    separated,
    groups,
    unreadableIds: separated ? [...unreadableIds, ...uncovered] : unreadableIds,
    meanSaturation,
    coverage: readable.length === 0 ? 0 : placed / readable.length,
  };
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

/**
 * A plain colour name for a kit tile ("Royal blue", "Dark / black"), keyed
 * into the copy's `kit.names`. The wireframe (CL03) labels every tile; a bare
 * swatch asks the player to name the colour themselves.
 *
 * Read off the tile's own swatch, so it can never disagree with what is drawn.
 * Dark is decided by lightness first: under floodlights black and maroon
 * separate by brightness, not hue (the same rule the split uses).
 */
export function kitColourKey(swatch: string): string {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(swatch.trim());
  if (!match) return "dark";
  const [r, g, b] = [match[1], match[2], match[3]].map((hex) => parseInt(hex, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (lightness < 0.2) return "dark";
  if (saturation < 0.18) return lightness > 0.6 ? "light" : "dark";
  let hue = 0;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 345) return lightness < 0.33 ? "maroon" : "red";
  if (hue < 42) return "orange";
  if (hue < 68) return "yellow";
  if (hue < 160) return "green";
  if (hue < 190) return "teal";
  if (hue < 205) return "sky";
  if (hue < 255) return "blue";
  if (hue < 290) return "purple";
  return lightness < 0.33 ? "maroon" : "pink";
}

/** True when the swatch is dark enough that black/maroon confusion applies. */
export function isDarkKit(swatch: string): boolean {
  const key = kitColourKey(swatch);
  return key === "dark" || key === "maroon";
}
