import type { Content } from "../content";
import { crest, ellipse, media, rect, slant, text, type Box, type Ctx, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";

/**
 * Stadium: a bright night under the floodlights. A deep gradient from the
 * academy colour down to midnight, diagonal light rays from the corners, a big
 * photo, bold white type, the crest and name as a lockup at the top and clean
 * info pills along the bottom.
 */

const NIGHT = "#040A1C";
const WHITE = "#FFFFFF";
const SOFT = "#C9D3EA";
const GLASS = "#FFFFFF1F";
const GLASS_EDGE = "#FFFFFF40";
const CLEAR = "#040A1C00";

function night(c: Ctx) {
  rect(c, "sky", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "@primary", to: NIGHT } });
  rect(c, "sky-deep", { x: 0, y: Math.round(c.H * 0.4), w: c.W, h: c.H - Math.round(c.H * 0.4) }, { gradient: { from: CLEAR, to: NIGHT } });
  rays(c, 1);
}

/** Floodlight rays from both top corners (drawn again, fainter, over the photo). */
function rays(c: Ctx, pass: number, t: Timing = {}) {
  const k = pass === 1 ? 1 : 0.45;
  const len = Math.round(c.H * 1.1);
  // [centre x of the beam's top, width, angle, opacity]: two beams from each corner floodlight.
  const list: Array<[number, number, number, number]> = [[60, 220, -28, 0.16], [120, 110, -14, 0.11], [c.W - 60, 220, 28, 0.16], [c.W - 120, 110, 14, 0.11]];
  list.forEach(([cx, w, deg, o], i) => {
    // A rotated rect turns about its centre; place the centre so the top end sits at the corner light.
    const a = (deg * Math.PI) / 180;
    const x = cx - Math.sin(a) * (len / 2) - w / 2;
    const y = -40 + Math.cos(a) * (len / 2) - len / 2;
    rect(c, `ray-${pass}-${i + 1}`, { x, y, w, h: len }, { gradient: { from: WHITE, to: "#FFFFFF00" }, opacity: o * k, rotation: deg, name: "bleed", mirror: false, ...t });
  });
}

/** Crest and name, centred at the top. Returns the y under it. */
function lockup(c: Ctx, k: Content, t: Timing = {}, size = 120): number {
  crest(c, "crest", { x: c.W / 2 - size / 2, y: c.T, w: size, h: size }, t);
  text(c, "academy", k.academy, { x: c.M, y: c.T + size + 14, w: c.CW, h: 44 }, { size: 34, font: "display", weight: 800, color: WHITE, upper: true, ls: 3, align: "center", fit: true, mirror: false, ...t });
  return c.T + size + 70;
}

/** The big photo, fading into the night at the bottom. */
function stagePhoto(c: Ctx, b: Box, path = "media", id = "photo") {
  if (b.h < 160) return;
  media(c, id, b, { name: "Photo", path });
  rect(c, `${id}-fade`, { x: b.x, y: b.y + Math.round(b.h * 0.45), w: b.w, h: b.h - Math.round(b.h * 0.45) }, { gradient: { from: CLEAR, to: NIGHT } });
  rect(c, `${id}-fade-top`, { x: b.x, y: b.y, w: b.w, h: Math.round(b.h * 0.3) }, { gradient: { from: "@primary", to: "#00000000" } });
  if (id === "photo") rays(c, 2);
}

/** A row of glassy pills; the first one is solid accent. */
function pills(c: Ctx, values: string[], y: number, h = 76, t: Timing = {}) {
  const list = values.filter((v) => v.trim());
  const gap = 14;
  const w = (c.CW - gap * (list.length - 1)) / Math.max(1, list.length);
  list.forEach((v, i) => {
    const x = c.M + i * (w + gap);
    rect(c, `pill-${i + 1}-bg`, { x, y, w, h }, { fill: i === 0 ? "@accent" : GLASS, radius: h / 2, ...(i === 0 ? {} : { stroke: { color: GLASS_EDGE, width: 2 } }), ...t });
    text(c, `pill-${i + 1}`, v, { x: x + 26, y: y + h * 0.22, w: w - 52, h: h * 0.56 }, { size: Math.round(h * 0.42), font: "display", weight: 800, color: i === 0 ? NIGHT : WHITE, upper: true, align: "center", fit: true, ...t });
  });
}

