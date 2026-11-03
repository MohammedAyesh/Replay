import type { Content } from "../content";
import { seam, crest, media, rect, rule, text, type Ctx, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Luxury: subdued and premium. Near-black, warm white type in widely spaced
 * capitals, a small crest, one fine line in the academy's accent and a great
 * deal of empty space. Nothing shouts.
 */

const BLACK = "#060606";
const TEXT = "#F1EDE4";
const MUTED = "#8F8B83";
const HAIR = "#2A2826";
const CLEAR = "#06060600";

function spaced(c: Ctx, id: string, value: string, x: number, y: number, w: number, o: { size?: number; color?: string; align?: "start" | "center" | "end" } & Timing = {}) {
  const { size, color, align, ...t } = o;
  text(c, id, value, { x, y, w, h: Math.round((size ?? 22) * 1.5) }, { size: size ?? 22, font: "body", weight: 600, color: color ?? MUTED, upper: true, ls: 9, fit: true, align, ...t });
}

/** Thin display capitals: the only big type luxury uses. */
function display(c: Ctx, id: string, value: string, b: { x: number; y: number; w: number; h: number }, size: number, o: { color?: string; align?: "start" | "center" | "end"; num?: boolean } & Timing = {}) {
  const { color, align, num, ...t } = o;
  text(c, id, value, b, { size, font: "display", weight: 300, color: color ?? TEXT, upper: true, ls: num ? 0 : 6, lh: 1.05, fit: true, align, num, ...t });
}

function top(c: Ctx, k: Content, right?: string) {
  crest(c, "crest", { x: c.M, y: c.T, w: 56, h: 56 });
  spaced(c, "academy", k.academy, c.M + 80, c.T + 12, right ? 440 : 760, { color: TEXT });
  if (right) spaced(c, "top-right", right, c.W - c.M - 360, c.T + 12, 360, { align: "end" });
}

function band(c: Ctx, h: number) {
  if (h < 160) return;
  media(c, "photo", { x: 0, y: 0, w: c.W, h }, { name: "Photo", opacity: 0.92 });
  rect(c, "photo-top", { x: 0, y: 0, w: c.W, h: 240 }, { gradient: { from: "#060606CC", to: CLEAR } });
  rect(c, "photo-fade", { x: 0, y: Math.round(h * 0.4), w: c.W, h: h - Math.round(h * 0.4) + 2 }, { gradient: { from: CLEAR, to: BLACK } });
  seam(c, "photo-seam", h + 2, BLACK);
}

/** The one accent line. */
const line = (c: Ctx, x: number, y: number, w = 140, t: Timing = {}) => rule(c, "accent-line", x, y, w, "@accent", 2, t);

const score: StyleKit["score"] = (c, k) => {
  const s = k.score!;
  const ss = Math.round(240 * c.k);
  const items: StackItem[] = [
    { h: 36, gap: 30, draw: (y) => spaced(c, "kicker", k.kicker, c.M, y, c.CW, { color: TEXT, size: 24 }) },
    { h: Math.round(ss * 1.05), gap: 20, draw: (y) => display(c, "score", `${s.own} – ${s.opp}`, { x: c.M - 8, y, w: c.CW, h: Math.round(ss * 1.05) }, ss, { num: true }) },
    { h: 40, gap: 36, draw: (y) => spaced(c, "teams", `${s.ownName}   /   ${s.oppName}`, c.M, y, c.CW, { color: TEXT, size: 26 }) },
    { h: 2, gap: 36, draw: (y) => line(c, c.M, y) },
    has(k.sub) && { h: 34, gap: 10, draw: (y) => spaced(c, "scorers", k.sub!, c.M, y, c.CW) },
    { h: 34, draw: (y) => spaced(c, "meta", k.meta.filter(Boolean).join("   ·   "), c.M, y, c.CW) },
  ];
  const y = c.B - stackHeight(items);
  band(c, y - 40);
  top(c, k);
  stackDown(y, items);
};

const fixture: StyleKit["fixture"] = (c, k) => {
  const v = k.vs!;
  const hs = Math.round(120 * c.k);
  const items: StackItem[] = [
    { h: 36, gap: 20, draw: (y) => spaced(c, "kicker", k.headline ? k.kicker : (k.meta[0] ?? ""), c.M, y, c.CW, { color: TEXT, size: 24 }) },
    { h: Math.round(hs * 1.1), gap: 50, draw: (y) => display(c, "headline", k.headline ?? k.kicker, { x: c.M - 6, y, w: c.CW, h: Math.round(hs * 1.1) }, hs) },
    { h: 60, gap: 18, draw: (y) => display(c, "own", v.ownName, { x: c.M, y, w: c.CW, h: 60 }, 50) },
    { h: 30, gap: 18, draw: (y) => {
      line(c, c.M, y + 14, 80);
      spaced(c, "vs", v.label, c.M + 104, y, 200, { size: 20 });
    } },
    { h: 60, gap: 60, draw: (y) => display(c, "opp", v.oppName, { x: c.M, y, w: c.CW, h: 60 }, 50) },
    { h: 1, gap: 26, draw: (y) => rule(c, "info-rule", c.M, y, c.CW, HAIR, 1) },
    { h: 34, gap: 8, draw: (y) => spaced(c, "pills", k.pills.filter(Boolean).join("   ·   "), c.M, y, c.CW, { color: TEXT }) },
    { h: 34, draw: (y) => spaced(c, "meta", k.meta[1] ?? "", c.M, y, c.CW) },
  ];
  const y = c.B - stackHeight(items);
  band(c, y - 40);
  top(c, k, k.headline ? k.meta[0] : undefined);
  stackDown(y, items);
};

const hero: StyleKit["hero"] = (c, k) => {
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo", opacity: 0.92 });
  rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 260 }, { gradient: { from: "#060606CC", to: CLEAR } });
  rect(c, "shade", { x: 0, y: Math.round(c.H * 0.38), w: c.W, h: c.H - Math.round(c.H * 0.38) }, { gradient: { from: CLEAR, to: BLACK } });
  top(c, k);
  const { head, tag } = heroWords(k);
  if (has(k.number)) {
    const nW = 300;
    const x = c.M + nW + 50;
    const w = c.CW - nW - 50;
    const items: StackItem[] = [
      { h: 34, gap: 22, draw: (y) => spaced(c, "kicker", tag, x, y, w) },
      { h: Math.round(130 * c.k), gap: 22, draw: (y) => display(c, "headline", head, { x, y, w, h: Math.round(130 * c.k) }, Math.round(56 * c.k)) },
      has(k.name) && { h: 36, gap: 14, draw: (y) => spaced(c, "name", k.name!, x, y, w, { color: TEXT, size: 26 }) },
      k.stat && { h: 36, gap: 14, draw: (y) => spaced(c, "stat", `${k.stat!.value}  ${k.stat!.label}`, x, y, w, { color: TEXT, size: 24 }) },
      has(k.sub) && { h: 34, gap: 10, draw: (y) => spaced(c, "sub", k.sub!, x, y, w) },
      ...k.meta.map((m, i) => ({ h: 30, gap: 6, draw: (y: number) => spaced(c, `meta-${i + 1}`, m, x, y, w, { size: 18 }) })),
    ];
    const blockH = Math.max(stackHeight(items), 300);
    const y = c.B - blockH;
    display(c, "number", k.number, { x: c.M - 10, y: y - 20, w: nW, h: blockH + 20 }, 300, { num: true });
    rect(c, "accent-line", { x: x - 26, y: y + 4, w: 2, h: blockH - 8 }, { fill: "@accent" });
    stackDown(y, items);
  } else {
    const hs = Math.round(116 * c.k);
    stackUp(c.B, [
      { h: 34, gap: 26, draw: (y) => spaced(c, "kicker", tag, c.M, y, c.CW) },
      { h: Math.round(hs * 2.2), gap: 30, draw: (y) => display(c, "headline", head, { x: c.M - 6, y, w: c.CW, h: Math.round(hs * 2.2) }, hs) },
      { h: 2, gap: 30, draw: (y) => line(c, c.M, y) },
      k.stat && { h: 36, gap: 12, draw: (y) => spaced(c, "stat", `${k.stat!.value}  ${k.stat!.label}`, c.M, y, c.CW, { color: TEXT, size: 24 }) },
      has(k.sub) && { h: 70, gap: 14, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: 820, h: 70 }, { size: 30, font: "body", weight: 500, color: TEXT, lh: 1.3, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 30, gap: 6, draw: (y: number) => spaced(c, `meta-${i + 1}`, m, c.M, y, c.CW, { size: 20 }) })),
    ]);
  }
};

