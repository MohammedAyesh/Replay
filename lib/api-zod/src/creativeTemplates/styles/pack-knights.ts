import type { SceneLayer } from "../../creativeScene";
import type { Content } from "../content";
import { crest, ellipse, media, rect, rule, slant, text, type Box, type Ctx, type TextOpts, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * Brand pack "knights" (Jordan Knights), from the club's brand deck: a fight
 * poster in black and Knight red. The photo fills the frame under heavy
 * black-to-transparent gradients with crimson rising from the bottom; a hard
 * black diagonal panel cuts across it. Headlines are massive italic Barlow
 * Condensed 900 capitals with a red glow, and the second line sits on a red
 * band tilted 2°. Small crest top right, steel for every quiet line, and a
 * black sponsor strip with a red top edge along the bottom of posts. Players
 * are led by their shirt number. Warm moments (birthday, get well, welcome)
 * swap the capitals for Permanent Marker.
 */

const INK = "#0B0B0D";
const PAPER = "#FFF4F0";
const CRIMSON = "#6E0B14";
const CLEAR = "#00000000";
const RED = "@primary";
const STEEL = "@accent";

type Fam = "display" | "body" | "marker";
const FAMILY: Record<Fam, string> = { display: "Barlow Condensed", body: "Inter", marker: "Permanent Marker" };
const ARABIC = "Cairo";

/** Red glow behind the big type. */
const GLOW = { color: RED, blur: 40, x: 0, y: 0 };
/** Templates that get the warm, hand-written treatment. */
const WARM = new Set(["birthday", "getwell", "welcome"]);
/** Height of the sponsor strip along the bottom of posts and squares. */
const STRIP = 84;

/** A text layer in the pack's typefaces (Cairo for Arabic, Barlow Condensed for digits). */
function tx(c: Ctx, id: string, value: string, b: Box, o: TextOpts & { fam?: Fam }): SceneLayer {
  const { fam, ...rest } = o;
  const f: Fam = fam ?? (rest.font === "body" ? "body" : rest.font === "script" ? "marker" : "display");
  const layer = text(c, id, value, b, rest);
  (layer as { family?: string }).family = c.ar && !rest.num ? ARABIC : FAMILY[f];
  return layer;
}

/** Massive italic capitals with the red glow; `outline` draws them hollow. */
function big(c: Ctx, id: string, value: string, b: Box, size: number, o: { num?: boolean; color?: string; align?: "start" | "center" | "end"; outline?: boolean } & Timing = {}) {
  const { num, color, align, outline, ...t } = o;
  return tx(c, id, value, b, {
    size, font: "condensed", weight: 900, italic: true, upper: true, lh: 0.9, fit: true, shadow: GLOW, num, align,
    color: outline ? CLEAR : color ?? PAPER, ...(outline ? { stroke: { color: PAPER, width: 4 } } : {}), ...t,
  });
}

const bandPad = (size: number) => Math.round(size * 0.16);
const bandH = (size: number, marker = false) => Math.round(size * (marker ? 1.3 : 1.04)) + 2 * bandPad(size);

/** The red band: a headline's second line on a slab of red that hugs the words, tilted. */
function band(c: Ctx, id: string, value: string, x: number, y: number, w: number, size: number, o: { marker?: boolean; align?: "start" | "center" | "end" } & Timing = {}) {
  const { marker, align, ...t } = o;
  const pad = bandPad(size);
  tx(c, id, value, { x, y, w, h: bandH(size, marker) }, {
    size, font: marker ? "script" : "condensed", weight: marker && !c.ar ? 400 : 900, arScale: marker ? 0.9 : undefined, italic: !marker, upper: !marker, color: PAPER,
    lh: marker ? 1.15 : 1, fit: true, rotation: marker ? -3 : -2, align, bg: { color: RED, padding: pad, radius: 0 }, ...t,
  });
}

/** Small steel capitals behind a red slash. */
function tag(c: Ctx, id: string, value: string, x: number, y: number, w: number, t: Timing = {}) {
  slant(c, `${id}-mark`, { x, y: y + 5, w: 22, h: 30 }, 14, { fill: RED, ...t });
  tx(c, id, value, { x: x + 36, y, w: w - 36, h: 40 }, { size: 28, font: "condensed", weight: 700, color: STEEL, upper: true, ls: 5, fit: true, ...t });
}

const meta = (c: Ctx, id: string, value: string, y: number, align: "start" | "center" = "start") =>
  tx(c, id, value, { x: c.M, y, w: c.CW, h: 36 }, { size: 28, font: "condensed", weight: 700, color: STEEL, upper: true, ls: 3, fit: true, align });

/** A paper pill with ink capitals (Watch on Replay, Book now). */
const ctaPill = (c: Ctx, value: string, y: number, align: "start" | "center" = "start", t: Timing = {}) =>
  tx(c, "cta", value, { x: c.M, y, w: c.CW, h: 72 }, { size: 36, font: "condensed", weight: 800, color: INK, upper: true, ls: 1, fit: true, align, bg: { color: PAPER, padding: 16, radius: 36 }, ...t });

/**
 * The headline's two lines: at a line break, a " · ", or half the words
 * (the shorter half first). One word or one binding stays whole.
 */
function split(s: string): [string, string] {
  const v = s.trim();
  if (v.includes("\n")) {
    const [a, ...b] = v.split("\n");
    return [a.trim(), b.join(" ").trim()];
  }
  const dot = v.indexOf(" · ");
  if (dot > 0) return [v.slice(0, dot).trim(), v.slice(dot + 3).trim()];
  const w = v.split(/\s+/).filter(Boolean);
  if (w.length < 2) return [v, ""];
  const n = Math.floor(w.length / 2);
  return [w.slice(0, n).join(" "), w.slice(n).join(" ")];
}

const lower = (s: string) => s.trim().toLowerCase();

/** Shrinks a stack (built at scale f) until it fits between top and bottom. */
function fitted(top: number, bottom: number, build: (f: number) => StackItem[]): StackItem[] {
  let f = 1;
  let items = build(f);
  while (f > 0.6 && stackHeight(items) > bottom - top) {
    f -= 0.05;
    items = build(f);
  }
  return items;
}

/** Proportional embers drifting over the dark. */
function embers(c: Ctx, t: Timing = {}) {
  const spots: Array<[number, number, number, number]> = [
    [0.1, 0.24, 9, 0.7], [0.2, 0.36, 5, 0.55], [0.82, 0.2, 11, 0.65], [0.9, 0.33, 6, 0.5], [0.66, 0.14, 5, 0.55], [0.38, 0.17, 7, 0.45], [0.94, 0.46, 8, 0.6],
  ];
  spots.forEach(([fx, fy, d, o], i) =>
    ellipse(c, `ember-${i + 1}`, { x: Math.round(c.W * fx), y: Math.round(c.H * fy), w: d, h: d }, { fill: i % 3 === 2 ? STEEL : RED, opacity: o, ...t }));
}

/** The hard black diagonal panel, its edge leaning like the italics. */
function panel(c: Ctx, o: { opacity?: number } & Timing = {}) {
  const { opacity, ...t } = o;
  const dx = Math.round(Math.tan((14 * Math.PI) / 180) * c.H);
  const x = Math.round(c.W * (c.story ? 0.3 : 0.36));
  slant(c, "panel", { x, y: 0, w: c.W - x + dx + 24, h: c.H }, 14, { fill: INK, opacity: opacity ?? 0.55, name: "bleed", ...t });
}

/** Photo full-bleed under the black gradients and the crimson. */
function poster(c: Ctx, o: { dim?: number; panel?: boolean } = {}) {
  media(c, "photo", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Photo" });
  if (o.dim) rect(c, "photo-dim", { x: 0, y: 0, w: c.W, h: c.H }, { fill: INK, opacity: o.dim });
  rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: Math.round(c.H * 0.3) }, { gradient: { from: "#0B0B0DD9", to: CLEAR } });
  if (o.panel) panel(c);
  const mid = Math.round(c.H * 0.3);
  const low = Math.round(c.H * 0.7);
  rect(c, "shade", { x: 0, y: mid, w: c.W, h: low - mid }, { gradient: { from: CLEAR, to: "#0B0B0DE0" } });
  rect(c, "shade-low", { x: 0, y: low - 2, w: c.W, h: c.H - low + 2 }, { gradient: { from: "#0B0B0DE0", to: INK } });
  rect(c, "crimson", { x: 0, y: Math.round(c.H * 0.5), w: c.W, h: c.H - Math.round(c.H * 0.5) }, { gradient: { from: CRIMSON, to: CLEAR, angle: 0 }, opacity: 0.75 });
  rect(c, "crimson-side", { x: 0, y: 0, w: Math.round(c.W * 0.5), h: c.H }, { gradient: { from: CRIMSON, to: CLEAR, angle: 90 }, opacity: 0.35 });
  embers(c);
}