function tagPill(c: Ctx, id: string, value: string, x: number, y: number, w: number, t: Timing = {}) {
  rect(c, `${id}-bg`, { x, y, w, h: 64 }, { fill: "@accent", radius: 32, ...t });
  text(c, id, value, { x: x + 26, y: y + 13, w: w - 52, h: 38 }, { size: 30, font: "display", weight: 800, color: NIGHT, upper: true, align: "center", fit: true, ...t });
}

const big = (c: Ctx, id: string, value: string, b: Box, size: number, o: { align?: "start" | "center" | "end"; color?: string; num?: boolean; opacity?: number; mirror?: boolean } & Timing = {}) => {
  const { align, color, num, ...t } = o;
  return text(c, id, value, b, { size, font: "display", weight: 900, color: color ?? WHITE, upper: true, lh: 0.95, fit: true, align, num, shadow: { color: "#00000066", blur: 24, x: 0, y: 8 }, ...t });
};

const score: StyleKit["score"] = (c, k) => {
  night(c);
  const s = k.score!;
  const ss = c.pick(240, 190, 270);
  const items: StackItem[] = [
    { h: 64, gap: 24, draw: (y) => tagPill(c, "kicker", k.kicker, c.W / 2 - 180, y, 360) },
    { h: Math.round(ss * 0.95), gap: 14, draw: (y) => {
      const sw = 520;
      big(c, "score", `${s.own} – ${s.opp}`, { x: c.W / 2 - sw / 2, y, w: sw, h: Math.round(ss * 0.95) }, ss, { align: "center", num: true, mirror: false });
      big(c, "own", s.ownName, { x: c.M, y: y + ss * 0.3, w: (c.CW - sw) / 2 - 10, h: ss * 0.4 }, 46, { align: "end" });
      big(c, "opp", s.oppName, { x: c.W / 2 + sw / 2 + 10, y: y + ss * 0.3, w: (c.CW - sw) / 2 - 10, h: ss * 0.4 }, 46, { align: "start" });
    } },
    has(k.sub) && { h: 44, gap: 24, draw: (y) => text(c, "scorers", k.sub!, { x: c.M, y, w: c.CW, h: 44 }, { size: 36, font: "display", weight: 800, color: SOFT, upper: true, align: "center", fit: true }) },
    { h: 70, draw: (y) => pills(c, k.meta, y, 70) },
  ];
  const y = c.B - stackHeight(items);
  const top = lockup(c, k);
  stagePhoto(c, { x: 0, y: top + 10, w: c.W, h: y - 20 - top });
  stackDown(y, items);
};

const fixture: StyleKit["fixture"] = (c, k) => {
  night(c);
  const v = k.vs!;
  const hs = c.pick(150, 120, 170);
  const ts = c.pick(76, 62, 84);
  const items: StackItem[] = [
    { h: 64, gap: 20, draw: (y) => tagPill(c, "kicker", k.headline ? k.kicker : (k.meta[0] ?? ""), c.M, y, 420) },
    { h: Math.round(hs * 1.0), gap: 20, draw: (y) => big(c, "headline", k.headline ?? k.kicker, { x: c.M, y, w: c.CW, h: hs }, hs) },
    { h: ts, gap: 4, draw: (y) => big(c, "own", v.ownName, { x: c.M, y, w: c.CW, h: ts }, ts) },
    { h: 44, gap: 4, draw: (y) => text(c, "vs", v.label, { x: c.M, y, w: 200, h: 44 }, { size: 36, font: "display", weight: 900, color: "@accent", upper: true }) },
    { h: ts, gap: 30, draw: (y) => big(c, "opp", v.oppName, { x: c.M, y, w: c.CW, h: ts }, ts, { color: SOFT }) },
    { h: 76, gap: 14, draw: (y) => pills(c, k.pills.slice(0, 2), y) },
    has(k.pills[2]) && { h: 66, draw: (y) => {
      rect(c, "place-bg", { x: c.M, y, w: c.CW, h: 66 }, { fill: GLASS, radius: 33, stroke: { color: GLASS_EDGE, width: 2 } });
      text(c, "place", k.pills[2], { x: c.M + 30, y: y + 14, w: c.CW - 60, h: 38 }, { size: 30, font: "display", weight: 700, color: WHITE, upper: true, align: "center", fit: true });
    } },
  ];
  const y = c.B - stackHeight(items);
  const top = lockup(c, k);
  stagePhoto(c, { x: 0, y: top + 10, w: c.W, h: y - 20 - top });
  stackDown(y, items);
};

