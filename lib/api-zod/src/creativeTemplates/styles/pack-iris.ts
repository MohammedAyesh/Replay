import type { SceneLayer } from "../../creativeScene";
import type { Content } from "../content";
import { crest, ellipse, full, media, rect, text, type Box, type Ctx, type TextOpts, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Brand pack "iris" (IRIS International Sports), from the IRIS brand deck.
 *
 * A floodlit big night: the royal-blue stadium plate under navy haze and
 * angled light blades. Bebas Neue capitals in white, Inter for info lines,
 * Cairo for Arabic, and Kaushan Script for one accent word only ("Game day").
 * Gold is saved for the one thing that matters in each post: the score, the
 * shirt number, the kick-off time or the call to action.
 *
 * Fixture and result posts are broadcast-style sheets: the crest and an away
 * slot either side of "VS" or the score, with a navy sponsor strip along the
 * bottom of big posts (never on stories). Players are children: every player
 * post leads with the shirt number in gold; names are optional.
 *
 * Jordan red / green are for national-team moments only, so no club template
 * here uses them.
 */

const NAVY = "#0B1F4D";
const WHITE = "#F6F7FB";
const SOFT = "#C9D3EE";
const MUTED = "#8FA3D6";
const CLEAR = "#0B1F4D00";
const PANEL = "#0B1F4DD1";
const EDGE = "#F6F7FB33";
const SHADOW = { color: "#0B1F4DB3", blur: 28, x: 0, y: 8 };
/** Tight navy shadow for small type over the floodlights. */
const LIFT = { color: "#0B1F4DF2", blur: 14, x: 0, y: 3 };

type TextLayer = Extract<SceneLayer, { kind: "text" }>;
type ImageLayer = Extract<SceneLayer, { kind: "image" }>;
type Face = "display" | "body" | "script";
type SayOpts = Omit<TextOpts, "size" | "font"> & { face?: Face };

/**
 * Text in the IRIS faces: Bebas Neue (display, caps only), Inter (info) and
 * Kaushan Script (one accent word). Arabic is Cairo (900 for headlines);
 * digits-only layers keep Bebas in Arabic too.
 */
function say(c: Ctx, id: string, value: string, b: Box, size: number, o: SayOpts = {}): TextLayer {
  const { face = "body", ...rest } = o;
  const arabic = c.ar && !o.num;
  const weight = o.weight ?? (arabic ? (face === "body" ? 700 : 900) : face === "body" ? 600 : 400);
  const layer = text(c, id, value, b, {
    ...rest,
    size: Math.round(size),
    font: face,
    weight,
    upper: face === "display" ? true : rest.upper,
    lh: rest.lh ?? (face === "body" ? undefined : 0.95),
  }) as TextLayer;
  layer.family = arabic ? "Cairo" : face === "display" ? "Bebas Neue" : face === "script" ? "Kaushan Script" : "Inter";
  return layer;
}

/** Rough line count for a Bebas headline (a binding counts as ten characters; each forced line wraps on its own). */
function lines(value: string, size: number, w: number, max = 2): number {
  const n = value.split("\n").reduce((sum, part) => sum + Math.max(1, Math.ceil((part.replace(/\{\{[^}]+\}\}/g, "xxxxxxxxxx").length * size * 0.46) / w)), 0);
  return Math.min(max, n);
}

// ── The plate, light and frame ──────────────────────────────────────────────

/** Royal-to-navy sky (the plate replaces it), navy haze top and bottom, light blades. */
function backdrop(c: Ctx) {
  rect(c, "sky", full(c), { gradient: { from: "@primary", to: NAVY } });
  rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: Math.round(c.H * 0.34) }, { gradient: { from: "#0B1F4DD9", to: CLEAR } });
  const sy = Math.round(c.H * 0.44);
  rect(c, "shade", { x: 0, y: sy, w: c.W, h: c.H - sy }, { gradient: { from: CLEAR, to: "#0B1F4DF0" } });
  blades(c);
}

/** Angled floodlight blades from the top corners. */
function blades(c: Ctx, t: Timing = {}, tag = "blade") {
  const len = Math.round(c.H * 1.3);
  const list: Array<[number, number, number, number]> = [[c.W * 0.8, 170, 26, 0.13], [c.W * 0.95, 70, 36, 0.1], [c.W * 0.12, 110, -30, 0.08]];
  list.forEach(([cx, w, deg, o], i) => {
    const a = (deg * Math.PI) / 180;
    const x = cx - Math.sin(a) * (len / 2) - w / 2;
    const y = -60 + Math.cos(a) * (len / 2) - len / 2;
    rect(c, `${tag}-${i + 1}`, { x, y, w, h: len }, { gradient: { from: WHITE, to: "#F6F7FB00" }, opacity: o, rotation: deg, name: "bleed", mirror: false, ...t });
  });
}

/** A ring halo behind the crest row or the score. */
function halo(c: Ctx, cx: number, cy: number, r: number, t: Timing = {}, id = "halo") {
  ellipse(c, `${id}-glow`, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, { gradient: { from: "#F6F7FB14", to: "#F6F7FB00" }, name: "bleed", mirror: false, ...t });
  ellipse(c, `${id}-ring`, { x: cx - r * 0.82, y: cy - r * 0.82, w: r * 1.64, h: r * 1.64 }, { stroke: { color: "#F6F7FB2E", width: 3 }, name: "bleed", mirror: false, ...t });
}

/** Crest top-left with the academy name beside it. Returns the y under it. */
function lockup(c: Ctx, k: Content, o: { size?: number; right?: number } & Timing = {}): number {
  const { size = c.pick(124, 104, 124), right = 0, ...t } = o;
  crest(c, "crest", { x: c.M, y: c.T, w: size, h: size }, t);
  say(c, "academy", k.academy, { x: c.M + size + 24, y: c.T + size / 2 - 24, w: c.CW - size - 24 - right, h: 48 }, 40, { face: "display", color: WHITE, ls: 2, fit: true, ...t });
  return c.T + size;
}