/**
 * Crest top right. Stories carry the academy name top left; posts put it in
 * the black sponsor strip. Returns the bottom of the content area.
 */
function frame(c: Ctx, k: Content): number {
  crest(c, "crest", { x: c.W - c.M - 88, y: c.T, w: 88, h: 88 });
  const name = (y: number) => tx(c, "academy", k.academy, { x: c.M, y, w: 640, h: 36 }, { size: 24, font: "condensed", weight: 700, color: STEEL, upper: true, ls: 6, fit: true });
  if (c.story) {
    name(c.T + 26);
    return c.B;
  }
  const y = c.H - STRIP;
  rect(c, "strip", { x: 0, y, w: c.W, h: STRIP }, { fill: INK });
  rule(c, "strip-rule", 0, y, c.W, RED, 4);
  name(y + 26);
  [0, 1, 2].forEach((i) => slant(c, `strip-mark-${i + 1}`, { x: c.W - c.M - 92 + i * 32, y: y + 26, w: 22, h: 34 }, 14, { fill: RED, opacity: 1 - i * 0.3 }));
  return y - 48;
}

/** The score bug: own | score | opponent | LIVE, in the same place on every live frame. */
function bug(c: Ctx, k: Content, y: number) {
  const s = k.score!;
  const h = 60;
  const cells: Array<{ id: string; value: string; w: number; fill: string; ink: string; num?: boolean }> = [
    { id: "bug-own", value: s.ownName, w: c.square ? 220 : 240, fill: INK, ink: PAPER },
    { id: "bug-score", value: `${s.own}–${s.opp}`, w: 120, fill: RED, ink: PAPER, num: true },
    { id: "bug-opp", value: s.oppName, w: c.square ? 220 : 240, fill: INK, ink: PAPER },
  ];
  if (has(k.badge)) cells.push({ id: "badge", value: k.badge, w: 130, fill: STEEL, ink: INK });
  let x = c.M;
  for (const cell of cells) {
    rect(c, `${cell.id}-bg`, { x, y, w: cell.w, h }, { fill: cell.fill });
    const dot = cell.id === "badge";
    if (dot) ellipse(c, "badge-dot", { x: x + 16, y: y + h / 2 - 7, w: 14, h: 14 }, { fill: RED });
    tx(c, cell.id, cell.value, { x: x + (dot ? 36 : 12), y: y + 10, w: cell.w - (dot ? 48 : 24), h: h - 20 }, {
      size: 32, font: "condensed", weight: cell.num ? 900 : 700, color: cell.ink, upper: true, align: "center", fit: true, num: cell.num,
    });
    x += cell.w;
  }
}

