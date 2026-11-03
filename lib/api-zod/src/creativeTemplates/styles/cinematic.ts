import type { Content } from "../content";
import { crest, ellipse, media, rect, rule, text, type Box, type Ctx, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";

/**
 * Cinematic: a film poster. The photo runs full-bleed under heavy black
 * gradients, the academy colour comes up from the bottom like smoke, a few
 * embers float, and the type is massive italic condensed capitals with a glow.
 * The crest is small, in the top corner.
 */

const BLACK = "#000000";
const WHITE = "#FFFFFF";
const SOFT = "#D9D4CF";
const CLEAR = "#00000000";

/** Glow behind the big type. */
const GLOW = { color: "@primary", blur: 42, x: 0, y: 0 };

function poster(c: Ctx, o: { dim?: number } = {}) {
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo" });
  if (o.dim) rect(c, "photo-dim", { x: 0, y: 0, w: c.W, h: c.H }, { fill: BLACK, opacity: o.dim });
  rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: Math.round(c.H * 0.3) }, { gradient: { from: "#000000E6", to: CLEAR } });
  rect(c, "shade", { x: 0, y: Math.round(c.H * 0.36), w: c.W, h: c.H - Math.round(c.H * 0.36) }, { gradient: { from: CLEAR, to: BLACK } });
  // Crimson smoke rising from the bottom, in the academy colour.
  rect(c, "smoke", { x: 0, y: Math.round(c.H * 0.45), w: c.W, h: c.H - Math.round(c.H * 0.45) }, { gradient: { from: "@primary", to: CLEAR, angle: 0 }, opacity: 0.45 });
  rect(c, "smoke-side", { x: 0, y: 0, w: Math.round(c.W * 0.55), h: c.H }, { gradient: { from: "@primary", to: CLEAR, angle: 90 }, opacity: 0.22 });
  embers(c);
}

function embers(c: Ctx, t: Timing = {}) {
  const spots: Array<[number, number, number, number]> = [
    [0.12, 0.3, 10, 0.8], [0.22, 0.42, 6, 0.6], [0.78, 0.26, 12, 0.7], [0.86, 0.38, 7, 0.55], [0.64, 0.18, 5, 0.6], [0.36, 0.22, 8, 0.5], [0.92, 0.5, 9, 0.65],
  ];
  spots.forEach(([fx, fy, d, o], i) =>
    ellipse(c, `ember-${i + 1}`, { x: Math.round(c.W * fx), y: Math.round(c.H * fy), w: d, h: d }, { fill: i % 2 ? "@accent" : "@primary", opacity: o, ...t }));
}

function corner(c: Ctx, k: Content) {
  crest(c, "crest", { x: c.W - c.M - 84, y: c.T, w: 84, h: 84 });
  text(c, "academy", k.academy, { x: c.M, y: c.T + 26, w: 640, h: 36 }, { size: 24, font: "body", weight: 700, color: SOFT, upper: true, ls: 8, fit: true });
}

/** Small spaced capitals behind a thin line in the academy colour. */
function kicker(c: Ctx, value: string, x: number, y: number, w: number, t: Timing = {}) {
  rule(c, "kicker-rule", x, y + 18, 64, "@primary", 4, t);
  text(c, "kicker", value, { x: x + 84, y, w: w - 84, h: 40 }, { size: 26, font: "body", weight: 700, color: WHITE, upper: true, ls: 8, fit: true, ...t });
}

function big(c: Ctx, id: string, value: string, b: Box, size: number, o: { num?: boolean; color?: string; align?: "start" | "center" | "end" } & Timing = {}) {
  const { num, color, align, ...t } = o;
  text(c, id, value, b, { size, font: "condensed", weight: 900, italic: true, upper: true, color: color ?? WHITE, lh: 0.9, fit: true, shadow: GLOW, num, align, ...t });
}

const meta = (c: Ctx, id: string, value: string, y: number, o: { color?: string } = {}) =>
  text(c, id, value, { x: c.M, y, w: c.CW, h: 36 }, { size: 26, font: "body", weight: 600, color: o.color ?? SOFT, upper: true, ls: 6, fit: true });

