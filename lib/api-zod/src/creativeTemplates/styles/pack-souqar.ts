import type { SceneLayer } from "../../creativeScene";
import type { Content } from "../content";
import { crest, ellipse, media, rect, rule, text, type Box, type Ctx, type TextOpts, type Timing } from "../kit";
import { has, pin, rowBoxes, stackHeight, stackDown, type StackItem } from "../parts";
import { heroWords, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Brand pack "souqar" — Sports iN Souqar (brand deck "Sports iN Souqar — brand
 * deck", slides 04–10). Every match under floodlights: the tinted night-stadium
 * plate shows bright behind a midnight scrim, the crest and academy name sit as
 * a left-aligned lockup at the top, one big photo in a silver frame fills the
 * middle, heavy white Montserrat 900 does the shouting and clean white info
 * pills run along the bottom. Silver (#C9CED6) is the metal for kickers, frames
 * and rules. Floodlight lime (@accent) appears only on LIVE and on the score.
 */

const MID = "#071A4A";
const WHITE = "#F3F6FF";
const SILVER = "#C9CED6";
const STEEL = "#9AA3B3";
const SOFT = "#DCE3F5";
const CLEAR = "#071A4A00";
const GLASS = "#071A4AC7";
const HAIR = "#C9CED64D";

/** Blue glow behind the white display type (deck: text-shadow 0 0 40px blue). */
const GLOW = { color: "@primary", blur: 40, x: 0, y: 0 };
/** Midnight halo behind the Floodlight score so it holds on a bright plate. */
const DEEP = { color: "#071A4AE6", blur: 30, x: 0, y: 6 };

const FAMILY = { display: "Montserrat", body: "Inter", arabic: "Cairo" };

/** Live templates: the only place Floodlight lime marks a badge. */
const LIVE = new Set(["kickoff", "goalflash", "livescore"]);

// ── Type ────────────────────────────────────────────────────────────────────

/** A text layer in the pack's faces: Montserrat display, Inter body, Cairo Arabic. */
function tx(c: Ctx, id: string, value: string, b: Box, o: TextOpts): SceneLayer {
  const layer = text(c, id, value, b, o);
  if (layer.kind === "text") {
    const display = o.font === "display" || o.font === "condensed";
    layer.family = layer.font.startsWith("arabic") ? FAMILY.arabic : display ? FAMILY.display : FAMILY.body;
  }
  return layer;
}

type BigOpts = Timing & { color?: string; align?: "start" | "center" | "end"; num?: boolean; mirror?: boolean; opacity?: number; shadow?: TextOpts["shadow"]; stroke?: TextOpts["stroke"]; lh?: number };

/** Heavy white capitals with the floodlight glow. */
function big(c: Ctx, id: string, value: string, b: Box, size: number, o: BigOpts = {}) {
  const { color, align, num, shadow, stroke, lh, ...t } = o;
  return tx(c, id, value, b, { size, font: "display", weight: 900, color: color ?? WHITE, upper: true, lh: lh ?? 0.98, fit: true, align, num, shadow: shadow ?? GLOW, stroke, ...t });
}

/** Small spaced silver capitals (NEXT MATCH, PLAYER OF THE MATCH). */
function kicker(c: Ctx, id: string, value: string, x: number, y: number, w: number, t: Timing = {}) {
  tx(c, id, value, { x, y: y - 3, w, h: 48 }, { size: c.pick(30, 27, 32), font: "display", weight: 800, color: SILVER, upper: true, ls: 4, lh: 1.1, fit: true, arScale: 1.05, ...t });
}

/** Lines a display headline will take at this size (bindings at their typical length), 1..max. */
const linesFor = (c: Ctx, value: string, size: number, max = 2) =>
  Math.max(1, Math.min(max, value.split("\n").reduce((n, line) => n + Math.ceil((guessLen(line) * size * 0.7) / c.CW), 0)));

// ── Stage ───────────────────────────────────────────────────────────────────

/**
 * Night sky (the plate replaces it), then the deck's scrim: midnight from 10%
 * at the top to 85% at the bottom, and a little extra up top for the lockup.
 */
function stage(c: Ctx, o: { dim?: number } = {}) {
  rect(c, "sky", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "@primary", to: MID } });
  rect(c, "scrim", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "#071A4A1A", to: "#071A4AD9" } });
  rect(c, "scrim-top", { x: 0, y: 0, w: c.W, h: c.T + 260 }, { gradient: { from: "#071A4A99", to: CLEAR } });
  if (o.dim) rect(c, "scrim-dim", { x: 0, y: 0, w: c.W, h: c.H }, { fill: MID, opacity: o.dim });
  flares(c);
}

