import type { Content } from "../content";
import { crest, ellipse, media, rect, seam, slant, text, type Box, type Ctx, type TextOpts, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Brand pack "barca" (Barça Academy Jordan, a franchise). From the academy's
 * brand deck: night-navy fields, garnet and blue always paired in diagonal
 * bands with one thin light streak on the seam, heavy gold condensed capitals
 * for headlines, numbers and scores, navy scoreboard cards with a gold rule,
 * rounded garnet / blue pills and a gold call-to-action bar.
 *
 * Garnet is @primary and gold is @accent, so the academy's own Branding wins;
 * the blue (always paired with garnet), navy and off-white are fixed neutrals
 * from the deck. No club marks: the crest slot only.
 */

const NAVY = "#0A1A3F";
const NAVY_CLEAR = "#0A1A3F00";
const PANEL = "#13265A";
const PANEL2 = "#0F2050";
const BLUE = "#004D98";
const CREAM = "#FFF8E7";
const MUTED = "#C8D0E6";
const DIM = "#8F9BBF";
const LINE = "#FFF8E733";

const DISPLAY = "Barlow Condensed";
const BODY = "Barlow";
const ARABIC = "Tajawal";

/** The deck's band angle (its 115° gradients): bands lean right going up. */
const SKEW = 25;

/** text() plus the pack's typeface: Barlow Condensed for display, Barlow for text, Tajawal for Arabic. */
function t(c: Ctx, id: string, value: string, b: Box, o: TextOpts) {
  const layer = text(c, id, value, b, o) as { font?: string; family?: string };
  const f = layer.font ?? "body";
  layer.family = f.startsWith("arabic") ? ARABIC : f === "condensed" || f === "display" ? DISPLAY : BODY;
  return layer;
}

/** Heavy gold capitals: the feed's signature. */
const gold = (c: Ctx, id: string, value: string, b: Box, size: number, o: Partial<TextOpts> = {}) =>
  t(c, id, value, b, { size, font: "condensed", weight: 900, color: "@accent", upper: true, lh: 0.92, fit: true, ...o });

/** Small spaced capitals (meta lines). */
const caps = (c: Ctx, id: string, value: string, b: Box, o: Partial<TextOpts> = {}) =>
  t(c, id, value, b, { size: 28, font: "condensed", weight: 700, color: MUTED, upper: true, ls: 2, fit: true, ...o });

type ShapeO = Parameters<typeof slant>[4] & {};

/**
 * A diagonal band: its left edge at xTop on the top line, leaning by skew
 * (positive = "/", negative = "\"). Bands run off the canvas, so they are bleeds.
 */
function diag(c: Ctx, id: string, xTop: number, bw: number, y: number, h: number, skew: number, o: ShapeO = {}) {
  const dx = Math.tan((Math.abs(skew) * Math.PI) / 180) * h;
  const x = skew >= 0 ? xTop - dx : xTop;
  return slant(c, id, { x, y, w: bw + dx, h }, skew, { name: "bleed", ...o });
}

/** Garnet and blue side by side, with the thin light streak on their seam. */
function bands(c: Ctx, p: string, xTop: number, bw: number, y: number, h: number, skew = SKEW, o: Timing & { opacity?: number } = {}) {
  diag(c, `${p}-garnet`, xTop, bw, y, h, skew, { fill: "@primary", ...o });
  diag(c, `${p}-blue`, xTop + bw, bw, y, h, skew, { fill: BLUE, ...o });
  diag(c, `${p}-streak`, xTop + bw - 3, 6, y, h, skew, { fill: CREAM, ...o, opacity: 0.85 * (o.opacity ?? 1) });
}

/** Full-bleed photo under a navy wash, the bands entering from the top-right, a navy fade under the type. */
function backdrop(c: Ctx, o: { fadeFrom?: number; wash?: number } = {}) {
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo" });
  rect(c, "photo-wash", { x: 0, y: 0, w: c.W, h: c.H }, { fill: NAVY, opacity: o.wash ?? 0.4 });
  const bw = c.pick(200, 180, 210);
  bands(c, "band", c.W - c.pick(250, 230, 250), bw, 0, Math.round(c.H * c.pick(0.82, 0.8, 0.62)));
  rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: c.T + 200 }, { gradient: { from: "#0A1A3FB3", to: NAVY_CLEAR } });
  const from = Math.round(c.H * (o.fadeFrom ?? 0.3));
  rect(c, "shade", { x: 0, y: from, w: c.W, h: c.H - from }, { gradient: { from: NAVY_CLEAR, to: NAVY } });
  rect(c, "shade-base", { x: 0, y: Math.round(c.H * 0.72), w: c.W, h: c.H - Math.round(c.H * 0.72) }, { fill: NAVY, opacity: 0.55 });
}

/** A plain navy field over the plate, with the bands cutting the top-right corner. */
function field(c: Ctx) {
  rect(c, "wash", { x: 0, y: 0, w: c.W, h: c.H }, { fill: NAVY, opacity: 0.82 });
  const h = c.pick(420, 380, 560);
  const bw = c.pick(120, 110, 130);
  bands(c, "band", c.W - h * 0.3 - 2 * bw, bw, 0, h, -45);
}

function crestTL(c: Ctx, k: Content, withName = false) {
  crest(c, "crest", { x: c.M, y: c.T, w: 104, h: 104 });
  if (withName) t(c, "academy", k.academy, { x: c.M + 124, y: c.T + 30, w: 560, h: 44 }, { size: 32, font: "condensed", weight: 800, color: CREAM, upper: true, ls: 2, fit: true });
}

/** The deck's top-right chip: navy, gold capitals, a gold rule. */
function chip(c: Ctx, id: string, value: string, w = 300, tm: Timing = {}) {
  const x = c.W - c.M - w;
  rect(c, `${id}-bg`, { x, y: c.T + 14, w, h: 76 }, { fill: NAVY, radius: 8, ...tm });
  rect(c, `${id}-rule`, { x, y: c.T + 86, w, h: 4 }, { fill: "@accent", ...tm });
  t(c, id, value, { x: x + 16, y: c.T + 24, w: w - 32, h: 56 }, { size: 40, font: "condensed", weight: 800, color: "@accent", upper: true, align: "center", fit: true, ...tm });
}

