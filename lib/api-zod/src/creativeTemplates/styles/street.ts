import type { Content } from "../content";
import { crest, ellipse, media, rect, text, type Ctx, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackUp } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Street: loud. Huge stacked condensed capitals that run off the edges,
 * outline type, tape strips and stickers stuck on at an angle. Black and
 * white with the academy's colours as the paint.
 */

const INK = "#0A0A0A";
const WHITE = "#FFFFFF";
const CLEAR = "#00000000";
const OUTLINE = { color: WHITE, width: 4 };

/** Tape: a strip with type on it, stuck on at an angle. */
function tape(c: Ctx, id: string, value: string, x: number, y: number, w: number, o: { h?: number; size?: number; rot?: number; fill?: string; ink?: string } & Timing = {}) {
  const h = o.h ?? 76;
  const { h: _h, size, rot, fill, ink, ...t } = o;
  rect(c, `${id}-tape`, { x, y, w, h }, { fill: fill ?? "@accent", rotation: rot ?? -4, ...t });
  text(c, id, value, { x: x + 22, y: y + h * 0.14, w: w - 44, h: h * 0.72 }, { size: size ?? Math.round(h * 0.6), font: "condensed", weight: 800, color: ink ?? INK, upper: true, fit: true, rotation: rot ?? -4, ...t });
}

/** A huge line of type running off both edges. */
function shout(c: Ctx, id: string, value: string, y: number, size: number, o: { outline?: boolean; color?: string; rot?: number } & Timing = {}) {
  const { outline, color, rot, ...t } = o;
  text(c, id, value, { x: c.M - 16, y, w: c.W - c.M + 120, h: Math.round(size * 1.02) }, {
    size, font: "condensed", weight: 900, upper: true, lh: 0.9, fit: true, rotation: rot ?? -4, name: "bleed",
    color: outline ? CLEAR : color ?? WHITE, ...(outline ? { stroke: OUTLINE } : {}), ...t,
  });
}

function photoBg(c: Ctx, dim = 0.45) {
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo" });
  rect(c, "photo-dim", { x: 0, y: 0, w: c.W, h: c.H }, { fill: INK, opacity: dim });
  rect(c, "photo-shade", { x: 0, y: Math.round(c.H * 0.45), w: c.W, h: c.H - Math.round(c.H * 0.45) }, { gradient: { from: CLEAR, to: INK } });
}

function corner(c: Ctx, k: Content) {
  crest(c, "crest", { x: c.W - c.M - 110, y: c.T, w: 110, h: 110 });
  text(c, "academy", k.academy, { x: c.M, y: c.T + 34, w: 640, h: 40 }, { size: 30, font: "condensed", weight: 800, color: WHITE, upper: true, ls: 4, fit: true });
}

/** Proportional y inside the safe area. */
const at = (c: Ctx, f: number) => Math.round(c.T + f * (c.B - c.T));

const score: StyleKit["score"] = (c, k) => {
  photoBg(c);
  const s = k.score!;
  const top = c.T + 150;
  const foot = 40 + (has(k.sub) ? 74 + 30 : 0) + 40;
  // own name, score (1.5×), opponent outline: about 3.4 × the name size tall.
  const big = Math.min(c.pick(250, 200, 280), Math.floor((c.B - foot - top) / 3.45));
  tape(c, "kicker", k.kicker, c.M, top - 60, 420, { h: 84, rot: -6 });
  stackDown(top + 40, [
    { h: Math.round(big * 1.02), gap: 0, draw: (y) => shout(c, "own", s.ownName, y, big) },
    { h: Math.round(big * 1.45), gap: 10, draw: (y) => text(c, "score", `${s.own}–${s.opp}`, { x: c.M, y, w: c.CW, h: Math.round(big * 1.45) }, {
      size: Math.round(big * 1.6), font: "display", weight: 900, color: "@accent", num: true, fit: true, rotation: -4, lh: 0.9,
      shadow: { color: "@primary", blur: 0, x: 14, y: 14 },
    }) },
    { h: Math.round(big * 1.02), draw: (y) => shout(c, "opp", s.oppName, y, big, { outline: true }) },
  ]);
  stackUp(c.B, [
    has(k.sub) && { h: 74, gap: 30, draw: (y) => tape(c, "scorers", k.sub!, c.M + 20, y, 560, { h: 74, rot: 3, fill: WHITE }) },
    { h: 40, draw: (y) => text(c, "meta", k.meta.join("  /  "), { x: c.M, y, w: c.CW, h: 40 }, { size: 28, font: "condensed", weight: 800, color: WHITE, upper: true, ls: 4, fit: true }) },
  ]);
  corner(c, k);
};