const score: StyleKit["score"] = (c, k) => {
  poster(c);
  corner(c, k);
  const s = k.score!;
  const ns = c.pick(140, 112, 160);
  const ss = c.pick(330, 250, 380);
  stackUp(c.B, [
    { h: 40, gap: 24, draw: (y) => kicker(c, k.kicker, c.M, y, c.CW) },
    { h: Math.round(ns * 0.95), gap: 0, draw: (y) => big(c, "own", s.ownName, { x: c.M - 10, y, w: c.CW + 10, h: Math.round(ns * 0.95) }, ns) },
    { h: Math.round(ss * 0.92), gap: 0, draw: (y) => big(c, "score", `${s.own}–${s.opp}`, { x: c.M - 10, y, w: c.CW, h: Math.round(ss * 0.92) }, ss, { num: true }) },
    { h: Math.round(ns * 0.95), gap: 30, draw: (y) => big(c, "opp", s.oppName, { x: c.M - 10, y, w: c.CW + 10, h: Math.round(ns * 0.95) }, ns, { color: SOFT }) },
    has(k.sub) && { h: 40, gap: 10, draw: (y) => text(c, "scorers", k.sub!, { x: c.M, y, w: c.CW, h: 40 }, { size: 32, font: "condensed", weight: 800, italic: true, color: WHITE, upper: true, fit: true }) },
    { h: 36, draw: (y) => meta(c, "meta", k.meta.filter(Boolean).join("   ·   "), y) },
  ]);
};

const fixture: StyleKit["fixture"] = (c, k) => {
  poster(c);
  corner(c, k);
  const v = k.vs!;
  const hs = c.pick(230, 180, 260);
  const ts = c.pick(96, 80, 110);
  stackUp(c.B, [
    { h: 40, gap: 20, draw: (y) => kicker(c, k.headline ? k.kicker : (k.meta[0] ?? ""), c.M, y, c.CW) },
    { h: Math.round(hs * 0.95), gap: 26, draw: (y) => big(c, "headline", k.headline ?? k.kicker, { x: c.M - 10, y, w: c.CW + 10, h: Math.round(hs * 0.95) }, hs) },
    { h: Math.round(ts * 1.0), gap: 6, draw: (y) => big(c, "own", v.ownName, { x: c.M, y, w: c.CW, h: ts }, ts) },
    { h: 44, gap: 6, draw: (y) => text(c, "vs", v.label, { x: c.M, y, w: 200, h: 44 }, { size: 36, font: "condensed", weight: 800, italic: true, color: "@primary", upper: true }) },
    { h: Math.round(ts * 1.0), gap: 36, draw: (y) => big(c, "opp", v.oppName, { x: c.M, y, w: c.CW, h: ts }, ts, { color: SOFT }) },
    { h: 2, gap: 20, draw: (y) => rule(c, "info-rule", c.M, y, c.CW, "#FFFFFF40", 2) },
    { h: 40, gap: 8, draw: (y) => text(c, "pills", k.pills.filter(Boolean).join("   ·   "), { x: c.M, y, w: c.CW, h: 40 }, { size: 32, font: "condensed", weight: 800, color: WHITE, upper: true, fit: true }) },
    { h: 36, draw: (y) => meta(c, "meta", k.meta[k.headline ? 0 : 1] ?? "", y) },
  ]);
};

const hero: StyleKit["hero"] = (c, k) => {
  poster(c);
  const { head, tag } = heroWords(k);
  if (has(k.number)) {
    big(c, "number", k.number, { x: c.W - c.M - 560, y: c.T + 80, w: 560, h: c.pick(560, 420, 640) }, c.pick(560, 420, 600), { num: true, color: "@primary" });
  }
  corner(c, k);
  const hs = c.pick(170, 130, 190);
  stackUp(c.B, [
    { h: 40, gap: 22, draw: (y) => kicker(c, tag, c.M, y, c.CW) },
    { h: Math.round(hs * 1.85), gap: 22, draw: (y) => big(c, "headline", head, { x: c.M - 10, y, w: c.CW + 10, h: Math.round(hs * 1.85) }, hs) },
    has(k.name) && { h: 56, gap: 14, draw: (y) => text(c, "name", has(k.number) ? `#${k.number}  ${k.name}` : k.name!, { x: c.M, y, w: c.CW, h: 56 }, { size: 46, font: "condensed", weight: 800, italic: true, color: WHITE, upper: true, fit: true }) },
    k.stat && { h: 60, gap: 14, draw: (y) => {
      text(c, "stat", k.stat!.value, { x: c.M, y, w: 140, h: 60 }, { size: 64, font: "condensed", weight: 900, italic: true, color: "@accent", num: true, shadow: GLOW });
      text(c, "stat-label", k.stat!.label, { x: c.M + 150, y: y + 14, w: c.CW - 150, h: 36 }, { size: 26, font: "body", weight: 700, color: WHITE, upper: true, ls: 6, fit: true });
    } },
    has(k.sub) && { h: 80, gap: 14, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: 860, h: 80 }, { size: 32, font: "body", weight: 500, color: SOFT, lh: 1.25, fit: true }) },
    ...k.meta.map((m, i) => ({ h: 36, gap: 4, draw: (y: number) => meta(c, `meta-${i + 1}`, m, y) })),
  ]);
};

