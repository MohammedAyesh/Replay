import type { Content } from "../content";
import { seam, crest, media, rect, slant, text, type Ctx, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackUp } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Broadcast: TV match graphics. Void base, slanted slabs, a score bug,
 * condensed capitals and accent stripes, like a pre-match package on a sports
 * channel.
 */

const VOID = "#0B0F1A";
const PANEL = "#151C2E";
const PANEL2 = "#1E2742";
const WHITE = "#FFFFFF";
const MUTED = "#8A93A6";
const CLEAR = "#0B0F1A00";

function header(c: Ctx, k: Content, right?: string) {
  crest(c, "crest", { x: c.M, y: c.T, w: 96, h: 96 });
  text(c, "academy", k.academy, { x: c.M + 116, y: c.T + 26, w: right ? 420 : 760, h: 44 }, { size: 34, font: "condensed", color: WHITE, upper: true, ls: 2, fit: true });
  if (right) text(c, "header-meta", right, { x: c.W - c.M - 380, y: c.T + 30, w: 380, h: 40 }, { size: 28, font: "condensed", color: MUTED, upper: true, ls: 2, align: "end", fit: true });
}

function photoTop(c: Ctx, h: number) {
  media(c, "photo", { x: 0, y: 0, w: c.W, h }, { name: "Photo" });
  rect(c, "photo-top-shade", { x: 0, y: 0, w: c.W, h: 300 }, { gradient: { from: "#0B0F1ACC", to: CLEAR } });
  rect(c, "photo-shade", { x: 0, y: Math.round(h * 0.3), w: c.W, h: h - Math.round(h * 0.3) }, { gradient: { from: CLEAR, to: VOID } });
  seam(c, "photo-seam", h, VOID);
}

function footer(c: Ctx) {
  rect(c, "footer-primary", { x: 0, y: c.H - 14, w: c.W, h: 14 }, { fill: "@primary" });
  rect(c, "footer-accent", { x: 0, y: c.H - 22, w: 360, h: 8 }, { fill: "@accent" });
}

/** Kicker tag: a slanted accent slab with dark capitals. */
function tag(c: Ctx, id: string, value: string, x: number, y: number, w: number, t: Timing = {}, fill = "@accent", ink = VOID) {
  slant(c, `${id}-bg`, { x, y, w, h: 68 }, -14, { fill, ...t });
  text(c, id, value, { x: x + 28, y: y + 12, w: w - 56, h: 46 }, { size: 38, font: "condensed", color: ink, upper: true, ls: 1, fit: true, ...t });
}

/** The score bug: own slab | own score | opponent score | opponent slab. */
function scoreBug(c: Ctx, k: Content, y: number, t: Timing = {}) {
  const s = k.score!;
  const h = Math.round(150 * c.k);
  const side = 330;
  const box = 138;
  slant(c, "bug-own-bg", { x: c.M, y, w: side + 20, h }, -10, { fill: "@primary", ...t });
  text(c, "own", s.ownName, { x: c.M + 28, y: y + h / 2 - 32, w: side - 40, h: 64 }, { size: 50, font: "condensed", color: WHITE, upper: true, fit: true, ...t });
  rect(c, "bug-own-score-bg", { x: c.M + side, y, w: box, h }, { fill: WHITE, ...t });
  text(c, "bug-own-score", s.own, { x: c.M + side, y: y + 8, w: box, h: h - 16 }, { size: Math.round(118 * c.k), font: "display", weight: 800, color: VOID, align: "center", num: true, ...t });
  rect(c, "bug-opp-score-bg", { x: c.M + side + box, y, w: box, h }, { fill: "#E4E8F0", ...t });
  text(c, "bug-opp-score", s.opp, { x: c.M + side + box, y: y + 8, w: box, h: h - 16 }, { size: Math.round(118 * c.k), font: "display", weight: 800, color: "#5A6378", align: "center", num: true, ...t });
  slant(c, "bug-opp-bg", { x: c.M + side + 2 * box - 20, y, w: side + 20, h }, -10, { fill: PANEL2, ...t });
  text(c, "opp", s.oppName, { x: c.M + side + 2 * box + 12, y: y + h / 2 - 32, w: side - 40, h: 64 }, { size: 50, font: "condensed", color: WHITE, upper: true, fit: true, align: "end", ...t });
  rect(c, "bug-stripe", { x: c.M, y: y + h, w: c.CW, h: 8 }, { fill: "@accent", ...t });
  return y + h + 8;
}