/** A soft navy band behind the crest row, so names read over the brightest floodlights. */
function haze(c: Ctx, y: number, h: number) {
  const half = Math.round(h / 2);
  rect(c, "haze-top", { x: 0, y, w: c.W, h: half }, { gradient: { from: CLEAR, to: "#0B1F4D80" } });
  rect(c, "haze", { x: 0, y: y + half, w: c.W, h: h - half }, { gradient: { from: "#0B1F4D80", to: CLEAR } });
}

/** The academy crest on a faint disc (fixture and result sheets). */
function homeCrest(c: Ctx, b: Box, t: Timing = {}) {
  ellipse(c, "crest-disc", { x: b.x - 12, y: b.y - 12, w: b.w + 24, h: b.h + 24 }, { fill: "#F6F7FB1A", stroke: { color: "#F6F7FB59", width: 3 }, ...t });
  crest(c, "crest", b, t);
}

/** The opponent's slot: a ring, since Replay has no crest for them. */
function awayCrest(c: Ctx, b: Box, t: Timing = {}) {
  ellipse(c, "opp-crest", { x: b.x - 12, y: b.y - 12, w: b.w + 24, h: b.h + 24 }, { fill: "#0B1F4D80", stroke: { color: "#F6F7FB8C", width: 4 }, ...t });
  ellipse(c, "opp-crest-inner", { x: b.x + b.w * 0.2, y: b.y + b.h * 0.2, w: b.w * 0.6, h: b.h * 0.6 }, { stroke: { color: "#F6F7FB40", width: 3 }, ...t });
}

/** Small spaced Inter capitals behind a short royal bar. */
function label(c: Ctx, id: string, value: string, b: Box, o: { color?: string; align?: "start" | "center" } & Timing = {}) {
  const { color = SOFT, align = "start", ...t } = o;
  if (align === "start") {
    rect(c, `${id}-bar`, { x: b.x, y: b.y + b.h / 2 - 3, w: 44, h: 6 }, { fill: "@primary", radius: 3, ...t });
    return say(c, id, value, { x: b.x + 64, y: b.y, w: b.w - 64, h: b.h }, 28, { weight: 800, color, upper: true, ls: 4, fit: true, ...t });
  }
  return say(c, id, value, b, 28, { weight: 800, color, upper: true, ls: 4, fit: true, align, ...t });
}

/** A rounded pill with Bebas capitals. */
function pill(c: Ctx, id: string, value: string, b: Box, o: { fill: string; ink: string; stroke?: string; size?: number; align?: "start" | "center" } & Timing) {
  const { fill, ink, stroke, size, align = "center", ...t } = o;
  rect(c, `${id}-bg`, b, { fill, radius: b.h / 2, ...(stroke ? { stroke: { color: stroke, width: 3 } } : {}), ...t });
  say(c, id, value, { x: b.x + b.h * 0.42, y: b.y + b.h * 0.2, w: b.w - b.h * 0.84, h: b.h * 0.62 }, size ?? b.h * 0.52, { face: "display", color: ink, align, fit: true, ...t });
}

/** The player photo as a card on the plate: blue-tinted, navy shadow at the feet. */
function card(c: Ctx, b: Box, o: { id?: string; path?: string; name?: string } = {}): boolean {
  const id = o.id ?? "photo";
  if (b.h < 150 || b.w < 150) return false;
  rect(c, `${id}-edge`, { x: b.x - 3, y: b.y - 3, w: b.w + 6, h: b.h + 6 }, { fill: "#F6F7FB4D", radius: 31 });
  const img = media(c, id, b, { radius: 28, name: o.name ?? "Photo", path: o.path }) as ImageLayer;
  img.tint = { color: "@primary", mode: "multiply", amount: 0.3 };
  const fy = b.y + Math.round(b.h * 0.5);
  rect(c, `${id}-feet`, { x: b.x, y: fy, w: b.w, h: b.y + b.h - fy }, { gradient: { from: CLEAR, to: "#0B1F4DE6" }, radius: 28 });
  return true;
}

/** Height of the sponsor strip: big posts only, never stories. */
const stripH = (c: Ctx) => (c.story ? 0 : c.pick(144, 120, 0));

/** Navy sponsor strip along the bottom: the academy name, its handle and room for partner logos. */
function strip(c: Ctx, k: Content) {
  const h = stripH(c);
  if (!h) return;
  const y = c.H - h;
  rect(c, "sponsor-strip", { x: 0, y, w: c.W, h }, { fill: NAVY, name: "Sponsor strip" });
  rect(c, "sponsor-rule", { x: 0, y, w: c.W, h: 4 }, { fill: "@primary" });
  say(c, "strip-name", k.academy, { x: c.M, y: y + h / 2 - 22, w: 600, h: 46 }, 40, { face: "display", color: WHITE, ls: 2, fit: true });
  say(c, "strip-handle", c.ar ? "\u200E{{academy.instagram}}" : "{{academy.instagram}}", { x: c.W - c.M - 300, y: y + h / 2 - 17, w: 300, h: 36 }, 28, { color: MUTED, align: "end", fit: true });
}