/** Rounded garnet (or blue) pill with off-white capitals. */
function pill(c: Ctx, id: string, value: string, x: number, y: number, w: number, h = 64, fill = "@primary", tm: Timing = {}) {
  rect(c, `${id}-bg`, { x, y, w, h }, { fill, radius: h / 2, ...tm });
  t(c, id, value, { x: x + h * 0.4, y: y + h * 0.12, w: w - h * 0.8, h: h * 0.76 }, { size: Math.round(h * 0.62), font: "condensed", weight: 900, color: CREAM, upper: true, ls: 1, align: "center", fit: true, ...tm });
}

/** Gold call-to-action bar with navy capitals. */
function ctaBar(c: Ctx, value: string, y: number, h = 96, tm: Timing = {}) {
  rect(c, "cta-bg", { x: c.M, y, w: c.CW, h }, { fill: "@accent", radius: 10, ...tm });
  t(c, "cta", value, { x: c.M + 36, y: y + h * 0.16, w: c.CW - 72, h: h * 0.68 }, { size: Math.round(h * 0.48), font: "condensed", weight: 900, color: NAVY, upper: true, ls: 1, align: "center", fit: true, ...tm });
}

/** The sponsor-strip line along the bottom: navy, an off-white hairline, spaced capitals. */
function strip(c: Ctx, id: string, value: string, y: number, h = 72) {
  rect(c, `${id}-strip`, { x: c.M, y, w: c.CW, h }, { fill: NAVY, opacity: 0.88 });
  rect(c, `${id}-strip-rule`, { x: c.M, y, w: c.CW, h: 2 }, { fill: CREAM, opacity: 0.8 });
  caps(c, id, value, { x: c.M + 24, y: y + 14, w: c.CW - 48, h: h - 26 }, { size: 30, color: CREAM, align: "center" });
}

/** In-game score bug: garnet | navy with gold digits | blue, gold rule under. */
function scoreBug(c: Ctx, k: Content, y: number, h: number, tm: Timing = {}) {
  const s = k.score!;
  const mid = Math.round(c.CW * 0.3);
  const side = (c.CW - mid) / 2;
  const x = c.M;
  rect(c, "bug-own-bg", { x, y, w: side, h }, { fill: "@primary", ...tm });
  rect(c, "bug-score-bg", { x: x + side, y, w: mid, h }, { fill: NAVY, ...tm });
  rect(c, "bug-opp-bg", { x: x + side + mid, y, w: side, h }, { fill: BLUE, ...tm });
  rect(c, "bug-rule", { x, y: y + h, w: c.CW, h: 6 }, { fill: "@accent", ...tm });
  const nh = h * 0.5;
  t(c, "own", s.ownName, { x: x + 24, y: y + (h - nh) / 2, w: side - 48, h: nh }, { size: Math.round(h * 0.38), font: "condensed", weight: 800, color: CREAM, upper: true, align: "center", fit: true, ...tm });
  t(c, "opp", s.oppName, { x: x + side + mid + 24, y: y + (h - nh) / 2, w: side - 48, h: nh }, { size: Math.round(h * 0.38), font: "condensed", weight: 800, color: CREAM, upper: true, align: "center", fit: true, ...tm });
  const sw = (mid - 40) / 2;
  const ss = Math.round(h * 0.7);
  gold(c, "bug-own-score", s.own, { x: x + side + 8, y: y + h * 0.1, w: sw, h: h * 0.8 }, ss, { num: true, align: "end", lh: 1, ...tm });
  gold(c, "bug-dash", "–", { x: x + side + 8 + sw, y: y + h * 0.1, w: 24, h: h * 0.8 }, ss, { num: true, align: "center", lh: 1, ...tm });
  gold(c, "bug-opp-score", s.opp, { x: x + side + 32 + sw, y: y + h * 0.1, w: sw, h: h * 0.8 }, ss, { num: true, align: "start", lh: 1, ...tm });
  return y + h + 6;
}

/** Full-time scoreboard card: team names on top, huge gold score, gold rule. */
function scoreCard(c: Ctx, k: Content, y: number, h: number) {
  const s = k.score!;
  rect(c, "card-bg", { x: c.M, y, w: c.CW, h }, { fill: NAVY, opacity: 0.94, radius: 12 });
  rect(c, "card-rule", { x: c.M, y: y + h - 8, w: c.CW, h: 8 }, { fill: "@accent" });
  const pad = 40;
  const half = c.CW / 2 - pad - 20;
  const nameH = c.pick(56, 50, 64);
  t(c, "own", s.ownName, { x: c.M + pad, y: y + 30, w: half, h: nameH }, { size: nameH * 0.8, font: "condensed", weight: 800, color: CREAM, upper: true, fit: true });
  t(c, "opp", s.oppName, { x: c.W / 2 + 20, y: y + 30, w: half, h: nameH }, { size: nameH * 0.8, font: "condensed", weight: 800, color: CREAM, upper: true, align: "end", fit: true });
  rect(c, "own-mark", { x: c.M + pad, y: y + 36 + nameH, w: 96, h: 8 }, { fill: "@primary" });
  rect(c, "opp-mark", { x: c.W - c.M - pad - 96, y: y + 36 + nameH, w: 96, h: 8 }, { fill: BLUE });
  const top = y + 52 + nameH;
  const sh = y + h - 20 - top;
  const ss = Math.round(sh * 1.05);
  const dw = Math.round(ss * 0.4);
  gold(c, "bug-own-score", s.own, { x: c.M + pad, y: top, w: c.CW / 2 - pad - dw / 2, h: sh }, ss, { num: true, align: "end", lh: 1 });
  gold(c, "bug-dash", "–", { x: c.W / 2 - dw / 2, y: top, w: dw, h: sh }, ss, { num: true, align: "center", lh: 1 });
  gold(c, "bug-opp-score", s.opp, { x: c.W / 2 + dw / 2, y: top, w: c.CW / 2 - pad - dw / 2, h: sh }, ss, { num: true, align: "start", lh: 1 });
}