const fixture: StyleKit["fixture"] = (c, k) => {
  photoBg(c, 0.5);
  const v = k.vs!;
  const [day, time, place] = k.pills;
  const foot = 66 + 14 + 66 + 20 + 36;
  const headSize = c.pick(200, 150, 240);
  const top = c.T + (k.headline ? 170 : 120);
  if (k.headline) tape(c, "kicker", k.kicker, c.M, c.T + 110, 380, { h: 72, rot: 4, fill: "@primary", ink: WHITE });
  shout(c, "headline", k.headline ?? k.kicker, top, headSize, { color: "@accent", rot: -6 });
  const y = top + headSize + 30;
  const big = Math.min(c.pick(200, 150, 240), Math.floor((c.B - foot - 40 - y - 60) / 2.04));
  shout(c, "own", v.ownName, y, big);
  ellipse(c, "vs-sticker", { x: c.W - c.M - 150, y: y + big - 40, w: 150, h: 150 }, { fill: "@accent", rotation: 10 });
  text(c, "vs", v.label, { x: c.W - c.M - 150, y: y + big - 2, w: 150, h: 70 }, { size: 64, font: "condensed", weight: 900, color: INK, upper: true, align: "center", rotation: 10 });
  shout(c, "opp", v.oppName, y + big + 60, big, { outline: true });
  stackUp(c.B, [
    { h: 66, gap: 14, draw: (yy) => tape(c, "pill-1", [day, time].filter(Boolean).join("  /  "), c.M, yy, c.pick(620, 600, 660), { h: 66, rot: -2 }) },
    has(place) && { h: 66, gap: 20, draw: (yy) => tape(c, "pill-2", place!, c.M + 40, yy, c.pick(600, 580, 640), { h: 66, rot: 2, fill: WHITE }) },
    { h: 36, draw: (yy: number) => text(c, "meta", k.meta.join("  /  "), { x: c.M, y: yy, w: c.CW, h: 36 }, { size: 26, font: "condensed", weight: 800, color: WHITE, upper: true, ls: 4, fit: true }) },
  ]);
  corner(c, k);
};

const hero: StyleKit["hero"] = (c, k) => {
  photoBg(c, 0.25);
  const { head, tag } = heroWords(k);
  if (has(k.number)) {
    text(c, "number-ghost", k.number, { x: c.W - 620, y: c.T - 80, w: 700, h: 640 }, {
      size: 600, font: "condensed", weight: 900, color: CLEAR, stroke: { color: "@accent", width: 6 }, num: true, align: "end", name: "bleed", fit: true,
    });
  }
  tape(c, "kicker", tag, c.M, at(c, 0.12), 470, { h: 80, rot: -6 });
  if (k.stat) {
    const sx = c.M + 10;
    const sy = at(c, 0.24);
    ellipse(c, "stat-sticker", { x: sx, y: sy, w: 230, h: 230 }, { fill: "@primary", rotation: -8 });
    text(c, "stat", k.stat.value, { x: sx, y: sy + 30, w: 230, h: 120 }, { size: 120, font: "display", weight: 900, color: WHITE, align: "center", num: true, rotation: -8 });
    text(c, "stat-label", k.stat.label, { x: sx + 20, y: sy + 148, w: 190, h: 40 }, { size: 30, font: "condensed", weight: 800, color: WHITE, upper: true, align: "center", fit: true, rotation: -8 });
  }
  const size = c.pick(190, 150, 210);
  stackUp(c.B, [
    { h: Math.round(size * 2), gap: 20, draw: (y) => text(c, "headline", head, { x: c.M - 16, y, w: c.W - c.M + 60, h: Math.round(size * 2) }, {
      size, font: "condensed", weight: 900, color: WHITE, upper: true, lh: 0.88, fit: true, rotation: -4, name: "bleed",
      shadow: { color: "@primary", blur: 0, x: 10, y: 10 },
    }) },
    has(k.number) && { h: 84, gap: 14, draw: (y) => {
      rect(c, "number-tag", { x: c.M, y, w: 180, h: 84 }, { fill: "@accent", rotation: 3 });
      text(c, "number", `#${k.number}`, { x: c.M, y: y + 8, w: 180, h: 68 }, { size: 64, font: "condensed", weight: 900, color: INK, align: "center", num: true, rotation: 3 });
      text(c, "name", k.name ?? "", { x: c.M + 210, y: y + 14, w: c.CW - 210, h: 60 }, { size: 52, font: "condensed", weight: 800, color: WHITE, upper: true, fit: true });
    } },
    has(k.sub) && { h: 70, gap: 14, draw: (y) => tape(c, "sub", k.sub!, c.M, y, c.CW - 60, { h: 70, rot: 2, fill: WHITE, size: 40 }) },
    { h: 36, draw: (y) => text(c, "meta", k.meta.join("  /  "), { x: c.M, y, w: c.CW, h: 36 }, { size: 26, font: "condensed", weight: 800, color: WHITE, upper: true, ls: 4, fit: true }) },
  ]);
  corner(c, k);
};