const score: StyleKit["score"] = (c, k) => {
  // The block sits on the bottom margin; the photo fills everything above it.
  const bugH = Math.round(150 * c.k);
  const y0 = c.B - 24 - (has(k.sub) ? 66 + 20 : 0) - 44 - 40 - bugH - 8;
  const photoH = y0 + 110;
  photoTop(c, photoH);
  header(c, k);
  tag(c, "kicker", k.kicker, c.M, y0 - 88, 360);
  text(c, "competition", k.meta[0] ?? "", { x: c.M + 390, y: y0 - 74, w: c.CW - 390, h: 44 }, { size: 32, font: "condensed", color: WHITE, upper: true, ls: 2, fit: true });
  const below = scoreBug(c, k, y0);
  stackDown(below + 44, [
    has(k.sub) && { h: 66, gap: 20, draw: (y) => {
      rect(c, "scorers-mark", { x: c.M, y: y + 12, w: 12, h: 44 }, { fill: "@primary" });
      text(c, "scorers", k.sub!, { x: c.M + 34, y, w: c.CW - 34, h: 66 }, { size: 54, font: "condensed", color: WHITE, upper: true, fit: true });
    } },
    { h: 40, draw: (y) => text(c, "meta", k.meta[1] ?? "", { x: c.M + 34, y, w: c.CW - 34, h: 40 }, { size: 32, font: "condensed", color: MUTED, upper: true, ls: 3, fit: true }) },
  ]);
  footer(c);
};

const fixture: StyleKit["fixture"] = (c, k) => {
  const photoH = c.pick(700, 480, 1000);
  photoTop(c, photoH);
  header(c, k, k.meta[0]);
  const v = k.vs!;
  const head = k.headline ?? k.kicker;
  if (k.headline) tag(c, "kicker", k.kicker, c.M, photoH - 300, 380);
  text(c, "headline", head, { x: c.M, y: photoH - 220, w: c.CW, h: 200 }, { size: Math.round(180 * c.k), font: "condensed", weight: 800, color: WHITE, upper: true, italic: true, fit: true, lh: 0.95 });
  rect(c, "headline-stripe", { x: c.M, y: photoH - 10, w: 180, h: 10 }, { fill: "@accent" });
  const y1 = photoH + 36;
  const rowH = Math.round(108 * c.k);
  slant(c, "own-bg", { x: c.M, y: y1, w: c.CW - 60, h: rowH }, -10, { fill: "@primary" });
  text(c, "own", v.ownName, { x: c.M + 36, y: y1 + rowH / 2 - 34, w: c.CW - 260, h: 68 }, { size: 58, font: "condensed", color: WHITE, upper: true, fit: true });
  slant(c, "opp-bg", { x: c.M + 60, y: y1 + rowH + 14, w: c.CW - 60, h: rowH }, -10, { fill: PANEL2 });
  text(c, "opp", v.oppName, { x: c.M + 96, y: y1 + rowH + 14 + rowH / 2 - 34, w: c.CW - 300, h: 68 }, { size: 58, font: "condensed", color: WHITE, upper: true, fit: true });
  rect(c, "vs-bg", { x: c.W - c.M - 128, y: y1 + rowH - 34, w: 128, h: 82 }, { fill: "@accent" });
  text(c, "vs", v.label, { x: c.W - c.M - 128, y: y1 + rowH - 26, w: 128, h: 66 }, { size: 46, font: "condensed", color: VOID, upper: true, align: "center" });
  const y2 = y1 + 2 * rowH + 14 + Math.round(42 * c.k);
  const cols = [250, 230, c.CW - 480];
  let x = c.M;
  k.pills.slice(0, 3).forEach((p, i) => {
    if (i > 0) rect(c, `pill-rule-${i}`, { x: x - 1, y: y2, w: 2, h: 60 }, { fill: "#2B3552" });
    text(c, `pill-${i + 1}`, p, { x: x + (i ? 24 : 0), y: y2 + 8, w: cols[i] - (i ? 40 : 16), h: 48 }, { size: 38, font: "condensed", color: i === 0 ? "@accent" : WHITE, upper: true, fit: true });
    x += cols[i];
  });
  text(c, "squad", k.meta[1] ?? "", { x: c.M, y: y2 + 84, w: c.CW, h: 40 }, { size: 28, font: "condensed", color: MUTED, upper: true, ls: 3 });
  footer(c);
};