/** A few floodlight sparkles near the top corners (deck: "flares and glitter, never flat colour"). */
function flares(c: Ctx, t: Timing = {}) {
  const spots: Array<[number, number, number, number]> = [
    [0.86, 0.05, 14, 0.55], [0.93, 0.12, 6, 0.5], [0.7, 0.09, 5, 0.4], [0.08, 0.16, 8, 0.4], [0.18, 0.07, 5, 0.35],
  ];
  spots.forEach(([fx, fy, d, o], i) =>
    ellipse(c, `flare-${i + 1}`, { x: Math.round(c.W * fx), y: Math.round(c.T * 0.4 + c.H * fy * 0.6), w: d, h: d }, { fill: WHITE, opacity: o, mirror: false, ...t }));
}

/** Crest + academy name, left-aligned at the top. Returns the y under it. */
function lockup(c: Ctx, k: Content, t: Timing = {}, size = c.pick(116, 100, 116)): number {
  crest(c, "crest", { x: c.M, y: c.T, w: size, h: size }, t);
  // Not uppercased: the name keeps its small i ("SPORTS iN SOUQAR") as the academy writes it.
  tx(c, "academy", k.academy, { x: c.M + size + 24, y: c.T + size / 2 - 26, w: c.CW - size - 24, h: 52 }, { size: c.pick(36, 32, 38), font: "display", weight: 800, color: WHITE, fit: true, arScale: 1, ...t });
  return c.T + size;
}

/** The one big photo, in a silver frame, fading to midnight at its foot. */
function card(c: Ctx, b: Box, o: { path?: string; id?: string; radius?: number } = {}) {
  if (b.h < 180) return;
  const id = o.id ?? "photo";
  const radius = o.radius ?? 28;
  media(c, id, b, { name: "Photo", path: o.path, radius });
  rect(c, `${id}-shade`, { x: b.x, y: b.y + Math.round(b.h * 0.5), w: b.w, h: b.h - Math.round(b.h * 0.5) }, { gradient: { from: CLEAR, to: "#071A4AA6" }, radius });
  rect(c, `${id}-frame`, b, { stroke: { color: SILVER, width: 3 }, radius });
}

// ── Pills and badges ────────────────────────────────────────────────────────

/** Typical lengths of the bound values, so pills can be sized to their words. */
const TYPICAL: Record<string, number> = { date: 10, time: 7, place: 18, squad: 4, competition: 22, days: 9, ages: 9, starts: 10, hours: 14, teams: 8, phone: 13, minute: 2, headline: 22, question: 26, month: 9, name: 14, club: 14 };
/** Arabic dates and times run longer ("السبت 7 تشرين الثاني", "5:00 المسا"). */
const TYPICAL_AR: Record<string, number> = { date: 19, time: 10, squad: 6, days: 13, starts: 18 };
const guessLen = (v: string, ar = false) =>
  v.replace(/\{\{([^}]+)\}\}/g, (_, p: string) => {
    const key = p.split(".").pop() ?? "";
    return "x".repeat((ar ? TYPICAL_AR[key] : undefined) ?? TYPICAL[key] ?? 12);
  }).length;

/**
 * The clean white info pills along the bottom, each sized to its words and
 * left-aligned, squeezed to the content width when they would overflow.
 */
function pills(c: Ctx, list: Array<[string, string]>, y: number, t: Timing = {}) {
  const items = list.filter(([, v]) => v.trim());
  if (!items.length) return;
  const h = pillH(c);
  const size = Math.round(h * 0.42);
  const pad = Math.round(h * 0.42);
  const gap = 12;
  const natural = items.map(([, v]) => Math.min(Math.max(guessLen(v, c.ar), 3), 26) * size * (c.ar ? 0.6 : 0.68) + pad * 2);
  const sum = natural.reduce((a, b) => a + b, 0);
  const squeeze = sum + gap * (items.length - 1) > c.CW ? (c.CW - gap * (items.length - 1)) / sum : 1;
  let x = c.M;
  items.forEach(([id, v], i) => {
    const w = natural[i] * squeeze;
    rect(c, `${id}-bg`, { x, y, w, h }, { fill: WHITE, radius: h / 2, ...t });
    tx(c, id, v, { x: x + pad * 0.6, y: y + h * 0.14, w: w - pad * 1.2, h: h * 0.72 }, { size, font: "body", weight: 700, color: MID, upper: true, align: "center", lh: 1.1, fit: true, arScale: 1.05, ...t });
    x += w + gap;
  });
}
const pillH = (c: Ctx) => c.pick(66, 58, 74);
const numbered = (values: string[], from = 1): Array<[string, string]> => values.map((v, i) => [`pill-${i + from}`, v]);