/** The score bug: own (royal) | score (white) | opponent (navy) | badge (gold). */
function bug(c: Ctx, s: NonNullable<Content["score"]>, badge: string | undefined, b: Box, t: Timing = {}) {
  const bw = has(badge) ? Math.round(b.h * 1.9) : 0;
  const sw = Math.round(b.h * 2.1);
  const nw = (b.w - bw - sw) / 2;
  const ts = b.h * 0.5;
  rect(c, "bug-bg", b, { fill: NAVY, radius: 14, ...t });
  rect(c, "bug-own-bg", { x: b.x, y: b.y, w: nw + 16, h: b.h }, { fill: "@primary", radius: 14, ...t });
  if (has(badge)) {
    rect(c, "badge-bg", { x: b.x + b.w - bw - 16, y: b.y, w: bw + 16, h: b.h }, { fill: "@accent", radius: 14, ...t });
    ellipse(c, "badge-dot", { x: b.x + b.w - bw + 18, y: b.y + b.h / 2 - 8, w: 16, h: 16 }, { fill: NAVY, ...t });
    say(c, "badge", badge, { x: b.x + b.w - bw + 42, y: b.y + b.h * 0.2, w: bw - 58, h: b.h * 0.62 }, ts, { face: "display", color: NAVY, align: "center", fit: true, ...t });
  }
  rect(c, "bug-score-bg", { x: b.x + nw, y: b.y, w: sw, h: b.h }, { fill: WHITE, ...t });
  say(c, "bug-own", s.ownName, { x: b.x + 18, y: b.y + b.h * 0.2, w: nw - 30, h: b.h * 0.62 }, ts, { face: "display", color: WHITE, align: "center", fit: true, ...t });
  say(c, "bug-score", c.ar ? `${s.opp}–${s.own}` : `${s.own}–${s.opp}`, { x: b.x + nw + 10, y: b.y + b.h * 0.14, w: sw - 20, h: b.h * 0.74 }, b.h * 0.64, { face: "display", num: true, color: NAVY, align: "center", fit: true, ...t });
  say(c, "bug-opp", s.oppName, { x: b.x + nw + sw + 12, y: b.y + b.h * 0.2, w: nw - 24, h: b.h * 0.62 }, ts, { face: "display", color: WHITE, align: "center", fit: true, ...t });
}

const metaLine = (k: Content) => k.meta.filter(has).join("  ·  ");

// ── Score: full time, half time (result sheet) and the live goal flash / score ──

const score: StyleKit["score"] = (c, k) => {
  backdrop(c);
  if (has(k.badge)) liveScore(c, k);
  else result(c, k);
};

function result(c: Ctx, k: Content) {
  const s = k.score!;
  const bottom = c.story ? c.B : c.H - stripH(c) - c.pick(36, 26, 0);
  const ks = c.pick(150, 116, 180);
  const cs = c.pick(196, 150, 230);
  const ss = c.pick(230, 176, 260);
  let y = c.T;
  say(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: Math.round(ks * 0.95) }, ks, { face: "display", color: WHITE, align: "center", fit: true, shadow: SHADOW });
  y += Math.round(ks * 0.95) + 10;
  say(c, "meta", metaLine(k), { x: c.M, y, w: c.CW, h: 40 }, 30, { color: SOFT, upper: true, ls: 3, align: "center", fit: true });
  y += 40 + c.pick(48, 30, 70);
  const x1 = c.M + 30;
  const x2 = c.W - c.M - 30 - cs;
  haze(c, y - 40, cs + 160);
  halo(c, c.W / 2, y + cs / 2, cs * 0.95);
  homeCrest(c, { x: x1, y, w: cs, h: cs });
  awayCrest(c, { x: x2, y, w: cs, h: cs });
  say(c, "score", c.ar ? `${s.opp}–${s.own}` : `${s.own}–${s.opp}`, { x: x1 + cs + 16, y: y + cs / 2 - ss * 0.5, w: x2 - x1 - cs - 32, h: ss }, ss, { face: "display", num: true, color: "@accent", align: "center", fit: true, mirror: false, shadow: SHADOW });
  y += cs + 26;
  const nw = cs + 140;
  say(c, "own", s.ownName, { x: x1 + cs / 2 - nw / 2, y, w: nw, h: 56 }, 50, { face: "display", color: WHITE, align: "center", fit: true, shadow: LIFT });
  say(c, "opp", s.oppName, { x: x2 + cs / 2 - nw / 2, y, w: nw, h: 56 }, 50, { face: "display", color: SOFT, align: "center", fit: true, shadow: LIFT });
  y += 56 + 12;
  if (has(k.sub)) {
    say(c, "scorers", k.sub, { x: c.M, y, w: c.CW, h: 44 }, 34, { weight: 700, color: WHITE, align: "center", fit: true });
    y += 44;
  }
  y += c.pick(36, 24, 60);
  card(c, { x: c.M, y, w: c.CW, h: bottom - y });
  strip(c, k);
}

function liveScore(c: Ctx, k: Content) {
  const s = k.score!;
  const bottom = c.B;
  const bh = c.pick(84, 76, 88);
  const cs = bh + 24;
  crest(c, "crest", { x: c.M, y: c.T, w: cs, h: cs });
  bug(c, s, k.badge, { x: c.M + cs + 20, y: c.T + (cs - bh) / 2, w: c.CW - cs - 20, h: bh });
  const top = c.T + cs + c.pick(40, 26, 56);
  const ks = c.pick(240, 176, 280);
  const numberLed = !!k.sub?.includes("player.number");
  const items: StackItem[] = [
    { h: Math.round(ks * 0.9), gap: 10, draw: (y) => say(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: Math.round(ks * 0.9) }, ks, { face: "display", color: WHITE, fit: true, shadow: SHADOW }) },
    !numberLed && has(k.sub) && { h: 76, gap: 22, draw: (y) => pill(c, "sub", k.sub!, { x: c.M, y, w: Math.min(c.CW, 620), h: 76 }, { fill: WHITE, ink: NAVY }) },
    { h: 40, draw: (y) => say(c, "meta", metaLine(k), { x: c.M, y, w: c.CW, h: 40 }, 30, { color: SOFT, upper: true, ls: 3, fit: true }) },
  ];
  const y0 = bottom - stackHeight(items);
  const cardBottom = y0 + Math.round(ks * 0.42);
  if (numberLed) {
    const cw = Math.round(c.CW * 0.56);
    card(c, { x: c.W - c.M - cw, y: top, w: cw, h: cardBottom - top });
    const ns = c.pick(160, 120, 190);
    say(c, "scorer", k.sub!, { x: c.M, y: top + 6, w: c.CW - cw - 28, h: Math.round(ns * 1.05) }, ns, { face: "display", color: "@accent", fit: true, lh: 0.9, shadow: SHADOW });
  } else {
    card(c, { x: c.M, y: top, w: c.CW, h: cardBottom - top });
  }
  stackDown(y0, items);
}

// ── Fixture: match day, kick-off, through to the next round ─────────────────