const hero: StyleKit["hero"] = (c, k) => {
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo" });
  rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 320 }, { gradient: { from: "#0B0F1ACC", to: CLEAR } });
  rect(c, "shade", { x: 0, y: Math.round(c.H * 0.32), w: c.W, h: c.H - Math.round(c.H * 0.32) }, { gradient: { from: CLEAR, to: VOID } });
  rect(c, "shade-side", { x: 0, y: 0, w: 760, h: c.H }, { gradient: { from: "#0B0F1A99", to: CLEAR, angle: 90 } });
  header(c, k);
  const { head, tag: tagText } = heroWords(k);
  if (k.stat) {
    const sx = c.W - c.M - 220;
    rect(c, "stat-bg", { x: sx, y: c.T, w: 220, h: 200 }, { fill: PANEL });
    rect(c, "stat-bar", { x: sx, y: c.T, w: 220, h: 10 }, { fill: "@primary" });
    text(c, "stat", k.stat.value, { x: sx, y: c.T + 22, w: 220, h: 120 }, { size: 112, font: "display", weight: 800, color: WHITE, align: "center", num: true });
    text(c, "stat-label", k.stat.label, { x: sx + 12, y: c.T + 146, w: 196, h: 36 }, { size: 26, font: "condensed", color: "@accent", upper: true, align: "center", fit: true });
  }
  const bottom = c.B - 24;
  if (has(k.number)) {
    const nW = 400;
    const colX = c.M + nW + 20;
    const colW = c.CW - nW - 20;
    rect(c, "number-bar", { x: c.M, y: bottom - 400, w: 12, h: 400 }, { fill: "@accent" });
    text(c, "number", k.number, { x: c.M + 28, y: bottom - 420, w: nW - 28, h: 420 }, { size: 400, font: "condensed", weight: 800, color: WHITE, num: true, fit: true, lh: 1 });
    stackUp(bottom, [
      { h: 68, gap: 20, draw: (y) => tag(c, "kicker", tagText, colX, y, Math.min(colW, 480)) },
      { h: 170, gap: 8, draw: (y) => text(c, "headline", head, { x: colX, y, w: colW, h: 170 }, { size: 78, font: "condensed", weight: 800, color: WHITE, upper: true, fit: true, lh: 1 }) },
      has(k.name) && { h: 60, gap: 8, draw: (y) => text(c, "name", k.name!, { x: colX, y, w: colW, h: 60 }, { size: 50, font: "condensed", color: "@accent", upper: true, fit: true }) },
      has(k.sub) && { h: 44, gap: 8, draw: (y) => text(c, "sub", k.sub!, { x: colX, y, w: colW, h: 44 }, { size: 32, font: "body", weight: 500, color: WHITE, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 38, gap: 4, draw: (y: number) => text(c, `meta-${i + 1}`, m, { x: colX, y, w: colW, h: 38 }, { size: 28, font: "condensed", color: MUTED, upper: true, ls: 2, fit: true }) })),
    ]);
  } else {
    stackUp(bottom, [
      { h: 68, gap: 24, draw: (y) => tag(c, "kicker", tagText, c.M, y, 520) },
      { h: Math.round(330 * c.k), gap: 16, draw: (y) => text(c, "headline", head, { x: c.M, y, w: c.CW, h: Math.round(330 * c.k) }, { size: Math.round(170 * c.k), font: "condensed", weight: 800, color: WHITE, upper: true, italic: true, fit: true, lh: 0.95 }) },
      has(k.sub) && { h: 96, gap: 18, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: 820, h: 96 }, { size: 36, font: "body", weight: 500, color: WHITE, lh: 1.25, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 40, gap: 4, draw: (y: number) => text(c, `meta-${i + 1}`, m, { x: c.M, y, w: c.CW, h: 40 }, { size: 30, font: "condensed", color: "@accent", upper: true, ls: 3, fit: true }) })),
    ]);
  }
  footer(c);
};