const hero: StyleKit["hero"] = (c, k) => {
  night(c);
  const { head, tag } = heroWords(k);
  const top = lockup(c, k);
  if (has(k.number)) {
    big(c, "number-ghost", k.number, { x: c.M, y: top, w: c.CW, h: c.pick(560, 380, 720) }, c.pick(560, 380, 700), { align: "center", num: true, color: WHITE, opacity: 0.14, mirror: false });
  }
  const hs = c.pick(120, 96, 136);
  const items: StackItem[] = [
    { h: 64, gap: 22, draw: (y) => tagPill(c, "kicker", tag, c.M, y, Math.min(560, c.CW)) },
    { h: Math.round(hs * 1.95), gap: 16, draw: (y) => big(c, "headline", head, { x: c.M, y, w: c.CW, h: Math.round(hs * 1.95) }, hs) },
    (has(k.number) || has(k.name)) && { h: 64, gap: 18, draw: (y) => {
      if (has(k.number)) {
        ellipse(c, "number-disc", { x: c.M, y, w: 64, h: 64 }, { fill: "@accent" });
        text(c, "number", k.number!, { x: c.M, y: y + 12, w: 64, h: 40 }, { size: 34, font: "display", weight: 900, color: NIGHT, align: "center", num: true, fit: true });
      }
      text(c, "name", k.name ?? "", { x: c.M + (has(k.number) ? 84 : 0), y: y + 6, w: c.CW - 84, h: 52 }, { size: 44, font: "display", weight: 800, color: WHITE, upper: true, fit: true });
    } },
    has(k.sub) && { h: 80, gap: 18, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: 80 }, { size: 32, font: "body", weight: 600, color: SOFT, lh: 1.25, fit: true }) },
    { h: 70, draw: (y) => pills(c, [...(k.stat ? [`${k.stat.value} ${k.stat.label}`] : []), ...k.meta].slice(0, 2), y, 70) },
  ];
  const y = c.B - stackHeight(items);
  stagePhoto(c, { x: 0, y: top + 10, w: c.W, h: y + 40 - top });
  stackDown(y, items);
};

const list: StyleKit["list"] = (c, k) => {
  night(c);
  const top = lockup(c, k, {}, 100);
  tagPill(c, "kicker", k.kicker, c.W / 2 - 220, top + 10, 440);
  const hs = c.pick(80, 68, 90);
  big(c, "headline", k.headline ?? "", { x: c.M, y: top + 100, w: c.CW, h: hs }, hs, { align: "center" });
  const rows = k.rows ?? [];
  const lead = numericLead(k);
  const foot = (k.cta ? 90 : 0) + k.meta.length * 44 + 24;
  rowBoxes(rows.length, top + 100 + hs + 40, c.B - foot, c.M, c.CW, { gap: 12, maxH: Math.round((lead ? 100 : 124) * c.k) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    rect(c, `${id}-bg`, b, { fill: i === 0 ? "#FFFFFF33" : GLASS, radius: 20, stroke: { color: GLASS_EDGE, width: 2 } });
    const lw = lead ? Math.round(b.h * 1.1) : Math.round(b.w * 0.34);
    rect(c, `${id}-lead-bg`, { x: b.x + 8, y: b.y + 8, w: lw - 16, h: b.h - 16 }, { fill: i === 0 ? "@accent" : "#FFFFFF1A", radius: 14 });
    text(c, `${id}-lead`, row[0], { x: b.x + 18, y: b.y + b.h * 0.24, w: lw - 36, h: b.h * 0.52 }, { size: Math.round(b.h * (lead ? 0.46 : 0.3)), font: "display", weight: 900, color: i === 0 ? NIGHT : WHITE, upper: true, align: "center", num: lead, fit: true });
    text(c, `${id}-main`, row[1], { x: b.x + lw + 20, y: b.y + b.h * 0.26, w: b.w - lw - 20 - 210, h: b.h * 0.48 }, { size: Math.round(b.h * (lead ? 0.38 : 0.26)), font: lead ? "display" : "body", weight: lead ? 800 : 600, color: WHITE, upper: lead, fit: true });
    text(c, `${id}-trail`, row[2], { x: b.x + b.w - 200, y: b.y + b.h * 0.24, w: 176, h: b.h * 0.52 }, { size: Math.round(b.h * 0.4), font: "display", weight: 900, color: "@accent", upper: true, align: "end", fit: true });
  });
  stackUp(c.B, [
    ...k.meta.map((m, i) => ({ h: 36, gap: 8, draw: (y: number) => text(c, `meta-${i + 1}`, m, { x: c.M, y, w: c.CW, h: 36 }, { size: 28, font: "display", weight: 700, color: SOFT, upper: true, align: "center", fit: true }) })),
    k.cta && { h: 76, draw: (y: number) => tagPill(c, "cta", k.cta!, c.M + 80, y + 6, c.CW - 160) },
  ]);
};