const list: StyleKit["list"] = (c, k) => {
  poster(c, { dim: 0.55 });
  corner(c, k);
  kicker(c, k.kicker, c.M, c.T + 150, c.CW);
  const hs = c.pick(120, 96, 140);
  big(c, "headline", k.headline ?? "", { x: c.M - 10, y: c.T + 210, w: c.CW + 10, h: Math.round(hs * 0.95) }, hs);
  const top = c.T + 210 + Math.round(hs * 0.95) + 40;
  const rows = k.rows ?? [];
  const lead = numericLead(k);
  const foot = (k.cta ? 56 : 0) + k.meta.length * 40 + 30;
  rowBoxes(rows.length, top, c.B - foot, c.M, c.CW, { gap: 0, maxH: Math.round((lead ? 108 : 130) * c.k) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    rule(c, `${id}-rule`, b.x, b.y + b.h - 2, b.w, "#FFFFFF2E", 2);
    const lw = lead ? Math.round(b.h * 1.1) : Math.round(b.w * 0.36);
    text(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.12, w: lw, h: b.h * 0.76 }, { size: Math.round(b.h * (lead ? 0.74 : 0.4)), font: "condensed", weight: 900, italic: true, color: i === 0 ? "@accent" : "@primary", upper: true, num: lead, fit: true, ...(lead ? { shadow: GLOW } : {}) });
    text(c, `${id}-main`, row[1], { x: b.x + lw + 20, y: b.y + b.h * 0.24, w: b.w - lw - 20 - 220, h: b.h * 0.52 }, { size: Math.round(b.h * (lead ? 0.46 : 0.28)), font: lead ? "condensed" : "body", weight: lead ? 800 : 600, italic: lead, color: WHITE, upper: lead, fit: true });
    text(c, `${id}-trail`, row[2], { x: b.x + b.w - 210, y: b.y + b.h * 0.2, w: 210, h: b.h * 0.6 }, { size: Math.round(b.h * 0.5), font: "condensed", weight: 900, italic: true, color: WHITE, upper: true, align: "end", fit: true });
  });
  stackUp(c.B, [
    ...k.meta.map((m, i) => ({ h: 36, gap: 10, draw: (y: number) => meta(c, `meta-${i + 1}`, m, y) })),
    k.cta && { h: 46, draw: (y: number) => text(c, "cta", k.cta!, { x: c.M, y, w: c.CW, h: 46 }, { size: 38, font: "condensed", weight: 800, italic: true, color: WHITE, upper: true, fit: true }) },
  ]);
};