// ── Score: full-time / half-time card, or the in-game goal flash ────────────

const score: StyleKit["score"] = (c, k) => (has(k.badge) ? liveScore(c, k) : fullScore(c, k));

function fullScore(c: Ctx, k: Content) {
  backdrop(c, { fadeFrom: 0.26 });
  crestTL(c, k);
  const two = k.meta.length > 1;
  if (two) chip(c, "header-meta", k.meta[1], c.pick(360, 340, 380));
  const stripH = 72;
  const stripY = c.B - stripH;
  strip(c, "meta", k.meta[0] ?? "", stripY, stripH);
  const ks = c.pick(150, 116, 176);
  const cardH = c.pick(440, 360, 540);
  stackUp(stripY - c.pick(40, 30, 56), [
    { h: Math.round(ks * 0.95), gap: c.pick(28, 20, 36), draw: (y) => gold(c, "kicker", k.kicker, { x: c.M, y, w: c.CW, h: Math.round(ks * 0.95) }, ks, { shadow: { color: "#0A1A3F99", blur: 24, x: 0, y: 6 } }) },
    { h: cardH, gap: 26, draw: (y) => scoreCard(c, k, y, cardH) },
    has(k.sub) && { h: 56, draw: (y) => {
      rect(c, "scorers-mark", { x: c.M, y: y + 10, w: 10, h: 36 }, { fill: "@primary" });
      rect(c, "scorers-mark-2", { x: c.M + 10, y: y + 10, w: 10, h: 36 }, { fill: BLUE });
      t(c, "scorers", k.sub!, { x: c.M + 40, y, w: c.CW - 40, h: 56 }, { size: 44, font: "condensed", weight: 800, color: CREAM, upper: true, fit: true });
    } },
  ]);
}

function liveScore(c: Ctx, k: Content) {
  // The goal flash: the photo split garnet | blue | navy along the band angle.
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo" });
  const split = Math.round(c.W * c.pick(0.66, 0.62, 0.8));
  const bw = c.pick(220, 200, 240);
  diag(c, "split-garnet", -c.W, split + c.W, 0, c.H, SKEW, { fill: "@primary", opacity: 0.78 });
  diag(c, "split-blue", split, bw, 0, c.H, SKEW, { fill: BLUE, opacity: 0.86 });
  diag(c, "split-navy", split + bw, c.W * 2, 0, c.H, SKEW, { fill: NAVY, opacity: 0.82 });
  diag(c, "split-streak", split - 3, 6, 0, c.H, SKEW, { fill: CREAM, opacity: 0.9 });
  const from = Math.round(c.H * 0.5);
  rect(c, "shade", { x: 0, y: from, w: c.W, h: c.H - from }, { gradient: { from: NAVY_CLEAR, to: "#0A1A3FE6" } });
  crestTL(c, k);
  // LIVE pill, top-right, with a light dot.
  const pw = 210;
  const px = c.W - c.M - pw;
  rect(c, "badge-bg", { x: px, y: c.T + 22, w: pw, h: 64 }, { fill: NAVY, radius: 32, stroke: { color: CREAM, width: 3 } });
  ellipse(c, "badge-dot", { x: px + 26, y: c.T + 44, w: 20, h: 20 }, { fill: "@primary", stroke: { color: CREAM, width: 3 } });
  t(c, "badge", k.badge!, { x: px + 58, y: c.T + 32, w: pw - 80, h: 44 }, { size: 38, font: "condensed", weight: 900, color: CREAM, upper: true, ls: 2, align: "center", fit: true });
  const bugH = c.pick(124, 110, 136);
  scoreBug(c, k, c.T + 150, bugH);
  const ks = c.pick(260, 200, 300);
  const subCta = k.key === "livescore";
  stackUp(c.B, [
    { h: Math.round(ks * 0.95), gap: c.pick(26, 18, 34), draw: (y) => gold(c, "kicker", k.kicker, { x: c.M - 6, y, w: c.CW + 6, h: Math.round(ks * 0.95) }, ks, { lh: 0.9, shadow: { color: "#0A1A3FB3", blur: 30, x: 0, y: 8 } }) },
    has(k.sub) && !subCta && { h: 104, gap: 24, draw: (y) => {
      rect(c, "scorers-bg", { x: c.M, y, w: 560, h: 104 }, { fill: NAVY, radius: 52, stroke: { color: "@accent", width: 5 } });
      t(c, "scorers", k.sub!, { x: c.M + 40, y: y + 16, w: 480, h: 72 }, { size: 64, font: "condensed", weight: 900, color: "@accent", upper: true, align: "center", fit: true });
    } },
    has(k.sub) && subCta && { h: 96, gap: 24, draw: (y) => ctaBar(c, k.sub!, y) },
    ...k.meta.map((m, i) => ({ h: 40, gap: 6, draw: (y: number) => caps(c, `meta-${i + 1}`, m, { x: c.M, y, w: c.CW, h: 40 }, { color: CREAM }) })),
  ]);
}

// ── Fixture: the poster a week out, kick-off, next round ────────────────────

