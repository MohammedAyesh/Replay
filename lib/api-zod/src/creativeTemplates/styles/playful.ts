import type { Content } from "../content";
import { crest, ellipse, media, rect, text, type Box, type Ctx, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";

/**
 * Playful: for the youngest squads. Cream paper, big soft blobs in the
 * academy's colours, photos in fat rounded frames tilted a little, pill
 * stickers stuck on at bouncy angles and chunky friendly type.
 */

const CREAM = "#FFF6E5";
const INK = "#1B1A2E";
const WHITE = "#FFFFFF";

function blobs(c: Ctx, variant = 0) {
  const big = c.pick(620, 520, 760);
  ellipse(c, "blob-1", { x: variant ? -big * 0.35 : c.W - big * 0.62, y: -big * 0.38, w: big, h: big }, { fill: "@primary", name: "bleed" });
  ellipse(c, "blob-2", { x: variant ? c.W - 300 : -140, y: c.H - c.pick(300, 260, 420), w: 380, h: 380 }, { fill: "@accent", name: "bleed" });
}

/** A pill sticker with a darker drop behind it. */
function sticker(c: Ctx, id: string, value: string, x: number, y: number, w: number, o: { h?: number; rot?: number; fill?: string; ink?: string; size?: number } & Timing = {}) {
  const { h: hh, rot, fill, ink, size, ...t } = o;
  const h = hh ?? 72;
  rect(c, `${id}-drop`, { x: x + 6, y: y + 8, w, h }, { fill: INK, radius: h / 2, rotation: rot ?? -5, ...t });
  rect(c, `${id}-pill`, { x, y, w, h }, { fill: fill ?? "@accent", radius: h / 2, rotation: rot ?? -5, ...t });
  text(c, id, value, { x: x + h * 0.4, y: y + h * 0.16, w: w - h * 0.8, h: h * 0.68 }, { size: size ?? Math.round(h * 0.5), font: "display", weight: 900, color: ink ?? INK, align: "center", fit: true, rotation: rot ?? -5, ...t });
}

/** A photo in a fat white rounded frame. */
function photo(c: Ctx, id: string, b: Box, rot = -3, path = "media") {
  if (b.h < 160) return;
  rect(c, `${id}-frame`, { x: b.x - 16, y: b.y - 16, w: b.w + 32, h: b.h + 32 }, { fill: WHITE, radius: 64, rotation: rot });
  media(c, id, b, { radius: 48, rotation: rot, path, name: "Photo" });
}

function bubbleNumber(c: Ctx, value: string, x: number, y: number, d: number, t: Timing = {}) {
  ellipse(c, "number-drop", { x: x + 10, y: y + 12, w: d, h: d }, { fill: INK, ...t });
  ellipse(c, "number-bubble", { x, y, w: d, h: d }, { fill: "@primary", stroke: { color: WHITE, width: 10 }, ...t });
  text(c, "number", value, { x: x + d * 0.12, y: y + d * 0.16, w: d * 0.76, h: d * 0.66 }, { size: Math.round(d * 0.56), font: "display", weight: 900, color: WHITE, align: "center", num: true, fit: true, ...t });
}

function head(c: Ctx, k: Content) {
  crest(c, "crest", { x: c.M, y: c.T, w: 100, h: 100 });
  text(c, "academy", k.academy, { x: c.M + 120, y: c.T + 30, w: 520, h: 44 }, { size: 34, font: "display", weight: 900, color: INK, fit: true });
}

const score: StyleKit["score"] = (c, k) => {
  blobs(c);
  head(c, k);
  const s = k.score!;
  const d = c.pick(230, 180, 250);
  const card: StackItem[] = [
    { h: d + 90, gap: 26, draw: (y) => {
      rect(c, "card-drop", { x: c.M + 10, y: y + 12, w: c.CW, h: d + 90 }, { fill: INK, radius: 56 });
      rect(c, "card", { x: c.M, y, w: c.CW, h: d + 90 }, { fill: WHITE, radius: 56 });
      ellipse(c, "own-bubble", { x: c.M + 40, y: y + 45, w: d, h: d }, { fill: "@primary" });
      text(c, "own-score", s.own, { x: c.M + 40, y: y + 45 + d * 0.16, w: d, h: d * 0.68 }, { size: Math.round(d * 0.6), font: "display", weight: 900, color: WHITE, align: "center", num: true });
      ellipse(c, "opp-bubble", { x: c.W - c.M - 40 - d, y: y + 45, w: d, h: d }, { fill: CREAM, stroke: { color: INK, width: 6 } });
      text(c, "opp-score", s.opp, { x: c.W - c.M - 40 - d, y: y + 45 + d * 0.16, w: d, h: d * 0.68 }, { size: Math.round(d * 0.6), font: "display", weight: 900, color: INK, align: "center", num: true });
      const mid = c.CW - 2 * d - 80 - 40;
      text(c, "own", s.ownName, { x: c.M + 60 + d, y: y + 60, w: mid, h: 70 }, { size: 46, font: "display", weight: 900, color: INK, align: "center", fit: true });
      text(c, "vs", "–", { x: c.M + 60 + d, y: y + 100, w: mid, h: 90 }, { size: 80, font: "display", weight: 900, color: "@primary", align: "center", num: true });
      text(c, "opp", s.oppName, { x: c.M + 60 + d, y: y + 190, w: mid, h: 70 }, { size: 46, font: "display", weight: 900, color: INK, align: "center", fit: true });
    } },
    has(k.sub) && { h: 70, gap: 16, draw: (y) => sticker(c, "scorers", k.sub!, c.M + 30, y, 520, { h: 70, rot: 3, fill: WHITE }) },
    { h: 40, draw: (y) => text(c, "meta", k.meta.filter(Boolean).join(" · "), { x: c.M, y, w: c.CW, h: 40 }, { size: 30, font: "display", weight: 800, color: INK, fit: true }) },
  ];
  const y = c.B - stackHeight(card);
  photo(c, "photo", { x: c.M + 30, y: c.T + 150, w: c.CW - 60, h: y - 70 - (c.T + 150) }, -2);
  sticker(c, "kicker", k.kicker, c.M, c.T + 130, 380, { h: 84, rot: -7 });
  stackDown(y, card);
};

const fixture: StyleKit["fixture"] = (c, k) => {
  blobs(c, 1);
  head(c, k);
  const v = k.vs!;
  const hs = Math.round(120 * c.k);
  const items: StackItem[] = [
    { h: Math.round(hs * 1.1), gap: 20, draw: (y) => text(c, "headline", k.headline ?? k.kicker, { x: c.M, y, w: c.CW, h: Math.round(hs * 1.1) }, { size: hs, font: "display", weight: 900, color: INK, fit: true }) },
    { h: 80, gap: 0, draw: (y) => sticker(c, "own", v.ownName, c.M, y, 600, { h: 80, rot: -3, fill: "@primary", ink: WHITE }) },
    { h: 70, gap: 0, draw: (y) => {
      ellipse(c, "vs-bubble", { x: c.M + 560, y: y - 20, w: 110, h: 110 }, { fill: "@accent", stroke: { color: INK, width: 5 }, rotation: 12 });
      text(c, "vs", v.label, { x: c.M + 560, y: y + 10, w: 110, h: 50 }, { size: 44, font: "display", weight: 900, color: INK, align: "center", rotation: 12 });
    } },
    { h: 80, gap: 30, draw: (y) => sticker(c, "opp", v.oppName, c.M + 120, y, 600, { h: 80, rot: 3, fill: WHITE }) },
    { h: 64, gap: 14, draw: (y) => {
      const pw = (c.CW - 24) / 3;
      k.pills.slice(0, 3).forEach((p, i) => {
        rect(c, `pill-${i + 1}-bg`, { x: c.M + i * (pw + 12), y, w: pw, h: 64 }, { fill: WHITE, radius: 32, stroke: { color: INK, width: 4 } });
        text(c, `pill-${i + 1}`, p, { x: c.M + i * (pw + 12) + 24, y: y + 12, w: pw - 48, h: 40 }, { size: 30, font: "display", weight: 800, color: INK, align: "center", fit: true });
      });
    } },
    { h: 36, draw: (y) => text(c, "meta", k.meta.filter(Boolean).join(" · "), { x: c.M, y, w: c.CW, h: 36 }, { size: 28, font: "display", weight: 800, color: INK, fit: true }) },
  ];
  const y = c.B - stackHeight(items);
  photo(c, "photo", { x: c.M + 30, y: c.T + 150, w: c.CW - 60, h: y - 60 - (c.T + 150) }, 2);
  if (k.headline) sticker(c, "kicker", k.kicker, c.W - c.M - 400, c.T + 130, 400, { h: 76, rot: 6 });
  stackDown(y, items);
};

const hero: StyleKit["hero"] = (c, k) => {
  blobs(c);
  head(c, k);
  const { head: words, tag } = heroWords(k);
  const hs = Math.round(110 * c.k);
  const items: StackItem[] = [
    { h: Math.round(hs * 2.1), gap: 14, draw: (y) => text(c, "headline", words, { x: c.M, y, w: c.CW, h: Math.round(hs * 2.1) }, { size: hs, font: "display", weight: 900, color: INK, lh: 1, fit: true }) },
    has(k.name) && { h: 72, gap: 14, draw: (y) => text(c, "name", k.name!, { x: c.M, y, w: c.CW, h: 72 }, { size: 56, font: "display", weight: 900, color: "@primary", fit: true }) },
    has(k.sub) && { h: 50, gap: 12, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: 50 }, { size: 34, font: "display", weight: 700, color: INK, fit: true }) },
    k.meta.length > 0 && { h: 40, draw: (y) => text(c, "meta", k.meta.filter(Boolean).join(" · "), { x: c.M, y, w: c.CW, h: 40 }, { size: 28, font: "display", weight: 800, color: INK, fit: true }) },
  ];
  const y = c.B - stackHeight(items);
  const pb: Box = { x: c.M + 30, y: c.T + 150, w: c.CW - 60, h: y - 70 - (c.T + 150) };
  photo(c, "photo", pb, -3);
  sticker(c, "kicker", tag, c.M, c.T + 128, Math.min(520, c.CW - 260), { h: 80, rot: -6 });
  if (has(k.number)) {
    const d = c.pick(280, 220, 320);
    bubbleNumber(c, k.number, c.W - c.M - d, Math.max(c.T + 150, pb.y + pb.h - d * 0.7), d);
  }
  if (k.stat) {
    const sy = pb.y + pb.h - 120;
    rect(c, "stat-pill", { x: c.M + 10, y: sy, w: 300, h: 120 }, { fill: WHITE, radius: 60, stroke: { color: INK, width: 5 }, rotation: 4 });
    text(c, "stat", k.stat.value, { x: c.M + 30, y: sy + 14, w: 110, h: 92 }, { size: 80, font: "display", weight: 900, color: "@primary", align: "center", num: true, rotation: 4 });
    text(c, "stat-label", k.stat.label, { x: c.M + 140, y: sy + 38, w: 150, h: 44 }, { size: 30, font: "display", weight: 900, color: INK, fit: true, rotation: 4 });
  }
  stackDown(y, items);
};