/** Floodlight LIVE tag with a midnight dot. Returns its height. */
function liveTag(c: Ctx, id: string, value: string, y: number, t: Timing = {}) {
  const h = 58;
  const w = Math.min(c.CW, 74 + Math.max(4, guessLen(value)) * 21);
  rect(c, `${id}-bg`, { x: c.M, y, w, h }, { fill: "@accent", radius: h / 2, ...t });
  ellipse(c, `${id}-dot`, { x: c.M + 24, y: y + h / 2 - 8, w: 16, h: 16 }, { fill: MID, ...t });
  tx(c, id, value, { x: c.M + 48, y: y + 9, w: w - 66, h: h - 18 }, { size: 28, font: "display", weight: 900, color: MID, upper: true, ls: 3, align: "center", lh: 1.1, fit: true, arScale: 1.1, ...t });
  return h;
}

/** A white call-to-action pill across the content width, with a blue play dot. */
function ctaPill(c: Ctx, value: string, y: number, t: Timing = {}) {
  const h = pillH(c) + 6;
  rect(c, "cta-bg", { x: c.M, y, w: c.CW, h }, { fill: WHITE, radius: h / 2, ...t });
  ellipse(c, "cta-dot", { x: c.M + 14, y: y + 10, w: h - 20, h: h - 20 }, { fill: "@primary", ...t });
  tx(c, "cta", value, { x: c.M + h + 10, y: y + h * 0.2, w: c.CW - 2 * h - 20, h: h * 0.6 }, { size: Math.round(h * 0.44), font: "display", weight: 800, color: MID, upper: true, align: "center", lh: 1.1, fit: true, ...t });
  return h;
}

/** Metallic silver sticker (FREE, NEW, U8–U14): the 3D badge's metal, never lime. */
function sticker(c: Ctx, value: string, x: number, y: number, d: number) {
  ellipse(c, "badge-disc", { x, y, w: d, h: d }, { gradient: { from: WHITE, to: STEEL, angle: 135 }, stroke: { color: WHITE, width: 5 }, rotation: -8 });
  tx(c, "badge", value, { x: x + d * 0.12, y: y + d * 0.3, w: d * 0.76, h: d * 0.4 }, { size: Math.round(d * 0.28), font: "display", weight: 900, color: MID, upper: true, align: "center", fit: true, rotation: -8 });
}

/**
 * The score bug: a midnight pill with a silver edge, the two names either side
 * of the score in a Floodlight box. In Arabic the own side is on the right, so
 * the own score is written on the right too.
 */
function bug(c: Ctx, s: NonNullable<Content["score"]>, y: number, h: number, t: Timing = {}) {
  rect(c, "bug-bg", { x: c.M, y, w: c.CW, h }, { fill: "#071A4AEB", stroke: { color: SILVER, width: 2 }, radius: h / 2, ...t });
  const sw = Math.round(h * 2.2);
  const side = (c.CW - sw) / 2 - 48;
  const nameBox = (x: number): Box => ({ x, y: y + h * 0.26, w: side, h: h * 0.48 });
  tx(c, "own", s.ownName, nameBox(c.M + 36), { size: Math.round(h * 0.3), font: "display", weight: 800, color: WHITE, upper: true, fit: true, ...t });
  rect(c, "score-bg", { x: c.W / 2 - sw / 2, y: y + 10, w: sw, h: h - 20 }, { fill: "@accent", radius: 18, mirror: false, ...t });
  tx(c, "score", c.ar ? `${s.opp}–${s.own}` : `${s.own}–${s.opp}`, { x: c.W / 2 - sw / 2 + 12, y: y + h * 0.16, w: sw - 24, h: h * 0.68 }, { size: Math.round(h * 0.56), font: "display", weight: 900, color: MID, align: "center", num: true, fit: true, mirror: false, ...t });
  tx(c, "opp", s.oppName, nameBox(c.W - c.M - 36 - side), { size: Math.round(h * 0.3), font: "display", weight: 800, color: WHITE, upper: true, align: "end", fit: true, ...t });
}

/** The photo between the lockup and the info block, if there is room. */
function photoBetween(c: Ctx, top: number, bottom: number) {
  card(c, { x: c.M, y: top + c.pick(36, 28, 44), w: c.CW, h: bottom - top - c.pick(36, 28, 44) });
}

// ── Score: full time, half time, live score, goal flash ─────────────────────