const fixture: StyleKit["fixture"] = (c, k) => {
  backdrop(c, { fadeFrom: 0.24 });
  crestTL(c, k);
  const v = k.vs!;
  const chipText = k.meta[1] ?? "";
  if (has(chipText)) chip(c, "header-meta", chipText, 220);
  const head = k.headline ?? k.kicker;
  const hs = c.pick(220, 170, 250);
  const ns = c.pick(64, 54, 72);
  const os = c.pick(104, 84, 116);
  const pills = k.pills.slice(0, 3);
  const cardH = c.pick(132, 116, 148);
  stackUp(c.B, [
    k.headline && { h: 64, gap: 20, draw: (y) => pill(c, "kicker", k.kicker, c.M, y, 400) },
    { h: Math.round(hs * 0.92), gap: c.pick(30, 20, 40), draw: (y) => gold(c, "headline", head, { x: c.M - 4, y, w: c.CW + 4, h: Math.round(hs * 0.92) }, hs, { shadow: { color: "#0A1A3F99", blur: 24, x: 0, y: 6 } }) },
    { h: ns, gap: 6, draw: (y) => t(c, "own", v.ownName, { x: c.M, y, w: c.CW, h: ns }, { size: ns * 0.9, font: "condensed", weight: 800, color: CREAM, upper: true, fit: true }) },
    { h: os, gap: c.pick(36, 26, 44), draw: (y) => {
      gold(c, "vs", v.label, { x: c.M, y: y + os * 0.12, w: 120, h: os * 0.8 }, Math.round(os * 0.66), { lh: 1 });
      t(c, "opp", v.oppName, { x: c.M + 132, y, w: c.CW - 132, h: os }, { size: os * 0.9, font: "condensed", weight: 900, color: CREAM, upper: true, lh: 1, fit: true });
    } },
    pills.length > 0 && { h: cardH, gap: 22, draw: (y) => infoCard(c, pills, y, cardH) },
    has(k.meta[0]) && { h: 40, gap: k.cta ? 26 : 0, draw: (y) => caps(c, "meta", k.meta[0], { x: c.M, y, w: c.CW, h: 40 }, { ls: 3 }) },
    k.cta && { h: 96, draw: (y) => ctaBar(c, k.cta!, y) },
  ]);
};

/** Navy info card with a gold top rule: day / time / place in cells. */
function infoCard(c: Ctx, pills: string[], y: number, h: number) {
  rect(c, "info-bg", { x: c.M, y, w: c.CW, h }, { fill: NAVY, opacity: 0.94, radius: 8 });
  rect(c, "info-rule", { x: c.M, y, w: c.CW, h: 6 }, { fill: "@accent" });
  const weights = pills.length === 3 ? [0.3, 0.24, 0.46] : pills.length === 2 ? [0.4, 0.6] : [1];
  let x = c.M;
  pills.forEach((p, i) => {
    const w = c.CW * weights[i];
    if (i > 0) rect(c, `pill-rule-${i}`, { x: x - 1, y: y + 30, w: 2, h: h - 48 }, { fill: LINE });
    t(c, `pill-${i + 1}`, p, { x: x + 28, y: y + 26, w: w - 52, h: h - 40 }, { size: Math.round(h * 0.36), font: "condensed", weight: i < 2 ? 900 : 700, color: i < 2 ? "@accent" : CREAM, upper: true, fit: true, lh: 1 });
    x += w;
  });
}

// ── Hero: player spotlight (number-led), champions, coach ───────────────────

const hero: StyleKit["hero"] = (c, k) => {
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo" });
  rect(c, "photo-wash", { x: 0, y: 0, w: c.W, h: c.H }, { fill: NAVY, opacity: 0.22 });
  // The navy split down from the top-left, the bands along its edge.
  const edge = Math.round(c.W * c.pick(0.7, 0.7, 0.74));
  const skew = c.pick(22, 26, 18);
  const slope = Math.tan((skew * Math.PI) / 180);
  diag(c, "split", -c.W, edge + c.W, 0, c.H, skew, { fill: NAVY, opacity: 0.86 });
  const bw = c.pick(64, 58, 70);
  bands(c, "band", edge, bw, 0, c.H, skew);
  const from = Math.round(c.H * 0.5);
  rect(c, "shade", { x: 0, y: from, w: c.W, h: c.H - from }, { gradient: { from: NAVY_CLEAR, to: NAVY } });
  crestTL(c, k);
  const { head, tag } = heroWords(k);
  if (k.stat) {
    const sw = c.pick(250, 230, 260);
    const sx = c.W - c.M - sw;
    const sh = c.pick(210, 190, 220);
    rect(c, "stat-bg", { x: sx, y: c.T, w: sw, h: sh }, { fill: NAVY, opacity: 0.94, radius: 10 });
    rect(c, "stat-rule", { x: sx, y: c.T + sh - 6, w: sw, h: 6 }, { fill: "@accent" });
    gold(c, "stat", k.stat.value, { x: sx, y: c.T + 14, w: sw, h: sh * 0.62 }, Math.round(sh * 0.6), { num: true, align: "center", lh: 1 });
    t(c, "stat-label", k.stat.label, { x: sx + 14, y: c.T + sh * 0.68, w: sw - 28, h: sh * 0.22 }, { size: 30, font: "condensed", weight: 800, color: CREAM, upper: true, align: "center", fit: true });
  }
  const showTag = has(tag) && tag !== head;
  if (has(k.number)) {
    // Words stacked in the navy column, the shirt number under them, the rest at the foot.
    const hs = c.pick(112, 92, 128);
    const nsz = c.pick(330, 230, 400);
    const top = c.T + c.pick(150, 136, 176);
    // The headline column ends where the navy split does at the headline's foot.
    const colW = Math.round(edge - slope * (top + (showTag ? 82 : 0) + hs * 2.85) - c.M - 28);
    stackDown(top, [
      showTag && { h: 60, gap: 22, draw: (y) => pill(c, "kicker", tag, c.M, y, Math.min(colW, 440), 60) },
      { h: Math.round(hs * 0.95 * 3), gap: c.pick(10, 4, 24), draw: (y) => gold(c, "headline", head, { x: c.M, y, w: colW, h: Math.round(hs * 0.95 * 3) }, hs) },
      { h: Math.round(nsz * 0.92), draw: (y) => {
        gold(c, "number", k.number!, { x: c.M - 8, y, w: colW, h: Math.round(nsz * 0.92) }, nsz, { num: true, lh: 0.9, shadow: { color: "#0A1A3FB3", blur: 30, x: 0, y: 8 } });
      } },
    ]);
    stackUp(c.B, [
      has(k.name) && { h: 64, gap: 12, draw: (y) => t(c, "name", k.name!, { x: c.M, y, w: c.CW, h: 64 }, { size: 56, font: "condensed", weight: 800, color: CREAM, upper: true, fit: true }) },
      has(k.sub) && { h: 84, gap: 16, draw: (y) => t(c, "sub", k.sub!, { x: c.M, y, w: c.pick(820, 820, 880), h: 84 }, { size: 34, font: "body", weight: 500, color: CREAM, lh: 1.25, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 38, gap: 6, draw: (y: number) => metaRow(c, i, m, y) })),
    ]);
  } else {
    const hs = c.pick(170, 136, 196);
    stackUp(c.B, [
      showTag && { h: 60, gap: 24, draw: (y) => pill(c, "kicker", tag, c.M, y, 460, 60) },
      { h: Math.round(hs * 0.95 * 2), gap: 22, draw: (y) => gold(c, "headline", head, { x: c.M - 4, y, w: c.CW + 4, h: Math.round(hs * 0.95 * 2) }, hs, { shadow: { color: "#0A1A3F99", blur: 24, x: 0, y: 6 } }) },
      has(k.sub) && { h: 92, gap: 20, draw: (y) => t(c, "sub", k.sub!, { x: c.M, y, w: 860, h: 92 }, { size: 36, font: "body", weight: 500, color: CREAM, lh: 1.25, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 38, gap: 6, draw: (y: number) => metaRow(c, i, m, y) })),
    ]);
  }
};

