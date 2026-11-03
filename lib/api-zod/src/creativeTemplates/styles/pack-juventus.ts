import { DEFINITIONS, type Content } from "../content";
import { crest, ellipse, full, media, rect, rule, text, type Box, type Ctx, type TextOpts, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Brand pack "juventus" — Juventus Academy Amman (franchise: no club or
 * partner marks, the crest slot only). From the academy's brand deck: white or
 * black fields, Bauhaus geometry (circles, quarter-circles, triangles, blocks)
 * in yellow, blue and pink around a cut-out player, strong black Archivo Black
 * capitals and a lot of white space. Before the match and for players the
 * field is white with two or three shapes; during the match and at full time
 * it is black with one accent shape. Yellow, blue and pink are only ever flat,
 * hard-edged shapes: text is black on white or white on black (black on a
 * shape only over a black field). Players are children, so every player
 * layout leads with the shirt number.
 */

const BLACK = "#0E0E10";
const WHITE = "#F7F7F5";
const GREY = "#55555C";
const SILVER = "#B9B9BE";
const HAIR_W = "#D5D5D1";
const HAIR_B = "#34343A";
const BLUE = "#1E4BD2";
const PINK = "#F28BB5";
const YELLOW = "@accent";

const FAMILY = { black: "Archivo Black", narrow: "Archivo Narrow", body: "Inter", arabic: "IBM Plex Sans Arabic" } as const;

// ── Type ────────────────────────────────────────────────────────────────────

type Face = "black" | "narrow" | "body";
type TypeOpts = Omit<TextOpts, "font"> & { face?: Face };

/**
 * One text layer in the pack's faces: Archivo Black (headlines, numbers),
 * Archivo Narrow 700 (labels, always capitals), Inter (body) and IBM Plex
 * Sans Arabic for every Arabic run. `font` stays a sensible house fallback.
 */
function type(c: Ctx, id: string, value: string, b: Box, o: TypeOpts) {
  const { face = "body", ...rest } = o;
  const font = face === "black" ? "display" : face === "narrow" ? "condensed" : "body";
  const layer = text(c, id, value, b, {
    upper: face !== "body",
    arScale: face === "black" ? 0.86 : face === "narrow" ? 1.12 : 1.08,
    ...rest,
    font,
    weight: rest.weight ?? (face === "body" ? 500 : 700),
  }) as Record<string, unknown>;
  const arabic = String(layer.font).startsWith("arabic");
  layer.family = arabic ? FAMILY.arabic : FAMILY[face];
  // Archivo Black has a single weight; Arabic labels and headlines are Plex Bold.
  if (!arabic && face === "black") layer.weight = 400;
  if (arabic && face !== "body") layer.weight = 700;
  return layer;
}

/** Small condensed capitals: the deck's label voice. */
const label = (c: Ctx, id: string, value: string, x: number, y: number, w: number, o: { color?: string; size?: number; align?: "start" | "center" | "end" } & Timing = {}) => {
  const { color, size, align, ...t } = o;
  const s = size ?? 30;
  return type(c, id, value, { x, y, w, h: Math.round(s * 1.3) }, { face: "narrow", size: s, color: color ?? GREY, ls: 1, fit: true, align, ...t });
};

/** A black or white block with the label reversed out of it (stat pills, info pills). */
const block = (c: Ctx, id: string, value: string, x: number, y: number, w: number, o: { dark?: boolean; size?: number; fill?: string; ink?: string; align?: "start" | "center" | "end" } & Timing = {}) => {
  const { dark, size, fill, ink, align, ...t } = o;
  const s = size ?? 34;
  return type(c, id, value, { x, y, w, h: Math.round(s * 1.9) }, {
    face: "narrow", size: s, color: ink ?? (dark ? BLACK : WHITE), fit: true, ls: 1, align,
    bg: { color: fill ?? (dark ? WHITE : BLACK), padding: Math.round(s * 0.42), radius: 0 }, ...t,
  });
};

// ── Fields and shapes ──────────────────────────────────────────────────────

/**
 * The flat field. The plate (greyscale, tinted with @primary = black) sits
 * right above it and the veil keeps it a quiet texture under the shapes.
 */
function field(c: Ctx, k: Content, dark: boolean) {
  // Pre-match templates get the pack's light plate (editorial/3), the rest a dark one.
  const light = DEFINITIONS.find((d) => d.key === k.key)?.category === "matchday";
  rect(c, "field", full(c), { fill: dark ? BLACK : WHITE });
  rect(c, "field-veil", full(c), { fill: dark ? (light ? "#0E0E10EB" : "#0E0E10A8") : light ? "#F7F7F5C8" : "#F7F7F5EE" });
}

type Corner = "tl" | "tr" | "bl" | "br";
const cornerXY = (c: Ctx, k: Corner) => ({ x: k[1] === "l" ? 0 : c.W, y: k[0] === "t" ? 0 : c.H });

/** A flat circle (may run off the canvas). */
function disc(c: Ctx, id: string, cx: number, cy: number, d: number, fill: string, t: Timing = {}) {
  ellipse(c, id, { x: cx - d / 2, y: cy - d / 2, w: d, h: d }, { fill, name: "bleed", ...t });
}

/** A quarter-circle in a canvas corner. */
function quarter(c: Ctx, id: string, k: Corner, r: number, fill: string, t: Timing = {}) {
  const p = cornerXY(c, k);
  ellipse(c, id, { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }, { fill, name: "bleed", ...t });
}

/** A right-angled triangle with legs `leg` along the two edges of a canvas corner (a square turned 45°). */
function cornerTri(c: Ctx, id: string, k: Corner, leg: number, fill: string, t: Timing = {}) {
  const p = cornerXY(c, k);
  const a = leg * Math.SQRT2;
  rect(c, id, { x: p.x - a / 2, y: p.y - a / 2, w: a, h: a }, { fill, rotation: 45, name: "bleed", ...t });
}

/** A triangle standing on a canvas edge (left or right) at height cy: base 2·d along the edge, pointing inwards. */
function edgeTri(c: Ctx, id: string, side: "l" | "r", cy: number, d: number, fill: string, t: Timing = {}) {
  const a = d * Math.SQRT2;
  const cx = side === "l" ? 0 : c.W;
  rect(c, id, { x: cx - a / 2, y: cy - a / 2, w: a, h: a }, { fill, rotation: 45, name: "bleed", ...t });
}

/** The template's picture: a hard-edged block (or the cut-out player once cut-outs land). */
function photo(c: Ctx, b: Box, o: { cutout?: boolean; id?: string; path?: string; name?: string } = {}) {
  if (b.h < 200 || b.w < 200) return false;
  media(c, o.id ?? "photo", b, { name: o.name ?? "Photo", path: o.path, ...(o.cutout ? { cutout: true } : {}) });
  return true;
}

/** Crest top-left inside the margin, the academy name in small capitals beside it. Returns the y under the crest. */
function head(c: Ctx, k: Content, dark: boolean, t: Timing = {}): number {
  const s = c.pick(150, 120, 160);
  crest(c, "crest", { x: c.M, y: c.T, w: s, h: s }, t);
  label(c, "academy", k.academy, c.M + s + 28, c.T + s / 2 - 20, 320, { color: dark ? SILVER : GREY, size: 28, ...t });
  return c.T + s;
}

/**
 * Lines a black-caps text will wrap to in a box w wide (Archivo Black is wide:
 * ~0.8 em a capital). Bindings count as eight characters. Used to give a
 * headline a box that hugs it, since text centres vertically in its box.
 */
function capLines(value: string, size: number, w: number, max = 4): number {
  const per = Math.max(1, Math.floor(w / (size * 0.8)));
  let lines = 1;
  let cur = 0;
  for (const word of value.replace(/\{\{[^}]+\}\}/g, "XXXXXXXX").split(/\s+/).filter(Boolean)) {
    const n = word.length;
    if (cur && cur + 1 + n > per) { lines += 1; cur = n; } else cur += (cur ? 1 : 0) + n;
  }
  return Math.min(max, lines + (value.match(/\n/g)?.length ?? 0));
}