const list: StyleKit["list"] = (c, k) => {
  blobs(c, 1);
  head(c, k);
  sticker(c, "kicker", k.kicker, c.M, c.T + 140, 440, { h: 80, rot: -5 });
  const hs = Math.round(84 * c.k);
  text(c, "headline", k.headline ?? "", { x: c.M, y: c.T + 250, w: c.CW, h: Math.round(hs * 1.15) }, { size: hs, font: "display", weight: 900, color: INK, fit: true });
  const top = c.T + 250 + Math.round(hs * 1.15) + 30;
  const rows = k.rows ?? [];
  const lead = numericLead(k);
  const foot = (k.cta ? 96 : 0) + k.meta.length * 40 + 30;
  rowBoxes(rows.length, top, c.B - foot, c.M, c.CW, { gap: 14, maxH: Math.round((lead ? 100 : 124) * c.k) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    rect(c, `${id}-bg`, b, { fill: WHITE, radius: b.h / 2, stroke: { color: INK, width: 4 } });
    if (lead) {
      ellipse(c, `${id}-lead-bg`, { x: b.x + 8, y: b.y + 8, w: b.h - 16, h: b.h - 16 }, { fill: i === 0 ? "@accent" : "@primary" });
      text(c, `${id}-lead`, row[0], { x: b.x + 8, y: b.y + b.h * 0.22, w: b.h - 16, h: b.h * 0.56 }, { size: Math.round(b.h * 0.44), font: "display", weight: 900, color: i === 0 ? INK : WHITE, align: "center", num: true, fit: true });
    } else {
      rect(c, `${id}-lead-bg`, { x: b.x + 8, y: b.y + 8, w: b.w * 0.34, h: b.h - 16 }, { fill: i % 2 ? "@accent" : "@primary", radius: (b.h - 16) / 2 });
      text(c, `${id}-lead`, row[0], { x: b.x + 30, y: b.y + b.h * 0.26, w: b.w * 0.34 - 44, h: b.h * 0.48 }, { size: Math.round(b.h * 0.34), font: "display", weight: 900, color: i % 2 ? INK : WHITE, align: "center", fit: true });
    }
    const mx = lead ? b.x + b.h + 16 : b.x + b.w * 0.34 + 30;
    text(c, `${id}-main`, row[1], { x: mx, y: b.y + b.h * 0.26, w: b.x + b.w - 210 - mx, h: b.h * 0.48 }, { size: Math.round(b.h * (lead ? 0.38 : 0.26)), font: "display", weight: lead ? 900 : 700, color: INK, fit: true });
    text(c, `${id}-trail`, row[2], { x: b.x + b.w - 200, y: b.y + b.h * 0.24, w: 170, h: b.h * 0.52 }, { size: Math.round(b.h * 0.38), font: "display", weight: 900, color: "@primary", align: "end", fit: true });
  });
  stackUp(c.B, [
    ...k.meta.map((m, i) => ({ h: 36, gap: 10, draw: (y: number) => text(c, `meta-${i + 1}`, m, { x: c.M, y, w: c.CW, h: 36 }, { size: 28, font: "display", weight: 800, color: INK, fit: true }) })),
    k.cta && { h: 80, draw: (y: number) => sticker(c, "cta", k.cta!, c.M, y, c.CW - 120, { h: 80, rot: -2, fill: "@primary", ink: WHITE }) },
  ]);
};