/** Line-up photo tiles: a dark panel with a brand slash, the number in the accent, a brand bar. */
const TILE: TileLook = {
  backdrop: (c, id, b, i) => {
    rect(c, id, b, { fill: i % 2 ? PANEL : PANEL2 });
    slant(c, `${id}-slash`, { x: b.x + b.w * 0.55, y: b.y, w: b.w * 0.3, h: b.h }, -14, { fill: "@primary", opacity: 0.55 });
    rect(c, `${id}-top`, { x: b.x, y: b.y, w: b.w, h: 6 }, { fill: "@accent" });
  },
  bar: (c, id, b) => rect(c, id, b, { fill: "@primary" }),
  num: { font: "condensed", color: "@accent", weight: 800 },
  name: { font: "condensed", color: WHITE, weight: 800 },
  pos: { font: "condensed", color: "@accent" },
  shadow: VOID,
  cardRadius: 0,
};

const list: StyleKit["list"] = (c, k) => {
  slant(c, "deco", { x: c.W - 460, y: 0, w: 460, h: 420 }, -18, { fill: "@primary", opacity: 0.22 });
  slant(c, "deco-2", { x: c.W - 250, y: 0, w: 120, h: 420 }, -18, { fill: "@accent", opacity: 0.18 });
  header(c, k);
  let y = c.T + 140;
  tag(c, "kicker", k.kicker, c.M, y, 420);
  y += 88;
  text(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: 96 }, { size: Math.round(84 * c.k), font: "condensed", weight: 800, color: WHITE, upper: true, fit: true });
  y += 120;
  const rows = k.rows ?? [];
  const footH = k.cta ? 150 : 90;
  const head = k.rowsHead;
  const boxes = rowBoxes(rows.length, y + (head ? 44 : 0), c.B - footH, c.M, c.CW, { maxH: Math.round((numericLead(k) ? 112 : 136) * c.k) });
  rowsOrTiles(c, k, { x: c.M, y, w: c.CW, h: c.B - footH - 24 - y }, TILE, () => {
  if (head && boxes.every((b) => b.x === c.M)) {
    text(c, "head-lead", head[0], numericLead(k) ? { x: c.M, y, w: 120, h: 32 } : { x: c.M + 24, y, w: 260, h: 32 }, { size: 24, font: "condensed", color: MUTED, upper: true, ls: 2, align: numericLead(k) ? "center" : "start" });
    if (numericLead(k)) text(c, "head-main", head[1], { x: c.M + 150, y, w: 500, h: 32 }, { size: 24, font: "condensed", color: MUTED, upper: true, ls: 2 });
    text(c, "head-trail", head[2], { x: c.W - c.M - 300, y, w: 276, h: 32 }, { size: 24, font: "condensed", color: MUTED, upper: true, ls: 2, align: "end" });
  }
  const lead = numericLead(k);
  boxes.forEach((b, i) => {
    const row = rows[i];
    const id = `row-${i + 1}`;
    const lw = lead ? Math.min(120, Math.round(b.h * 1.15)) : Math.round(b.w * 0.3);
    const tw = Math.min(276, Math.round(b.w * 0.3));
    rect(c, `${id}-bg`, b, { fill: i % 2 ? PANEL : PANEL2 });
    rect(c, `${id}-lead-bg`, { x: b.x, y: b.y, w: lw, h: b.h }, { fill: i === 0 ? "@accent" : "@primary" });
    text(c, `${id}-lead`, row[0], { x: b.x + (lead ? 0 : 24), y: b.y + b.h * 0.2, w: lw - (lead ? 0 : 40), h: b.h * 0.6 }, { size: Math.round(b.h * (lead ? 0.5 : 0.36)), font: "condensed", weight: 800, color: i === 0 ? VOID : WHITE, align: lead ? "center" : "start", upper: true, num: lead, fit: true });
    const mainX = b.x + lw + 28;
    const mainW = b.w - lw - 28 - tw - 24;
    text(c, `${id}-main`, row[1], { x: mainX, y: b.y + b.h * (lead ? 0.24 : 0.3), w: mainW, h: b.h * (lead ? 0.52 : 0.4) }, { size: Math.round(b.h * (lead ? 0.42 : 0.28)), font: lead ? "condensed" : "body", weight: lead ? 700 : 600, color: lead ? WHITE : "#C9D0DE", upper: lead, fit: true });
    text(c, `${id}-trail`, row[2], { x: b.x + b.w - tw - 24, y: b.y + b.h * 0.24, w: tw, h: b.h * 0.52 }, { size: Math.round(b.h * 0.42), font: "condensed", weight: 800, color: "@accent", upper: true, align: "end", fit: true });
  });
  });
  stackUp(c.B, [
    ...k.meta.map((m, i) => ({ h: 38, gap: 10, draw: (yy: number) => text(c, `meta-${i + 1}`, m, { x: c.M, y: yy, w: c.CW, h: 38 }, { size: 28, font: "condensed", color: MUTED, upper: true, ls: 2, fit: true }) })),
    k.cta && { h: 56, draw: (yy: number) => {
      rect(c, "cta-mark", { x: c.M, y: yy + 8, w: 12, h: 40 }, { fill: "@accent" });
      text(c, "cta", k.cta!, { x: c.M + 30, y: yy, w: c.CW - 30, h: 56 }, { size: 42, font: "condensed", color: WHITE, upper: true, fit: true });
    } },
  ]);
  footer(c);
};