/** Line-up photo tiles: a slab of brand paint, a white number, a strip of tape for the name. */
const TILE: TileLook = {
  backdrop: (c, id, b, i) => rect(c, id, b, { fill: i % 2 ? "@primary" : "@accent", rotation: i % 2 ? 1.5 : -1.5 }),
  bar: (c, id, b, i) => rect(c, id, { x: b.x - 6, y: b.y, w: b.w + 12, h: b.h }, { fill: WHITE, rotation: i % 2 ? -1 : 1 }),
  num: { font: "condensed", color: WHITE, weight: 900, stroke: { color: INK, width: 6 } },
  name: { font: "condensed", color: INK, weight: 900 },
  pos: { font: "condensed", color: "@primary", weight: 900 },
  shadow: INK,
  cardRadius: 0,
};

const list: StyleKit["list"] = (c, k) => {
  rect(c, "paint", { x: 0, y: 0, w: c.W, h: c.pick(380, 330, 520) }, { fill: "@primary" });
  shout(c, "kicker", k.kicker, c.T + 90, c.pick(170, 140, 190), { rot: -5 });
  const headY = c.pick(380, 330, 520) - 50;
  tape(c, "headline", k.headline ?? "", c.M, headY, c.pick(720, 680, 760), { h: 92, rot: -3 });
  const rows = k.rows ?? [];
  const footH = (k.cta ? 96 : 0) + 60;
  const lead = numericLead(k);
  rowsOrTiles(c, k, { x: c.M, y: headY + 140, w: c.CW, h: c.B - footH - 30 - headY - 140 }, TILE, () => rowBoxes(rows.length, headY + 140, c.B - footH, c.M, c.CW, { gap: 14, maxH: Math.round((lead ? 104 : 130) * c.k) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    const first = i === 0;
    if (first) rect(c, `${id}-bg`, b, { fill: WHITE, rotation: -1 });
    else rect(c, `${id}-rule`, { x: b.x, y: b.y + b.h - 3, w: b.w, h: 3 }, { fill: WHITE, opacity: 0.25 });
    const lw = lead ? Math.round(b.h * 1.2) : Math.round(b.w * 0.34);
    text(c, `${id}-lead`, row[0], { x: b.x + 12, y: b.y + b.h * 0.12, w: lw, h: b.h * 0.76 }, { size: Math.round(b.h * (lead ? 0.72 : 0.42)), font: "condensed", weight: 900, color: first ? INK : "@accent", upper: true, num: lead, fit: true });
    text(c, `${id}-main`, row[1], { x: b.x + lw + 30, y: b.y + b.h * 0.2, w: b.w - lw - 30 - 220, h: b.h * 0.6 }, { size: Math.round(b.h * (lead ? 0.5 : 0.32)), font: lead ? "condensed" : "body", weight: 800, color: first ? INK : WHITE, upper: lead, fit: true });
    text(c, `${id}-trail`, row[2], { x: b.x + b.w - 216, y: b.y + b.h * 0.18, w: 200, h: b.h * 0.64 }, { size: Math.round(b.h * 0.5), font: "condensed", weight: 900, color: first ? INK : WHITE, upper: true, align: "end", fit: true });
  }));
  stackUp(c.B, [
    k.cta && { h: 80, gap: 16, draw: (y) => tape(c, "cta", k.cta!, c.M, y, c.CW - 40, { h: 80, rot: -2 }) },
    { h: 36, draw: (y) => text(c, "meta", k.meta.join("  /  "), { x: c.M, y, w: c.CW, h: 36 }, { size: 26, font: "condensed", weight: 800, color: WHITE, upper: true, ls: 4, fit: true }) },
  ]);
  corner(c, k);
};