const fixture: StyleKit["fixture"] = (c, k) => {
  backdrop(c);
  const v = k.vs!;
  const live = has(k.cta);
  const bottom = c.story ? c.B : c.H - stripH(c) - c.pick(36, 26, 0);
  const hs = c.pick(150, 116, 180);
  const cs = c.pick(188, 140, 220);
  let y = c.T;
  if (live) {
    const pw = 300;
    rect(c, "pill-1-bg", { x: c.W / 2 - pw / 2, y, w: pw, h: 60 }, { fill: "@accent", radius: 30 });
    ellipse(c, "pill-1-dot", { x: c.W / 2 - pw / 2 + 30, y: y + 22, w: 16, h: 16 }, { fill: NAVY });
    say(c, "pill-1", k.pills[0] ?? "", { x: c.W / 2 - pw / 2 + 58, y: y + 12, w: pw - 90, h: 38 }, 34, { face: "display", color: NAVY, align: "center", fit: true });
    y += 60 + 18;
  } else if (has(k.headline)) {
    label(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: 38 }, { align: "center", color: WHITE });
    y += 38 + 10;
  }
  say(c, "headline", k.headline ?? k.kicker, { x: c.M, y, w: c.CW, h: Math.round(hs * 0.95) }, hs, { face: "display", color: WHITE, align: "center", fit: true, shadow: SHADOW });
  y += Math.round(hs * 0.95) + 10;
  say(c, "meta", metaLine(k), { x: c.M, y, w: c.CW, h: 40 }, 30, { color: SOFT, upper: true, ls: 3, align: "center", fit: true });
  y += 40 + c.pick(48, 30, 72);
  const x1 = c.M + 40;
  const x2 = c.W - c.M - 40 - cs;
  haze(c, y - 40, cs + 160);
  halo(c, c.W / 2, y + cs / 2, cs * 0.9);
  homeCrest(c, { x: x1, y, w: cs, h: cs });
  awayCrest(c, { x: x2, y, w: cs, h: cs });
  const vs = c.pick(120, 96, 130);
  say(c, "vs", v.label, { x: x1 + cs + 20, y: y + cs / 2 - vs * 0.5, w: x2 - x1 - cs - 40, h: vs }, vs, { face: "display", color: WHITE, align: "center", fit: true, shadow: SHADOW });
  y += cs + 26;
  const nw = cs + 150;
  say(c, "own", v.ownName, { x: x1 + cs / 2 - nw / 2, y, w: nw, h: 56 }, 50, { face: "display", color: WHITE, align: "center", fit: true, shadow: LIFT });
  say(c, "opp", v.oppName, { x: x2 + cs / 2 - nw / 2, y, w: nw, h: 56 }, 50, { face: "display", color: SOFT, align: "center", fit: true, shadow: LIFT });
  y += 56 + c.pick(34, 22, 56);
  // The info pill sits over the bottom edge of the photo card.
  const ih = c.pick(136, 116, 146);
  const iy = bottom - ih;
  card(c, { x: c.M, y, w: c.CW, h: iy + Math.round(ih * 0.5) - y });
  const ib = { x: c.M + 50, y: iy, w: c.CW - 100, h: ih };
  if (live) {
    rect(c, "info-bg", ib, { fill: WHITE, radius: ih / 2 });
    say(c, "cta", k.cta!, { x: ib.x + 60, y: iy + ih * 0.16, w: ib.w - 120, h: ih * 0.42 }, ih * 0.4, { face: "display", color: NAVY, align: "center", fit: true });
    say(c, "pill-2", k.pills[1] ?? "", { x: ib.x + 60, y: iy + ih * 0.6, w: ib.w - 120, h: ih * 0.24 }, ih * 0.2, { weight: 700, color: "#3A4A6B", upper: true, ls: 2, align: "center", fit: true });
  } else {
    rect(c, "info-bg", ib, { fill: NAVY, radius: ih / 2, stroke: { color: "@accent", width: 3 } });
    const half = ib.w / 2;
    say(c, "pill-1", k.pills[0] ?? "", { x: ib.x + 40, y: iy + ih * 0.14, w: half - 64, h: ih * 0.44 }, ih * 0.4, { face: "display", color: WHITE, align: "end", fit: true });
    ellipse(c, "info-dot", { x: ib.x + half - 7, y: iy + ih * 0.34 - 7, w: 14, h: 14 }, { fill: "@accent" });
    say(c, "pill-2", k.pills[1] ?? "", { x: ib.x + half + 24, y: iy + ih * 0.14, w: half - 64, h: ih * 0.44 }, ih * 0.4, { face: "display", color: "@accent", fit: true });
    say(c, "pill-3", k.pills[2] ?? "", { x: ib.x + 60, y: iy + ih * 0.62, w: ib.w - 120, h: ih * 0.24 }, ih * 0.2, { weight: 700, color: SOFT, upper: true, ls: 2, align: "center", fit: true });
  }
  strip(c, k);
};

// ── Hero: player of the match / month, birthday, welcome, clean sheet, coach ──

