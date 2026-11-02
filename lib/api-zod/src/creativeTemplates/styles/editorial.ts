import type { Content } from "../content";
import { crest, ellipse, media, rect, rule, text, type Ctx, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";

/**
 * Editorial: a club magazine page. Off-white paper, a serif headline set
 * large and left, hairline rules, small-caps metadata and framed photographs
 * with room around them. The academy colour appears only in small doses.
 */

const PAPER = "#F3EFE6";
const INK = "#16181D";
const GREY = "#6B6F78";
const WHITE = "#FFFFFF";

/** Small capitals: the magazine's metadata voice. */
function caps(c: Ctx, id: string, value: string, x: number, y: number, w: number, o: { color?: string; size?: number; align?: "start" | "end" } & Timing = {}) {
  const { color, size, align, ...t } = o;
  text(c, id, value, { x, y, w, h: Math.round((size ?? 24) * 1.4) }, { size: size ?? 24, font: "body", weight: 700, color: color ?? GREY, upper: true, ls: 5, fit: true, align, ...t });
}

function masthead(c: Ctx, k: Content, right?: string) {
  crest(c, "crest", { x: c.M, y: c.T, w: 64, h: 64 });
  caps(c, "academy", k.academy, c.M + 84, c.T + 18, right ? 460 : 760, { color: INK });
  if (right) caps(c, "masthead-meta", right, c.W - c.M - 360, c.T + 18, 360, { align: "end" });
  rule(c, "masthead-rule", c.M, c.T + 84, c.CW, INK, 2);
}

function kicker(c: Ctx, value: string, y: number) {
  rule(c, "kicker-rule", c.M, y + 16, 48, "@primary", 4);
  caps(c, "kicker", value, c.M + 68, y, c.CW - 68, { color: "@primary", size: 26 });
}

function frame(c: Ctx, id: string, b: { x: number; y: number; w: number; h: number }, path = "media") {
  if (b.h < 160) return;
  media(c, id, b, { path, name: "Photo" });
}

const score: StyleKit["score"] = (c, k) => {
  const s = k.score!;
  masthead(c, k, k.meta[0]);
  kicker(c, k.kicker, c.T + 124);
  const rowH = Math.round(190 * c.k);
  let y = c.T + 190;
  ([[s.ownName, s.own, INK], [s.oppName, s.opp, GREY]] as const).forEach(([name, goals, color], i) => {
    text(c, i ? "opp" : "own", name, { x: c.M, y: y + rowH * 0.2, w: c.CW - 260, h: rowH * 0.6 }, { size: Math.round(92 * c.k), font: "serif", weight: 500, color, fit: true });
    text(c, `goals-${i + 1}`, goals, { x: c.W - c.M - 240, y: y + 4, w: 240, h: rowH - 8 }, { size: Math.round(190 * c.k), font: "serif", weight: 400, color, align: "end", num: true, fit: true });
    y += rowH;
    rule(c, `team-rule-${i + 1}`, c.M, y, c.CW, i ? INK : "#C9C3B6", i ? 2 : 1);
  });
  const captionH = (has(k.sub) ? 50 : 0) + 44;
  frame(c, "photo", { x: c.M, y: y + 40, w: c.CW, h: c.B - captionH - 30 - (y + 40) });
  stackUp(c.B, [
    has(k.sub) && { h: 44, gap: 8, draw: (yy) => text(c, "scorers", k.sub!, { x: c.M, y: yy, w: c.CW, h: 44 }, { size: 36, font: "serif", weight: 500, italic: true, color: INK, fit: true }) },
    { h: 34, draw: (yy) => caps(c, "meta", k.meta[1] ?? "", c.M, yy, c.CW) },
  ]);
};

const fixture: StyleKit["fixture"] = (c, k) => {
  const v = k.vs!;
  masthead(c, k, k.meta[0]);
  let y = c.T + 120;
  if (k.headline) { kicker(c, k.kicker, y); y += 50; }
  const headSize = Math.round(150 * c.k);
  text(c, "headline", k.headline ?? k.kicker, { x: c.M - 6, y, w: c.CW, h: headSize * 1.1 }, { size: headSize, font: "serif", weight: 400, italic: true, color: INK, fit: true });
  y += headSize * 1.1 + 30;
  const colW = c.pick(560, 560, 936);
  const teamSize = Math.round(68 * c.k);
  stackDown(y, [
    { h: teamSize * 1.2, gap: 4, draw: (yy) => text(c, "own", v.ownName, { x: c.M, y: yy, w: colW, h: teamSize * 1.2 }, { size: teamSize, font: "serif", weight: 500, color: INK, fit: true }) },
    { h: 50, gap: 4, draw: (yy) => text(c, "vs", v.label, { x: c.M, y: yy, w: 200, h: 50 }, { size: 40, font: "serif", weight: 400, italic: true, color: "@primary" }) },
    { h: teamSize * 1.2, draw: (yy) => text(c, "opp", v.oppName, { x: c.M, y: yy, w: colW, h: teamSize * 1.2 }, { size: teamSize, font: "serif", weight: 500, color: INK, fit: true }) },
  ]);
  const labels = c.ar ? ["التاريخ", "الساعة", "الملعب"] : ["Date", "Kick-off", "Venue"];
  const info = (x: number, yy: number, w: number, i: number, p: string) => {
    caps(c, `pill-${i + 1}-label`, labels[i], x, yy, w, { size: 20 });
    text(c, `pill-${i + 1}`, p, { x, y: yy + 32, w, h: 44 }, { size: 32, font: "body", weight: 600, color: INK, fit: true });
    rule(c, `pill-${i + 1}-rule`, x, yy + 90, w, "#C9C3B6", 1);
  };
  let bottom: number;
  if (c.story) {
    // Info runs under the teams in a row of three.
    const iy = y + teamSize * 2.4 + 58 + 50;
    const w = (c.CW - 48) / 3;
    k.pills.slice(0, 3).forEach((p, i) => info(c.M + i * (w + 24), iy, w, i, p));
    bottom = iy + 130;
  } else {
    const x = c.M + colW + 56;
    const w = c.CW - colW - 56;
    rect(c, "info-divider-v", { x: x - 28, y, w: 1, h: 3 * 100 }, { fill: "#C9C3B6" });
    k.pills.slice(0, 3).forEach((p, i) => info(x, y + i * 100, w, i, p));
    bottom = Math.max(y + teamSize * 2.4 + 58, y + 300) + 40;
  }
  frame(c, "photo", { x: c.M, y: bottom, w: c.CW, h: c.B - 50 - bottom });
  caps(c, "squad", k.meta[1] ?? "", c.M, c.B - 34, c.CW);
};

const hero: StyleKit["hero"] = (c, k) => {
  masthead(c, k);
  const { head, tag } = heroWords(k);
  const photoY = c.T + 110;
  if (has(k.number)) {
    const nW = 330;
    const x = c.M + nW + 30;
    const w = c.CW - nW - 30;
    const items: StackItem[] = [
      { h: 34, gap: 14, draw: (yy) => caps(c, "kicker", tag, x, yy, w, { color: "@primary" }) },
      { h: Math.round(170 * c.k), gap: 10, draw: (yy) => text(c, "headline", head, { x, y: yy, w, h: Math.round(170 * c.k) }, { size: Math.round(80 * c.k), font: "serif", weight: 500, color: INK, lh: 1.04, fit: true }) },
      has(k.name) && { h: 56, gap: 8, draw: (yy) => text(c, "name", k.name!, { x, y: yy, w, h: 56 }, { size: 44, font: "serif", italic: true, weight: 400, color: INK, fit: true }) },
      k.stat && { h: 76, gap: 8, draw: (yy) => {
        text(c, "stat", k.stat!.value, { x, y: yy, w: 120, h: 76 }, { size: 70, font: "serif", weight: 500, color: "@primary", num: true });
        caps(c, "stat-label", k.stat!.label, x + 130, yy + 24, w - 130);
      } },
      has(k.sub) && { h: 44, gap: 8, draw: (yy) => text(c, "sub", k.sub!, { x, y: yy, w, h: 44 }, { size: 30, font: "body", weight: 500, color: GREY, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 32, gap: 4, draw: (yy: number) => caps(c, `meta-${i + 1}`, m, x, yy, w, { size: 22 }) })),
    ];
    const blockH = Math.max(stackHeight(items), Math.round(330 * c.k));
    const y = c.B - blockH;
    frame(c, "photo", { x: c.M, y: photoY, w: c.CW, h: y - 44 - photoY });
    caps(c, "number-label", c.ar ? "رقم" : "No.", c.M, y, nW, { color: "@primary" });
    text(c, "number", k.number, { x: c.M - 8, y: y + 24, w: nW, h: Math.round(300 * c.k) }, { size: Math.round(310 * c.k), font: "serif", weight: 400, color: INK, num: true, fit: true, lh: 1 });
    rect(c, "column-rule", { x: x - 30, y: y + 6, w: 1, h: c.B - y - 6 }, { fill: "#C9C3B6" });
    stackDown(y, items);
  } else {
    const hs = Math.round(130 * c.k);
    const items: StackItem[] = [
      { h: 34, gap: 16, draw: (yy) => caps(c, "kicker", tag, c.M, yy, c.CW, { color: "@primary" }) },
      { h: Math.round(hs * 1.12), gap: 18, draw: (yy) => text(c, "headline", head, { x: c.M - 4, y: yy, w: c.CW - (k.stat ? 260 : 0), h: Math.round(hs * 1.12) }, { size: hs, font: "serif", weight: 400, color: INK, fit: true }) },
      has(k.sub) && { h: 96, gap: 16, draw: (yy) => text(c, "sub", k.sub!, { x: c.M, y: yy, w: c.pick(820, 820, 936), h: 96 }, { size: 36, font: "serif", italic: true, weight: 400, color: INK, lh: 1.3, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 32, gap: 4, draw: (yy: number) => caps(c, `meta-${i + 1}`, m, c.M, yy, c.CW, { size: 22 }) })),
    ];
    const y = c.B - stackHeight(items);
    frame(c, "photo", { x: c.M, y: photoY, w: c.CW, h: y - 44 - photoY });
    stackDown(y, items);
    if (k.stat) {
      text(c, "stat", k.stat.value, { x: c.W - c.M - 240, y: y + 40, w: 240, h: 130 }, { size: 130, font: "serif", weight: 400, color: "@primary", num: true, align: "end" });
      caps(c, "stat-label", k.stat.label, c.W - c.M - 240, y + 176, 240, { align: "end", size: 20 });
    }
  }
};

const list: StyleKit["list"] = (c, k) => {
  masthead(c, k);
  kicker(c, k.kicker, c.T + 124);
  const hs = Math.round(104 * c.k);
  text(c, "headline", k.headline ?? "", { x: c.M - 4, y: c.T + 180, w: c.CW, h: hs * 1.15 }, { size: hs, font: "serif", weight: 400, color: INK, fit: true });
  const top = c.T + 180 + hs * 1.15 + 40;
  rule(c, "table-top", c.M, top - 2, c.CW, INK, 2);
  const rows = k.rows ?? [];
  const lead = numericLead(k);
  const foot = (k.cta ? 56 : 0) + k.meta.length * 40 + 30;
  rowBoxes(rows.length, top + 6, c.B - foot, c.M, c.CW, { gap: 0, maxH: Math.round((lead ? 136 : 160) * c.k) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    if (lead) {
      text(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.12, w: 100, h: b.h * 0.76 }, { size: Math.round(b.h * 0.6), font: "serif", weight: 400, color: "@primary", num: true, fit: true });
      text(c, `${id}-main`, row[1], { x: b.x + 120, y: b.y + b.h * 0.2, w: b.w - 120 - 200, h: b.h * 0.6 }, { size: Math.round(b.h * 0.42), font: "serif", weight: 500, color: INK, fit: true });
    } else {
      text(c, `${id}-lead`, row[0], { x: b.x, y: b.y + b.h * 0.12, w: b.w - 260, h: b.h * 0.46 }, { size: Math.round(b.h * 0.34), font: "serif", weight: 500, color: INK, fit: true });
      text(c, `${id}-main`, row[1], { x: b.x, y: b.y + b.h * 0.58, w: b.w - 260, h: b.h * 0.3 }, { size: Math.round(b.h * 0.2), font: "body", weight: 500, color: GREY, fit: true });
    }
    text(c, `${id}-trail`, row[2], { x: b.x + b.w - 240, y: b.y + b.h * 0.2, w: 240, h: b.h * 0.6 }, { size: Math.round(b.h * (lead ? 0.36 : 0.34)), font: lead ? "body" : "serif", weight: lead ? 700 : 500, color: lead ? GREY : INK, upper: lead, align: "end", fit: true });
    rule(c, `${id}-rule`, b.x, b.y + b.h - 1, b.w, "#C9C3B6", 1);
  });
  stackUp(c.B, [
    ...k.meta.map((m, i) => ({ h: 36, gap: 8, draw: (y: number) => text(c, `meta-${i + 1}`, m, { x: c.M, y, w: c.CW, h: 36 }, { size: 26, font: "serif", italic: true, weight: 400, color: GREY, fit: true }) })),
    k.cta && { h: 40, draw: (y: number) => caps(c, "cta", k.cta!, c.M, y, c.CW, { color: INK, size: 26 }) },
  ]);
};