/** Which of three shape compositions a white template uses: stable per template, so the feed varies. */
const variant = (key: string) => [...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 3;

// ── Score: black field, one accent shape, a huge score ───────────────────────

const goalFlash = (c: Ctx, k: Content) => {
  const s = k.score!;
  let y = head(c, k, true) + c.pick(48, 30, 64);
  // Score bug: white block with the score, yellow block with LIVE.
  const bh = c.pick(88, 76, 96);
  const bw = c.pick(200, 180, 210);
  rect(c, "bug", { x: c.M, y, w: c.CW - bw, h: bh }, { fill: WHITE });
  const bs = c.pick(38, 34, 42);
  type(c, "score", `${s.ownName} ${s.own}–${s.opp} ${s.oppName}`, { x: c.M + 26, y: y + (bh - bs * 1.25) / 2, w: c.CW - bw - 52, h: bs * 1.25 }, { face: "black", size: bs, color: BLACK, lh: 1.1, fit: true });
  rect(c, "badge-block", { x: c.W - c.M - bw, y, w: bw, h: bh }, { fill: YELLOW });
  type(c, "badge", k.badge ?? "", { x: c.W - c.M - bw + 12, y, w: bw - 24, h: bh }, { face: "narrow", size: c.pick(40, 36, 44), color: BLACK, align: "center", fit: true });
  y += bh + c.pick(36, 24, 56);
  const ks = c.pick(240, 180, 270);
  type(c, "kicker", k.kicker, { x: c.M - 8, y, w: c.CW + 8, h: Math.round(ks * 1.02) }, { face: "black", size: ks, color: WHITE, lh: 1, fit: true });
  y += Math.round(ks * 1.02) + c.pick(40, 26, 60);
  const metaH = 40;
  const avail = c.B - metaH - c.pick(36, 24, 44) - y;
  const d = Math.min(avail, Math.round(c.CW * c.pick(0.5, 0.44, 0.56)));
  // The one shape: a yellow circle carrying the scorer's number (black on yellow, over black).
  disc(c, "shape-1", c.M + d / 2, y + d / 2, d, YELLOW);
  type(c, "sub", k.sub ?? "", { x: c.M + d * 0.1, y: y + d * 0.3, w: d * 0.8, h: d * 0.4 }, { face: "black", size: Math.round(d * 0.2), color: BLACK, align: "center", lh: 1.05, fit: true });
  photo(c, { x: c.M + d + 36, y, w: c.CW - d - 36, h: avail });
  label(c, "meta", k.meta.filter(Boolean).join("  ·  "), c.M, c.B - metaH, c.CW, { color: SILVER });
};

const score: StyleKit["score"] = (c, k) => {
  const s = k.score!;
  field(c, k, true);
  if (k.key === "goalflash") return goalFlash(c, k);
  const cs = c.pick(150, 120, 160);
  const ks = c.pick(104, 84, 120);
  const ss = c.pick(340, 250, 400);
  const ts = c.pick(54, 44, 62);
  const kH = Math.round(ks * 1.08);
  const kGap = c.pick(10, 4, 16);
  const y0 = c.T + cs + c.pick(56, 32, 80);
  // The one accent shape: yellow quarter at full time, a blue circle live (pink at half time, below).
  if (k.key === "livescore") {
    const d = c.pick(440, 340, 500);
    disc(c, "shape-1", c.W + d * 0.08, y0 + kH + kGap + ss * 0.47, d, BLUE);
  } else if (k.key !== "halftime") quarter(c, "shape-1", "tr", c.pick(330, 270, 380), YELLOW);
  head(c, k, true);
  if (has(k.badge)) block(c, "badge", k.badge, c.W - c.M - 240, c.T + cs / 2 - 34, 240, { size: 34, fill: YELLOW, ink: BLACK, align: "end" });
  const end = stackDown(y0, [
    { h: kH, gap: kGap, draw: (y) => type(c, "kicker", k.kicker, { x: c.M, y, w: c.CW - c.pick(200, 180, 220), h: kH }, { face: "black", size: ks, color: WHITE, lh: 1, fit: true }) },
    { h: Math.round(ss * 0.94), gap: c.pick(18, 10, 26), draw: (y) => type(c, "score", `${s.own}–${s.opp}`, { x: c.M - 10, y, w: c.CW, h: Math.round(ss * 0.94) }, { face: "black", size: ss, color: WHITE, num: true, lh: 0.94, fit: true }) },
    { h: Math.round(ts * 1.15), gap: 0, draw: (y) => type(c, "own", s.ownName, { x: c.M, y, w: c.CW, h: Math.round(ts * 1.15) }, { face: "narrow", size: ts, color: WHITE, fit: true }) },
    { h: Math.round(ts * 1.15), gap: c.pick(24, 14, 30), draw: (y) => type(c, "opp", s.oppName, { x: c.M, y, w: c.CW, h: Math.round(ts * 1.15) }, { face: "narrow", size: ts, color: SILVER, fit: true }) },
    has(k.sub) && { h: c.pick(50, 44, 56), gap: c.pick(10, 6, 14), draw: (y) => type(c, "scorers", k.sub!, { x: c.M, y, w: c.CW, h: c.pick(50, 44, 56) }, { size: c.pick(38, 34, 42), color: WHITE, fit: true }) },
    { h: 40, draw: (y) => label(c, "meta", k.meta.filter(Boolean).join("  ·  "), c.M, y, c.CW, { color: SILVER }) },
  ]);
  const py = end + c.pick(44, 30, 60);
  photo(c, { x: c.M, y: py, w: c.CW, h: c.B - py });
  // Half time: a pink quarter laid over the picture's corner.
  if (k.key === "halftime") quarter(c, "shape-1", "br", c.pick(300, 240, 340), PINK);
};

// ── Fixture: white poster with shapes around the player; kick-off in black ──

const fixture: StyleKit["fixture"] = (c, k) => {
  const v = k.vs!;
  const dark = k.key === "kickoff";
  field(c, k, dark);
  const ink = dark ? WHITE : BLACK;
  const dim = dark ? SILVER : GREY;
  const cs = c.pick(150, 120, 160);
  const top = c.T + cs;
  const px = Math.round(c.W * 0.5);
  const pw = c.W - c.M - px;
  const py = top + c.pick(200, 150, 330);
  // Square is short: a smaller circle set lower, so it stays clear of the headline.
  const d = Math.round(pw * c.pick(1.2, 1.0, 1.2));
  disc(c, "shape-1", px + pw * 0.62, py + c.pick(30, 80, 60), d, dark ? BLUE : YELLOW);
  photo(c, { x: px, y: py, w: pw, h: c.B - py }, { cutout: !dark });
  head(c, k, dark);

  const colW = px - c.M - 36;
  const hs = c.pick(112, 92, 128);
  const ts = c.pick(54, 44, 60);
  const big = c.pick(60, 50, 68);
  const small = c.pick(40, 34, 44);
  const tagged = has(k.headline);
  const pills: StackItem[] = k.pills.map((p, i): StackItem => {
    if (dark && i === 0) return { h: Math.round(small * 1.9), gap: c.pick(30, 20, 40), draw: (y) => block(c, "pill-1", p, c.M, y, colW, { size: small, fill: YELLOW, ink: BLACK }) };
    const bold = !dark && i < 2;
    const s = bold ? big : small;
    return { h: Math.round(s * (bold ? 1.12 : 1.3)), gap: bold && i === 1 ? c.pick(12, 8, 18) : 0, draw: (y) => type(c, `pill-${i + 1}`, p, { x: c.M, y, w: colW, h: Math.round(s * (bold ? 1.12 : 1.3)) }, { face: bold ? "black" : "narrow", size: s, color: bold ? ink : dim, lh: 1, fit: true }) };
  });
  const colEnd = stackDown(top + c.pick(40, 30, 56), [
    tagged && { h: 44, gap: 10, draw: (y) => label(c, "kicker", k.kicker, c.M, y, colW + 40, { color: ink, size: 34 }) },
    { h: Math.round(hs * 1.06), gap: c.pick(40, 28, 60), draw: (y) => type(c, "headline", k.headline ?? k.kicker, { x: c.M - 4, y, w: colW + 60, h: Math.round(hs * 1.06) }, { face: "black", size: hs, color: ink, lh: 1, fit: true }) },
    { h: Math.round(ts * 1.15), gap: 2, draw: (y) => type(c, "own", v.ownName, { x: c.M, y, w: colW, h: Math.round(ts * 1.15) }, { face: "narrow", size: ts, color: ink, fit: true }) },
    { h: Math.round(ts * 0.8), gap: 2, draw: (y) => type(c, "vs", v.label, { x: c.M, y, w: 160, h: Math.round(ts * 0.8) }, { face: "narrow", size: Math.round(ts * 0.66), color: dim }) },
    { h: Math.round(ts * 1.15), gap: c.pick(44, 28, 64), draw: (y) => type(c, "opp", v.oppName, { x: c.M, y, w: colW, h: Math.round(ts * 1.15) }, { face: "narrow", size: ts, color: ink, fit: true }) },
    ...pills,
  ]);
  const metaTop = stackUp(c.B, [
    ...k.meta.map((m, i): StackItem => ({ h: 40, gap: i === k.meta.length - 1 ? 24 : 4, draw: (y) => label(c, `meta-${i + 1}`, m, c.M, y, colW, { color: dim }) })),
    k.cta && { h: Math.round(small * 1.9), draw: (y) => block(c, "cta", k.cta!, c.M, y, colW, { size: Math.round(small * 0.9), dark }) },
  ]);
  // A pink triangle on the left edge in the white space between the info and the footer,
  // and a blue circle half over the picture's edge beside it.
  const room = metaTop - colEnd - 60;
  if (!dark && room >= 140) {
    const td = Math.min(c.pick(120, 90, 150), Math.round(room / 2));
    const cy = Math.round((colEnd + metaTop) / 2);
    edgeTri(c, "shape-3", "l", cy, td, PINK);
    const bd = Math.min(c.pick(260, 200, 300), room);
    disc(c, "shape-2", px, cy, bd, BLUE);
  }
};

// ── Hero: white field, cut-out player right, the shirt number bottom-left ────

/**
 * Three compositions for the player layouts. A big circle sits behind the
 * picture and shows round its top and sides (all of it once the player is cut
 * out); the corner shapes lie over the picture's corner.
 */
function heroShapes(c: Ctx, key: string, p: Box, layer: "behind" | "front") {
  const v = variant(key);
  const fill = [YELLOW, BLUE, YELLOW][v];
  if (layer === "behind") {
    const d = Math.round(p.w * 1.16);
    disc(c, "shape-1", p.x + p.w / 2, p.y + d * 0.36, d, fill);
    return;
  }
  if (v === 0) quarter(c, "shape-2", "br", c.pick(300, 240, 330), BLUE);
  else if (v === 1) {
    quarter(c, "shape-2", "br", c.pick(260, 210, 290), YELLOW);
    cornerTri(c, "shape-3", "tr", c.pick(190, 160, 210), PINK);
  } else {
    cornerTri(c, "shape-2", "br", c.pick(300, 240, 330), BLUE);
    quarter(c, "shape-3", "tr", c.pick(200, 170, 220), PINK);
  }
}

const hero: StyleKit["hero"] = (c, k) => {
  field(c, k, false);
  const { head: words, tag } = heroWords(k);
  const cs = c.pick(150, 120, 160);
  const top = c.T + cs;
  if (has(k.number)) {
    const px = Math.round(c.W * 0.48);
    const p = { x: px, y: c.T + c.pick(150, 110, 200), w: c.W - c.M - px, h: 0 };
    p.h = c.B - p.y;
    heroShapes(c, k.key, p, "behind");
    photo(c, p, { cutout: true });
    heroShapes(c, k.key, p, "front");
    head(c, k, false);
    const colW = px - c.M - 28;
    const ns = c.pick(300, 230, 340);
    const bottom: StackItem[] = [
      k.stat && { h: c.pick(64, 56, 70), gap: c.pick(18, 12, 24), draw: (y) => block(c, "stat", `${k.stat!.value} ${k.stat!.label}`, c.M, y, colW, { size: c.pick(34, 30, 36) }) },
      has(k.sub) && { h: c.pick(96, 80, 110), gap: c.pick(16, 10, 22), draw: (y) => type(c, "sub", k.sub!, { x: c.M, y, w: colW, h: c.pick(96, 80, 110) }, { size: c.pick(32, 28, 36), color: BLACK, lh: 1.3, fit: true }) },
      ...k.meta.map((m, i): StackItem => ({ h: 38, gap: i === k.meta.length - 1 ? c.pick(26, 16, 34) : 2, draw: (y) => label(c, `meta-${i + 1}`, m, c.M, y, colW, { size: 28 }) })),
      has(k.name) && { h: c.pick(64, 54, 70), gap: 0, draw: (y) => type(c, "name", k.name!, { x: c.M, y, w: colW, h: c.pick(64, 54, 70) }, { face: "narrow", size: c.pick(54, 46, 60), color: BLACK, fit: true }) },
      { h: Math.round(ns * 0.92), draw: (y) => type(c, "number", `#${k.number}`, { x: c.M - 10, y, w: colW + 10, h: Math.round(ns * 0.92) }, { face: "black", size: ns, color: BLACK, num: true, lh: 0.92, fit: true }) },
    ];
    const bTop = stackUp(c.B, bottom);
    const one = words.trim().toLowerCase() === tag.trim().toLowerCase();
    const hy = top + c.pick(40, 26, 60);
    const tagH = one ? 0 : 44 + 12;
    if (!one) label(c, "kicker", tag, c.M, hy, colW, { color: BLACK, size: 34 });
    const hs = c.pick(80, 64, 84);
    // Keep clear of the circle that shows to the left of the picture.
    const hw = colW - Math.round(p.w * 0.08) - 12;
    const room = bTop - c.pick(40, 24, 60) - hy - tagH;
    const hh = Math.max(80, Math.min(Math.round(hs * 1.04 * capLines(words, hs, hw)), room));
    type(c, "headline", words, { x: c.M - 4, y: hy + tagH, w: hw + 4, h: hh }, { face: "black", size: hs, color: BLACK, lh: 1, fit: true });
    return;
  }
  // No number (champions, the coach): a big headline across the top, the picture below.
  head(c, k, false);
  const hs = c.pick(140, 110, 160);
  const textEnd = stackDown(top + c.pick(40, 26, 60), [
    { h: 44, gap: 12, draw: (y) => label(c, "kicker", tag, c.M, y, c.CW - 120, { color: BLACK, size: 34 }) },
    { h: Math.round(hs * 1.02 * (c.story ? 2 : 1)), gap: c.pick(22, 14, 30), draw: (y) => type(c, "headline", words, { x: c.M - 6, y, w: c.CW, h: Math.round(hs * 1.02 * (c.story ? 2 : 1)) }, { face: "black", size: hs, color: BLACK, lh: 1, fit: true }) },
    has(k.sub) && { h: c.pick(96, 80, 110), draw: (y) => type(c, "sub", k.sub!, { x: c.M, y, w: c.pick(820, 860, 936), h: c.pick(96, 80, 110) }, { size: c.pick(34, 30, 38), color: BLACK, lh: 1.3, fit: true }) },
  ]);
  const px = c.M + Math.round(c.CW * 0.36);
  const p = { x: px, y: textEnd + c.pick(44, 28, 70), w: c.W - c.M - px, h: 0 };
  p.h = c.B - p.y;
  if (p.h >= 200) {
    const d = c.pick(360, 280, 420);
    // Half behind the picture's left edge, below the text so no words sit on it.
    disc(c, "shape-1", p.x, p.y + Math.round(d * 0.46), d, YELLOW);
    quarter(c, "shape-2", "br", c.pick(360, 280, 420), BLUE);
    photo(c, p, { cutout: true });
  }
  const colW = px - c.M - 30;
  stackUp(c.B, [
    k.stat && { h: c.pick(170, 130, 190), gap: 0, draw: (y) => type(c, "stat", k.stat!.value, { x: c.M - 6, y, w: colW, h: c.pick(170, 130, 190) }, { face: "black", size: c.pick(180, 136, 200), color: BLACK, num: true, lh: 0.95, fit: true }) },
    k.stat && { h: 76, gap: c.pick(30, 18, 40), draw: (y) => type(c, "stat-label", k.stat!.label, { x: c.M, y, w: colW, h: 76 }, { face: "narrow", size: 32, color: BLACK, lh: 1.1, fit: true }) },
    ...k.meta.map((m, i): StackItem => ({ h: 76, gap: 4, draw: (y) => type(c, `meta-${i + 1}`, m, { x: c.M, y, w: colW, h: 76 }, { face: "narrow", size: 28, color: GREY, lh: 1.15, fit: true }) })),
  ]);
};

// ── List: black table / number grid (white for prices) ────────────────────

/** Text in the pack's faces for the photo tiles: Archivo Black for numbers and names, Narrow for positions, Plex in Arabic. */
function juveText(c: Ctx, id: string, value: string, b: Box, o: TextOpts) {
  const layer = text(c, id, value, b, { ...o, arScale: o.font === "condensed" ? 1.12 : 0.86 }) as Record<string, unknown>;
  const arabic = String(layer.font).startsWith("arabic");
  layer.family = arabic ? FAMILY.arabic : o.font === "condensed" ? FAMILY.narrow : FAMILY.black;
  if (!arabic && o.font !== "condensed") layer.weight = 400;
  return layer;
}

/** Line-up photo tiles: the figure over a coloured disc on black (blue, pink, yellow in turn), a white caption block. */
const TILE: TileLook = {
  backdrop: (c, id, b, i) => {
    rect(c, id, b, { fill: "#18181C" });
    const d = Math.min(b.w * 0.86, b.h * 0.9);
    ellipse(c, `${id}-disc`, { x: b.x + (b.w - d) / 2, y: b.y + b.h - d * 0.92, w: d, h: d }, { fill: [BLUE, PINK, YELLOW][i % 3] });
  },
  bar: (c, id, b) => rect(c, id, b, { fill: WHITE }),
  num: { font: "display", color: WHITE, weight: 400 },
  name: { font: "display", color: BLACK, weight: 400 },
  pos: { font: "condensed", color: GREY, weight: 700 },
  shadow: BLACK,
  cardRadius: 0,
  text: juveText,
};

const list: StyleKit["list"] = (c, k) => {
  const dark = k.key !== "pricing";
  field(c, k, dark);
  const ink = dark ? WHITE : BLACK;
  const dim = dark ? SILVER : GREY;
  quarter(c, "shape-1", "tr", c.pick(230, 200, 260), k.key === "callup" ? BLUE : k.key === "standings" ? PINK : YELLOW);
  const ks = c.pick(100, 80, 116);
  const top = stackDown(head(c, k, dark) + c.pick(44, 28, 64), [
    { h: Math.round(ks * 1.05), gap: c.pick(8, 4, 12), draw: (y) => type(c, "kicker", k.kicker, { x: c.M - 4, y, w: c.CW + 4, h: Math.round(ks * 1.05) }, { face: "black", size: ks, color: ink, lh: 1, fit: true }) },
    { h: 56, draw: (y) => type(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: 56 }, { face: "narrow", size: c.pick(44, 38, 48), color: dim, fit: true }) },
  ]) + c.pick(40, 24, 64);
  const rows = k.rows ?? [];
  const ctaH = k.cta ? c.pick(80, 70, 86) : 0;
  const foot = (ctaH ? ctaH + 24 : 0) + k.meta.length * 42 + c.pick(30, 20, 40);
  const bottom = c.B - foot;

  if ((numericLead(k) || k.rowsHead?.[0] === "#") && k.key !== "standings") rowsOrTiles(c, k, { x: c.M, y: top, w: c.CW, h: bottom - top }, TILE, () => {
    // Line-up / call-up: a grid of shirt numbers, three across; names only if the academy fills them.
    const cols = 3;
    const gap = 24;
    const perRow = Math.ceil(rows.length / cols);
    const cw = (c.CW - gap * (cols - 1)) / cols;
    const th = Math.min(c.pick(250, 200, 340), Math.floor((bottom - top) / perRow));
    rows.forEach((row, i) => {
      const id = `row-${i + 1}`;
      const x = c.M + (i % cols) * (cw + gap);
      const y = top + Math.floor(i / cols) * th;
      rule(c, `${id}-rule`, x, y, cw, dark ? HAIR_B : HAIR_W, 3);
      const nh = Math.round(th * 0.5);
      type(c, `${id}-lead`, `#${row[0]}`, { x: x - 4, y: y + th * 0.06, w: cw, h: nh }, { face: "black", size: Math.round(th * 0.44), color: ink, num: true, lh: 1, fit: true });
      label(c, `${id}-trail`, row[2], x, y + th * 0.06 + nh + 4, cw, { color: dim, size: Math.round(th * 0.12) });
      type(c, `${id}-main`, row[1], { x, y: y + th * 0.06 + nh + Math.round(th * 0.16) + 4, w: cw, h: Math.round(th * 0.17) }, { face: "narrow", size: Math.round(th * 0.13), color: ink, fit: true });
    });
  });
  else {
    const stats = k.key === "matchstats";
    const pricing = k.key === "pricing";
    rowBoxes(rows.length, top, bottom, c.M, c.CW, { gap: 0, maxH: c.pick(stats ? 150 : 140, 112, stats ? 170 : 160), minH: 60 }).forEach((b, i) => {
      const id = `row-${i + 1}`;
      const row = rows[i];
      rule(c, `${id}-rule`, b.x, b.y, b.w, pricing ? BLACK : HAIR_B, pricing ? 2 : 2);
      if (stats) {
        // [own, label, opp]: our number big on the left, the label beside it, theirs (often empty) on the right.
        type(c, `${id}-lead`, row[0], { x: b.x - 4, y: b.y + b.h * 0.14, w: 300, h: b.h * 0.72 }, { face: "black", size: Math.round(b.h * 0.56), color: ink, num: true, lh: 1, fit: true });
        label(c, `${id}-main`, row[1], b.x + 320, b.y + b.h * 0.5 - Math.round(b.h * 0.14), b.w - 320 - 220, { color: dim, size: Math.round(b.h * 0.21) });
        type(c, `${id}-trail`, row[2], { x: b.x + b.w - 220, y: b.y + b.h * 0.2, w: 220, h: b.h * 0.6 }, { face: "black", size: Math.round(b.h * 0.4), color: SILVER, num: true, align: "end", lh: 1, fit: true });
      } else if (pricing) {
        type(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.12, w: b.w - 300, h: b.h * 0.44 }, { face: "black", size: Math.round(b.h * 0.32), color: BLACK, lh: 1, fit: true });
        type(c, `${id}-main`, row[1], { x: b.x, y: b.y + b.h * 0.58, w: b.w - 300, h: b.h * 0.3 }, { size: Math.round(b.h * 0.19), color: GREY, fit: true });
        type(c, `${id}-trail`, row[2], { x: b.x + b.w - 290, y: b.y + b.h * 0.18, w: 290, h: b.h * 0.64 }, { face: "black", size: Math.round(b.h * 0.34), color: BLACK, align: "end", lh: 1, fit: true });
      } else {
        // League table: position, team, points. The top of the table sits on a yellow square.
        const sq = Math.round(b.h * 0.66);
        if (i === 0) rect(c, `${id}-mark`, { x: b.x, y: b.y + (b.h - sq) / 2, w: sq, h: sq }, { fill: YELLOW });
        type(c, `${id}-lead`, row[0], { x: b.x, y: b.y + (b.h - sq) / 2, w: sq, h: sq }, { face: "black", size: Math.round(b.h * 0.42), color: i === 0 ? BLACK : ink, num: true, align: "center", lh: 1, fit: true });
        type(c, `${id}-main`, row[1], { x: b.x + sq + 30, y: b.y + b.h * 0.2, w: b.w - sq - 30 - 180, h: b.h * 0.6 }, { face: "narrow", size: Math.round(b.h * 0.36), color: ink, fit: true });
        type(c, `${id}-trail`, row[2], { x: b.x + b.w - 170, y: b.y + b.h * 0.16, w: 170, h: b.h * 0.68 }, { face: "black", size: Math.round(b.h * 0.44), color: ink, num: true, align: "end", lh: 1, fit: true });
      }
    });
  }
  stackUp(c.B, [
    ...k.meta.map((m, i): StackItem => ({ h: 38, gap: i === k.meta.length - 1 ? 24 : 4, draw: (y) => label(c, `meta-${i + 1}`, m, c.M, y, c.CW, { color: dim, size: 28 }) })),
    k.cta && { h: ctaH, draw: (y) => {
      rect(c, "cta-block", { x: c.M, y, w: c.CW, h: ctaH }, { fill: dark ? WHITE : BLACK });
      type(c, "cta", k.cta!, { x: c.M + 30, y, w: c.CW - 60, h: ctaH }, { face: "narrow", size: c.pick(36, 32, 40), color: dark ? BLACK : WHITE, fit: true });
    } },
  ]);
};