const score: StyleKit["score"] = (c, k) => {
  stage(c);
  const s = k.score!;
  const top = lockup(c, k);
  const live = LIVE.has(k.key) && has(k.badge);
  let items: StackItem[];
  if (k.key === "goalflash") {
    const gs = c.pick(150, 116, 170);
    items = [
      live && { h: 58, gap: 18, draw: (y) => liveTag(c, "live", k.badge!, y) },
      { h: Math.round(gs * 0.98), gap: 4, draw: (y) => big(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: Math.round(gs * 0.98) }, gs) },
      has(k.sub) && { h: c.pick(78, 64, 88), gap: 26, draw: (y) => big(c, "scorers", k.sub!, { x: c.M, y, w: c.CW, h: c.pick(78, 64, 88) }, c.pick(70, 58, 80), { color: WHITE, shadow: DEEP }) },
      { h: c.pick(112, 98, 124), gap: 20, draw: (y) => bug(c, s, y, c.pick(112, 98, 124)) },
      k.meta.length > 0 && { h: pillH(c), draw: (y) => pills(c, numbered(k.meta), y) },
    ];
  } else {
    const ks = c.pick(92, 74, 104);
    const ss = c.pick(290, 220, 330);
    const ns = c.pick(50, 42, 56);
    items = [
      live && { h: 58, gap: 18, draw: (y) => liveTag(c, "live", k.badge!, y) },
      { h: Math.round(ks * 1.02), gap: 12, draw: (y) => big(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: Math.round(ks * 1.02) }, ks) },
      { h: Math.round(ns * 1.15), gap: 0, draw: (y) => big(c, "own", s.ownName, { x: c.M, y, w: c.CW, h: Math.round(ns * 1.15) }, ns, { shadow: DEEP }) },
      { h: Math.round(ss * 0.9), gap: 0, draw: (y) => big(c, "score", `${s.own}–${s.opp}`, { x: c.M - 6, y, w: c.CW + 6, h: Math.round(ss * 0.9) }, ss, { color: "@accent", num: true, shadow: DEEP, lh: 0.9 }) },
      { h: Math.round(ns * 1.15), gap: 18, draw: (y) => big(c, "opp", s.oppName, { x: c.M, y, w: c.CW, h: Math.round(ns * 1.15) }, ns, { color: SILVER, shadow: DEEP }) },
      has(k.sub) && { h: 44, gap: 24, draw: (y) => tx(c, "scorers", k.sub!, { x: c.M, y, w: c.CW, h: 44 }, { size: c.pick(34, 30, 38), font: "display", weight: 800, color: SOFT, upper: true, fit: true }) },
      k.meta.length > 0 && { h: pillH(c), draw: (y) => pills(c, numbered(k.meta), y) },
    ];
  }
  const y = c.B - stackHeight(items);
  photoBetween(c, top, y - c.pick(36, 26, 44));
  stackDown(y, items);
};

// ── Fixture: matchday, through to the next round, kick-off ──────────────────

const fixture: StyleKit["fixture"] = (c, k) => {
  stage(c);
  const v = k.vs!;
  const top = lockup(c, k);
  const kick = k.key === "kickoff";
  const head = k.headline ?? k.kicker;
  const tag = k.headline ? k.kicker : (k.meta[0] ?? "");
  const hs = c.pick(128, 100, 146);
  const ts = c.pick(76, 60, 86);
  // Squad first, as the deck's pills read: age group · date · time · pitch.
  const info: Array<[string, string]> = kick
    ? [["pill-2", k.pills[1] ?? ""], ["squad", k.meta[1] ?? ""]]
    : [["squad", k.meta[1] ?? ""], ...numbered(k.pills)];
  const bh = c.pick(150, 128, 166);
  const items: StackItem[] = [
    kick && has(k.pills[0]) && { h: 58, gap: 18, draw: (y) => liveTag(c, "pill-1", k.pills[0], y) },
    has(tag) && { h: 42, gap: 8, draw: (y) => kicker(c, "kicker", tag, c.M, y, c.CW) },
    { h: Math.round(hs * 1.0), gap: kick ? 22 : 14, draw: (y) => big(c, "headline", head, { x: c.M, y, w: c.CW, h: Math.round(hs * 1.0) }, hs) },
    kick
      ? { h: bh, gap: 22, draw: (y) => {
        // The deck's kick-off box: midnight glass with a silver edge, the two sides and a silver "vs".
        rect(c, "vs-bg", { x: c.M, y, w: c.CW, h: bh }, { fill: GLASS, stroke: { color: SILVER, width: 2 }, radius: 24 });
        const d = Math.round(bh * 0.5);
        const side = (c.CW - d) / 2 - 56;
        big(c, "own", v.ownName, { x: c.M + 32, y: y + bh * 0.25, w: side, h: bh * 0.5 }, c.pick(46, 40, 50));
        ellipse(c, "vs-disc", { x: c.W / 2 - d / 2, y: y + bh / 2 - d / 2, w: d, h: d }, { gradient: { from: WHITE, to: STEEL, angle: 135 }, mirror: false });
        tx(c, "vs", v.label, { x: c.W / 2 - d / 2 + 8, y: y + bh / 2 - d * 0.3, w: d - 16, h: d * 0.6 }, { size: Math.round(d * 0.4), font: "display", weight: 900, color: MID, upper: true, align: "center", fit: true, mirror: false });
        big(c, "opp", v.oppName, { x: c.W - c.M - 32 - side, y: y + bh * 0.25, w: side, h: bh * 0.5 }, c.pick(46, 40, 50), { align: "end" });
      } }
      : { h: ts * 2 + 46, gap: 26, draw: (y) => {
        big(c, "own", v.ownName, { x: c.M, y, w: c.CW, h: ts }, ts, { shadow: DEEP });
        rule(c, "vs-rule", c.M, y + ts + 22, 56, SILVER, 3);
        tx(c, "vs", v.label, { x: c.M + 72, y: y + ts + 4, w: 200, h: 38 }, { size: 30, font: "display", weight: 900, color: SILVER, upper: true, ls: 3 });
        big(c, "opp", v.oppName, { x: c.M, y: y + ts + 46, w: c.CW, h: ts }, ts, { shadow: DEEP });
      } },
    { h: pillH(c), gap: 16, draw: (y) => pills(c, info, y) },
    has(k.cta) && { h: pillH(c) + 6, draw: (y) => ctaPill(c, k.cta!, y) },
  ];
  const y = c.B - stackHeight(items);
  photoBetween(c, top, y - c.pick(36, 26, 44));
  stackDown(y, items);
};