/** A meta line led by a short garnet / blue tick. */
function metaRow(c: Ctx, i: number, value: string, y: number) {
  rect(c, `meta-${i + 1}-mark`, { x: c.M, y: y + 9, w: 8, h: 20 }, { fill: i % 2 ? BLUE : "@primary" });
  caps(c, `meta-${i + 1}`, value, { x: c.M + 24, y, w: c.CW - 24, h: 38 }, { color: i === 0 ? CREAM : MUTED });
}

// ── List: line-up / call-up, table, match stats, prices ─────────────────────

/** Line-up photo tiles: the figure over a garnet and blue band on navy, a gold number, a navy bar with a gold rule. */
const TILE: TileLook = {
  backdrop: (c, id, b) => {
    rect(c, id, b, { fill: PANEL, radius: 6 });
    const bw = b.w * 0.3;
    slant(c, `${id}-garnet`, { x: b.x + b.w * 0.2, y: b.y, w: bw, h: b.h }, 12, { fill: "@primary" });
    slant(c, `${id}-blue`, { x: b.x + b.w * 0.2 + bw - 2, y: b.y, w: bw, h: b.h }, 12, { fill: BLUE });
    slant(c, `${id}-streak`, { x: b.x + b.w * 0.2 + bw - 4, y: b.y, w: 6, h: b.h }, 12, { fill: CREAM, opacity: 0.85 });
  },
  bar: (c, id, b) => {
    rect(c, id, b, { fill: NAVY, radius: 6 });
    rect(c, `${id}-rule`, { x: b.x, y: b.y, w: b.w, h: 4 }, { fill: "@accent" });
  },
  num: { font: "condensed", color: "@accent", weight: 900 },
  name: { font: "condensed", color: CREAM, weight: 800 },
  pos: { font: "condensed", color: "@accent", weight: 800 },
  shadow: NAVY,
  cardRadius: 6,
  text: t,
};

const list: StyleKit["list"] = (c, k) => {
  field(c);
  crestTL(c, k, true);
  let y = c.T + c.pick(148, 132, 168);
  pill(c, "kicker", k.kicker, c.M, y, 420, 60);
  y += 60 + c.pick(18, 14, 24);
  const hs = c.pick(96, 80, 112);
  gold(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: Math.round(hs * 0.95) }, hs);
  y += Math.round(hs * 0.95) + c.pick(30, 22, 40);
  const foot: StackItem[] = [
    ...k.meta.map((m, i) => ({ h: 36, gap: 8, draw: (yy: number) => caps(c, `meta-${i + 1}`, m, { x: c.M, y: yy, w: c.CW, h: 36 }, { ls: 3, color: i === 0 ? CREAM : MUTED }) })),
    k.cta && { h: 88, draw: (yy: number) => ctaBar(c, k.cta!, yy, 88) },
  ];
  const footH = stackHeight(foot) + c.pick(30, 22, 40);
  if (k.key === "matchstats") statsTable(c, k, y, c.B - footH);
  else table(c, k, y, c.B - footH);
  stackUp(c.B, foot);
};

/**
 * Line-up and call-up: the deck's grid of shirt-number tiles, two columns,
 * garnet and blue in turn, the position in gold beside each and the first
 * name after it only when the academy allows names. No row panels, just a
 * hairline, so a numbers-only sheet reads as finished.
 */
function playerGrid(c: Ctx, k: Content, top: number, bottom: number) {
  const rows = k.rows ?? [];
  const head = k.rowsHead;
  const headH = head ? 44 : 0;
  const raw = rowBoxes(rows.length, top + headH, bottom, c.M, c.CW, { gap: c.pick(14, 10, 18), maxH: c.pick(140, 108, 170), minH: 9999, colGap: 40 });
  // Rows are capped in height: centre the grid in the space left, header and all.
  const gridBottom = Math.max(top + headH, ...raw.map((b) => b.y + b.h));
  const shift = Math.max(0, Math.round((bottom - gridBottom) / 2));
  const boxes = raw.map((b) => ({ ...b, y: b.y + shift }));
  top += shift;
  const tw = (b: Box) => Math.round(b.h * 1.08);
  if (head && boxes.length) {
    const cols = [...new Set(boxes.map((b) => b.x))];
    cols.forEach((x, ci) => {
      const b = boxes.find((bb) => bb.x === x)!;
      const sfx = ci ? `-${ci + 1}` : "";
      caps(c, `head-lead${sfx}`, head[0], { x, y: top, w: tw(b), h: 30 }, { size: 24, color: DIM, align: "center" });
      caps(c, `head-trail${sfx}`, head[2], { x: x + tw(b) + 22, y: top, w: 110, h: 30 }, { size: 24, color: DIM });
      caps(c, `head-main${sfx}`, head[1], { x: x + tw(b) + 140, y: top, w: b.w - tw(b) - 140, h: 30 }, { size: 24, color: DIM });
    });
  }
  boxes.forEach((b, i) => {
    const row = rows[i];
    const id = `row-${i + 1}`;
    const w = tw(b);
    rect(c, `${id}-bg`, { x: b.x, y: b.y + b.h + Math.round(c.pick(14, 10, 18) / 2) - 1, w: b.w, h: 2 }, { fill: LINE });
    rect(c, `${id}-lead-bg`, { x: b.x, y: b.y, w, h: b.h }, { fill: i % 2 ? BLUE : "@primary", radius: 8 });
    t(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.1, w, h: b.h * 0.8 }, { size: Math.round(b.h * 0.66), font: "condensed", weight: 900, color: CREAM, align: "center", num: true, fit: true, lh: 1 });
    t(c, `${id}-trail`, row[2], { x: b.x + w + 22, y: b.y + b.h * 0.18, w: 110, h: b.h * 0.64 }, { size: Math.round(b.h * 0.5), font: "condensed", weight: 900, color: "@accent", upper: true, fit: true });
    t(c, `${id}-main`, row[1], { x: b.x + w + 140, y: b.y + b.h * 0.22, w: b.w - w - 140, h: b.h * 0.56 }, { size: Math.round(b.h * 0.42), font: "condensed", weight: 800, color: CREAM, upper: true, fit: true });
  });
}