// ── Promo: white poster, headline across the top, picture in a shape cluster ─

function promoShapes(c: Ctx, key: string, p: Box) {
  switch (variant(key)) {
    case 0:
      disc(c, "shape-1", p.x + p.w * 0.86, p.y + c.pick(20, 10, 30), c.pick(380, 300, 420), YELLOW);
      quarter(c, "shape-2", "br", c.pick(250, 200, 280), BLUE);
      break;
    case 1:
      cornerTri(c, "shape-1", "tr", c.pick(280, 230, 300), PINK);
      disc(c, "shape-2", p.x + p.w * 0.92, p.y + p.h * 0.62, c.pick(360, 290, 420), BLUE);
      quarter(c, "shape-3", "br", c.pick(220, 180, 250), YELLOW);
      break;
    default:
      quarter(c, "shape-1", "tr", c.pick(260, 220, 290), BLUE);
      disc(c, "shape-2", p.x + p.w * 0.1, p.y + p.h * 0.94, c.pick(300, 240, 340), YELLOW);
      edgeTri(c, "shape-3", "r", Math.round(p.y + p.h * 0.3), c.pick(120, 100, 140), PINK);
  }
}

const poll = (c: Ctx, k: Content) => {
  quarter(c, "shape-1", "tr", c.pick(250, 210, 270), YELLOW);
  const top = head(c, k, false);
  const hs = c.pick(120, 92, 140);
  const y0 = stackDown(top + c.pick(40, 26, 60), [
    { h: 44, gap: 10, draw: (y) => label(c, "kicker", k.kicker, c.M, y, c.CW - 200, { color: BLACK, size: 34 }) },
    { h: Math.round(hs * 2.05), draw: (y) => type(c, "headline", k.headline ?? "", { x: c.M - 4, y, w: c.CW, h: Math.round(hs * 2.05) }, { face: "black", size: hs, color: BLACK, lh: 1, fit: true }) },
  ]) + c.pick(40, 24, 60);
  const gap = 36;
  const cw = (c.CW - gap) / 2;
  const kh = c.pick(110, 90, 120);
  const ch = c.B - 50 - kh - 20 - y0;
  cornerTri(c, "shape-2", "br", c.pick(200, 160, 230), PINK);
  k.options!.forEach((opt, i) => {
    const x = c.M + i * (cw + gap);
    photo(c, { x, y: y0, w: cw, h: ch }, { id: `option-${i + 1}-photo`, path: `more.${i}`, name: `Option ${i + 1} photo` });
    rect(c, `option-${i + 1}-block`, { x, y: y0 + ch, w: kh, h: kh }, { fill: BLACK });
    type(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x, y: y0 + ch, w: kh, h: kh }, { face: "black", size: Math.round(kh * 0.56), color: WHITE, align: "center", lh: 1, fit: true });
    type(c, `option-${i + 1}`, opt, { x: x + kh + 20, y: y0 + ch, w: cw - kh - 20, h: kh }, { face: "black", size: Math.round(kh * 0.5), color: BLACK, lh: 1, fit: true });
  });
  label(c, "meta-1", k.meta[0] ?? "", c.M, c.B - 40, c.CW - c.pick(240, 200, 260), { color: GREY });
};