// ── Hero: player of the match / month, birthday, welcome, champions, coach ──

const hero: StyleKit["hero"] = (c, k) => {
  stage(c);
  const { head, tag } = heroWords(k);
  const top = lockup(c, k);
  const num = has(k.number);
  const ns = c.pick(300, 220, 350);
  const hs = c.pick(100, 80, 112);
  const info: Array<[string, string]> = numbered([...(k.stat ? [`${k.stat.value} ${k.stat.label}`] : []), ...k.meta].slice(0, 2));
  const items: StackItem[] = [
    has(tag) && tag !== head && { h: 42, gap: 12, draw: (y) => kicker(c, "kicker", tag, c.M, y, c.CW) },
    { h: Math.round(hs * 1.0 * linesFor(c, head, hs)), gap: 14, draw: (y) => big(c, "headline", head, { x: c.M, y, w: c.CW, h: Math.round(hs * 1.0 * linesFor(c, head, hs)) }, hs) },
    has(k.name) && { h: 56, gap: 12, draw: (y) => tx(c, "name", k.name!, { x: c.M, y, w: c.CW, h: 56 }, { size: c.pick(46, 40, 50), font: "display", weight: 800, color: SILVER, upper: true, fit: true }) },
    has(k.sub) && { h: 84, gap: 16, draw: (y) => tx(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: 84 }, { size: c.pick(32, 28, 34), font: "body", weight: 600, color: SOFT, lh: 1.25, fit: true }) },
    info.length > 0 && { h: pillH(c), draw: (y) => pills(c, info, y) },
  ];
  const y = c.B - stackHeight(items);
  // The shirt number overlaps the photo's foot, as big as the page allows.
  const under = num ? Math.round(ns * 0.18) : 0;
  const cardBottom = y - under - c.pick(30, 22, 40);
  photoBetween(c, top, cardBottom);
  if (num) {
    big(c, "number", `#${k.number}`, { x: c.M + 8, y: cardBottom - ns + under + 4, w: c.CW - 16, h: ns }, ns, { num: true, stroke: { color: SILVER, width: 3 }, lh: 0.9 });
  }
  stackDown(y, items);
};

// ── List: line-up, call-up, table, prices, match stats ──────────────────────

/** Line-up photo tiles: midnight glass in a silver frame, the figure over a glowing number, a white name bar. */
const TILE: TileLook = {
  backdrop: (c, id, b) => {
    rect(c, id, b, { fill: GLASS, radius: 18, stroke: { color: SILVER, width: 2 } });
    ellipse(c, `${id}-glow`, { x: b.x + b.w * 0.12, y: b.y + b.h * 0.1, w: b.w * 0.76, h: b.h * 0.62 }, { fill: "@primary", opacity: 0.42 });
  },
  bar: (c, id, b) => rect(c, id, b, { fill: WHITE, radius: 12 }),
  num: { font: "display", color: WHITE, weight: 900, shadow: GLOW },
  name: { font: "display", color: MID, weight: 900 },
  pos: { font: "display", color: "@primary", weight: 800 },
  shadow: MID,
  cardRadius: 14,
  text: tx,
};