// ── Score: full time, half time, goal flash, live score ─────────────────────

const score: StyleKit["score"] = (c, k) => {
  poster(c, { panel: true });
  const bot = frame(c, k);
  const s = k.score!;
  const live = has(k.badge) || k.key === "halftime";
  if (live) bug(c, k, c.T + 14);
  const top = c.T + (live ? 108 : 100);
  // The label stays whole (FULL TIME, GOAL!); the scorers ride the band under it.
  const metaLine = k.meta.filter(Boolean).join("  ·  ");
  const items = fitted(top, bot, (f) => {
    const hs = Math.round(c.pick(150, 116, 176) * f);
    const bs = Math.round(hs * 0.5);
    const ss = Math.round(c.pick(380, 270, 440) * f);
    const ns = Math.round(c.pick(62, 48, 70) * f);
    return [
      { h: Math.round(hs * 0.95), gap: 12, draw: (y) => big(c, "kicker", k.kicker, { x: c.M - 8, y, w: c.CW, h: Math.round(hs * 0.95) }, hs) },
      has(k.sub) && { h: bandH(bs), gap: 10, draw: (y) => band(c, "sub", k.sub!, c.M, y, c.CW, bs) },
      { h: Math.round(ss * 0.9), gap: 6, draw: (y) => big(c, "score", `${s.own}–${s.opp}`, { x: c.M - 10, y, w: c.CW, h: Math.round(ss * 0.9) }, ss, { num: true }) },
      { h: Math.round(ns * 1.05), gap: 2, draw: (y) => tx(c, "own", s.ownName, { x: c.M, y, w: c.CW, h: Math.round(ns * 1.05) }, { size: ns, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, fit: true }) },
      { h: Math.round(ns * 1.05), gap: 20, draw: (y) => tx(c, "opp", s.oppName, { x: c.M, y, w: c.CW, h: Math.round(ns * 1.05) }, { size: ns, font: "condensed", weight: 800, italic: true, color: STEEL, upper: true, fit: true }) },
      has(metaLine) && { h: 36, draw: (y) => meta(c, "meta", metaLine, y) },
    ];
  });
  stackUp(bot, items);
};

// ── Fixture: matchday, through to the next round, kick-off ──────────────────