const promo: StyleKit["promo"] = (c, k) => {
  if (k.options) {
    rect(c, "paint", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "@primary", to: INK } });
    corner(c, k);
    tape(c, "kicker", k.kicker, c.M, c.T + 130, 400, { h: 76, rot: -5 });
    shout(c, "headline", k.headline ?? "", c.T + 230, c.pick(150, 120, 170), { rot: -3 });
    const top = c.T + 230 + c.pick(210, 170, 250);
    const cw = (c.CW - 40) / 2;
    const ch = Math.min(c.B - 70 - top, cw * 1.5);
    k.options.forEach((opt, i) => {
      const x = c.M + i * (cw + 40) + 10;
      const rot = i ? 3 : -3;
      rect(c, `option-${i + 1}-frame`, { x: x - 14, y: top - 14, w: cw - 20 + 28, h: ch + 28 }, { fill: WHITE, rotation: rot });
      media(c, `option-${i + 1}-photo`, { x, y: top, w: cw - 20, h: ch }, { path: `more.${i}`, rotation: rot, name: `Option ${i + 1} photo` });
      text(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x + 10, y: top + 10, w: 120, h: 120 }, { size: 110, font: "condensed", weight: 900, color: "@accent", rotation: rot, shadow: { color: INK, blur: 0, x: 6, y: 6 } });
      tape(c, `option-${i + 1}`, opt, x + 20, top + ch - 60, cw - 60, { h: 80, rot: -rot, fill: i ? WHITE : "@accent" });
    });
    text(c, "meta", k.meta[0] ?? "", { x: c.M, y: c.B - 40, w: c.CW, h: 36 }, { size: 28, font: "condensed", weight: 800, color: WHITE, upper: true, ls: 4 });
    return;
  }
  photoBg(c, 0.35);
  if (k.key === "map") pin(c, Math.round(c.W * 0.62), at(c, 0.3), "@accent");
  corner(c, k);
  tape(c, "kicker", k.kicker, c.M, at(c, 0.1), 460, { h: 80, rot: -5, fill: "@primary", ink: WHITE });
  if (has(k.badge)) {
    rect(c, "badge-sticker", { x: c.W - c.M - 230, y: c.T + 150, w: 220, h: 220 }, { fill: "@accent", rotation: 12, radius: 18 });
    text(c, "badge", k.badge, { x: c.W - c.M - 220, y: c.T + 210, w: 200, h: 100 }, { size: 80, font: "condensed", weight: 900, color: INK, upper: true, align: "center", fit: true, rotation: 12 });
  }
  const manifesto = k.key === "manifesto";
  const size = c.pick(manifesto ? 140 : 190, manifesto ? 104 : 130, manifesto ? 156 : 220);
  stackUp(c.B, [
    { h: Math.round(size * (manifesto ? 3.4 : 2)), gap: 26, draw: (y) => text(c, "headline", k.headline ?? "", { x: c.M - 16, y, w: c.W - c.M + 60, h: Math.round(size * (manifesto ? 3.4 : 2)) }, {
      size, font: "condensed", weight: 900, color: WHITE, upper: true, lh: 0.88, fit: true, rotation: -4, name: "bleed",
      shadow: { color: "@primary", blur: 0, x: 10, y: 10 },
    }) },
    has(k.sub) && { h: 70, gap: 18, draw: (y) => tape(c, "sub", k.sub!, c.M, y, c.CW - 40, { h: 70, rot: 2, fill: WHITE, size: 38 }) },
    k.pills.length > 0 && { h: 60, gap: 22, draw: (y) => {
      const pw = (c.CW - 16 * (k.pills.length - 1)) / k.pills.length;
      k.pills.forEach((p, i) => text(c, `pill-${i + 1}`, p, { x: c.M + i * (pw + 16), y: y + 6, w: pw, h: 48 }, { size: 36, font: "condensed", weight: 800, color: WHITE, upper: true, fit: true, stroke: undefined }));
      rect(c, "pills-rule", { x: c.M, y: y + 58, w: c.CW, h: 4 }, { fill: "@accent" });
    } },
    k.cta && { h: 82, draw: (y) => tape(c, "cta", k.cta!, c.M, y, c.CW - 20, { h: 82, rot: -2 }) },
  ]);
};