const list: StyleKit["list"] = (c, k) => {
  stage(c, { dim: 0.25 });
  const top = lockup(c, k, {}, c.pick(100, 88, 108));
  const rows = k.rows ?? [];
  kicker(c, "kicker", k.kicker, c.M, top + c.pick(40, 28, 52), c.CW);
  const hs = c.pick(76, 62, 88);
  const hy = top + c.pick(88, 72, 102);
  big(c, "headline", k.headline ?? "", { x: c.M, y: hy, w: c.CW, h: Math.round(hs * 1.1) }, hs);
  const bodyTop = hy + Math.round(hs * 1.1) + c.pick(34, 24, 44);
  const footItems: StackItem[] = [
    ...k.meta.map((m, i) => ({ h: 36, gap: i === k.meta.length - 1 ? 22 : 6, draw: (y: number) => tx(c, `meta-${i + 1}`, m, { x: c.M, y, w: c.CW, h: 36 }, { size: c.pick(28, 25, 30), font: "display", weight: 800, color: SILVER, upper: true, lh: 1.1, fit: true, arScale: 1.05 }) })),
    k.cta && { h: pillH(c) + 6, draw: (y: number) => ctaPill(c, k.cta!, y) },
  ];
  const foot = stackHeight(footItems);
  const bodyBottom = c.B - foot - c.pick(30, 22, 40);
  stackDown(c.B - foot, footItems);

  if (k.key === "lineup" || k.key === "callup") return rowsOrTiles(c, k, { x: c.M, y: bodyTop, w: c.CW, h: bodyBottom - bodyTop }, TILE, () => tiles(c, rows, bodyTop, bodyBottom));
  if (k.key === "matchstats") return statRows(c, k, rows, bodyTop, bodyBottom);
  const lead = k.key === "standings";
  const boxes = rowBoxes(rows.length, bodyTop, bodyBottom, c.M, c.CW, { gap: 12, maxH: lead ? c.pick(118, 96, 136) : c.pick(156, 118, 180), minH: 60 });
  // Whatever height is left over goes half above, half below, so the table sits in the middle.
  const spare = boxes.length ? Math.max(0, Math.round((bodyBottom - (boxes[boxes.length - 1].y + boxes[boxes.length - 1].h)) / 2)) : 0;
  boxes.map((b) => ({ ...b, y: b.y + spare })).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    const first = i === 0;
    rect(c, `${id}-bg`, b, { fill: first ? WHITE : GLASS, radius: 18, ...(first ? {} : { stroke: { color: HAIR, width: 2 } }) });
    const lw = lead ? Math.round(b.h * 1.05) : Math.round(b.w * 0.34);
    rect(c, `${id}-lead-bg`, { x: b.x + 8, y: b.y + 8, w: lw - 16, h: b.h - 16 }, { fill: first ? "@primary" : "#F3F6FF14", radius: 12 });
    tx(c, `${id}-lead`, row[0], { x: b.x + 18, y: b.y + b.h * 0.22, w: lw - 36, h: b.h * 0.56 }, { size: Math.round(b.h * (lead ? 0.46 : 0.3)), font: "display", weight: 900, color: WHITE, upper: true, align: "center", num: lead, fit: true });
    tx(c, `${id}-main`, row[1], { x: b.x + lw + 20, y: b.y + b.h * 0.24, w: b.w - lw - 20 - 200, h: b.h * 0.52 }, { size: Math.round(b.h * (lead ? 0.36 : 0.26)), font: lead ? "display" : "body", weight: lead ? 800 : 600, color: first ? MID : WHITE, upper: lead, fit: true });
    tx(c, `${id}-trail`, row[2], { x: b.x + b.w - 196, y: b.y + b.h * 0.22, w: 172, h: b.h * 0.56 }, { size: Math.round(b.h * 0.4), font: "display", weight: 900, color: first ? "@primary" : WHITE, upper: true, align: "end", fit: true });
  });
};

/**
 * The deck's line-up: shirt-number tiles, three across, midnight glass with a
 * silver edge. Position on top, the number big in the middle, the first name
 * (only with consent; usually empty) at the foot.
 */
function tiles(c: Ctx, rows: Array<[string, string, string]>, top: number, bottom: number) {
  const n = rows.length;
  const cols = 3;
  const lines = Math.ceil(n / cols);
  const gap = c.pick(16, 12, 18);
  const tw = (c.CW - gap * (cols - 1)) / cols;
  const th = Math.min(Math.round(tw * c.pick(0.92, 0.86, 1.12)), Math.floor((bottom - top - gap * (lines - 1)) / lines));
  const y0 = top + Math.max(0, Math.round((bottom - top - (th * lines + gap * (lines - 1))) / 2));
  rows.forEach((row, i) => {
    const line = Math.floor(i / cols);
    const inLine = Math.min(cols, n - line * cols);
    // An unfinished last line sits centred.
    const x = c.M + (c.CW - (inLine * tw + (inLine - 1) * gap)) / 2 + (i % cols) * (tw + gap);
    const y = y0 + line * (th + gap);
    const id = `row-${i + 1}`;
    rect(c, `${id}-bg`, { x, y, w: tw, h: th }, { fill: GLASS, stroke: { color: SILVER, width: 2 }, radius: 18 });
    tx(c, `${id}-trail`, row[2], { x: x + 14, y: y + th * 0.08, w: tw - 28, h: th * 0.17 }, { size: Math.round(th * 0.13), font: "display", weight: 800, color: SILVER, upper: true, ls: 3, align: "center", fit: true, arScale: 1.1 });
    tx(c, `${id}-lead`, row[0], { x: x + 10, y: y + th * 0.25, w: tw - 20, h: th * 0.5 }, { size: Math.round(th * 0.46), font: "display", weight: 900, color: WHITE, align: "center", num: true, fit: true, shadow: GLOW });
    tx(c, `${id}-main`, row[1], { x: x + 14, y: y + th * 0.76, w: tw - 28, h: th * 0.16 }, { size: Math.round(th * 0.12), font: "display", weight: 800, color: WHITE, upper: true, align: "center", fit: true, arScale: 1.1 });
  });
}