const fixture: StyleKit["fixture"] = (c, k) => {
  poster(c, { panel: true });
  const bot = frame(c, k);
  const v = k.vs!;
  const head = k.headline ?? k.kicker;
  const tagText = k.headline ? k.kicker : (k.meta[0] ?? "");
  const metaLine = k.meta[k.headline ? 0 : 1] ?? "";
  const [l1, l2] = split(head);
  const pills = k.pills.filter(Boolean);
  const p1 = pills.length > 1 ? pills.slice(0, -1).join("  ·  ") : (pills[0] ?? "");
  const p2 = pills.length > 1 ? pills[pills.length - 1] : "";
  const live = k.key === "kickoff";
  const items = fitted(c.T + 110, bot, (f) => {
    const hs = Math.round(c.pick(190, 146, 214) * f);
    const bs = Math.round(Math.min(hs * 0.56, 100));
    const ts = Math.round(c.pick(64, 54, 72) * f);
    const vs = (y: number) => {
      tx(c, "vs", v.label, { x: c.M, y: y + Math.round(ts * 0.18), w: 76, h: Math.round(ts * 0.8) }, { size: Math.round(ts * 0.62), font: "condensed", weight: 900, italic: true, color: RED, upper: true, fit: true });
      tx(c, "opp", v.oppName, { x: c.M + 86, y, w: c.CW - 86, h: Math.round(ts * 1.05) }, { size: ts, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, fit: true });
    };
    return [
      has(tagText) && { h: 40, gap: c.ar ? 34 : 18, draw: (y) => tag(c, "kicker", tagText, c.M, y, c.CW) },
      { h: Math.round(hs * 0.95), gap: 10, draw: (y) => big(c, "headline", l1, { x: c.M - 8, y, w: c.CW, h: Math.round(hs * 0.95) }, hs) },
      has(l2) && { h: bandH(bs), gap: 16, draw: (y) => band(c, "headline-2", l2, c.M, y, c.CW, bs) },
      has(l2)
        ? { h: Math.round(ts * 1.05), gap: 4, draw: (y) => tx(c, "own", v.ownName, { x: c.M, y, w: c.CW, h: Math.round(ts * 1.05) }, { size: ts, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, fit: true }) }
        : { h: bandH(bs), gap: 16, draw: (y) => band(c, "own", v.ownName, c.M, y, c.CW, bs) },
      { h: Math.round(ts * 1.05), gap: 26, draw: vs },
      { h: 2, gap: 22, draw: (y) => rule(c, "info-rule", c.M, y, c.CW, "#B9BEC659", 2) },
      has(p1) && { h: live ? 60 : 40, gap: 10, draw: (y) => live
        ? tx(c, "pill-1", p1, { x: c.M, y, w: c.CW, h: 60 }, { size: 36, font: "condensed", weight: 900, italic: true, color: PAPER, upper: true, ls: 2, fit: true, bg: { color: RED, padding: 10, radius: 4 } })
        : tx(c, "pill-1", p1, { x: c.M, y, w: c.CW, h: 40 }, { size: 34, font: "condensed", weight: 800, color: PAPER, upper: true, ls: 2, fit: true }) },
      has(p2) && { h: 38, gap: 8, draw: (y) => tx(c, "pill-2", p2, { x: c.M, y, w: c.CW, h: 38 }, { size: 30, font: "condensed", weight: 700, color: STEEL, upper: true, ls: 2, fit: true }) },
      has(metaLine) && { h: 36, gap: 18, draw: (y) => meta(c, "meta", metaLine, y) },
      k.cta && { h: 72, draw: (y) => ctaPill(c, k.cta!, y) },
    ];
  });
  stackUp(bot, items);
};

// ── Hero: player of the match / month, clean sheet, champions, coach, alumni ─

/** Birthday, get well, welcome: centred, in the brush script, the number hollow. */
function warm(c: Ctx, k: Content) {
  poster(c, { dim: 0.2 });
  const bot = frame(c, k);
  const { head, tag: tagText } = heroWords(k);
  const [l1, l2] = split(head);
  const showTag = has(tagText) && !lower(head).includes(lower(tagText));
  const items = fitted(c.T + 110, bot, (f) => {
    const ms = Math.round(c.pick(124, 100, 140) * f);
    const bs = Math.round(ms * 0.82);
    const ns = Math.round(c.pick(300, 220, 340) * f);
    return [
      showTag && { h: 40, gap: 16, draw: (y) => tx(c, "kicker", tagText, { x: c.M, y, w: c.CW, h: 40 }, { size: 30, font: "condensed", weight: 700, color: STEEL, upper: true, ls: 5, align: "center", fit: true }) },
      { h: Math.round(ms * 1.25), gap: 4, draw: (y) => tx(c, "headline", l1, { x: c.M, y, w: c.CW, h: Math.round(ms * 1.25) }, {
        size: ms, font: "script", weight: c.ar ? 900 : 400, arScale: 0.9, color: PAPER, align: "center", lh: 1.1, fit: true, shadow: { color: INK, blur: 24, x: 0, y: 6 },
      }) },
      has(l2) && { h: bandH(bs, true), gap: 20, draw: (y) => band(c, "headline-2", l2, c.M, y, c.CW, bs, { marker: true, align: "center" }) },
      has(k.number) && { h: Math.round(ns * 0.9), gap: 8, draw: (y) => big(c, "number", `#${k.number}`, { x: c.M, y, w: c.CW, h: Math.round(ns * 0.9) }, ns, { num: true, outline: true, align: "center" }) },
      has(k.name) && { h: 56, gap: 10, draw: (y) => tx(c, "name", k.name!, { x: c.M, y, w: c.CW, h: 56 }, { size: 48, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, align: "center", fit: true }) },
      has(k.sub) && { h: 76, gap: 14, draw: (y) => tx(c, "sub", k.sub!, { x: c.M + 40, y, w: c.CW - 80, h: 76 }, { size: 32, font: "body", weight: 500, color: PAPER, align: "center", lh: 1.2, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 36, gap: 6, draw: (y: number) => meta(c, `meta-${i + 1}`, m, y, "center") })),
    ];
  });
  stackUp(bot, items);
}