const promo: StyleKit["promo"] = (c, k) => {
  const poll = !!k.options;
  const photoH = poll ? 0 : c.pick(700, 500, 1000);
  if (!poll) {
    photoTop(c, photoH);
    if (k.key === "map") pin(c, c.W / 2, Math.round(photoH * 0.46), "@accent");
  }
  header(c, k);
  if (has(k.badge)) {
    slant(c, "badge-bg", { x: c.W - c.M - 250, y: c.T + 4, w: 250, h: 92 }, -14, { fill: "@accent" });
    text(c, "badge", k.badge, { x: c.W - c.M - 226, y: c.T + 18, w: 202, h: 64 }, { size: 56, font: "condensed", weight: 800, color: VOID, upper: true, align: "center", fit: true });
  }
  if (poll) {
    const y = c.T + 160;
    tag(c, "kicker", k.kicker, c.M, y, 420);
    text(c, "headline", k.headline ?? "", { x: c.M, y: y + 96, w: c.CW, h: 230 }, { size: Math.round(110 * c.k), font: "condensed", weight: 800, color: WHITE, upper: true, fit: true, lh: 0.98 });
    const cy = y + 360;
    const cw = (c.CW - 24) / 2;
    const ch = c.B - 80 - cy;
    k.options!.forEach((opt, i) => {
      const x = c.M + i * (cw + 24);
      media(c, `option-${i + 1}-photo`, { x, y: cy, w: cw, h: ch - 110 }, { path: `more.${i}`, name: `Option ${i + 1} photo` });
      slant(c, `option-${i + 1}-bg`, { x, y: cy + ch - 110, w: cw, h: 110 }, -8, { fill: i === 0 ? "@primary" : PANEL2 });
      text(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x + 24, y: cy + ch - 92, w: 60, h: 74 }, { size: 60, font: "condensed", weight: 800, color: "@accent" });
      text(c, `option-${i + 1}`, opt, { x: x + 96, y: cy + ch - 92, w: cw - 120, h: 74 }, { size: 56, font: "condensed", weight: 800, color: WHITE, upper: true, fit: true });
    });
    text(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 48, w: c.CW, h: 40 }, { size: 30, font: "condensed", color: MUTED, upper: true, ls: 3 });
    footer(c);
    return;
  }
  tag(c, "kicker", k.kicker, c.M, photoH - 100, 460, {}, "@primary", WHITE);
  const manifesto = k.key === "manifesto";
  stackDown(photoH, [
    { h: manifesto ? Math.round(300 * c.k) : Math.round(220 * c.k), gap: 18, draw: (y) => text(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: manifesto ? Math.round(300 * c.k) : Math.round(220 * c.k) }, { size: Math.round((manifesto ? 92 : 116) * c.k), font: "condensed", weight: 800, color: WHITE, upper: true, fit: true, lh: 0.98 }) },
    has(k.sub) && { h: 90, gap: 28, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: 860, h: 90 }, { size: 36, font: "body", weight: 500, color: "#D5DAE5", lh: 1.25, fit: true }) },
    k.pills.length > 0 && { h: 72, draw: (y) => {
      const pw = (c.CW - 16 * (k.pills.length - 1)) / k.pills.length;
      k.pills.forEach((p, i) => {
        const x = c.M + i * (pw + 16);
        rect(c, `pill-${i + 1}-bg`, { x, y, w: pw, h: 72 }, { fill: PANEL2 });
        rect(c, `pill-${i + 1}-edge`, { x, y, w: 8, h: 72 }, { fill: "@accent" });
        text(c, `pill-${i + 1}`, p, { x: x + 26, y: y + 14, w: pw - 40, h: 44 }, { size: 34, font: "condensed", color: WHITE, upper: true, fit: true });
      });
    } },
  ]);
  if (k.cta) {
    slant(c, "cta-bg", { x: c.M, y: c.B - 92, w: c.CW, h: 92 }, -8, { fill: "@primary" });
    text(c, "cta", k.cta, { x: c.M + 36, y: c.B - 74, w: c.CW - 72, h: 56 }, { size: 44, font: "condensed", color: WHITE, upper: true, fit: true });
  }
  footer(c);
};

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 360 }, { gradient: { from: "#0B0F1AAA", to: CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 760, w: c.W, h: 760 }, { gradient: { from: CLEAR, to: "#0B0F1AE6" } });
  },
  frame: (c, k, t) => {
    crest(c, "crest", { x: c.M, y: c.T, w: 88, h: 88 }, t);
    text(c, "academy", k.academy, { x: c.M + 104, y: c.T + 24, w: 560, h: 42 }, { size: 32, font: "condensed", color: WHITE, upper: true, ls: 2, fit: true, ...t });
  },
  tag: (c, k, t) => tag(c, "kicker", k.kicker, c.M, c.B - 470, k.video?.variant === "goal" ? 300 : 460, t),
  goal: (c, k, t) => {
    const y = c.B - 380;
    rect(c, "number-bg", { x: c.M, y, w: 170, h: 170 }, { fill: "@primary", ...t });
    text(c, "number", k.number ?? "", { x: c.M, y: y + 14, w: 170, h: 142 }, { size: 120, font: "condensed", weight: 800, color: WHITE, align: "center", num: true, fit: true, ...t });
    text(c, "name", k.name ?? "", { x: c.M + 196, y: y + 54, w: c.CW - 196, h: 64 }, { size: 54, font: "condensed", color: WHITE, upper: true, fit: true, ...t });
    scoreBug(c, k, c.B - 170, t);
  },
  speaker: (c, k, t) => {
    const y = c.B - 380;
    slant(c, "speaker-bg", { x: c.M, y, w: 720, h: 100 }, -10, { fill: "@primary", ...t });
    text(c, "speaker", k.headline ?? "", { x: c.M + 32, y: y + 20, w: 660, h: 60 }, { size: 52, font: "condensed", color: WHITE, upper: true, fit: true, ...t });
    rect(c, "role-bg", { x: c.M, y: y + 100, w: 560, h: 64 }, { fill: PANEL, ...t });
    text(c, "role", k.sub ?? "", { x: c.M + 32, y: y + 112, w: 500, h: 42 }, { size: 32, font: "condensed", color: "@accent", upper: true, fit: true, ...t });
  },
  title: (c, k, t) => {
    const y = c.B - 380;
    text(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: 200 }, { size: 120, font: "condensed", weight: 800, color: WHITE, upper: true, italic: true, fit: true, lh: 0.95, ...t });
    rect(c, "headline-stripe", { x: c.M, y: y + 214, w: 180, h: 10 }, { fill: "@accent", ...t });
    text(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: y + 250, w: c.CW, h: 44 }, { size: 32, font: "condensed", color: WHITE, upper: true, ls: 3, fit: true, ...t });
  },
  caption: (c, id, value, t) =>
    text(c, id, value, { x: c.M, y: c.B - 170, w: c.CW, h: 150 }, { size: 44, font: "body", weight: 700, color: WHITE, align: "center", lh: 1.2, fit: true, bg: { color: "#0B0F1AD9", padding: 18, radius: 4 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: VOID, ...t });
    slant(c, "end-slab", { x: -60, y: c.H / 2 + 150, w: c.W + 120, h: 120 }, -12, { fill: "@primary", name: "bleed", mirror: false, ...t });
    crest(c, "end-crest", { x: c.W / 2 - 150, y: c.H / 2 - 260, w: 300, h: 300 }, t);
    text(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 172, w: c.CW, h: 76 }, { size: 60, font: "condensed", color: WHITE, upper: true, align: "center", fit: true, ...t });
    rect(c, "end-stripe", { x: c.W / 2 - 90, y: c.H / 2 + 300, w: 180, h: 8 }, { fill: "@accent", ...t });
  },
};

export const broadcast: StyleKit = { background: VOID, plate: { opacity: 0.6 }, score, fixture, hero, list, promo, skin };