function table(c: Ctx, k: Content, top: number, bottom: number) {
  const rows = k.rows ?? [];
  if (k.key === "lineup" || k.key === "callup") return rowsOrTiles(c, k, { x: c.M, y: top, w: c.CW, h: bottom - top }, TILE, () => playerGrid(c, k, top, bottom));
  const lead = numericLead(k);
  const head = k.rowsHead;
  const headH = head ? 40 : 0;
  const boxes = rowBoxes(rows.length, top + headH, bottom, c.M, c.CW, { gap: 8, maxH: Math.round((lead ? 104 : 132) * c.k), minH: 60 });
  const oneCol = boxes.every((b) => b.x === c.M);
  if (head && oneCol) {
    const tile = lead ? Math.min(124, Math.round((boxes[0]?.h ?? 80) * 1.2)) : 0;
    if (lead) {
      caps(c, "head-lead", head[0], { x: c.M, y: top, w: tile, h: 30 }, { size: 24, color: DIM, align: "center" });
      caps(c, "head-main", head[1], { x: c.M + tile + 28, y: top, w: 400, h: 30 }, { size: 24, color: DIM });
    } else caps(c, "head-lead", head[0], { x: c.M + 34, y: top, w: 300, h: 30 }, { size: 24, color: DIM });
    caps(c, "head-trail", head[2], { x: c.W - c.M - 300, y: top, w: 276, h: 30 }, { size: 24, color: DIM, align: "end" });
  }
  boxes.forEach((b, i) => {
    const row = rows[i];
    const id = `row-${i + 1}`;
    rect(c, `${id}-bg`, b, { fill: i % 2 ? PANEL2 : PANEL, radius: 6 });
    if (lead) {
      const tw = Math.min(124, Math.round(b.h * 1.2));
      rect(c, `${id}-lead-bg`, { x: b.x, y: b.y, w: tw, h: b.h }, { fill: i === 0 ? "@accent" : "@primary", radius: 6 });
      t(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.12, w: tw, h: b.h * 0.76 }, { size: Math.round(b.h * 0.62), font: "condensed", weight: 900, color: i === 0 ? NAVY : CREAM, align: "center", num: true, fit: true, lh: 1 });
      t(c, `${id}-main`, row[1], { x: b.x + tw + 28, y: b.y + b.h * 0.2, w: b.w - tw - 28 - 220, h: b.h * 0.6 }, { size: Math.round(b.h * 0.46), font: "condensed", weight: 800, color: CREAM, upper: true, fit: true });
      t(c, `${id}-trail`, row[2], { x: b.x + b.w - 200, y: b.y + b.h * 0.16, w: 176, h: b.h * 0.68 }, { size: Math.round(b.h * 0.56), font: "condensed", weight: 900, color: "@accent", upper: true, align: "end", num: true, fit: true });
    } else {
      // Prices: a garnet / blue edge, plan, detail, gold price.
      rect(c, `${id}-lead-bg`, { x: b.x, y: b.y, w: 10, h: b.h }, { fill: i % 2 ? BLUE : "@primary" });
      const lw = Math.round(b.w * 0.32);
      t(c, `${id}-lead`, row[0], { x: b.x + 34, y: b.y + b.h * 0.2, w: lw - 40, h: b.h * 0.6 }, { size: Math.round(b.h * 0.36), font: "condensed", weight: 900, color: CREAM, upper: true, fit: true });
      t(c, `${id}-main`, row[1], { x: b.x + lw + 10, y: b.y + b.h * 0.24, w: b.w - lw - 260, h: b.h * 0.52 }, { size: Math.round(b.h * 0.26), font: "body", weight: 500, color: MUTED, fit: true });
      t(c, `${id}-trail`, row[2], { x: b.x + b.w - 240, y: b.y + b.h * 0.18, w: 216, h: b.h * 0.64 }, { size: Math.round(b.h * 0.44), font: "condensed", weight: 900, color: "@accent", upper: true, align: "end", fit: true });
    }
  });
}