const hero: StyleKit["hero"] = (c, k) => {
  backdrop(c);
  const { head, tag } = heroWords(k);
  const numbered = has(k.number);
  const top = lockup(c, k);
  const hs = c.pick(140, 108, 160);
  let y = top + c.pick(44, 28, 64);
  if (has(tag) && tag !== head) {
    label(c, "kicker", tag, { x: c.M, y, w: c.CW, h: 40 }, { color: numbered || k.stat ? SOFT : "@accent" });
    y += 40 + 14;
  }
  const hh = Math.round(lines(head, hs, c.CW) * hs * 0.95);
  say(c, "headline", head, { x: c.M, y, w: c.CW, h: hh }, hs, { face: "display", color: WHITE, fit: true, shadow: SHADOW });
  y += hh + c.pick(40, 26, 56);
  const bottom = c.B;
  const metas = k.meta.filter(has);
  const metaItems = (w: number, x: number): StackItem[] =>
    metas.map((m, i) => ({ h: 36, gap: 6, draw: (yy: number) => say(c, `meta-${i + 1}`, m, { x, y: yy, w, h: 36 }, 27, { color: SOFT, upper: true, ls: 2, fit: true }) }));
  if (numbered) {
    // Number, then first name, beside the photo card.
    const lw = c.pick(372, 330, 372);
    const ns = c.pick(290, 210, 320);
    card(c, { x: c.M + lw + 28, y, w: c.CW - lw - 28, h: bottom - y });
    stackDown(y - Math.round(ns * 0.06), [
      { h: Math.round(ns * 0.9), gap: 8, draw: (yy) => say(c, "number", `#${k.number}`, { x: c.M, y: yy, w: lw, h: Math.round(ns * 0.9) }, ns, { face: "display", num: true, color: "@accent", fit: true, lh: 0.9, shadow: SHADOW }) },
      has(k.name) && { h: 60, gap: 18, draw: (yy) => say(c, "name", k.name!, { x: c.M, y: yy, w: lw, h: 60 }, 56, { face: "display", color: WHITE, fit: true }) },
      k.stat && { h: 64, gap: 18, draw: (yy) => pill(c, "stat", `${k.stat!.value} ${k.stat!.label}`, { x: c.M, y: yy, w: lw, h: 64 }, { fill: WHITE, ink: NAVY }) },
      has(k.sub) && { h: c.pick(124, 92, 140), draw: (yy) => say(c, "sub", k.sub!, { x: c.M, y: yy, w: lw, h: c.pick(124, 92, 140) }, 30, { color: WHITE, lh: 1.3, fit: true }) },
    ]);
    stackUp(bottom, metaItems(lw, c.M));
    return;
  }
  // Coach, champions: the stat (in gold) or the words, then a wide photo card.
  const yAfter = stackDown(y - c.pick(14, 10, 20), [
    k.stat && { h: c.pick(150, 112, 170), gap: 16, draw: (yy) => {
      const ss = c.pick(150, 112, 170);
      say(c, "stat", k.stat!.value, { x: c.M, y: yy, w: ss, h: ss }, ss, { face: "display", num: true, color: "@accent", fit: true, lh: 0.9, shadow: SHADOW });
      say(c, "stat-label", k.stat!.label, { x: c.M + ss + 20, y: yy + ss * 0.36, w: c.CW - ss - 20, h: 40 }, 30, { weight: 800, color: WHITE, upper: true, ls: 3, fit: true });
    } },
    has(k.sub) && { h: c.pick(90, 76, 100), gap: 0, draw: (yy) => say(c, "sub", k.sub!, { x: c.M, y: yy, w: c.CW, h: c.pick(90, 76, 100) }, 34, { color: WHITE, lh: 1.3, fit: true }) },
  ]);
  const mh = stackHeight(metaItems(c.CW, c.M));
  const cy = yAfter + c.pick(34, 22, 48);
  card(c, { x: c.M, y: cy, w: c.CW, h: bottom - mh - (mh ? 24 : 0) - cy });
  stackUp(bottom, metaItems(c.CW, c.M));
};

// ── List: line-up / call-up (number tiles), table, prices, match stats ──────

/** Text in IRIS faces for the photo tiles (Bebas for display, Inter otherwise, Cairo in Arabic). */
function irisText(c: Ctx, id: string, value: string, b: Box, o: TextOpts) {
  const layer = text(c, id, value, b, o) as TextLayer;
  layer.family = String(layer.font).startsWith("arabic") ? "Cairo" : o.font === "display" ? "Bebas Neue" : "Inter";
  if (layer.family === "Bebas Neue") layer.weight = 400;
  return layer;
}

/** Line-up photo tiles: a royal card with a light edge, the figure under floodlight, a navy caption band. */
const TILE: TileLook = {
  backdrop: (c, id, b) => {
    rect(c, id, b, { gradient: { from: "@primary", to: NAVY }, radius: 20, stroke: { color: EDGE, width: 2 } });
    ellipse(c, `${id}-light`, { x: b.x + b.w * 0.15, y: b.y - b.h * 0.05, w: b.w * 0.7, h: b.h * 0.6 }, { fill: WHITE, opacity: 0.12 });
  },
  bar: (c, id, b) => rect(c, id, b, { fill: NAVY, radius: 14, stroke: { color: EDGE, width: 2 } }),
  num: { font: "display", color: WHITE, weight: 400, opacity: 0.9 },
  name: { font: "display", color: WHITE, weight: 400, ls: 1 },
  pos: { font: "body", color: SOFT, weight: 700 },
  shadow: NAVY,
  cardRadius: 16,
  text: irisText,
};

const list: StyleKit["list"] = (c, k) => {
  backdrop(c);
  const rows = k.rows ?? [];
  const grid = k.key === "lineup" || k.key === "callup";
  const withStrip = !c.story && ["callup", "matchstats", "standings"].includes(k.key);
  const bottom = withStrip ? c.H - stripH(c) - c.pick(32, 24, 0) : c.B;
  const top = lockup(c, k, { size: c.pick(112, 96, 120) });
  let y = top + c.pick(40, 22, 60);
  label(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: 38 });
  y += 38 + 8;
  const hs = c.pick(104, 84, 124);
  say(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: Math.round(hs * 0.95) }, hs, { face: "display", color: WHITE, fit: true, shadow: SHADOW });
  y += Math.round(hs * 0.95) + c.pick(34, 20, 52);
  // Gold goes to the call to action, or to the kick-off line of a line-up; tables and stats gold their first row.
  const metas = k.meta.filter(has);
  const goldMeta = !k.cta && grid;
  const foot: StackItem[] = [
    k.cta && { h: 76, gap: 14, draw: (yy) => pill(c, "cta", k.cta!, { x: c.M, y: yy, w: c.CW, h: 76 }, { fill: "@accent", ink: NAVY }) },
    ...metas.map((m, i): StackItem => goldMeta && i === 0
      ? { h: 70, gap: 14, draw: (yy) => pill(c, "meta-1", m, { x: c.M + 60, y: yy, w: c.CW - 120, h: 70 }, { fill: "@accent", ink: NAVY }) }
      : { h: 36, gap: 8, draw: (yy) => say(c, `meta-${i + 1}`, m, { x: c.M, y: yy, w: c.CW, h: 36 }, 27, { color: SOFT, upper: true, ls: 2, align: grid ? "center" : "start", fit: true }) }),
  ];
  const areaBottom = bottom - stackHeight(foot) - c.pick(32, 20, 44);
  if (grid) rowsOrTiles(c, k, { x: c.M, y, w: c.CW, h: areaBottom - y }, TILE, () => tiles(c, rows, y, areaBottom));
  else bars(c, k, rows, y, areaBottom);
  stackUp(bottom, foot);
  if (withStrip) strip(c, k);
};