const hero: StyleKit["hero"] = (c, k) => {
  if (WARM.has(k.key)) return warm(c, k);
  poster(c, { panel: true });
  const bot = frame(c, k);
  const { head, tag: tagText } = heroWords(k);
  const [l1, l2] = split(head);
  const dup = lower(tagText) === lower(head);
  // Two words: the second goes on the band and the tag sits on top. One: the tag is the band.
  const bandText = l2 || (dup ? "" : tagText);
  const showTag = has(l2) && !dup && has(tagText);
  const num = has(k.number);
  const items = fitted(c.T + 300, bot, (f) => {
    const hs = Math.round(c.pick(170, 130, 190) * f);
    const bs = Math.round(Math.min(hs * 0.6, 100));
    return [
      showTag && { h: 40, gap: 18, draw: (y) => tag(c, "kicker", tagText, c.M, y, c.CW) },
      { h: Math.round(hs * (l2 ? 0.95 : 1.8)), gap: 10, draw: (y) => big(c, "headline", l1, { x: c.M - 8, y, w: c.CW, h: Math.round(hs * (l2 ? 0.95 : 1.8)) }, hs) },
      has(bandText) && { h: bandH(bs), gap: 26, draw: (y) => band(c, l2 ? "headline-2" : "kicker", bandText, c.M, y, c.CW, bs) },
      num && { h: 84, gap: 20, draw: (y) => {
        rect(c, "number-chip-bg", { x: c.M, y, w: 150, h: 84 }, { fill: INK, stroke: { color: RED, width: 3 }, radius: 8 });
        tx(c, "number-chip", `#${k.number}`, { x: c.M + 8, y: y + 10, w: 134, h: 64 }, { size: 60, font: "condensed", weight: 900, italic: true, color: PAPER, align: "center", fit: true, num: true });
        tx(c, "name", k.name ?? "", { x: c.M + 176, y: y + 12, w: c.CW - 176, h: 62 }, { size: 54, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, fit: true });
      } },
      !num && has(k.name) && { h: 60, gap: 20, draw: (y) => tx(c, "name", k.name!, { x: c.M, y, w: c.CW, h: 60 }, { size: 54, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, fit: true }) },
      k.stat && { h: 72, gap: 20, draw: (y) => {
        rect(c, "stat-bg", { x: c.M, y, w: 150, h: 72 }, { fill: RED });
        tx(c, "stat", k.stat!.value, { x: c.M + 10, y: y + 8, w: 130, h: 56 }, { size: 56, font: "condensed", weight: 900, italic: true, color: PAPER, align: "center", fit: true, num: true });
        tx(c, "stat-label", k.stat!.label, { x: c.M + 150, y, w: c.CW - 150, h: 72 }, { size: 36, font: "condensed", weight: 800, color: INK, upper: true, ls: 2, fit: true, bg: { color: STEEL, padding: 18, radius: 0 } });
      } },
      has(k.sub) && { h: 80, gap: 14, draw: (y) => tx(c, "sub", k.sub!, { x: c.M, y, w: Math.min(c.CW, 860), h: 80 }, { size: 32, font: "body", weight: 500, color: PAPER, lh: 1.25, fit: true }) },
      ...k.meta.map((m, i) => ({ h: 36, gap: 6, draw: (y: number) => meta(c, `meta-${i + 1}`, m, y) })),
    ];
  });
  // The hollow number fills the dark panel above the words, drawn first so the words sit over it.
  if (num) {
    const ny = c.T + 104;
    const nh = Math.min(c.pick(560, 400, 660), bot - stackHeight(items) - 24 - ny);
    if (nh > 160) big(c, "number", k.number!, { x: c.W - c.M - 640, y: ny, w: 640, h: nh }, nh, { num: true, outline: true, align: "end" });
  }
  stackUp(bot, items);
};

// ── List: line-up, call-up, table, prices, match stats ──────────────────────

/** Shirt-number cards: they read as a squad sheet with names or without. */
function squad(c: Ctx, rows: Array<[string, string, string]>, top: number, bottom: number) {
  const n = rows.length;
  const cols = n <= 4 ? 2 : 3;
  const lines = Math.ceil(n / cols);
  const gap = 16;
  const cw = Math.floor((c.CW - gap * (cols - 1)) / cols);
  const ch = Math.max(80, Math.min(c.pick(220, 150, 270), Math.floor((bottom - top - gap * (lines - 1)) / lines)));
  rows.forEach((row, i) => {
    const line = Math.floor(i / cols);
    const inLine = Math.min(cols, n - line * cols);
    const x0 = c.M + Math.round((c.CW - (inLine * cw + (inLine - 1) * gap)) / 2);
    const x = x0 + (i % cols) * (cw + gap);
    const y = top + line * (ch + gap);
    const id = `row-${i + 1}`;
    rect(c, `${id}-bg`, { x, y, w: cw, h: ch }, { fill: INK, opacity: 0.88, stroke: { color: RED, width: 3 }, radius: 10 });
    slant(c, `${id}-mark`, { x: x + 18, y: y + 16, w: 16, h: 22 }, 14, { fill: RED });
    tx(c, `${id}-lead`, row[0], { x: x + 10, y: y + ch * 0.1, w: cw - 20, h: ch * 0.58 }, { size: Math.round(ch * 0.56), font: "condensed", weight: 900, italic: true, color: PAPER, align: "center", fit: true, num: true, shadow: GLOW });
    tx(c, `${id}-main`, row[1], { x: x + 12, y: y + ch * 0.64, w: cw - 24, h: ch * 0.18 }, { size: Math.round(ch * 0.16), font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, align: "center", fit: true });
    tx(c, `${id}-trail`, row[2], { x: x + 12, y: y + ch * 0.82, w: cw - 24, h: ch * 0.13 }, { size: Math.round(ch * 0.115), font: "condensed", weight: 700, color: STEEL, upper: true, ls: 3, align: "center", fit: true });
  });
}