const promo: StyleKit["promo"] = (c, k) => {
  blobs(c, k.options ? 1 : 0);
  head(c, k);
  if (k.options) {
    sticker(c, "kicker", k.kicker, c.M, c.T + 140, 420, { h: 80, rot: -5 });
    const hs = Math.round(110 * c.k);
    text(c, "headline", k.headline ?? "", { x: c.M, y: c.T + 250, w: c.CW, h: Math.round(hs * 2.1) }, { size: hs, font: "display", weight: 900, color: INK, lh: 1, fit: true });
    const top = c.T + 250 + Math.round(hs * 2.1) + 40;
    const cw = (c.CW - 60) / 2;
    const ch = c.B - 110 - top;
    k.options.forEach((opt, i) => {
      const x = c.M + 16 + i * (cw + 30);
      photo(c, `option-${i + 1}-photo`, { x, y: top, w: cw - 4, h: ch - 60 }, i ? 3 : -3, `more.${i}`);
      ellipse(c, `option-${i + 1}-key-bg`, { x: x - 10, y: top - 20, w: 100, h: 100 }, { fill: i ? "@accent" : "@primary" });
      text(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x - 10, y: top + 2, w: 100, h: 56 }, { size: 52, font: "display", weight: 900, color: i ? INK : WHITE, align: "center" });
      sticker(c, `option-${i + 1}`, opt, x + 20, top + ch - 70, cw - 60, { h: 72, rot: i ? -4 : 4, fill: WHITE });
    });
    text(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 40, w: c.CW, h: 40 }, { size: 30, font: "display", weight: 800, color: INK, fit: true });
    return;
  }
  const manifesto = k.key === "manifesto";
  const hs = Math.round((manifesto ? 80 : 110) * c.k);
  const items: StackItem[] = [
    { h: Math.round(hs * (manifesto ? 3.2 : 2.1)), gap: 18, draw: (y) => text(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: Math.round(hs * (manifesto ? 3.2 : 2.1)) }, { size: hs, font: "display", weight: 900, color: INK, lh: 1, fit: true }) },
    has(k.sub) && { h: 50, gap: 22, draw: (y) => text(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: 50 }, { size: 34, font: "display", weight: 700, color: INK, fit: true }) },
    k.pills.length > 0 && { h: 64, gap: 22, draw: (y) => {
      const pw = (c.CW - 12 * (k.pills.length - 1)) / k.pills.length;
      k.pills.forEach((p, i) => {
        rect(c, `pill-${i + 1}-bg`, { x: c.M + i * (pw + 12), y, w: pw, h: 64 }, { fill: WHITE, radius: 32, stroke: { color: INK, width: 4 } });
        text(c, `pill-${i + 1}`, p, { x: c.M + i * (pw + 12) + 22, y: y + 12, w: pw - 44, h: 40 }, { size: 30, font: "display", weight: 800, color: INK, align: "center", fit: true });
      });
    } },
    k.cta && { h: 80, draw: (y) => sticker(c, "cta", k.cta!, c.M, y, c.CW - 100, { h: 80, rot: -2, fill: "@primary", ink: WHITE }) },
  ];
  const y = c.B - stackHeight(items);
  const pb: Box = { x: c.M + 30, y: c.T + 150, w: c.CW - 60, h: y - 60 - (c.T + 150) };
  photo(c, "photo", pb, 2);
  if (k.key === "map") pin(c, pb.x + pb.w / 2, pb.y + pb.h / 2, "@primary");
  sticker(c, "kicker", k.kicker, c.M, c.T + 128, Math.min(520, c.CW - 260), { h: 80, rot: -6 });
  if (has(k.badge)) {
    const d = c.pick(240, 200, 260);
    ellipse(c, "badge-drop", { x: c.W - c.M - d + 10, y: pb.y + pb.h - d * 0.75 + 12, w: d, h: d }, { fill: INK });
    ellipse(c, "badge-bubble", { x: c.W - c.M - d, y: pb.y + pb.h - d * 0.75, w: d, h: d }, { fill: "@accent", stroke: { color: WHITE, width: 10 }, rotation: 10 });
    text(c, "badge", k.badge, { x: c.W - c.M - d + d * 0.14, y: pb.y + pb.h - d * 0.75 + d * 0.3, w: d * 0.72, h: d * 0.4 }, { size: Math.round(d * 0.3), font: "display", weight: 900, color: INK, align: "center", fit: true, rotation: 10 });
  }
  stackDown(y, items);
};