const skin: StyleKit["skin"] = {
  shade: (c) => rect(c, "shade", { x: 0, y: c.H - 900, w: c.W, h: 900 }, { gradient: { from: CLEAR, to: "#0A0A0AE0" } }),
  frame: (c, k, t) => {
    crest(c, "crest", { x: c.W - c.M - 100, y: c.T, w: 100, h: 100 }, t);
    text(c, "academy", k.academy, { x: c.M, y: c.T + 30, w: 640, h: 40 }, { size: 30, font: "condensed", weight: 800, color: WHITE, upper: true, ls: 4, fit: true, ...t });
  },
  tag: (c, k, t) => tape(c, "kicker", k.kicker, c.M, c.B - 560, k.video?.variant === "goal" ? 360 : 480, { h: 90, rot: -6, ...t }),
  goal: (c, k, t) => {
    const s = k.score!;
    text(c, "number", `#${k.number ?? ""}`, { x: c.M - 16, y: c.B - 450, w: c.W - c.M + 60, h: 260 }, { size: 260, font: "condensed", weight: 900, color: WHITE, num: true, rotation: -4, fit: true, name: "bleed", shadow: { color: "@primary", blur: 0, x: 12, y: 12 }, ...t });
    text(c, "name", k.name ?? "", { x: c.M, y: c.B - 190, w: c.CW, h: 56 }, { size: 50, font: "condensed", weight: 800, color: WHITE, upper: true, fit: true, ...t });
    tape(c, "score", `${s.ownName} ${s.own}–${s.opp} ${s.oppName}`, c.M, c.B - 110, c.CW - 40, { h: 96, rot: 2, fill: WHITE, ...t });
  },
  speaker: (c, k, t) => {
    tape(c, "speaker", k.headline ?? "", c.M, c.B - 440, 700, { h: 90, rot: -3, fill: WHITE, ...t });
    tape(c, "role", k.sub ?? "", c.M + 40, c.B - 340, 520, { h: 64, rot: 2, ...t });
  },
  title: (c, k, t) => {
    text(c, "headline", k.headline ?? "", { x: c.M - 16, y: c.B - 460, w: c.W - c.M + 60, h: 360 }, { size: 180, font: "condensed", weight: 900, color: WHITE, upper: true, lh: 0.88, fit: true, rotation: -4, name: "bleed", shadow: { color: "@primary", blur: 0, x: 10, y: 10 }, ...t });
    tape(c, "meta", k.meta[0] ?? "", c.M, c.B - 80, 600, { h: 72, rot: 2, fill: WHITE, ...t });
  },
  caption: (c, id, value, t) => text(c, id, value, { x: c.M, y: c.B - 200, w: c.CW, h: 170 }, { size: 52, font: "condensed", weight: 800, color: INK, upper: true, align: "center", lh: 1.05, fit: true, bg: { color: "@accent", padding: 16, radius: 0 }, rotation: -2, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: "@primary", ...t });
    shout(c, "end-shout", k.academy, c.H / 2 - 420, 200, { outline: true, ...t });
    crest(c, "end-crest", { x: c.W / 2 - 160, y: c.H / 2 - 160, w: 320, h: 320 }, t);
    tape(c, "end-name", k.academy, c.M + 60, c.H / 2 + 220, c.CW - 120, { h: 90, rot: -3, ...t });
  },
};

export const street: StyleKit = { background: INK, plate: { opacity: 0.75 }, score, fixture, hero, list, promo, skin };