/** Shirt-number tiles, three across; the position sits in a band along the bottom. */
function tiles(c: Ctx, rows: Array<[string, string, string]>, top: number, bottom: number) {
  const n = rows.length;
  const cols = n <= 4 ? 2 : 3;
  const nr = Math.ceil(n / cols);
  const gap = c.pick(18, 14, 20);
  const tw = (c.CW - gap * (cols - 1)) / cols;
  const th = Math.max(80, Math.min(Math.round(tw * c.pick(0.86, 0.8, 1.12)), Math.floor((bottom - top - gap * (nr - 1)) / nr)));
  rows.forEach((row, i) => {
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, n - r * cols);
    const x = c.M + (c.CW - (inRow * tw + (inRow - 1) * gap)) / 2 + (i % cols) * (tw + gap);
    const y = top + r * (th + gap);
    const id = `row-${i + 1}`;
    const band = Math.round(th * 0.24);
    rect(c, `${id}-bg`, { x, y, w: tw, h: th }, { fill: "@primary", radius: 20, stroke: { color: EDGE, width: 2 } });
    if (th < tw * 0.62) {
      // Short tiles (square posts): number on the left, name and position beside it.
      const nw = Math.round(tw * 0.5);
      say(c, `${id}-lead`, `#${row[0]}`, { x: x + 14, y: y + th * 0.16, w: nw - 14, h: th * 0.68 }, th * 0.62, { face: "display", num: true, color: WHITE, align: "center", fit: true });
      rect(c, `${id}-band`, { x: x + nw, y: y + 12, w: 2, h: th - 24 }, { fill: EDGE });
      say(c, `${id}-main`, row[1], { x: x + nw + 14, y: y + th * 0.16, w: tw - nw - 26, h: th * 0.3 }, th * 0.26, { weight: 700, color: WHITE, fit: true });
      say(c, `${id}-trail`, row[2], { x: x + nw + 14, y: y + th * 0.5, w: tw - nw - 26, h: th * 0.34 }, th * 0.3, { face: "display", color: SOFT, fit: true });
      return;
    }
    rect(c, `${id}-band`, { x, y: y + th - band, w: tw, h: band }, { fill: "#0B1F4D99", radius: 20 });
    say(c, `${id}-lead`, `#${row[0]}`, { x: x + 10, y: y + th * 0.1, w: tw - 20, h: th * 0.46 }, th * 0.46, { face: "display", num: true, color: WHITE, align: "center", fit: true });
    say(c, `${id}-main`, row[1], { x: x + 14, y: y + th * 0.56, w: tw - 28, h: th * 0.16 }, th * 0.14, { weight: 700, color: WHITE, align: "center", fit: true });
    say(c, `${id}-trail`, row[2], { x: x + 14, y: y + th - band + band * 0.22, w: tw - 28, h: band * 0.56 }, band * 0.5, { face: "display", color: SOFT, align: "center", fit: true });
  });
}

/** Navy bars with a royal lead cell: league table, prices, match stats. */
function bars(c: Ctx, k: Content, rows: Array<[string, string, string]>, top: number, bottom: number) {
  const stats = k.key === "matchstats";
  let y = top;
  if (stats && k.rowsHead) {
    say(c, "head-lead", k.rowsHead[0], { x: c.M, y, w: c.CW / 2 - 20, h: 44 }, 40, { face: "display", color: WHITE, fit: true });
    say(c, "head-trail", k.rowsHead[2], { x: c.W / 2 + 20, y, w: c.CW / 2 - 20, h: 44 }, 40, { face: "display", color: SOFT, align: "end", fit: true });
    y += 44 + 16;
  }
  const lead = numericLead(k);
  const boxes = rowBoxes(rows.length, y, bottom, c.M, c.CW, { gap: 12, maxH: c.pick(stats ? 104 : 118, stats ? 92 : 104, stats ? 150 : 150), minH: 60 });
  boxes.forEach((b, i) => {
    const row = rows[i];
    const id = `row-${i + 1}`;
    const gold = i === 0 && (stats || k.key === "standings");
    const lw = lead ? Math.round(b.h * 1.1) : stats ? Math.round(b.w * 0.24) : Math.round(b.w * 0.3);
    const tw = stats ? Math.round(b.w * 0.2) : Math.round(b.w * 0.26);
    rect(c, `${id}-bg`, b, { fill: PANEL, radius: 18, stroke: { color: EDGE, width: 2 } });
    rect(c, `${id}-lead-bg`, { x: b.x + 8, y: b.y + 8, w: lw - 16, h: b.h - 16 }, { fill: gold ? "@accent" : "@primary", radius: 12 });
    say(c, `${id}-lead`, row[0], { x: b.x + 22, y: b.y + b.h * 0.22, w: lw - 44, h: b.h * 0.56 }, b.h * (lead || stats ? 0.52 : 0.4), { face: "display", num: lead, color: gold ? NAVY : WHITE, align: "center", fit: true });
    if (stats) {
      say(c, `${id}-main`, row[1], { x: b.x + lw + 16, y: b.y + b.h * 0.3, w: b.w - lw - tw - 32, h: b.h * 0.4 }, b.h * 0.3, { weight: 800, color: WHITE, upper: true, ls: 3, align: "center", fit: true });
    } else {
      say(c, `${id}-main`, row[1], { x: b.x + lw + 24, y: b.y + b.h * (lead ? 0.24 : 0.3), w: b.w - lw - tw - 48, h: b.h * (lead ? 0.52 : 0.4) }, b.h * (lead ? 0.46 : 0.3), lead ? { face: "display", color: WHITE, fit: true } : { color: SOFT, fit: true });
    }
    say(c, `${id}-trail`, row[2], { x: b.x + b.w - tw - 24, y: b.y + b.h * 0.22, w: tw, h: b.h * 0.56 }, b.h * 0.5, { face: "display", color: stats ? SOFT : WHITE, align: "end", fit: true });
  });
}