const promo: StyleKit["promo"] = (c, k) => {
  masthead(c, k);
  if (k.options) {
    kicker(c, k.kicker, c.T + 124);
    const hs = Math.round(110 * c.k);
    text(c, "headline", k.headline ?? "", { x: c.M - 4, y: c.T + 180, w: c.CW, h: hs * 2.2 }, { size: hs, font: "serif", weight: 400, color: INK, lh: 1.05, fit: true });
    const top = c.T + 180 + hs * 2.2 + 30;
    const cw = (c.CW - 40) / 2;
    const ch = c.B - 130 - top;
    k.options.forEach((opt, i) => {
      const x = c.M + i * (cw + 40);
      frame(c, `option-${i + 1}-photo`, { x, y: top, w: cw, h: ch }, `more.${i}`);
      text(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x, y: top + ch + 18, w: 60, h: 64 }, { size: 54, font: "serif", italic: true, weight: 400, color: "@primary" });
      text(c, `option-${i + 1}`, opt, { x: x + 64, y: top + ch + 18, w: cw - 64, h: 64 }, { size: 54, font: "serif", weight: 500, color: INK, fit: true });
    });
    caps(c, "meta-1", k.meta[0] ?? "", c.M, c.B - 34, c.CW);
    return;
  }
  const manifesto = k.key === "manifesto";
  const hs = Math.round((manifesto ? 84 : 112) * c.k);
  const down: StackItem[] = [
    { h: 34, gap: 16, draw: (yy) => caps(c, "kicker", k.kicker, c.M, yy, c.CW - 220, { color: "@primary" }) },
    manifesto && !c.ar && { h: 90, gap: 0, draw: (yy) => text(c, "quote-mark", "\u201C", { x: c.M - 10, y: yy - 10, w: 120, h: 120 }, { size: 180, font: "serif", weight: 400, color: "@primary", lh: 1 }) },
    { h: Math.round(hs * (manifesto ? 2.4 : 2.2)), gap: 18, draw: (yy) => text(c, "headline", k.headline ?? "", { x: c.M - 4, y: yy, w: c.CW, h: Math.round(hs * (manifesto ? 2.4 : 2.2)) }, { size: hs, font: "serif", weight: 400, italic: manifesto, color: INK, lh: 1.08, fit: true }) },
    has(k.sub) && { h: 50, gap: 0, draw: (yy) => text(c, "sub", k.sub!, { x: c.M, y: yy, w: c.CW, h: 50 }, { size: 34, font: "body", weight: 500, color: GREY, fit: true }) },
  ];
  const up: StackItem[] = [
    k.pills.length > 0 && { h: 50, gap: 20, draw: (yy) => {
      rule(c, "pills-rule", c.M, yy - 16, c.CW, INK, 1);
      const pw = c.CW / k.pills.length;
      k.pills.forEach((p, i) => text(c, `pill-${i + 1}`, p, { x: c.M + i * pw, y: yy, w: pw - 24, h: 44 }, { size: 32, font: "body", weight: 600, color: INK, fit: true }));
    } },
    k.cta && { h: 40, draw: (yy) => {
      caps(c, "cta", k.cta!, c.M, yy, c.CW, { color: INK, size: 26 });
      rule(c, "cta-rule", c.M, yy + 42, 120, "@primary", 3);
    } },
  ];
  const upH = stackHeight(up);
  const textTop = c.B - upH - (upH ? 56 : 0) - stackHeight(down);
  const photoY = c.T + 110;
  const photoH = textTop - 44 - photoY;
  frame(c, "photo", { x: c.M, y: photoY, w: c.CW, h: photoH });
  if (k.key === "map") pin(c, c.W / 2, photoY + photoH / 2, "@primary", PAPER);
  if (has(k.badge)) {
    const bx = c.W - c.M - 200;
    const by = photoY + photoH - 120;
    ellipse(c, "badge-disc", { x: bx, y: by, w: 200, h: 200 }, { fill: PAPER, stroke: { color: "@primary", width: 3 }, rotation: -12 });
    text(c, "badge", k.badge, { x: bx + 20, y: by + 70, w: 160, h: 60 }, { size: 40, font: "serif", italic: true, weight: 500, color: "@primary", align: "center", fit: true, rotation: -12 });
  }
  stackDown(textTop, down);
  stackUp(c.B, up);
};