/** Match stats: our number, the label, theirs, on black diagonal slabs. */
function statRows(c: Ctx, k: Content, top: number, bottom: number) {
  const head = k.rowsHead;
  let y = top;
  if (head) {
    tx(c, "head-lead", head[0], { x: c.M, y, w: c.CW / 2 - 20, h: 40 }, { size: 32, font: "condensed", weight: 900, italic: true, color: PAPER, upper: true, fit: true });
    tx(c, "head-trail", head[2], { x: c.M + c.CW / 2 + 20, y, w: c.CW / 2 - 20, h: 40 }, { size: 32, font: "condensed", weight: 900, italic: true, color: STEEL, upper: true, align: "end", fit: true });
    y += 58;
  }
  const rows = k.rows ?? [];
  rowBoxes(rows.length, y, bottom, c.M, c.CW, { gap: 12, maxH: Math.round(128 * c.k), minH: 56 }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    slant(c, `${id}-bg`, b, 10, { fill: INK, opacity: 0.82 });
    slant(c, `${id}-edge`, { x: b.x, y: b.y, w: Math.round(b.h * 0.42), h: b.h }, 10, { fill: RED });
    const vw = Math.round(b.w * 0.3);
    tx(c, `${id}-lead`, row[0], { x: b.x + Math.round(b.h * 0.42) + 6, y: b.y + b.h * 0.14, w: vw, h: b.h * 0.72 }, { size: Math.round(b.h * 0.62), font: "condensed", weight: 900, italic: true, color: PAPER, fit: true, num: true, shadow: GLOW });
    tx(c, `${id}-main`, row[1], { x: b.x + b.w * 0.33, y: b.y + b.h * 0.22, w: b.w * 0.4, h: b.h * 0.56 }, { size: Math.max(22, Math.round(b.h * 0.34)), font: "condensed", weight: 700, color: STEEL, upper: true, ls: 3, align: "center", fit: true });
    tx(c, `${id}-trail`, row[2], { x: b.x + b.w - vw - 28, y: b.y + b.h * 0.18, w: vw, h: b.h * 0.64 }, { size: Math.round(b.h * 0.52), font: "condensed", weight: 900, italic: true, color: STEEL, align: "end", fit: true, num: true });
  });
}

/** Line-up photo tiles: the figure over a red slant on black, a glowing italic number, a black slanted caption. */
const TILE: TileLook = {
  backdrop: (c, id, b) => {
    rect(c, id, b, { fill: INK, opacity: 0.85 });
    slant(c, `${id}-slant`, { x: b.x + b.w * 0.16, y: b.y, w: b.w * 0.68, h: b.h }, 14, { fill: RED });
    slant(c, `${id}-cut`, { x: b.x + b.w * 0.58, y: b.y, w: b.w * 0.12, h: b.h }, 14, { fill: CRIMSON });
  },
  bar: (c, id, b) => {
    slant(c, id, b, 8, { fill: INK });
    rect(c, `${id}-rule`, { x: b.x + 10, y: b.y, w: b.w - 20, h: 4 }, { fill: RED });
  },
  num: { font: "condensed", color: PAPER, weight: 900, italic: true, shadow: GLOW },
  name: { font: "condensed", color: PAPER, weight: 900, italic: true },
  pos: { font: "condensed", color: STEEL, weight: 800 },
  shadow: INK,
  cardRadius: 0,
  text: tx,
};

const list: StyleKit["list"] = (c, k) => {
  poster(c, { dim: 0.5, panel: true });
  const bot = frame(c, k);
  const hs = c.pick(118, 92, 136);
  const bs = Math.round(hs * 0.6);
  let y = c.T + 116;
  big(c, "kicker", k.kicker, { x: c.M - 8, y, w: c.CW, h: Math.round(hs * 0.95) }, hs);
  y += Math.round(hs * 0.95) + 10;
  if (has(k.headline)) {
    band(c, "headline", k.headline, c.M, y, c.CW, bs);
    y += bandH(bs);
  }
  y += c.pick(40, 26, 60);
  const metaH = k.meta.filter(Boolean).length * 42;
  const foot = metaH + (k.cta ? 82 : 0) + (metaH || k.cta ? 24 : 0);
  const rows = k.rows ?? [];
  if (k.key === "lineup" || k.key === "callup") rowsOrTiles(c, k, { x: c.M, y, w: c.CW, h: bot - foot - 20 - y }, TILE, () => squad(c, rows, y, bot - foot));
  else if (k.key === "matchstats") statRows(c, k, y, bot - foot);
  else {
    const lead = numericLead(k);
    rowBoxes(rows.length, y, bot - foot, c.M, c.CW, { gap: 10, maxH: Math.round(118 * c.k) }).forEach((b, i) => {
      const id = `row-${i + 1}`;
      const row = rows[i];
      slant(c, `${id}-bg`, b, 10, { fill: i === 0 ? RED : INK, opacity: i === 0 ? 1 : 0.82 });
      const lw = lead ? Math.round(b.h * 1.1) : Math.round(b.w * 0.34);
      tx(c, `${id}-lead`, row[0], { x: b.x + 24, y: b.y + b.h * 0.14, w: lw - 24, h: b.h * 0.72 }, { size: Math.round(b.h * (lead ? 0.66 : 0.38)), font: "condensed", weight: 900, italic: true, color: i === 0 ? PAPER : RED, upper: true, num: lead, fit: true });
      tx(c, `${id}-main`, row[1], { x: b.x + lw + 16, y: b.y + b.h * 0.26, w: b.w - lw - 16 - 230, h: b.h * 0.48 }, { size: Math.round(b.h * (lead ? 0.42 : 0.28)), font: lead ? "condensed" : "body", weight: lead ? 800 : 500, italic: lead, color: PAPER, upper: lead, fit: true });
      tx(c, `${id}-trail`, row[2], { x: b.x + b.w - 220, y: b.y + b.h * 0.2, w: 190, h: b.h * 0.6 }, { size: Math.round(b.h * 0.5), font: "condensed", weight: 900, italic: true, color: i === 0 ? PAPER : STEEL, upper: true, align: "end", fit: true });
    });
  }
  stackUp(bot, [
    ...k.meta.filter(Boolean).map((m, i) => ({ h: 36, gap: 6, draw: (yy: number) => meta(c, `meta-${i + 1}`, m, yy) })),
    k.cta && { h: 72, draw: (yy: number) => ctaPill(c, k.cta!, yy) },
  ]);
};