// ── Promo: free trial, new group, tournament, find us, values, countdown, poll ──

const promo: StyleKit["promo"] = (c, k) => {
  backdrop(c);
  if (k.options) return poll(c, k);
  if (k.key === "countdown") return countdown(c, k);
  const badge = has(k.badge);
  const d = c.pick(196, 164, 210);
  const top = lockup(c, k, { right: badge ? d + 10 : 0 });
  if (badge) {
    ellipse(c, "badge-disc", { x: c.W - c.M - d, y: c.T - 8, w: d, h: d }, { fill: WHITE, stroke: { color: "@primary", width: 6 }, rotation: -8 });
    say(c, "badge", k.badge!, { x: c.W - c.M - d + 22, y: c.T - 8 + d * 0.3, w: d - 44, h: d * 0.4 }, d * 0.3, { face: "display", color: "@primary", align: "center", fit: true, rotation: -8 });
  }
  const manifesto = k.key === "manifesto";
  const hs = c.pick(manifesto ? 92 : 132, manifesto ? 74 : 104, manifesto ? 110 : 150);
  let y = Math.max(top, badge ? c.T + d - 8 : 0) + c.pick(40, 24, 60);
  label(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: 38 });
  y += 38 + 10;
  // The manifesto is free text: always give it three lines.
  const hh = Math.round((manifesto ? 3 : lines(k.headline ?? "", hs, c.CW)) * hs * 0.95);
  say(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: hh }, hs, { face: "display", color: WHITE, fit: true, shadow: SHADOW });
  y += hh + 12;
  if (has(k.sub)) {
    const sh = c.pick(84, 44, 90);
    say(c, "sub", k.sub, { x: c.M, y, w: c.CW, h: sh }, 36, { color: SOFT, lh: 1.3, fit: true });
    y += sh;
  }
  y += c.pick(30, 20, 44);
  const pills = k.pills.filter(has);
  const foot: StackItem[] = [
    pills.length > 0 && { h: 68, gap: 16, draw: (yy) => {
      const gap = 14;
      const pw = (c.CW - gap * (k.pills.length - 1)) / k.pills.length;
      k.pills.forEach((p, i) => pill(c, `pill-${i + 1}`, p, { x: c.M + i * (pw + gap), y: yy, w: pw, h: 68 }, { fill: PANEL, ink: WHITE, stroke: EDGE, size: 32 }));
    } },
    k.cta && { h: 80, draw: (yy) => pill(c, "cta", k.cta!, { x: c.M, y: yy, w: c.CW, h: 80 }, { fill: "@accent", ink: NAVY }) },
  ];
  const fh = stackHeight(foot);
  const cb = { x: c.M, y, w: c.CW, h: c.B - fh - (fh ? c.pick(28, 20, 40) : 0) - y };
  if (card(c, cb) && k.key === "map") pin(c, c.W / 2, cb.y + Math.round(cb.h * 0.45), "@accent", WHITE);
  stackUp(c.B, foot);
};

/** Countdown: "Game day" with the one script word, the days-to-go pill and a white fixture card. */
function countdown(c: Ctx, k: Content) {
  const top = lockup(c, k);
  let y = top + c.pick(30, 16, 60);
  const gs = c.pick(220, 150, 260);
  if (c.ar) {
    say(c, "hype", "يوم", { x: c.M, y: y - gs * 0.16, w: c.CW, h: Math.round(gs * 1.1) }, gs, { face: "display", color: WHITE, fit: true, shadow: SHADOW });
    say(c, "hype-accent", "الماتش", { x: c.M + gs * 0.55, y: y + gs * 0.82, w: c.CW - gs * 0.55, h: Math.round(gs * 0.8) }, gs * 0.72, { face: "script", color: "@accent", fit: true, rotation: -4, shadow: SHADOW });
  } else {
    say(c, "hype", "Game", { x: c.M, y, w: c.CW, h: Math.round(gs * 0.92) }, gs, { face: "display", color: WHITE, fit: true, shadow: SHADOW });
    say(c, "hype-accent", "day", { x: c.M + gs * 0.86, y: y + gs * 0.6, w: gs * 1.6, h: Math.round(gs * 0.82) }, gs * 0.62, { face: "script", color: "@accent", lh: 1.2, rotation: -6, shadow: SHADOW });
  }
  y += Math.round(gs * (c.ar ? 1.68 : 1.42));
  const ph = c.pick(76, 66, 84);
  pill(c, "headline", k.headline ?? "", { x: c.M, y, w: Math.min(c.CW, 600), h: ph }, { fill: WHITE, ink: NAVY });
  y += ph + c.pick(30, 20, 44);
  // White fixture card at the bottom.
  const fh = c.pick(232, 196, 252);
  const fy = c.B - fh;
  card(c, { x: c.M, y, w: c.CW, h: fy - c.pick(24, 18, 36) - y });
  rect(c, "info-bg", { x: c.M, y: fy, w: c.CW, h: fh }, { fill: WHITE, radius: 28 });
  say(c, "kicker", k.kicker, { x: c.M + 40, y: fy + fh * 0.1, w: c.CW - 80, h: fh * 0.3 }, fh * 0.28, { face: "display", color: "@primary", fit: true });
  say(c, "sub", k.sub ?? "", { x: c.M + 40, y: fy + fh * 0.42, w: c.CW - 80, h: fh * 0.15 }, fh * 0.12, { weight: 700, color: "#3A4A6B", upper: true, ls: 2, fit: true });
  rect(c, "info-rule", { x: c.M + 40, y: fy + fh * 0.63, w: c.CW - 80, h: 2 }, { fill: "#C3CCE2" });
  const cols = [0.3, 0.24, 0.46];
  let x = c.M + 40;
  k.pills.slice(0, 3).forEach((p, i) => {
    const w = (c.CW - 80) * cols[i];
    say(c, `pill-${i + 1}`, p, { x, y: fy + fh * 0.7, w: w - 16, h: fh * 0.2 }, fh * 0.17, { face: "display", color: NAVY, fit: true });
    x += w;
  });
}