/** Match stats: own value | label | their value, on silver hairlines; the names head the columns. */
function statRows(c: Ctx, k: Content, rows: Array<[string, string, string]>, top: number, bottom: number) {
  const head = k.rowsHead;
  let y = top;
  if (head) {
    const hw = (c.CW - 40) / 2;
    tx(c, "head-own", head[0], { x: c.M, y, w: hw, h: 40 }, { size: c.pick(30, 26, 32), font: "display", weight: 800, color: WHITE, upper: true, fit: true });
    tx(c, "head-opp", head[2], { x: c.W - c.M - hw, y, w: hw, h: 40 }, { size: c.pick(30, 26, 32), font: "display", weight: 800, color: SILVER, upper: true, align: "end", fit: true });
    y += 56;
  }
  rowBoxes(rows.length, y, bottom, c.M, c.CW, { gap: 0, maxH: c.pick(132, 112, 168), minH: 60 }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    rule(c, `${id}-rule`, b.x, b.y, b.w, HAIR, 2);
    const vw = Math.round(b.w * 0.28);
    tx(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.14, w: vw, h: b.h * 0.72 }, { size: Math.round(b.h * 0.56), font: "display", weight: 900, color: WHITE, num: true, fit: true, shadow: GLOW });
    tx(c, `${id}-main`, row[1], { x: b.x + vw, y: b.y + b.h * 0.3, w: b.w - 2 * vw, h: b.h * 0.4 }, { size: Math.round(b.h * 0.24), font: "display", weight: 800, color: SILVER, upper: true, ls: 3, align: "center", fit: true, arScale: 1.1 });
    tx(c, `${id}-trail`, row[2], { x: b.x + b.w - vw, y: b.y + b.h * 0.14, w: vw, h: b.h * 0.72 }, { size: Math.round(b.h * 0.56), font: "display", weight: 900, color: SILVER, align: "end", num: true, fit: true });
  });
}

// ── Promo: free trial, new group, tournament, countdown, poll, map, values ──

const promo: StyleKit["promo"] = (c, k) => {
  stage(c);
  const top = lockup(c, k);
  if (k.options) {
    const hs = c.pick(96, 78, 112);
    kicker(c, "kicker", k.kicker, c.M, top + c.pick(40, 28, 52), c.CW);
    const hy = top + c.pick(88, 72, 102);
    big(c, "headline", k.headline ?? "", { x: c.M, y: hy, w: c.CW, h: Math.round(hs * 1.95) }, hs);
    const y = hy + Math.round(hs * 1.95) + c.pick(30, 22, 40);
    const gap = 24;
    const cw = (c.CW - gap) / 2;
    const ch = c.B - 56 - y;
    k.options.forEach((opt, i) => {
      const x = c.M + i * (cw + gap);
      card(c, { x, y, w: cw, h: ch }, { path: `more.${i}`, id: `option-${i + 1}-photo`, radius: 24 });
      const d = 76;
      ellipse(c, `option-${i + 1}-key-bg`, { x: x + 22, y: y + ch - d - 22, w: d, h: d }, { fill: i === 0 ? "@primary" : WHITE, stroke: { color: WHITE, width: 3 } });
      tx(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x + 22, y: y + ch - d - 6, w: d, h: d - 32 }, { size: 40, font: "display", weight: 900, color: i === 0 ? WHITE : MID, align: "center" });
      big(c, `option-${i + 1}`, opt, { x: x + d + 40, y: y + ch - d - 18, w: cw - d - 62, h: d - 8 }, 48);
    });
    tx(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 38, w: c.CW, h: 36 }, { size: 28, font: "display", weight: 800, color: SILVER, upper: true, align: "center", fit: true });
    return;
  }
  const manifesto = k.key === "manifesto";
  const countdown = k.key === "countdown";
  const hs = c.pick(manifesto ? 84 : countdown ? 132 : 112, manifesto ? 68 : countdown ? 104 : 90, manifesto ? 96 : countdown ? 150 : 126);
  const hh = Math.round(hs * (manifesto ? 3.1 : linesFor(c, k.headline ?? "", hs)));
  const items: StackItem[] = [
    has(k.kicker) && { h: 42, gap: 10, draw: (y) => kicker(c, "kicker", k.kicker, c.M, y, c.CW) },
    { h: hh, gap: 14, draw: (y) => big(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: hh }, hs) },
    has(k.sub) && { h: manifesto ? 92 : 48, gap: 22, draw: (y) => tx(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: manifesto ? 92 : 48 }, { size: c.pick(32, 28, 34), font: "body", weight: 600, color: SOFT, lh: 1.25, fit: true }) },
    k.pills.length > 0 && { h: pillH(c), gap: 16, draw: (y) => pills(c, numbered(k.pills), y) },
    has(k.cta) && { h: pillH(c) + 6, draw: (y) => ctaPill(c, k.cta!, y) },
  ];
  const y = c.B - stackHeight(items);
  const pt = top + c.pick(36, 28, 44);
  const pb = { x: c.M, y: pt, w: c.CW, h: y - c.pick(36, 26, 44) - pt };
  card(c, pb);
  if (k.key === "map" && pb.h > 180) pin(c, c.W / 2, pb.y + Math.round(pb.h * 0.45), "@primary", WHITE);
  if (has(k.badge)) {
    const d = c.pick(200, 160, 220);
    sticker(c, k.badge, c.W - c.M - d + 24, Math.max(pt - 24, y - c.pick(36, 26, 44) - d + 40), d);
  }
  stackDown(y, items);
};