const promo: StyleKit["promo"] = (c, k) => {
  field(c, k, false);
  if (k.options) return poll(c, k);
  const manifesto = k.key === "manifesto";
  const cs = c.pick(150, 120, 160);
  const top = c.T + cs;
  const hs = c.pick(manifesto ? 92 : 116, manifesto ? 74 : 92, manifesto ? 104 : 132);
  const lines = manifesto ? 3.1 : 2.05;
  // Measure the text block first so the picture can take the rest.
  const down: StackItem[] = [
    { h: 44, gap: 10, draw: (y) => label(c, "kicker", k.kicker, c.M, y, c.CW - 260, { color: BLACK, size: 34 }) },
    { h: Math.round(hs * lines), gap: c.pick(18, 12, 26), draw: (y) => type(c, "headline", k.headline ?? "", { x: c.M - 4, y, w: c.CW, h: Math.round(hs * lines) }, { face: "black", size: hs, color: BLACK, lh: 1, fit: true }) },
    has(k.sub) && { h: c.pick(90, 76, 104), draw: (y) => type(c, "sub", k.sub!, { x: c.M, y, w: c.pick(860, 900, 936), h: c.pick(90, 76, 104) }, { size: c.pick(34, 30, 38), color: BLACK, lh: 1.3, fit: true }) },
  ];
  const textTop = top + c.pick(40, 26, 60);
  const textEnd = textTop + stackHeight(down);
  const px = c.M + Math.round(c.CW * (k.pills.length || k.cta ? 0.42 : 0.3));
  const bd = c.pick(230, 190, 250);
  const p = { x: px, y: textEnd + (has(k.badge) ? Math.round(bd / 2) + 24 : c.pick(44, 26, 70)), w: c.W - c.M - px, h: 0 };
  p.h = c.B - p.y - c.pick(80, 40, 120);
  if (p.h >= 200) promoShapes(c, k.key, p);
  const shown = photo(c, p, { cutout: false });
  if (shown && k.key === "map") pin(c, Math.round(p.x + p.w / 2), Math.round(p.y + p.h / 2), YELLOW, BLACK);
  head(c, k, false);
  stackDown(textTop, down);
  // Info pills: black blocks down the left of the picture; the call to action at the bottom.
  const colW = px - c.M - 30;
  const ps = c.pick(32, 28, 36);
  stackDown(p.y, k.pills.map((pl, i): StackItem => ({ h: Math.round(ps * 1.9), gap: 14, draw: (y) => block(c, `pill-${i + 1}`, pl, c.M, y, colW, { size: ps }) })));
  if (k.cta) {
    const ch = c.pick(84, 70, 90);
    rect(c, "cta-block", { x: c.M, y: c.B - ch, w: shown ? p.x - c.M + Math.round(p.w * 0.55) : c.CW, h: ch }, { fill: BLACK });
    type(c, "cta", k.cta, { x: c.M + 28, y: c.B - ch, w: (shown ? p.x - c.M + Math.round(p.w * 0.55) : c.CW) - 56, h: ch }, { face: "narrow", size: c.pick(36, 30, 40), color: WHITE, fit: true });
  }
  if (has(k.badge)) {
    // A black disc pinned to the picture's corner, reversed out in white.
    const d = bd;
    const bx = shown ? p.x : c.W - c.M - d / 2;
    const by = shown ? p.y : c.T + cs / 2;
    ellipse(c, "badge-disc", { x: bx - d / 2, y: by - d / 2, w: d, h: d }, { fill: BLACK });
    type(c, "badge", k.badge, { x: bx - d * 0.38, y: by - d * 0.2, w: d * 0.76, h: d * 0.4 }, { face: "black", size: Math.round(d * 0.24), color: WHITE, align: "center", lh: 1, fit: true });
  }
};