// ── Promo: free trial, new group, tournament, countdown, map, values, poll ──

function poll(c: Ctx, k: Content) {
  rect(c, "bg", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "#1A0306", to: INK } });
  rect(c, "crimson", { x: 0, y: Math.round(c.H * 0.4), w: c.W, h: c.H - Math.round(c.H * 0.4) }, { gradient: { from: CRIMSON, to: CLEAR, angle: 0 }, opacity: 0.9 });
  embers(c);
  const bot = frame(c, k);
  const hs = c.pick(136, 104, 156);
  const bs = Math.round(hs * 0.56);
  const y1 = stackDown(c.T + 116, [
    { h: Math.round(hs * 1.8), gap: 8, draw: (y) => big(c, "headline", k.headline ?? "", { x: c.M - 8, y, w: c.CW, h: Math.round(hs * 1.8) }, hs) },
    { h: bandH(bs), draw: (y) => band(c, "kicker", k.kicker, c.M, y, c.CW, bs) },
  ]);
  const top = y1 + c.pick(40, 28, 60);
  const gap = 24;
  const cw = (c.CW - gap) / 2;
  const ch = bot - 56 - top;
  k.options!.forEach((opt, i) => {
    const x = c.M + i * (cw + gap);
    const id = `option-${i + 1}`;
    media(c, `${id}-photo`, { x, y: top, w: cw, h: ch }, { path: `more.${i}`, name: `Option ${i + 1} photo`, radius: 10 });
    rect(c, `${id}-shade`, { x, y: top + ch * 0.4, w: cw, h: ch * 0.6 }, { gradient: { from: CLEAR, to: INK }, radius: 10 });
    rect(c, `${id}-frame`, { x, y: top, w: cw, h: ch }, { stroke: { color: i === 0 ? RED : STEEL, width: 3 }, radius: 10 });
    rect(c, `${id}-key-bg`, { x: x + 20, y: top + ch - 196, w: 84, h: 84 }, { fill: i === 0 ? RED : STEEL });
    tx(c, `${id}-key`, optionKey(c.ar, i), { x: x + 20, y: top + ch - 190, w: 84, h: 72 }, { size: 64, font: "condensed", weight: 900, italic: true, color: i === 0 ? PAPER : INK, align: "center" });
    big(c, id, opt, { x: x + 20, y: top + ch - 100, w: cw - 40, h: 76 }, 72);
  });
  meta(c, "meta-1", k.meta[0] ?? "", bot - 36);
}