/** Match stats: own value | label | opponent value, under a garnet / blue team header. */
function statsTable(c: Ctx, k: Content, top: number, bottom: number) {
  const rows = k.rows ?? [];
  const head = k.rowsHead ?? ["", "", ""];
  const hh = c.pick(72, 64, 80);
  const half = (c.CW - 12) / 2;
  rect(c, "head-own-bg", { x: c.M, y: top, w: half, h: hh }, { fill: "@primary", radius: 6 });
  rect(c, "head-opp-bg", { x: c.M + half + 12, y: top, w: half, h: hh }, { fill: BLUE, radius: 6 });
  t(c, "head-lead", head[0], { x: c.M + 24, y: top + hh * 0.18, w: half - 48, h: hh * 0.64 }, { size: Math.round(hh * 0.5), font: "condensed", weight: 800, color: CREAM, upper: true, fit: true });
  t(c, "head-trail", head[2], { x: c.M + half + 36, y: top + hh * 0.18, w: half - 48, h: hh * 0.64 }, { size: Math.round(hh * 0.5), font: "condensed", weight: 800, color: CREAM, upper: true, align: "end", fit: true });
  rect(c, "head-rule", { x: c.M, y: top + hh, w: c.CW, h: 5 }, { fill: "@accent" });
  const boxes = rowBoxes(rows.length, top + hh + 21, bottom, c.M, c.CW, { gap: 8, maxH: c.pick(124, 110, 160), minH: 56 });
  boxes.forEach((b, i) => {
    const row = rows[i];
    const id = `row-${i + 1}`;
    rect(c, `${id}-bg`, b, { fill: i % 2 ? PANEL2 : PANEL, radius: 6 });
    const vw = Math.round(b.w * 0.28);
    t(c, `${id}-lead`, row[0], { x: b.x + 28, y: b.y + b.h * 0.12, w: vw, h: b.h * 0.76 }, { size: Math.round(b.h * 0.6), font: "condensed", weight: 900, color: "@accent", num: true, fit: true, lh: 1 });
    t(c, `${id}-main`, row[1], { x: b.x + vw + 40, y: b.y + b.h * 0.26, w: b.w - 2 * vw - 80, h: b.h * 0.48 }, { size: Math.round(b.h * 0.34), font: "condensed", weight: 800, color: CREAM, upper: true, align: "center", ls: 1, fit: true });
    t(c, `${id}-trail`, row[2], { x: b.x + b.w - vw - 28, y: b.y + b.h * 0.12, w: vw, h: b.h * 0.76 }, { size: Math.round(b.h * 0.6), font: "condensed", weight: 900, color: CREAM, align: "end", num: true, fit: true, lh: 1 });
  });
}

// ── Promo: trials, new groups, tournaments, countdown, poll, map, values ────

const promo: StyleKit["promo"] = (c, k) => {
  if (k.options) return poll(c, k);
  const photoH = c.pick(720, 520, 1000);
  media(c, "photo", { x: 0, y: 0, w: c.W, h: photoH }, { name: "Photo" });
  rect(c, "photo-wash", { x: 0, y: 0, w: c.W, h: photoH }, { fill: NAVY, opacity: 0.3 });
  seam(c, "photo-seam", photoH, NAVY);
  bands(c, "band", c.W - c.pick(250, 230, 250), c.pick(190, 170, 200), 0, photoH);
  rect(c, "photo-top-shade", { x: 0, y: 0, w: c.W, h: c.T + 200 }, { gradient: { from: "#0A1A3FB3", to: NAVY_CLEAR } });
  const fade = Math.round(photoH * 0.4);
  rect(c, "photo-shade", { x: 0, y: fade, w: c.W, h: photoH - fade }, { gradient: { from: NAVY_CLEAR, to: NAVY } });
  if (k.key === "map") pin(c, Math.round(c.W * 0.42), Math.round(photoH * 0.44), "@primary", CREAM);
  crestTL(c, k);
  if (has(k.badge)) {
    const bw = c.pick(250, 230, 270);
    const bx = c.W - c.M - bw;
    rect(c, "badge-bg", { x: bx, y: c.T + 6, w: bw, h: 96 }, { fill: "@accent", radius: 12 });
    t(c, "badge", k.badge, { x: bx + 20, y: c.T + 18, w: bw - 40, h: 72 }, { size: 60, font: "condensed", weight: 900, color: NAVY, upper: true, align: "center", fit: true, lh: 1 });
  }
  const manifesto = k.key === "manifesto";
  const hs = c.pick(manifesto ? 92 : 128, manifesto ? 74 : 100, manifesto ? 100 : 140);
  const hh = Math.round(hs * 0.95 * (manifesto ? 3 : 2));
  const pills = k.pills.slice(0, 3);
  const ctaH = 96;
  const subH = c.pick(90, 64, 100);
  const items: StackItem[] = [
    { h: 60, gap: c.pick(26, 18, 30), draw: (y) => pill(c, "kicker", k.kicker, c.M, y, 460, 60) },
    { h: hh, gap: c.pick(22, 16, 30), draw: (y) => gold(c, "headline", k.headline ?? "", { x: c.M - 4, y, w: c.CW + 4, h: hh }, hs) },
    has(k.sub) && { h: subH, gap: c.pick(28, 18, 36), draw: (y) => t(c, "sub", k.sub!, { x: c.M, y, w: c.pick(880, 900, 900), h: subH }, { size: 36, font: "body", weight: 500, color: CREAM, lh: 1.25, fit: true }) },
    pills.length > 0 && { h: 68, draw: (y) => {
      const gap = 14;
      const weights = pills.length === 3 ? [0.3, 0.3, 0.4] : pills.length === 2 ? [0.45, 0.55] : [0.6];
      const avail = c.CW - gap * (pills.length - 1);
      let x = c.M;
      pills.forEach((p, i) => {
        const w = avail * weights[i];
        pill(c, `pill-${i + 1}`, p, x, y, w, 68, i % 2 ? BLUE : "@primary");
        x += w + gap;
      });
    } },
  ];
  // Sits on the call-to-action (or the foot), never higher than the photo's fade.
  const bottom = k.cta ? c.B - ctaH - c.pick(40, 26, 48) : c.B;
  stackDown(Math.max(photoH - c.pick(150, 120, 170), bottom - stackHeight(items)), items);
  if (k.cta) ctaBar(c, k.cta, c.B - ctaH, ctaH);
};