/** Line-up photo tiles: near-black panels on a hairline, a thin pale number, spaced capitals. */
const TILE: TileLook = {
  backdrop: (c, id, b) => {
    rect(c, id, b, { gradient: { from: "#1A1816", to: BLACK } });
    rule(c, `${id}-rule`, b.x, b.y, b.w, HAIR, 1);
  },
  bar: (c, id, b) => {
    rect(c, id, b, { fill: BLACK });
    rule(c, `${id}-rule`, b.x + b.w * 0.3, b.y, b.w * 0.4, TEXT, 1);
  },
  num: { font: "display", color: TEXT, weight: 300, opacity: 0.55 },
  name: { font: "body", color: TEXT, weight: 500, ls: 4 },
  pos: { font: "body", color: MUTED, weight: 500, ls: 4 },
  shadow: BLACK,
  cardRadius: 0,
};

const list: StyleKit["list"] = (c, k) => {
  top(c, k);
  const hs = Math.round(76 * c.k);
  spaced(c, "kicker", k.kicker, c.M, c.T + 150, c.CW, { size: 24 });
  display(c, "headline", k.headline ?? "", { x: c.M - 4, y: c.T + 200, w: c.CW, h: Math.round(hs * 1.2) }, hs);
  line(c, c.M, c.T + 200 + Math.round(hs * 1.2) + 30);
  const topY = c.T + 200 + Math.round(hs * 1.2) + 80;
  const rows = k.rows ?? [];
  const lead = numericLead(k);
  const foot = (k.cta ? 50 : 0) + k.meta.length * 40 + 40;
  rowsOrTiles(c, k, { x: c.M, y: topY - 20, w: c.CW, h: c.B - foot - topY }, TILE, () => rowBoxes(rows.length, topY, c.B - foot, c.M, c.CW, { gap: 0, maxH: Math.round(120 * c.k) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    rule(c, `${id}-rule`, b.x, b.y + b.h - 1, b.w, HAIR, 1);
    const lw = lead ? 110 : Math.round(b.w * 0.36);
    if (lead) display(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.2, w: lw - 20, h: b.h * 0.6 }, Math.round(b.h * 0.46), { color: MUTED, num: true });
    else spaced(c, `${id}-lead`, row[0], b.x, b.y + b.h * 0.34, lw - 20, { color: TEXT, size: Math.round(b.h * 0.22) });
    text(c, `${id}-main`, row[1], { x: b.x + lw, y: b.y + b.h * 0.3, w: b.w - lw - 220, h: b.h * 0.4 }, { size: Math.round(b.h * (lead ? 0.3 : 0.22)), font: "body", weight: 500, color: lead ? TEXT : MUTED, upper: lead, ls: lead ? 4 : 0, fit: true });
    text(c, `${id}-trail`, row[2], { x: b.x + b.w - 200, y: b.y + b.h * 0.28, w: 200, h: b.h * 0.44 }, { size: Math.round(b.h * 0.3), font: "display", weight: 300, color: TEXT, upper: true, align: "end", fit: true });
  }));
  stackUp(c.B, [
    ...k.meta.map((m, i) => ({ h: 30, gap: 10, draw: (y: number) => spaced(c, `meta-${i + 1}`, m, c.M, y, c.CW, { size: 20 }) })),
    k.cta && { h: 36, draw: (y: number) => spaced(c, "cta", k.cta!, c.M, y, c.CW, { color: TEXT, size: 24 }) },
  ]);
};