const promo: StyleKit["promo"] = (c, k) => {
  if (k.options) {
    rect(c, "bg", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "#1A0306", to: BLACK } });
    rect(c, "smoke", { x: 0, y: Math.round(c.H * 0.4), w: c.W, h: c.H - Math.round(c.H * 0.4) }, { gradient: { from: "@primary", to: CLEAR, angle: 0 }, opacity: 0.5 });
    embers(c);
    corner(c, k);
    kicker(c, k.kicker, c.M, c.T + 150, c.CW);
    const hs = c.pick(150, 120, 170);
    big(c, "headline", k.headline ?? "", { x: c.M - 10, y: c.T + 210, w: c.CW + 10, h: Math.round(hs * 1.85) }, hs);
    const top = c.T + 210 + Math.round(hs * 1.85) + 40;
    const cw = (c.CW - 30) / 2;
    const ch = c.B - 90 - top;
    k.options.forEach((opt, i) => {
      const x = c.M + i * (cw + 30);
      media(c, `option-${i + 1}-photo`, { x, y: top, w: cw, h: ch }, { path: `more.${i}`, name: `Option ${i + 1} photo` });
      rect(c, `option-${i + 1}-shade`, { x, y: top + ch * 0.5, w: cw, h: ch * 0.5 }, { gradient: { from: CLEAR, to: BLACK } });
      text(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x + 24, y: top + ch - 150, w: 100, h: 90 }, { size: 90, font: "condensed", weight: 900, italic: true, color: "@primary", shadow: GLOW });
      big(c, `option-${i + 1}`, opt, { x: x + 24, y: top + ch - 70, w: cw - 48, h: 60 }, 56);
    });
    meta(c, "meta-1", k.meta[0] ?? "", c.B - 36);
    return;
  }
  poster(c);
  if (k.key === "map") pin(c, Math.round(c.W * 0.6), Math.round(c.H * 0.3), "@primary");
  corner(c, k);
  if (has(k.badge)) {
    text(c, "badge", k.badge, { x: c.W - c.M - 320, y: c.T + 130, w: 320, h: 110 }, { size: 100, font: "condensed", weight: 900, italic: true, color: "@accent", upper: true, align: "end", fit: true, shadow: GLOW });
  }
  const manifesto = k.key === "manifesto";
  const hs = c.pick(manifesto ? 116 : 170, manifesto ? 92 : 130, manifesto ? 130 : 190);
  stackUp(c.B, [
    { h: 40, gap: 22, draw: (y) => kicker(c, k.kicker, c.M, y, c.CW) },
    { h: Math.round(hs * (manifesto ? 2.8 : 1.85)), gap: 24, draw: (y) => big(c, "headline", k.headline ?? "", { x: c.M - 10, y, w: c.CW + 10, h: Math.round(hs * (manifesto ? 2.8 : 1.85)) }, hs) },
    has(k.sub) && { h: 50, gap: 20, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: 50 }, { size: 34, font: "body", weight: 500, color: SOFT, fit: true }) },
    k.pills.length > 0 && { h: 2, gap: 18, draw: (y) => rule(c, "info-rule", c.M, y, c.CW, "#FFFFFF40", 2) },
    k.pills.length > 0 && { h: 40, gap: 18, draw: (y) => text(c, "pills", k.pills.filter(Boolean).join("   ·   "), { x: c.M, y, w: c.CW, h: 40 }, { size: 32, font: "condensed", weight: 800, color: WHITE, upper: true, fit: true }) },
    k.cta && { h: 50, draw: (y) => text(c, "cta", k.cta!, { x: c.M, y, w: c.CW, h: 50 }, { size: 40, font: "condensed", weight: 900, italic: true, color: "@accent", upper: true, fit: true }) },
  ]);
};

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 400 }, { gradient: { from: "#000000CC", to: CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 900, w: c.W, h: 900 }, { gradient: { from: CLEAR, to: "#000000F0" } });
    rect(c, "smoke", { x: 0, y: c.H - 700, w: c.W, h: 700 }, { gradient: { from: "@primary", to: CLEAR, angle: 0 }, opacity: 0.4 });
  },
  frame: (c, k, t) => {
    crest(c, "crest", { x: c.W - c.M - 80, y: c.T, w: 80, h: 80 }, t);
    text(c, "academy", k.academy, { x: c.M, y: c.T + 24, w: 640, h: 36 }, { size: 24, font: "body", weight: 700, color: SOFT, upper: true, ls: 8, fit: true, ...t });
  },
  tag: (c, k, t) => kicker(c, k.kicker, c.M, c.B - 520, c.CW, t),
  goal: (c, k, t) => {
    const s = k.score!;
    big(c, "number", `#${k.number ?? ""}`, { x: c.M - 10, y: c.B - 460, w: c.CW, h: 260 }, 280, { num: true, ...t });
    text(c, "name", k.name ?? "", { x: c.M, y: c.B - 190, w: c.CW, h: 56 }, { size: 46, font: "condensed", weight: 800, italic: true, color: WHITE, upper: true, fit: true, ...t });
    text(c, "score", `${s.ownName} ${s.own}–${s.opp} ${s.oppName}`, { x: c.M, y: c.B - 120, w: c.CW, h: 56 }, { size: 44, font: "condensed", weight: 900, italic: true, color: "@accent", upper: true, fit: true, ...t });
  },
  speaker: (c, k, t) => {
    big(c, "speaker", k.headline ?? "", { x: c.M - 10, y: c.B - 440, w: c.CW, h: 110 }, 100, t);
    text(c, "role", k.sub ?? "", { x: c.M, y: c.B - 320, w: c.CW, h: 40 }, { size: 28, font: "body", weight: 700, color: SOFT, upper: true, ls: 6, fit: true, ...t });
  },
  title: (c, k, t) => {
    big(c, "headline", k.headline ?? "", { x: c.M - 10, y: c.B - 460, w: c.CW, h: 320 }, 170, t);
    text(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 110, w: c.CW, h: 40 }, { size: 28, font: "body", weight: 700, color: SOFT, upper: true, ls: 6, fit: true, ...t });
  },
  caption: (c, id, value, t) => text(c, id, value, { x: c.M, y: c.B - 220, w: c.CW, h: 170 }, { size: 46, font: "condensed", weight: 800, italic: true, color: WHITE, upper: true, align: "center", lh: 1.05, fit: true, shadow: { color: BLACK, blur: 18, x: 0, y: 4 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: BLACK, ...t });
    rect(c, "end-smoke", { x: 0, y: c.H / 2, w: c.W, h: c.H / 2 }, { gradient: { from: "@primary", to: CLEAR, angle: 0 }, opacity: 0.55, ...t });
    crest(c, "end-crest", { x: c.W / 2 - 140, y: c.H / 2 - 260, w: 280, h: 280 }, t);
    big(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 60, w: c.CW, h: 110 }, 90, { align: "center", ...t });
  },
};

export const cinematic: StyleKit = { background: BLACK, plate: { opacity: 1 }, score, fixture, hero, list, promo, skin };