/** Poll: two photo options with A / B discs; voting line in gold. */
function poll(c: Ctx, k: Content) {
  const top = lockup(c, k);
  let y = top + c.pick(40, 22, 60);
  label(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: 38 });
  y += 38 + 10;
  const hs = c.pick(124, 96, 140);
  const hh = Math.round(lines(k.headline ?? "", hs, c.CW) * hs * 0.95);
  say(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: hh }, hs, { face: "display", color: WHITE, fit: true, shadow: SHADOW });
  y += hh + c.pick(34, 20, 48);
  const mh = 70;
  const cw = (c.CW - 28) / 2;
  const ch = c.B - mh - c.pick(28, 20, 40) - y;
  k.options!.forEach((opt, i) => {
    const x = c.M + i * (cw + 28);
    card(c, { x, y, w: cw, h: ch }, { id: `option-${i + 1}-photo`, path: `more.${i}`, name: `Option ${i + 1} photo` });
    const dd = 72;
    ellipse(c, `option-${i + 1}-key-bg`, { x: x + 22, y: y + ch - dd - 22, w: dd, h: dd }, { fill: i === 0 ? "@primary" : NAVY, stroke: { color: WHITE, width: 3 } });
    say(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x + 22, y: y + ch - dd - 22 + dd * 0.18, w: dd, h: dd * 0.64 }, dd * 0.56, { face: "display", color: WHITE, align: "center" });
    say(c, `option-${i + 1}`, opt, { x: x + dd + 40, y: y + ch - dd - 12, w: cw - dd - 60, h: 60 }, 56, { face: "display", color: WHITE, fit: true, shadow: SHADOW });
  });
  pill(c, "meta-1", k.meta[0] ?? "", { x: c.M + 80, y: c.B - mh, w: c.CW - 160, h: mh }, { fill: "@accent", ink: NAVY });
}

// ── Video skin ──────────────────────────────────────────────────────────────

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 420 }, { gradient: { from: "#0B1F4DCC", to: CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 860, w: c.W, h: 860 }, { gradient: { from: CLEAR, to: "#0B1F4DF0" } });
  },
  frame: (c, k, t) => { lockup(c, k, { size: 96, ...t }); },
  tag: (c, k, t) => {
    const y = k.video?.variant === "goal" ? c.B - 560 : c.B - 480;
    rect(c, "kicker-bg", { x: c.M, y, w: 420, h: 64 }, { fill: "@primary", radius: 32, ...t });
    say(c, "kicker", k.kicker, { x: c.M + 28, y: y + 12, w: 364, h: 42 }, 38, { face: "display", color: WHITE, align: "center", fit: true, ...t });
  },
  goal: (c, k, t) => {
    const s = k.score!;
    say(c, "number", `#${k.number ?? ""}`, { x: c.M, y: c.B - 470, w: 440, h: 290 }, 300, { face: "display", num: true, color: "@accent", fit: true, lh: 0.9, shadow: SHADOW, ...t });
    say(c, "name", k.name ?? "", { x: c.M + 460, y: c.B - 300, w: c.CW - 460, h: 70 }, 64, { face: "display", color: WHITE, fit: true, shadow: SHADOW, ...t });
    bug(c, s, undefined, { x: c.M, y: c.B - 140, w: c.CW, h: 96 }, t);
  },
  speaker: (c, k, t) => {
    const y = c.B - 380;
    rect(c, "speaker-bg", { x: c.M, y, w: c.CW, h: 170 }, { fill: PANEL, radius: 24, stroke: { color: EDGE, width: 2 }, ...t });
    rect(c, "speaker-bar", { x: c.M, y, w: 14, h: 170 }, { fill: "@primary", radius: 7, ...t });
    say(c, "speaker", k.headline ?? "", { x: c.M + 44, y: y + 24, w: c.CW - 80, h: 72 }, 68, { face: "display", color: WHITE, fit: true, ...t });
    say(c, "role", k.sub ?? "", { x: c.M + 44, y: y + 106, w: c.CW - 80, h: 40 }, 30, { weight: 700, color: "@accent", upper: true, ls: 3, fit: true, ...t });
  },
  title: (c, k, t) => {
    say(c, "headline", k.headline ?? "", { x: c.M, y: c.B - 400, w: c.CW, h: 290 }, 150, { face: "display", color: WHITE, fit: true, shadow: SHADOW, ...t });
    say(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 80, w: c.CW, h: 40 }, 30, { color: SOFT, upper: true, ls: 3, fit: true, ...t });
  },
  caption: (c, id, value, t) =>
    say(c, id, value, { x: c.M, y: c.B - 170, w: c.CW, h: 150 }, 44, { weight: 700, color: WHITE, align: "center", lh: 1.2, fit: true, bg: { color: "#0B1F4DE6", padding: 20, radius: 20 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "@primary", to: NAVY }, ...t });
    blades(c, t, "end-blade");
    halo(c, c.W / 2, c.H / 2 - 100, 300, t, "end-halo");
    crest(c, "end-crest", { x: c.W / 2 - 160, y: c.H / 2 - 260, w: 320, h: 320 }, t);
    say(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 110, w: c.CW, h: 96 }, 84, { face: "display", color: WHITE, align: "center", fit: true, ...t });
    rect(c, "end-rule", { x: c.W / 2 - 80, y: c.H / 2 + 230, w: 160, h: 6 }, { fill: "@accent", radius: 3, ...t });
  },
};

export const pack_iris: StyleKit = { background: NAVY, plate: { opacity: 1, above: "sky" }, score, fixture, hero, list, promo, skin };