const promo: StyleKit["promo"] = (c, k) => {
  if (k.options) return poll(c, k);
  const map = k.key === "map";
  poster(c, { panel: !map });
  if (map) pin(c, Math.round(c.W * 0.6), Math.round(c.H * 0.3), RED, PAPER);
  const bot = frame(c, k);
  if (has(k.badge)) {
    const by = c.story ? c.T + 84 : c.T + 4;
    slant(c, "badge-bg", { x: c.M, y: by, w: 280, h: 92 }, 14, { fill: RED });
    tx(c, "badge", k.badge, { x: c.M + 34, y: by + 12, w: 212, h: 68 }, { size: 60, font: "condensed", weight: 900, italic: true, color: PAPER, upper: true, align: "center", fit: true });
  }
  const manifesto = k.key === "manifesto";
  const countdown = k.key === "countdown";
  const [l1, l2] = split(k.headline ?? "");
  const bandText = l2 || k.kicker;
  const showTag = has(l2) && has(k.kicker);
  const pills = k.pills.filter(Boolean).join("  ·  ");
  const items = fitted(c.T + (has(k.badge) ? 220 : 110), bot, (f) => {
    const hs = Math.round((manifesto ? c.pick(108, 84, 124) : countdown ? c.pick(230, 176, 260) : c.pick(170, 130, 190)) * f);
    const lines = l2 ? 1 : manifesto ? 3 : 2;
    const hh = Math.round(hs * (lines === 1 ? 0.95 : 0.92 * lines));
    const bs = Math.round(Math.min(hs * (countdown ? 0.42 : 0.58), 96));
    return [
      showTag && { h: 40, gap: 18, draw: (y) => tag(c, "kicker", k.kicker, c.M, y, c.CW) },
      { h: hh, gap: 10, draw: (y) => big(c, "headline", l1, { x: c.M - 8, y, w: c.CW, h: hh }, hs) },
      has(bandText) && { h: bandH(bs), gap: 26, draw: (y) => band(c, l2 ? "headline-2" : "kicker", bandText, c.M, y, c.CW, bs) },
      has(k.sub) && { h: manifesto ? 84 : 48, gap: 18, draw: (y) => tx(c, "sub", k.sub!, { x: c.M, y, w: c.CW, h: manifesto ? 84 : 48 }, { size: 32, font: "body", weight: 500, color: PAPER, lh: 1.25, fit: true }) },
      has(pills) && { h: 2, gap: 18, draw: (y) => rule(c, "info-rule", c.M, y, c.CW, "#B9BEC659", 2) },
      has(pills) && { h: 40, gap: 20, draw: (y) => tx(c, "pills", pills, { x: c.M, y, w: c.CW, h: 40 }, { size: 32, font: "condensed", weight: 800, color: STEEL, upper: true, ls: 2, fit: true }) },
      k.cta && { h: 72, draw: (y) => ctaPill(c, k.cta!, y) },
    ];
  });
  stackUp(bot, items);
};

// ── Video ───────────────────────────────────────────────────────────────────

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 420 }, { gradient: { from: "#0B0B0DCC", to: CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 900, w: c.W, h: 900 }, { gradient: { from: CLEAR, to: "#0B0B0DF0" } });
    rect(c, "crimson", { x: 0, y: c.H - 640, w: c.W, h: 640 }, { gradient: { from: CRIMSON, to: CLEAR, angle: 0 }, opacity: 0.7 });
  },
  frame: (c, k, t) => {
    crest(c, "crest", { x: c.W - c.M - 84, y: c.T, w: 84, h: 84 }, t);
    tx(c, "academy", k.academy, { x: c.M, y: c.T + 24, w: 640, h: 36 }, { size: 24, font: "condensed", weight: 700, color: STEEL, upper: true, ls: 6, fit: true, ...t });
  },
  tag: (c, k, t) => {
    slant(c, "kicker-bg", { x: c.M, y: c.B - 560, w: 340, h: 58 }, 14, { fill: RED, ...t });
    tx(c, "kicker", k.kicker, { x: c.M + 30, y: c.B - 552, w: 280, h: 42 }, { size: 32, font: "condensed", weight: 800, color: PAPER, upper: true, ls: 3, align: "center", fit: true, ...t });
  },
  goal: (c, k, t) => {
    const s = k.score!;
    big(c, "number", `#${k.number ?? ""}`, { x: c.M - 10, y: c.B - 480, w: c.CW, h: 280 }, 300, { num: true, outline: true, ...t });
    tx(c, "name", k.name ?? "", { x: c.M, y: c.B - 190, w: c.CW, h: 56 }, { size: 48, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, fit: true, ...t });
    band(c, "score", `${s.ownName} ${s.own}–${s.opp} ${s.oppName}`, c.M, c.B - 118, c.CW, 56, t);
  },
  speaker: (c, k, t) => {
    big(c, "speaker", k.headline ?? "", { x: c.M - 10, y: c.B - 470, w: c.CW, h: 110 }, 104, t);
    band(c, "role", k.sub ?? "", c.M, c.B - 350, c.CW, 44, t);
  },
  title: (c, k, t) => {
    big(c, "headline", k.headline ?? "", { x: c.M - 10, y: c.B - 470, w: c.CW, h: 320 }, 170, t);
    tx(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 110, w: c.CW, h: 40 }, { size: 30, font: "condensed", weight: 700, color: STEEL, upper: true, ls: 4, fit: true, ...t });
  },
  caption: (c, id, value, t) => tx(c, id, value, { x: c.M, y: c.B - 230, w: c.CW, h: 170 }, {
    size: 50, font: "condensed", weight: 800, italic: true, color: PAPER, upper: true, align: "center", lh: 1.05, fit: true, shadow: { color: INK, blur: 18, x: 0, y: 4 }, ...t,
  }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { fill: INK, ...t });
    rect(c, "end-crimson", { x: 0, y: c.H / 2, w: c.W, h: c.H / 2 }, { gradient: { from: CRIMSON, to: CLEAR, angle: 0 }, ...t });
    crest(c, "end-crest", { x: c.W / 2 - 130, y: c.H / 2 - 260, w: 260, h: 260 }, t);
    big(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 50, w: c.CW, h: 110 }, 92, { align: "center", ...t });
    rule(c, "end-rule", c.W / 2 - 60, c.H / 2 + 186, 120, RED, 6, t);
  },
};

export const pack_knights: StyleKit = { background: INK, plate: { opacity: 1 }, score, fixture, hero, list, promo, skin };