const promo: StyleKit["promo"] = (c, k) => {
  night(c);
  const top = lockup(c, k);
  if (k.options) {
    tagPill(c, "kicker", k.kicker, c.W / 2 - 200, top + 10, 400);
    const hs = c.pick(110, 90, 130);
    big(c, "headline", k.headline ?? "", { x: c.M, y: top + 100, w: c.CW, h: hs * 2 }, hs, { align: "center" });
    const y = top + 100 + hs * 2 + 30;
    const cw = (c.CW - 24) / 2;
    const ch = c.B - 70 - y;
    k.options.forEach((opt, i) => {
      const x = c.M + i * (cw + 24);
      rect(c, `option-${i + 1}-frame`, { x, y, w: cw, h: ch }, { fill: GLASS, radius: 28, stroke: { color: GLASS_EDGE, width: 2 } });
      media(c, `option-${i + 1}-photo`, { x: x + 10, y: y + 10, w: cw - 20, h: ch - 110 }, { path: `more.${i}`, radius: 20, name: `Option ${i + 1} photo` });
      ellipse(c, `option-${i + 1}-key-bg`, { x: x + 22, y: y + ch - 88, w: 66, h: 66 }, { fill: i === 0 ? "@accent" : WHITE });
      text(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x + 22, y: y + ch - 76, w: 66, h: 44 }, { size: 36, font: "display", weight: 900, color: NIGHT, align: "center" });
      big(c, `option-${i + 1}`, opt, { x: x + 104, y: y + ch - 84, w: cw - 130, h: 60 }, 52);
    });
    text(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 40, w: c.CW, h: 36 }, { size: 28, font: "display", weight: 700, color: SOFT, upper: true, align: "center" });
    return;
  }
  const manifesto = k.key === "manifesto";
  const hs = c.pick(manifesto ? 92 : 124, manifesto ? 74 : 100, manifesto ? 104 : 140);
  const items: StackItem[] = [
    { h: 64, gap: 22, draw: (y) => tagPill(c, "kicker", k.kicker, c.M, y, Math.min(560, c.CW)) },
    { h: Math.round(hs * (manifesto ? 2.9 : 1.95)), gap: 16, draw: (y) => big(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: Math.round(hs * (manifesto ? 2.9 : 1.95)) }, hs) },
    has(k.sub) && { h: 50, gap: 22, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: 50 }, { size: 34, font: "body", weight: 600, color: SOFT, fit: true }) },
    k.pills.length > 0 && { h: 70, gap: 16, draw: (y) => pills(c, k.pills, y, 70) },
    k.cta && { h: 66, draw: (y) => {
      rect(c, "cta-bg", { x: c.M, y, w: c.CW, h: 66 }, { fill: WHITE, radius: 33 });
      text(c, "cta", k.cta!, { x: c.M + 30, y: y + 14, w: c.CW - 60, h: 38 }, { size: 32, font: "display", weight: 900, color: NIGHT, upper: true, align: "center", fit: true });
    } },
  ];
  const y = c.B - stackHeight(items);
  const pb = { x: 0, y: top + 10, w: c.W, h: y - 20 - top };
  stagePhoto(c, pb);
  if (k.key === "map") pin(c, c.W / 2, pb.y + Math.round(pb.h * 0.45), "@accent");
  if (has(k.badge)) {
    const d = 190;
    ellipse(c, "badge-disc", { x: c.W - c.M - d, y: y - d - 10, w: d, h: d }, { fill: "@accent", stroke: { color: WHITE, width: 6 }, rotation: 8 });
    text(c, "badge", k.badge, { x: c.W - c.M - d + 20, y: y - d - 10 + d * 0.3, w: d - 40, h: d * 0.4 }, { size: 56, font: "display", weight: 900, color: NIGHT, upper: true, align: "center", fit: true, rotation: 8 });
  }
  stackDown(y, items);
};

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 420 }, { gradient: { from: "#040A1CCC", to: CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 820, w: c.W, h: 820 }, { gradient: { from: CLEAR, to: "#040A1CF0" } });
  },
  frame: (c, k, t) => { lockup(c, k, t, 96); },
  tag: (c, k, t) => tagPill(c, "kicker", k.kicker, c.M, c.B - 480, 420, t),
  goal: (c, k, t) => {
    const s = k.score!;
    ellipse(c, "number-disc", { x: c.M, y: c.B - 390, w: 170, h: 170 }, { fill: "@accent", ...t });
    text(c, "number", k.number ?? "", { x: c.M, y: c.B - 352, w: 170, h: 96 }, { size: 90, font: "display", weight: 900, color: NIGHT, align: "center", num: true, fit: true, ...t });
    big(c, "name", k.name ?? "", { x: c.M + 200, y: c.B - 340, w: c.CW - 200, h: 70 }, 60, t);
    rect(c, "score-bg", { x: c.M, y: c.B - 180, w: c.CW, h: 110 }, { fill: GLASS, radius: 55, stroke: { color: GLASS_EDGE, width: 2 }, ...t });
    big(c, "score", `${s.ownName}  ${s.own} – ${s.opp}  ${s.oppName}`, { x: c.M + 40, y: c.B - 158, w: c.CW - 80, h: 66 }, 50, { align: "center", ...t });
  },
  speaker: (c, k, t) => {
    rect(c, "speaker-bg", { x: c.M, y: c.B - 380, w: c.CW, h: 170 }, { fill: GLASS, radius: 32, stroke: { color: GLASS_EDGE, width: 2 }, ...t });
    big(c, "speaker", k.headline ?? "", { x: c.M + 36, y: c.B - 356, w: c.CW - 72, h: 70 }, 60, t);
    text(c, "role", k.sub ?? "", { x: c.M + 36, y: c.B - 276, w: c.CW - 72, h: 42 }, { size: 32, font: "display", weight: 700, color: "@accent", upper: true, fit: true, ...t });
  },
  title: (c, k, t) => {
    big(c, "headline", k.headline ?? "", { x: c.M, y: c.B - 420, w: c.CW, h: 260 }, 130, t);
    pills(c, k.meta, c.B - 120, 76, t);
  },
  caption: (c, id, value, t) => text(c, id, value, { x: c.M, y: c.B - 210, w: c.CW, h: 170 }, { size: 46, font: "display", weight: 800, color: WHITE, align: "center", lh: 1.15, fit: true, bg: { color: "#040A1CCC", padding: 20, radius: 24 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "@primary", to: NIGHT }, ...t });
    rays(c, 3, t);
    crest(c, "end-crest", { x: c.W / 2 - 160, y: c.H / 2 - 260, w: 320, h: 320 }, t);
    big(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 100, w: c.CW, h: 90 }, 70, { align: "center", ...t });
  },
};

export const stadium: StyleKit = { background: NIGHT, plate: { opacity: 1, above: "sky" }, score, fixture, hero, list, promo, skin };