function poll(c: Ctx, k: Content) {
  field(c);
  crestTL(c, k, true);
  const y = c.T + c.pick(150, 132, 170);
  pill(c, "kicker", k.kicker, c.M, y, 420, 60);
  const hs = c.pick(104, 84, 120);
  const hh = Math.round(hs * 0.95 * 2);
  gold(c, "headline", k.headline ?? "", { x: c.M, y: y + 84, w: c.CW, h: hh }, hs);
  const cy = y + 84 + hh + c.pick(36, 26, 48);
  const cw = (c.CW - 24) / 2;
  const ch = c.B - 70 - cy;
  const bar = c.pick(112, 96, 124);
  k.options!.forEach((opt, i) => {
    const x = c.M + i * (cw + 24);
    media(c, `option-${i + 1}-photo`, { x, y: cy, w: cw, h: ch - bar }, { path: `more.${i}`, name: `Option ${i + 1} photo`, radius: 10 });
    rect(c, `option-${i + 1}-bg`, { x, y: cy + ch - bar, w: cw, h: bar }, { fill: i ? BLUE : "@primary", radius: 10 });
    rect(c, `option-${i + 1}-rule`, { x, y: cy + ch - bar, w: cw, h: 6 }, { fill: "@accent" });
    ellipse(c, `option-${i + 1}-key-bg`, { x: x + 20, y: cy + ch - bar + (bar - 72) / 2 + 3, w: 72, h: 72 }, { fill: NAVY, stroke: { color: "@accent", width: 4 } });
    gold(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x + 20, y: cy + ch - bar + (bar - 72) / 2 + 9, w: 72, h: 60 }, 50, { align: "center", lh: 1 });
    t(c, `option-${i + 1}`, opt, { x: x + 108, y: cy + ch - bar + bar * 0.2, w: cw - 130, h: bar * 0.66 }, { size: Math.round(bar * 0.42), font: "condensed", weight: 900, color: CREAM, upper: true, fit: true });
  });
  caps(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 40, w: c.CW, h: 40 }, { ls: 3, color: CREAM, align: "center" });
}

// ── Video skin ──────────────────────────────────────────────────────────────

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: c.T + 260 }, { gradient: { from: "#0A1A3FCC", to: NAVY_CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 820, w: c.W, h: 820 }, { gradient: { from: NAVY_CLEAR, to: "#0A1A3FF0" } });
  },
  frame: (c, k, tm) => {
    crest(c, "crest", { x: c.M, y: c.T, w: 92, h: 92 }, tm);
    t(c, "academy", k.academy, { x: c.M + 112, y: c.T + 26, w: 560, h: 42 }, { size: 32, font: "condensed", weight: 800, color: CREAM, upper: true, ls: 2, fit: true, ...tm });
  },
  tag: (c, k, tm) => pill(c, "kicker", k.kicker, c.M, c.B - 500, k.video?.variant === "goal" ? 300 : 460, 64, "@primary", tm),
  goal: (c, k, tm) => {
    const y = c.B - 410;
    ellipse(c, "number-bg", { x: c.M, y, w: 190, h: 190 }, { fill: NAVY, stroke: { color: "@accent", width: 8 }, ...tm });
    gold(c, "number", k.number ?? "", { x: c.M + 10, y: y + 30, w: 170, h: 130 }, 120, { num: true, align: "center", lh: 1, ...tm });
    t(c, "name", k.name ?? "", { x: c.M + 220, y: y + 64, w: c.CW - 220, h: 64 }, { size: 56, font: "condensed", weight: 800, color: CREAM, upper: true, fit: true, ...tm });
    scoreBug(c, k, c.B - 150, 118, tm);
  },
  speaker: (c, k, tm) => {
    const y = c.B - 400;
    rect(c, "speaker-bg", { x: c.M, y, w: 760, h: 104 }, { fill: "@primary", radius: 8, ...tm });
    rect(c, "speaker-edge", { x: c.M + 760 - 70, y, w: 70, h: 104 }, { fill: BLUE, ...tm });
    t(c, "speaker", k.headline ?? "", { x: c.M + 32, y: y + 20, w: 640, h: 64 }, { size: 56, font: "condensed", weight: 900, color: CREAM, upper: true, fit: true, ...tm });
    rect(c, "role-bg", { x: c.M, y: y + 112, w: 580, h: 68 }, { fill: NAVY, radius: 8, ...tm });
    rect(c, "role-rule", { x: c.M, y: y + 176, w: 580, h: 4 }, { fill: "@accent", ...tm });
    t(c, "role", k.sub ?? "", { x: c.M + 28, y: y + 124, w: 524, h: 44 }, { size: 34, font: "condensed", weight: 800, color: "@accent", upper: true, fit: true, ...tm });
  },
  title: (c, k, tm) => {
    const y = c.B - 420;
    gold(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: 250 }, 130, { shadow: { color: "#0A1A3FB3", blur: 24, x: 0, y: 6 }, ...tm });
    rect(c, "headline-band", { x: c.M, y: y + 266, w: 110, h: 10 }, { fill: "@primary", ...tm });
    rect(c, "headline-band-2", { x: c.M + 110, y: y + 266, w: 110, h: 10 }, { fill: BLUE, ...tm });
    caps(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: y + 300, w: c.CW, h: 44 }, { size: 32, color: CREAM, ls: 3, ...tm });
  },
  caption: (c, id, value, tm) =>
    t(c, id, value, { x: c.M, y: c.B - 180, w: c.CW, h: 150 }, { size: 44, font: "body", weight: 700, color: CREAM, align: "center", lh: 1.2, fit: true, bg: { color: "#0A1A3FE0", padding: 18, radius: 8 }, ...tm }),
  end: (c, k, tm) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: NAVY, ...tm });
    bands(c, "end-band", Math.round(c.W * 0.74), 190, 0, c.H, SKEW, tm);
    rect(c, "end-shade", { x: 0, y: 0, w: c.W, h: c.H }, { fill: NAVY, opacity: 0.35, ...tm });
    crest(c, "end-crest", { x: c.W / 2 - 150, y: c.H / 2 - 280, w: 300, h: 300 }, tm);
    t(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 60, w: c.CW, h: 80 }, { size: 64, font: "condensed", weight: 900, color: CREAM, upper: true, align: "center", fit: true, ...tm });
    rect(c, "end-stripe", { x: c.W / 2 - 100, y: c.H / 2 + 170, w: 200, h: 8 }, { fill: "@accent", ...tm });
  },
};

export const pack_barca: StyleKit = { background: NAVY, plate: { opacity: 0.55 }, score, fixture, hero, list, promo, skin };