// ── Video ──────────────────────────────────────────────────────────────────

const skin: StyleKit["skin"] = {
  shade: (c) => rect(c, "shade", { x: 0, y: c.H - 760, w: c.W, h: 760 }, { gradient: { from: "#0E0E1000", to: "#0E0E10D9" } }),
  frame: (c, k, t) => {
    crest(c, "crest", { x: c.M, y: c.T, w: 110, h: 110 }, t);
    label(c, "academy", k.academy, c.M + 134, c.T + 35, 520, { color: WHITE, size: 28, ...t });
  },
  tag: (c, k, t) => {
    const h = 84;
    type(c, "kicker", k.kicker, { x: c.M, y: c.B - (k.video?.variant === "goal" ? 700 : 540), w: c.CW, h }, { face: "black", size: 46, color: BLACK, lh: 1, fit: true, bg: { color: YELLOW, padding: 18, radius: 0 }, ...t });
  },
  goal: (c, k, t) => {
    const s = k.score!;
    const d = 340;
    disc(c, "goal-disc", c.M + d / 2, c.B - 250 - d / 2, d, YELLOW, t);
    type(c, "number", `#${k.number ?? ""}`, { x: c.M + d * 0.1, y: c.B - 250 - d * 0.75, w: d * 0.8, h: d * 0.5 }, { face: "black", size: 150, color: BLACK, num: true, align: "center", lh: 1, fit: true, ...t });
    type(c, "name", k.name ?? "", { x: c.M + d + 36, y: c.B - 250 - d * 0.6, w: c.CW - d - 36, h: 70 }, { face: "narrow", size: 56, color: WHITE, fit: true, ...t });
    rect(c, "bug", { x: c.M, y: c.B - 190, w: c.CW, h: 100 }, { fill: WHITE, ...t });
    type(c, "score", `${s.ownName} ${s.own}–${s.opp} ${s.oppName}`, { x: c.M + 30, y: c.B - 190, w: c.CW - 60, h: 100 }, { face: "black", size: 44, color: BLACK, fit: true, ...t });
  },
  speaker: (c, k, t) => {
    const y = c.B - 420;
    rect(c, "card", { x: c.M, y, w: c.CW - 120, h: 190 }, { fill: BLACK, ...t });
    rect(c, "card-mark", { x: c.M, y, w: 24, h: 190 }, { fill: BLUE, ...t });
    type(c, "speaker", k.headline ?? "", { x: c.M + 60, y: y + 30, w: c.CW - 240, h: 76 }, { face: "black", size: 56, color: WHITE, lh: 1, fit: true, ...t });
    label(c, "role", k.sub ?? "", c.M + 60, y + 118, c.CW - 240, { color: SILVER, size: 34, ...t });
  },
  title: (c, k, t) => {
    const y = c.B - 460;
    rect(c, "card", { x: c.M, y, w: c.CW, h: 300 }, { fill: BLACK, ...t });
    rect(c, "card-mark", { x: c.W - c.M - 90, y, w: 90, h: 90 }, { fill: PINK, ...t });
    type(c, "headline", k.headline ?? "", { x: c.M + 40, y: y + 40, w: c.CW - 180, h: 170 }, { face: "black", size: 88, color: WHITE, lh: 1, fit: true, ...t });
    label(c, "meta-1", k.meta[0] ?? "", c.M + 40, y + 226, c.CW - 80, { color: SILVER, size: 30, ...t });
  },
  caption: (c, id, value, t) => type(c, id, value, { x: c.M, y: c.B - 230, w: c.CW, h: 180 }, { size: 42, weight: 600, color: WHITE, align: "center", lh: 1.3, fit: true, bg: { color: "#0E0E10E6", padding: 18, radius: 0 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: WHITE, ...t });
    quarter(c, "end-shape-1", "tr", 330, YELLOW, t);
    quarter(c, "end-shape-2", "bl", 300, BLUE, t);
    cornerTri(c, "end-shape-3", "br", 200, PINK, t);
    crest(c, "end-crest", { x: c.W / 2 - 130, y: c.H / 2 - 280, w: 260, h: 260 }, t);
    type(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 20, w: c.CW, h: 170 }, { face: "black", size: 76, color: BLACK, align: "center", lh: 1.05, fit: true, ...t });
  },
};

export const pack_juventus: StyleKit = { background: WHITE, plate: { opacity: 0.8, above: "field" }, score, fixture, hero, list, promo, skin };