const skin: StyleKit["skin"] = {
  shade: (c) => rect(c, "shade", { x: 0, y: c.H - 700, w: c.W, h: 700 }, { gradient: { from: "#16181D00", to: "#16181DB3" } }),
  frame: (c, k, t) => {
    crest(c, "crest", { x: c.M, y: c.T, w: 64, h: 64 }, t);
    text(c, "academy", k.academy, { x: c.M + 84, y: c.T + 18, w: 700, h: 34 }, { size: 24, font: "body", weight: 700, color: WHITE, upper: true, ls: 5, fit: true, ...t });
  },
  tag: (c, k, t) => {
    rule(c, "kicker-rule", c.M, c.B - 474, 48, "@primary", 4, t);
    text(c, "kicker", k.kicker, { x: c.M + 68, y: c.B - 490, w: 600, h: 36 }, { size: 26, font: "body", weight: 700, color: WHITE, upper: true, ls: 5, fit: true, ...t });
  },
  goal: (c, k, t) => {
    const s = k.score!;
    const y = c.B - 420;
    rect(c, "card", { x: c.M, y, w: c.CW, h: 400 }, { fill: PAPER, ...t });
    text(c, "number", k.number ?? "", { x: c.M + 40, y: y + 30, w: 280, h: 240 }, { size: 240, font: "serif", weight: 400, color: "@primary", num: true, fit: true, ...t });
    text(c, "name", k.name ?? "", { x: c.M + 340, y: y + 80, w: c.CW - 380, h: 60 }, { size: 48, font: "serif", italic: true, weight: 400, color: INK, fit: true, ...t });
    text(c, "score", `${s.ownName} ${s.own}–${s.opp} ${s.oppName}`, { x: c.M + 40, y: y + 300, w: c.CW - 80, h: 56 }, { size: 40, font: "serif", weight: 500, color: INK, fit: true, ...t });
    rule(c, "card-rule", c.M + 40, y + 284, c.CW - 80, INK, 1, t);
  },
  speaker: (c, k, t) => {
    const y = c.B - 400;
    rect(c, "card", { x: c.M, y, w: 760, h: 170 }, { fill: PAPER, ...t });
    text(c, "speaker", k.headline ?? "", { x: c.M + 36, y: y + 26, w: 690, h: 64 }, { size: 52, font: "serif", weight: 500, color: INK, fit: true, ...t });
    text(c, "role", k.sub ?? "", { x: c.M + 36, y: y + 100, w: 690, h: 44 }, { size: 32, font: "serif", italic: true, weight: 400, color: GREY, fit: true, ...t });
  },
  title: (c, k, t) => {
    const y = c.B - 420;
    rect(c, "card", { x: c.M, y, w: c.CW, h: 300 }, { fill: PAPER, ...t });
    text(c, "headline", k.headline ?? "", { x: c.M + 40, y: y + 40, w: c.CW - 80, h: 160 }, { size: 96, font: "serif", weight: 400, color: INK, fit: true, ...t });
    rule(c, "card-rule", c.M + 40, y + 214, c.CW - 80, INK, 1, t);
    text(c, "meta-1", k.meta[0] ?? "", { x: c.M + 40, y: y + 236, w: c.CW - 80, h: 34 }, { size: 24, font: "body", weight: 700, color: GREY, upper: true, ls: 5, fit: true, ...t });
  },
  caption: (c, id, value, t) => text(c, id, value, { x: c.M, y: c.B - 220, w: c.CW, h: 170 }, { size: 46, font: "serif", italic: true, weight: 400, color: WHITE, lh: 1.25, fit: true, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: PAPER, ...t });
    crest(c, "end-crest", { x: c.W / 2 - 110, y: c.H / 2 - 240, w: 220, h: 220 }, t);
    text(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 20, w: c.CW, h: 90 }, { size: 64, font: "serif", weight: 400, color: INK, align: "center", fit: true, ...t });
    rule(c, "end-rule", c.W / 2 - 60, c.H / 2 + 140, 120, "@primary", 3, t);
  },
};

export const editorial: StyleKit = { background: PAPER, score, fixture, hero, list, promo, skin };