// ── Video ───────────────────────────────────────────────────────────────────

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: c.T + 300 }, { gradient: { from: "#071A4AD9", to: CLEAR } });
    rect(c, "shade", { x: 0, y: Math.round(c.H * 0.38), w: c.W, h: c.H - Math.round(c.H * 0.38) }, { gradient: { from: CLEAR, to: "#071A4AF2" } });
  },
  frame: (c, k, t) => { lockup(c, k, t, 92); },
  tag: (c, k, t) => {
    // A white info pill: footage is busy, so the tag gets a solid ground (lime stays for LIVE and the score).
    const y = c.B - (k.video?.variant === "talk" ? 500 : k.video?.variant === "goal" ? 232 + c.pick(220, 200, 250) + 64 : 470);
    pills(c, [["kicker", k.kicker]], y, t);
  },
  goal: (c, k, t) => {
    const s = k.score!;
    const ns = c.pick(220, 200, 250);
    big(c, "number", `#${k.number ?? ""}`, { x: c.M, y: c.B - 160 - 72 - ns, w: c.CW, h: ns }, ns, { num: true, stroke: { color: SILVER, width: 3 }, lh: 0.9, ...t });
    tx(c, "name", k.name ?? "", { x: c.M, y: c.B - 160 - 64, w: c.CW, h: 52 }, { size: 44, font: "display", weight: 800, color: SILVER, upper: true, fit: true, ...t });
    bug(c, s, c.B - 140, 110, t);
  },
  speaker: (c, k, t) => {
    const y = c.B - 420;
    rect(c, "speaker-bg", { x: c.M, y, w: c.CW, h: 176 }, { fill: GLASS, stroke: { color: SILVER, width: 2 }, radius: 28, ...t });
    rect(c, "speaker-bar", { x: c.M + 28, y: y + 32, w: 8, h: 112 }, { fill: "@primary", radius: 4, ...t });
    big(c, "speaker", k.headline ?? "", { x: c.M + 60, y: y + 26, w: c.CW - 96, h: 72 }, 60, t);
    tx(c, "role", k.sub ?? "", { x: c.M + 60, y: y + 106, w: c.CW - 96, h: 44 }, { size: 30, font: "display", weight: 800, color: SILVER, upper: true, ls: 3, fit: true, ...t });
  },
  title: (c, k, t) => {
    big(c, "headline", k.headline ?? "", { x: c.M, y: c.B - 410, w: c.CW, h: 260 }, 124, t);
    pills(c, numbered(k.meta), c.B - pillH(c), t);
  },
  caption: (c, id, value, t) => tx(c, id, value, { x: c.M, y: c.B - 230, w: c.CW, h: 170 }, { size: 44, font: "display", weight: 800, color: WHITE, align: "center", lh: 1.15, fit: true, bg: { color: "#071A4AD9", padding: 20, radius: 22 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "@primary", to: MID }, ...t });
    rect(c, "end-glow", { x: 0, y: 0, w: c.W, h: Math.round(c.H * 0.5) }, { gradient: { from: "#F3F6FF33", to: "#F3F6FF00" }, ...t });
    flares(c, t);
    crest(c, "end-crest", { x: c.W / 2 - 150, y: c.H / 2 - 250, w: 300, h: 300 }, t);
    tx(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 90, w: c.CW, h: 90 }, { size: 64, font: "display", weight: 900, color: WHITE, align: "center", fit: true, shadow: GLOW, ...t });
    rule(c, "end-rule", c.W / 2 - 60, c.H / 2 + 200, 120, SILVER, 3, t);
  },
};

export const pack_souqar: StyleKit = { background: MID, plate: { opacity: 1, above: "sky" }, score, fixture, hero, list, promo, skin };