const promo: StyleKit["promo"] = (c, k) => {
  if (k.options) {
    top(c, k);
    const hs = Math.round(88 * c.k);
    spaced(c, "kicker", k.kicker, c.M, c.T + 150, c.CW, { size: 24 });
    display(c, "headline", k.headline ?? "", { x: c.M - 4, y: c.T + 200, w: c.CW, h: Math.round(hs * 2.2) }, hs);
    const y = c.T + 200 + Math.round(hs * 2.2) + 50;
    const cw = (c.CW - 36) / 2;
    const ch = c.B - 140 - y;
    k.options.forEach((opt, i) => {
      const x = c.M + i * (cw + 36);
      media(c, `option-${i + 1}-photo`, { x, y, w: cw, h: ch }, { path: `more.${i}`, name: `Option ${i + 1} photo` });
      spaced(c, `option-${i + 1}-key`, optionKey(c.ar, i), x, y + ch + 26, 60, { color: "@accent", size: 26 });
      spaced(c, `option-${i + 1}`, opt, x + 60, y + ch + 26, cw - 60, { color: TEXT, size: 26 });
    });
    spaced(c, "meta-1", k.meta[0] ?? "", c.M, c.B - 34, c.CW, { size: 20 });
    return;
  }
  const manifesto = k.key === "manifesto";
  const hs = Math.round((manifesto ? 64 : 96) * c.k);
  const items: StackItem[] = [
    { h: 34, gap: 24, draw: (y) => spaced(c, "kicker", k.kicker, c.M, y, c.CW - 240) },
    { h: Math.round(hs * (manifesto ? 3.3 : 2.2)), gap: 26, draw: (y) => display(c, "headline", k.headline ?? "", { x: c.M - 4, y, w: c.CW, h: Math.round(hs * (manifesto ? 3.3 : 2.2)) }, hs) },
    { h: 2, gap: 26, draw: (y) => line(c, c.M, y) },
    has(k.sub) && { h: 44, gap: 22, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: 44 }, { size: 30, font: "body", weight: 500, color: TEXT, fit: true }) },
    k.pills.length > 0 && { h: 34, gap: 14, draw: (y) => spaced(c, "pills", k.pills.filter(Boolean).join("   ·   "), c.M, y, c.CW) },
    k.cta && { h: 36, draw: (y) => spaced(c, "cta", k.cta!, c.M, y, c.CW, { color: TEXT, size: 24 }) },
  ];
  const y = c.B - stackHeight(items);
  band(c, y - 40);
  if (k.key === "map") pin(c, c.W / 2, Math.round((y - 40) * 0.45), "@accent", TEXT);
  top(c, k);
  if (has(k.badge)) {
    rect(c, "badge-frame", { x: c.W - c.M - 220, y: y - 6, w: 220, h: 50 }, { stroke: { color: TEXT, width: 1 } });
    spaced(c, "badge", k.badge, c.W - c.M - 210, y + 2, 200, { color: TEXT, size: 20, align: "center" });
  }
  stackDown(y, items);
};

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 300 }, { gradient: { from: "#060606B3", to: CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 760, w: c.W, h: 760 }, { gradient: { from: CLEAR, to: "#060606F0" } });
  },
  frame: (c, k, t) => {
    crest(c, "crest", { x: c.M, y: c.T, w: 56, h: 56 }, t);
    spaced(c, "academy", k.academy, c.M + 80, c.T + 12, 760, { color: TEXT, ...t });
  },
  tag: (c, k, t) => spaced(c, "kicker", k.kicker, c.M, c.B - 440, c.CW, { color: TEXT, size: 24, ...t }),
  goal: (c, k, t) => {
    const s = k.score!;
    display(c, "number", k.number ?? "", { x: c.M - 8, y: c.B - 390, w: 400, h: 230 }, 220, { num: true, ...t });
    spaced(c, "name", k.name ?? "", c.M + 420, c.B - 300, c.CW - 420, { color: TEXT, size: 28, ...t });
    line(c, c.M, c.B - 130, 140, t);
    spaced(c, "score", `${s.ownName}  ${s.own} — ${s.opp}  ${s.oppName}`, c.M, c.B - 100, c.CW, { color: TEXT, size: 26, ...t });
  },
  speaker: (c, k, t) => {
    display(c, "speaker", k.headline ?? "", { x: c.M, y: c.B - 390, w: c.CW, h: 64 }, 50, t);
    spaced(c, "role", k.sub ?? "", c.M, c.B - 310, c.CW, { ...t });
    line(c, c.M, c.B - 262, 140, t);
  },
  title: (c, k, t) => {
    display(c, "headline", k.headline ?? "", { x: c.M - 6, y: c.B - 390, w: c.CW, h: 220 }, 100, t);
    line(c, c.M, c.B - 140, 140, t);
    spaced(c, "meta-1", k.meta[0] ?? "", c.M, c.B - 104, c.CW, t);
  },
  caption: (c, id, value, t) => text(c, id, value, { x: c.M, y: c.B - 220, w: c.CW, h: 160 }, { size: 40, font: "body", weight: 500, color: TEXT, align: "center", lh: 1.3, fit: true, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: BLACK, ...t });
    crest(c, "end-crest", { x: c.W / 2 - 80, y: c.H / 2 - 200, w: 160, h: 160 }, t);
    spaced(c, "end-name", k.academy, c.M, c.H / 2 + 20, c.CW, { color: TEXT, size: 38, align: "center", ...t });
    rule(c, "end-line", c.W / 2 - 70, c.H / 2 + 110, 140, "@accent", 2, t);
  },
};

export const luxury: StyleKit = { background: BLACK, plate: { opacity: 0.35 }, score, fixture, hero, list, promo, skin };