const skin: StyleKit["skin"] = {
  shade: (c) => rect(c, "shade", { x: 0, y: c.H - 600, w: c.W, h: 600 }, { gradient: { from: "#1B1A2E00", to: "#1B1A2E99" } }),
  frame: (c, k, t) => {
    rect(c, "frame-pill", { x: c.M, y: c.T, w: 560, h: 96 }, { fill: WHITE, radius: 48, ...t });
    crest(c, "crest", { x: c.M + 12, y: c.T + 8, w: 80, h: 80 }, t);
    text(c, "academy", k.academy, { x: c.M + 108, y: c.T + 26, w: 430, h: 44 }, { size: 32, font: "display", weight: 900, color: INK, fit: true, ...t });
  },
  tag: (c, k, t) => sticker(c, "kicker", k.kicker, c.M, c.B - 520, k.video?.variant === "goal" ? 380 : 480, { h: 96, rot: -7, ...t }),
  goal: (c, k, t) => {
    const s = k.score!;
    bubbleNumber(c, k.number ?? "", c.W - c.M - 260, c.B - 560, 260, t);
    text(c, "name", k.name ?? "", { x: c.M, y: c.B - 300, w: c.CW, h: 64 }, { size: 52, font: "display", weight: 900, color: WHITE, fit: true, shadow: { color: INK, blur: 0, x: 4, y: 4 }, ...t });
    sticker(c, "score", `${s.ownName} ${s.own}–${s.opp} ${s.oppName}`, c.M, c.B - 200, c.CW - 40, { h: 100, rot: 2, fill: WHITE, ...t });
  },
  speaker: (c, k, t) => {
    sticker(c, "speaker", k.headline ?? "", c.M, c.B - 420, 700, { h: 96, rot: -3, fill: WHITE, ...t });
    sticker(c, "role", k.sub ?? "", c.M + 60, c.B - 310, 500, { h: 70, rot: 3, fill: "@primary", ink: WHITE, ...t });
  },
  title: (c, k, t) => {
    text(c, "headline", k.headline ?? "", { x: c.M, y: c.B - 400, w: c.CW, h: 240 }, { size: 120, font: "display", weight: 900, color: WHITE, lh: 1, fit: true, shadow: { color: INK, blur: 0, x: 6, y: 6 }, ...t });
    sticker(c, "meta-1", k.meta[0] ?? "", c.M, c.B - 120, 560, { h: 80, rot: 3, fill: WHITE, ...t });
  },
  caption: (c, id, value, t) => text(c, id, value, { x: c.M, y: c.B - 210, w: c.CW, h: 170 }, { size: 46, font: "display", weight: 800, color: INK, align: "center", lh: 1.15, fit: true, bg: { color: WHITE, padding: 20, radius: 36 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: CREAM, ...t });
    ellipse(c, "end-blob", { x: c.W / 2 - 300, y: c.H / 2 - 360, w: 600, h: 600 }, { fill: "@primary", ...t });
    crest(c, "end-crest", { x: c.W / 2 - 170, y: c.H / 2 - 230, w: 340, h: 340 }, t);
    sticker(c, "end-name", k.academy, c.M + 60, c.H / 2 + 280, c.CW - 120, { h: 96, rot: -4, ...t });
  },
};

export const playful: StyleKit = { background: CREAM, score, fixture, hero, list, promo, skin };
