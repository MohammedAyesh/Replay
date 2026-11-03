import { DEFINITIONS, type Content } from "../content";
import { CREATIVE_PACKS } from "../../creativePacks";
import { crest, ellipse, media, rect, text, type Box, type Ctx, type TextOpts, type Timing } from "../kit";
import { has, pin, rowBoxes, stackDown, stackHeight, stackUp, type StackItem } from "../parts";
import { heroWords, numericLead, optionKey, type StyleKit } from "./types";
import { rowsOrTiles, type TileLook } from "../players";

/**
 * JUFA Academy (brand pack "jufa", from the JUFA brand deck). For the
 * youngest squads (U7–U10): royal JUFA blue, deep navy, white and a neon
 * yellow kick taken from the training shirts. Two moods, as the deck asks:
 *
 * - Day (training, recruitment, community, players): soft sky paper with the
 *   paper-cut plate showing through, photos in fat white frames, navy type
 *   over neon highlighter swashes, huge blue shirt numbers with a neon offset.
 * - Night (match day, live, results): under the Galaxy floodlights. Navy over
 *   the stadium plate, neon scores in navy score bugs, white type with a blue
 *   drop, white info pills.
 *
 * Both share the skeleton from the deck: crest and name top-left, one big
 * photo or shirt number in the middle, tilted neon stickers for labels, info
 * pills along the bottom, confetti dots in the margins. Players are children:
 * every layout leads with the shirt number; names are optional and may be
 * empty. Neon is never body text on white or sky.
 */

const NAVY = "#0D1F5C";
const SKY = "#DCE7FF";
const WHITE = "#FFFFFF";
const CLEAR = "#00000000";
const NAVY_CLEAR = "#0D1F5C00";
const GLASS = "#FFFFFF1A";
const GLASS_EDGE = "#FFFFFF3D";

const FONT = { display: "Baloo 2", body: "Inter", arabic: "Baloo Bhaijaan 2" } as const;

type Mode = {
  night: boolean;
  /** Headlines. */
  head: string;
  /** Secondary and meta text. */
  soft: string;
  /** Player / team names. */
  name: string;
  /** Giant numbers and their hard offset shadow. */
  num: string;
  numShadow: string;
  /** Photo frame. */
  frame: string;
  pillFill: string;
  pillInk: string;
  pillEdge?: string;
};

const NIGHT: Mode = { night: true, head: WHITE, soft: SKY, name: WHITE, num: "@accent", numShadow: "@primary", frame: "@primary", pillFill: WHITE, pillInk: "@primary" };
const DAY: Mode = { night: false, head: "@ink", soft: "@ink", name: "@primary", num: "@primary", numShadow: "@accent", frame: WHITE, pillFill: WHITE, pillInk: "@ink", pillEdge: "@primary" };

/** Match day, live and results go under the floodlights; everything else is a day post. */
const NIGHT_CATEGORIES = new Set(["matchday", "live", "results"]);
const categoryOf = (k: Content) => DEFINITIONS.find((d) => d.key === k.key)?.category ?? "";
const modeOf = (k: Content): Mode => (NIGHT_CATEGORIES.has(categoryOf(k)) ? NIGHT : DAY);

/** Whether the pack's plate for this template is a light paper-cut one (it decides how hard to wash it). */
function lightPlate(k: Content): boolean {
  const p = CREATIVE_PACKS.jufa.plates;
  const cat = categoryOf(k);
  const key = cat === "matchday" ? p.pre : cat === "live" ? p.live : cat === "results" || cat === "players" ? p.post : p.cover;
  return key.startsWith("bg/playful");
}

/** Day headlines that sit on one line over a neon highlighter swash. */
const SWASH = new Set(["birthday", "getwell", "staff", "pricing", "freetrial", "newgroup", "map", "poll"]);

// ── Type ────────────────────────────────────────────────────────────────────

type Tx = TextOpts & { body?: boolean };

/** Text in the pack's faces: Baloo 2 800 for display, Inter for details, Baloo Bhaijaan 2 for Arabic. */
function tx(c: Ctx, id: string, value: string, b: Box, o: Tx) {
  const { body, ...rest } = o;
  const layer = text(c, id, value, b, { font: body ? "body" : "display", weight: body ? 600 : 800, ...rest });
  (layer as { family?: string }).family = c.ar && !rest.num ? FONT.arabic : body ? FONT.body : FONT.display;
  return layer;
}

/** Headline: navy and warm by day, white capitals with a blue drop at night. */
function headline(c: Ctx, id: string, value: string, b: Box, size: number, m: Mode, o: { align?: "start" | "center" | "end"; lh?: number } & Timing = {}) {
  const { align, lh, ...t } = o;
  return tx(c, id, value, b, {
    size, color: m.head, fit: true, lh: lh ?? 1, align, ...t,
    ...(m.night ? { upper: true, shadow: { color: "@primary", blur: 0, x: 0, y: Math.round(size * 0.06) } } : {}),
  });
}

/**
 * One line of big words over a neon highlighter swash (the deck's "Big
 * future"). The swash is a see-through copy of the words whose background
 * pill covers the lower half of the line, so it is exactly as wide as the
 * words in whatever face renders them.
 */
function swashLine(c: Ctx, id: string, value: string, b: Box, size: number, o: { color?: string; align?: "start" | "center" | "end" } & Timing = {}) {
  const { color, align, ...t } = o;
  const p = Math.round(size * 0.08);
  const inner = Math.round(size * 0.27);
  const gh = inner + 2 * p;
  const cy = b.y + b.h / 2 + size * 0.2;
  tx(c, `${id}-swash`, value, { x: b.x - p, y: cy - gh / 2, w: b.w + 2 * p, h: gh }, {
    size, lh: Math.round(size * 0.26), color: CLEAR, fit: true, align, rotation: -1, name: "Swash", bg: { color: "@accent", padding: p, radius: Math.round(size * 0.08) }, ...t,
  });
  tx(c, id, value, b, { size, lh: 1, color: color ?? "@ink", fit: true, align, ...t });
}

/** A giant rounded shirt number with the deck's hard offset shadow. */
function bigNumber(c: Ctx, id: string, value: string, b: Box, size: number, m: Mode, o: { align?: "start" | "center" | "end"; mirror?: boolean } & Timing = {}) {
  const { align, ...t } = o;
  const off = Math.max(4, Math.round(size * 0.03));
  return tx(c, id, value, b, { size, color: m.num, num: true, fit: true, lh: 0.95, align: align ?? "start", shadow: { color: m.numShadow, blur: 0, x: off, y: off }, ...t });
}

/**
 * A tilted sticker label: a pill that hugs its words (neon with navy type by
 * default). Returns its height.
 */
function sticker(c: Ctx, id: string, value: string, x: number, y: number, w: number, o: { size?: number; rot?: number; fill?: string; ink?: string; align?: "start" | "center" | "end"; upper?: boolean } & Timing = {}): number {
  const { size: s0, rot, fill, ink, align, upper, ...t } = o;
  const size = s0 ?? c.pick(34, 30, 38);
  const pad = Math.round(size * 0.42);
  const h = Math.round(size * 1.2 + pad * 2);
  tx(c, id, value, { x, y, w, h }, {
    size, color: ink ?? NAVY, upper: upper ?? true, ls: 1, lh: 1.2, fit: true, align: align ?? "start", rotation: rot ?? -3,
    bg: { color: fill ?? "@accent", padding: pad, radius: 999 }, ...t,
  });
  return h;
}

const stickerH = (c: Ctx, size?: number) => {
  const s = size ?? c.pick(34, 30, 38);
  return Math.round(s * 1.2 + Math.round(s * 0.42) * 2);
};

/** A call to action pill, centred, hugging its words. */
function cta(c: Ctx, id: string, value: string, y: number, m: Mode, t: Timing = {}) {
  const size = c.pick(34, 30, 38);
  const pad = Math.round(size * 0.5);
  const h = Math.round(size * 1.2 + pad * 2);
  tx(c, id, value, { x: c.M, y, w: c.CW, h }, {
    size, color: m.night ? "@primary" : WHITE, align: "center", fit: true, lh: 1.2, upper: true,
    bg: { color: m.night ? WHITE : NAVY, padding: pad, radius: 999 }, ...t,
  });
  return h;
}
const ctaH = (c: Ctx) => { const s = c.pick(34, 30, 38); return Math.round(s * 1.2 + Math.round(s * 0.5) * 2); };

// ── Ground ──────────────────────────────────────────────────────────────────

/** Confetti dots and streamers in the margins and the top-right corner: [x, y, size, colour, kind, rotation]. */
const BITS: Array<[number, number, number, number, "dot" | "bar", number]> = [
  [0.62, 0.035, 26, 0, "dot", 0], [0.74, 0.085, 50, 1, "bar", -25], [0.885, 0.03, 20, 2, "dot", 0], [0.935, 0.115, 44, 0, "bar", 22],
  [0.53, 0.105, 16, 2, "dot", 0], [0.018, 0.46, 44, 3, "bar", 32], [0.962, 0.55, 22, 0, "dot", 0], [0.022, 0.74, 18, 1, "dot", 0], [0.945, 0.8, 46, 2, "bar", -18],
];

function confetti(c: Ctx, m: Mode, prefix = "bit", t: Timing = {}) {
  const colours = m.night ? ["@accent", WHITE, "@primary", SKY] : ["@accent", "@primary", WHITE, NAVY];
  BITS.forEach(([fx, fy, s, ci, kind, rot], i) => {
    const x = Math.round(c.W * fx);
    const y = Math.round(c.H * fy);
    const fill = colours[ci];
    if (kind === "dot") ellipse(c, `${prefix}-${i + 1}`, { x, y, w: s, h: s }, { fill, name: "Confetti", ...t });
    else rect(c, `${prefix}-${i + 1}`, { x, y, w: s, h: Math.round(s * 0.4) }, { fill, radius: 999, rotation: rot, name: "Confetti", ...t });
  });
}

/** Sky paper or floodlit navy, the washes that set how much of the plate shows, and confetti. */
function ground(c: Ctx, k: Content): Mode {
  const m = modeOf(k);
  const light = lightPlate(k);
  const all = { x: 0, y: 0, w: c.W, h: c.H };
  if (m.night) {
    rect(c, "sky", all, { gradient: { from: "@primary", to: NAVY } });
    // The plate goes here (above "sky"). A paper-cut plate needs more navy to read as night.
    rect(c, "wash", all, { gradient: light ? { from: "#0D1F5CC7", to: "#0D1F5CF5" } : { from: "#0D1F5C38", to: "#0D1F5CE6" } });
  } else {
    rect(c, "sky", all, { fill: SKY });
    rect(c, "wash", all, { gradient: light ? { from: "#DCE7FF73", to: "#DCE7FFA6" } : { from: "#DCE7FFE0", to: "#DCE7FFF2" } });
  }
  confetti(c, m);
  return m;
}

/** Crest top-left, "JUFA ACADEMY" beside it. Returns the y under the crest. */
function lockup(c: Ctx, k: Content, m: Mode, t: Timing = {}, w = 560): number {
  const s = c.pick(112, 100, 120);
  crest(c, "crest", { x: c.M, y: c.T, w: s, h: s }, t);
  tx(c, "academy", k.academy, { x: c.M + s + 22, y: c.T + s / 2 - 30, w, h: 60 }, { size: 40, color: m.night ? WHITE : "@primary", upper: true, fit: true, ...t });
  return c.T + s;
}

/** The LIVE sticker, top right beside the lockup. */
function liveBadge(c: Ctx, value: string, t: Timing = {}) {
  const size = c.pick(34, 30, 38);
  const w = 300;
  const crestS = c.pick(112, 100, 120);
  sticker(c, "badge", `• ${value}`, c.W - c.M - w, c.T + (crestS - stickerH(c, size)) / 2, w, { size, align: "end", rot: 3, ...t });
}

/** A rounded photo: a fat white frame by day, a blue rim and a navy fade at night. */
function photo(c: Ctx, id: string, b: Box, m: Mode, o: { path?: string; rot?: number } = {}): boolean {
  if (b.h < 160) return false;
  const f = m.night ? 8 : 14;
  const rot = o.rot ?? 0;
  const path = o.path ?? "media";
  const outer: Box = { x: b.x - f, y: b.y - f, w: b.w + 2 * f, h: b.h + 2 * f };
  if (!m.night) rect(c, `${id}-drop`, { ...outer, y: outer.y + 18 }, { fill: NAVY, opacity: 0.12, radius: 40 + f, rotation: rot });
  // With a picture: the fat frame around it. Without one (no photo of the player
  // and no action shot), an empty white frame looked broken: the space becomes
  // a brand card instead, the academy's colour with its crest and two rings.
  c.only([{ path }], () => {
    rect(c, `${id}-frame`, outer, { fill: m.frame, radius: 40 + f, rotation: rot });
    media(c, id, b, { radius: 40, path: o.path, name: "Photo", rotation: rot });
    if (m.night) rect(c, `${id}-fade`, { x: b.x, y: b.y + Math.round(b.h * 0.5), w: b.w, h: b.h - Math.round(b.h * 0.5) }, { gradient: { from: NAVY_CLEAR, to: "#0D1F5CD9" }, radius: 40, rotation: rot });
  });
  c.only([{ path, not: true }], () => {
    rect(c, `${id}-empty`, outer, m.night
      ? { fill: GLASS, radius: 40 + f, rotation: rot, stroke: { color: GLASS_EDGE, width: 2 } }
      : { gradient: { from: "@primary", to: NAVY, angle: 160 }, radius: 40 + f, rotation: rot });
    // A halo the player's cut-out stands in front of; everything stays inside the frame.
    const d = Math.round(Math.min(outer.w * 0.8, outer.h * 0.86));
    ellipse(c, `${id}-empty-halo`, { x: outer.x + (outer.w - d) / 2, y: outer.y + (outer.h - d) / 2, w: d, h: d }, { fill: "@accent", opacity: 0.16 });
    const d2 = Math.round(d * 0.7);
    ellipse(c, `${id}-empty-ring`, { x: outer.x + (outer.w - d2) / 2, y: outer.y + (outer.h - d2) / 2, w: d2, h: d2 }, { fill: CLEAR, stroke: { color: "@accent", width: 6 }, opacity: 0.5 });
    // The crest: large and centred when there is no picture at all, small in the corner behind a player.
    c.only([{ path: "player.photo", not: true }], () => {
      const cs = Math.round(Math.min(outer.h * 0.5, outer.w * 0.42));
      crest(c, `${id}-empty-crest`, { x: outer.x + (outer.w - cs) / 2, y: outer.y + (outer.h - cs) / 2, w: cs, h: cs }, { rotation: rot });
    });
    c.only([{ path: "player.photo" }], () => {
      const cs = Math.round(Math.min(outer.h * 0.2, 120));
      crest(c, `${id}-empty-mark`, { x: outer.x + 28, y: outer.y + 28, w: cs, h: cs }, { rotation: rot });
    });
  });
  return true;
}

/** Equal info pills in one row (white, capitals). */
function pills(c: Ctx, values: string[], y: number, m: Mode, o: { h?: number; x?: number; w?: number; start?: number; prefix?: string } & Timing = {}) {
  const { h: hh, x: xx, w: ww, start, prefix, ...t } = o;
  const list = values.filter((v) => v.trim());
  if (!list.length) return;
  const h = hh ?? pillH(c);
  const gap = 14;
  const x0 = xx ?? c.M;
  const W = ww ?? c.CW;
  const w = (W - gap * (list.length - 1)) / list.length;
  list.forEach((v, i) => {
    const id = `${prefix ?? "pill"}-${(start ?? 0) + i + 1}`;
    const x = x0 + i * (w + gap);
    rect(c, `${id}-bg`, { x, y, w, h }, { fill: m.pillFill, radius: h / 2, ...(m.pillEdge ? { stroke: { color: m.pillEdge, width: 3 } } : {}), ...t });
    tx(c, id, v, { x: x + 24, y: y + h * 0.18, w: w - 48, h: h * 0.64 }, { size: Math.round(h * 0.44), body: true, weight: 700, color: m.pillInk, align: "center", upper: true, fit: true, ...t });
  });
}
const pillH = (c: Ctx) => c.pick(66, 60, 72);

/** Info pills as stack rows: two to a row, a third (usually the pitch) gets its own full-width row. */
function pillRows(c: Ctx, values: string[], m: Mode, gapAfter = 0): StackItem[] {
  const list = values.filter((v) => v.trim());
  const h = pillH(c);
  if (list.length === 3) {
    return [
      { h, gap: 14, draw: (y) => pills(c, list.slice(0, 2), y, m) },
      { h, gap: gapAfter, draw: (y) => pills(c, list.slice(2), y, m, { start: 2 }) },
    ];
  }
  return list.length ? [{ h, gap: gapAfter, draw: (y) => pills(c, list, y, m) }] : [];
}

/** Details in Inter: one sentence, up to two lines. */
function body(c: Ctx, id: string, value: string, y: number, h: number, m: Mode, o: { align?: "start" | "center" | "end"; size?: number } = {}) {
  tx(c, id, value, { x: c.M, y, w: c.CW, h }, { size: o.size ?? c.pick(36, 32, 40), body: true, weight: 600, color: m.soft, lh: 1.25, fit: true, align: o.align });
}

// ── Score ───────────────────────────────────────────────────────────────────

/** The navy score bug: neon score, the two names under it with a neon dot between. */
function scoreBug(c: Ctx, k: Content, y: number, h: number, ss: number, nameH: number) {
  const s = k.score!;
  rect(c, "score-bg", { x: c.M, y, w: c.CW, h }, { fill: "#0D1F5CF0", radius: 48, stroke: { color: "@accent", width: 4 } });
  const sh = Math.round(ss * 0.92);
  // Own score sits on the own side: left in English, right in Arabic.
  tx(c, "score", c.ar ? `${s.opp}–${s.own}` : `${s.own}–${s.opp}`, { x: c.M + 40, y: y + 30, w: c.CW - 80, h: sh }, { size: ss, color: "@accent", num: true, align: "center", lh: 0.95, fit: true, mirror: false });
  const ny = y + 30 + sh + 4;
  const half = (c.CW - 80 - 60) / 2;
  tx(c, "own", s.ownName, { x: c.M + 40, y: ny, w: half, h: nameH }, { size: Math.round(nameH * 0.72), color: WHITE, upper: true, align: "end", fit: true });
  ellipse(c, "vs-dot", { x: c.W / 2 - 9, y: ny + nameH / 2 - 9, w: 18, h: 18 }, { fill: "@accent", mirror: false });
  tx(c, "opp", s.oppName, { x: c.M + 40 + half + 60, y: ny, w: half, h: nameH }, { size: Math.round(nameH * 0.72), color: SKY, upper: true, align: "start", fit: true });
}

const score: StyleKit["score"] = (c, k) => {
  const m = ground(c, k);
  const top = lockup(c, k, m, {}, has(k.badge) ? 440 : 560);
  if (has(k.badge)) liveBadge(c, k.badge!);
  const ss = c.pick(210, 160, 250);
  const nameH = c.pick(56, 48, 62);
  const bugH = Math.round(ss * 0.92) + nameH + 66;
  const items: StackItem[] = [
    { h: bugH, gap: 26, draw: (y) => scoreBug(c, k, y, bugH, ss, nameH) },
    has(k.sub) && { h: stickerH(c), gap: 24, draw: (y) => sticker(c, "scorers", k.sub!, c.M + 10, y, c.CW - 20, { fill: WHITE, ink: "@primary", rot: 2, upper: false }) },
    k.meta.length > 0 && { h: pillH(c), draw: (y) => pills(c, k.meta, y, m) },
  ];
  const y = c.B - stackHeight(items);
  photo(c, "photo", { x: c.M, y: top + 40, w: c.CW, h: y - 40 - (top + 40) }, m);
  stackDown(y, items);
  if (k.key === "goalflash") {
    // GOAL! goes up huge in neon, tilted, over the bottom of the photo.
    const bw = c.pick(170, 130, 200);
    tx(c, "kicker", k.kicker, { x: c.M + 10, y: y - bw - 22, w: c.CW - 20, h: bw }, { size: bw, color: "@accent", upper: true, fit: true, lh: 0.95, rotation: -3, shadow: { color: NAVY, blur: 0, x: 0, y: 10 } });
  } else {
    sticker(c, "kicker", k.kicker, c.M + 24, y - stickerH(c, c.pick(40, 34, 44)) + 18, c.CW - 48, { size: c.pick(40, 34, 44), rot: -3 });
  }
};

// ── Fixture ─────────────────────────────────────────────────────────────────

const fixture: StyleKit["fixture"] = (c, k) => {
  const m = ground(c, k);
  const v = k.vs!;
  const top = lockup(c, k, m);
  const kick = k.key === "kickoff";
  const tag = kick ? `• ${k.pills[0] ?? ""}` : k.headline ? k.kicker : (k.meta[1] ?? k.meta[0] ?? "");
  const info = kick ? k.pills.slice(1) : k.pills;
  const line = kick || !k.headline ? (k.meta[0] ?? "") : k.meta.filter(Boolean).join(" · ");
  const hs = c.pick(136, 104, 156);
  const ts = c.pick(76, 60, 86);
  const items: StackItem[] = [
    { h: hs, gap: 26, draw: (y) => headline(c, "headline", k.headline ?? k.kicker, { x: c.M, y, w: c.CW, h: hs }, hs, m, { lh: 0.95 }) },
    { h: ts, gap: 8, draw: (y) => tx(c, "own", v.ownName, { x: c.M, y, w: c.CW, h: ts }, { size: ts, color: WHITE, upper: true, fit: true, lh: 1 }) },
    { h: ts, gap: 30, draw: (y) => {
      ellipse(c, "vs-disc", { x: c.M, y: y - 4, w: ts + 8, h: ts + 8 }, { fill: "@accent", rotation: -8 });
      tx(c, "vs", v.label, { x: c.M + 6, y: y + ts * 0.18, w: ts - 4, h: ts * 0.64 }, { size: Math.round(ts * 0.46), color: NAVY, upper: true, align: "center", fit: true, rotation: -8 });
      tx(c, "opp", v.oppName, { x: c.M + ts + 30, y, w: c.CW - ts - 30, h: ts }, { size: ts, color: SKY, upper: true, fit: true, lh: 1 });
    } },
    ...pillRows(c, info, m, 18),
    has(k.cta) && { h: ctaH(c), gap: 18, draw: (y) => cta(c, "cta", k.cta!, y, m) },
    has(line) && { h: 40, draw: (y) => tx(c, "meta", line, { x: c.M, y, w: c.CW, h: 40 }, { size: 30, body: true, weight: 600, color: SKY, upper: true, ls: 2, fit: true }) },
  ];
  const y = c.B - stackHeight(items);
  const pb: Box = { x: c.M, y: top + 40, w: c.CW, h: y - 56 - (top + 40) };
  const shown = photo(c, "photo", pb, m);
  stackDown(y, items);
  const ks = c.pick(38, 32, 42);
  sticker(c, "kicker", tag, c.M + 24, shown ? pb.y - 26 : top + 30, c.CW - 48, { size: ks, rot: -4 });
};

// ── Hero ────────────────────────────────────────────────────────────────────

/** "6 GOALS": a white pill with the value in blue. */
function statPill(c: Ctx, k: Content, y: number, m: Mode) {
  const st = k.stat!;
  const h = c.pick(76, 68, 82);
  const w = c.pick(420, 380, 440);
  rect(c, "stat-bg", { x: c.M, y, w, h }, { fill: WHITE, radius: h / 2, stroke: { color: m.night ? "@accent" : "@primary", width: 4 }, rotation: -2 });
  tx(c, "stat", st.value, { x: c.M + 22, y: y + h * 0.1, w: 110, h: h * 0.8 }, { size: Math.round(h * 0.66), color: "@primary", num: true, align: "center", fit: true, lh: 1, rotation: -2 });
  tx(c, "stat-label", st.label, { x: c.M + 140, y: y + h * 0.2, w: w - 170, h: h * 0.6 }, { size: Math.round(h * 0.4), color: "@ink", upper: true, fit: true, rotation: -2 });
}

const hero: StyleKit["hero"] = (c, k) => {
  const m = ground(c, k);
  const { head: words, tag } = heroWords(k);
  const top = lockup(c, k, m);
  const num = has(k.number);
  const ns = c.pick(300, 220, 340);
  const numW = c.pick(450, 360, 480);
  const rowH = Math.round(ns * 0.92);
  const colX = c.M + numW + 24;
  const colW = c.CW - numW - 24;
  const hsCol = c.pick(78, 62, 86);
  const hsBig = c.pick(130, 100, 150);
  const nameH = c.pick(58, 50, 64);
  const metaH = 40;
  const swash = !m.night && SWASH.has(k.key);
  const items: StackItem[] = [
    num ? { h: rowH, gap: 20, draw: (y) => {
      bigNumber(c, "number", `#${k.number}`, { x: c.M, y, w: numW, h: rowH }, ns, m);
      const colH = Math.round(hsCol * 2.05) + 8 + nameH;
      const cy = y + (rowH - colH) / 2;
      headline(c, "headline", words, { x: colX, y: cy, w: colW, h: Math.round(hsCol * 2.05) }, hsCol, m);
      tx(c, "name", k.name ?? "", { x: colX, y: cy + Math.round(hsCol * 2.05) + 8, w: colW, h: nameH }, { size: Math.round(nameH * 0.8), color: m.name, fit: true });
    } } : { h: Math.round(hsBig * 1.1), gap: 14, draw: (y) => {
      const b = { x: c.M, y, w: c.CW, h: Math.round(hsBig * 1.1) };
      if (swash) swashLine(c, "headline", words, b, hsBig);
      else headline(c, "headline", words, b, hsBig, m);
    } },
    !num && has(k.name) && { h: nameH, gap: 16, draw: (y) => tx(c, "name", k.name!, { x: c.M, y, w: c.CW, h: nameH }, { size: Math.round(nameH * 0.8), color: m.name, fit: true }) },
    has(k.sub) && { h: c.pick(92, 80, 100), gap: 18, draw: (y) => body(c, "sub", k.sub!, y, c.pick(92, 80, 100), m) },
    k.stat && { h: c.pick(76, 68, 82), gap: 22, draw: (y) => statPill(c, k, y, m) },
    ...k.meta.map((line, i) => ({ h: metaH, gap: 6, draw: (y: number) => tx(c, `meta-${i + 1}`, line, { x: c.M, y, w: c.CW, h: metaH }, { size: 30, body: true, weight: 700, color: m.soft, upper: true, ls: 1, fit: true }) })),
  ];
  const y = c.B - stackHeight(items);
  const pb: Box = { x: c.M, y: top + 40, w: c.CW, h: y - 40 - (top + 40) };
  const shown = photo(c, "photo", pb, m);
  stackDown(y, items);
  if (tag !== words && has(tag)) sticker(c, "kicker", tag, c.M + 24, shown ? pb.y - 26 : top + 30, c.CW - 48, { rot: -4 });
};

// ── List ────────────────────────────────────────────────────────────────────

/** Line-ups and call-ups: a grid of shirt-number tiles, three across; a short last row is centred. */
function numberGrid(c: Ctx, rows: Array<[string, string, string]>, top: number, bottom: number) {
  const n = rows.length;
  const cols = 3;
  const gap = 18;
  const lines = Math.ceil(n / cols);
  const tw = (c.CW - gap * (cols - 1)) / cols;
  const th = Math.max(80, Math.min(Math.floor((bottom - top - gap * (lines - 1)) / lines), Math.round(tw * 0.92)));
  const total = lines * th + gap * (lines - 1);
  const y0 = top + Math.max(0, (bottom - top - total) / 2);
  rows.forEach((row, i) => {
    const id = `row-${i + 1}`;
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, n - r * cols);
    const x = c.M + ((cols - inRow) * (tw + gap)) / 2 + (i % cols) * (tw + gap);
    const y = y0 + r * (th + gap);
    const hot = i % 4 === 0;
    rect(c, `${id}-bg`, { x, y, w: tw, h: th }, { fill: hot ? "@accent" : WHITE, radius: 32, ...(hot ? {} : { stroke: { color: "@primary", width: 4 } }) });
    tx(c, `${id}-lead`, `#${row[0]}`, { x: x + 12, y: y + th * 0.08, w: tw - 24, h: th * 0.56 }, { size: Math.round(Math.min(th * 0.5, tw * 0.4)), color: hot ? NAVY : "@primary", num: true, align: "center", fit: true, lh: 1 });
    tx(c, `${id}-main`, row[1], { x: x + 16, y: y + th * 0.6, w: tw - 32, h: th * 0.18 }, { size: Math.round(th * 0.15), color: "@ink", align: "center", upper: true, fit: true });
    tx(c, `${id}-trail`, row[2], { x: x + 16, y: y + th * 0.78, w: tw - 32, h: th * 0.14 }, { size: Math.round(th * 0.11), body: true, weight: 700, color: hot ? NAVY : "@primary", align: "center", upper: true, ls: 2, fit: true });
  });
}

/** rowBoxes, centred in the space between top and bottom (stories have room to spare). */
function centredRows(c: Ctx, n: number, top: number, bottom: number, o: { gap: number; maxH: number }) {
  const boxes = rowBoxes(n, top, bottom, c.M, c.CW, o);
  if (!boxes.length) return boxes;
  const used = Math.max(...boxes.map((b) => b.y + b.h)) - top;
  const shift = Math.max(0, Math.round((bottom - top - used) / 2));
  return boxes.map((b) => ({ ...b, y: b.y + shift }));
}

/** Match stats: our number (neon) · what it is · theirs. */
function statRows(c: Ctx, rows: Array<[string, string, string]>, top: number, bottom: number) {
  centredRows(c, rows.length, top, bottom, { gap: c.pick(14, 12, 18), maxH: c.pick(118, 100, 150) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    rect(c, `${id}-bg`, b, { fill: i === 0 ? "#FFFFFF2E" : GLASS, radius: b.h / 2, stroke: { color: GLASS_EDGE, width: 2 } });
    tx(c, `${id}-lead`, row[0], { x: b.x + 34, y: b.y + b.h * 0.14, w: b.w * 0.26, h: b.h * 0.72 }, { size: Math.round(b.h * 0.52), color: "@accent", num: true, fit: true, lh: 1 });
    tx(c, `${id}-main`, row[1], { x: b.x + b.w * 0.28, y: b.y + b.h * 0.25, w: b.w * 0.44, h: b.h * 0.5 }, { size: Math.round(b.h * 0.3), color: WHITE, upper: true, align: "center", fit: true });
    tx(c, `${id}-trail`, row[2], { x: b.x + b.w * 0.72 - 34, y: b.y + b.h * 0.14, w: b.w * 0.28, h: b.h * 0.72 }, { size: Math.round(b.h * 0.52), color: SKY, num: true, align: "end", fit: true, lh: 1 });
  });
}

/** Table and price rows: rounded bars, a lead disc or label, the main words, a trail value. */
function barRows(c: Ctx, k: Content, rows: Array<[string, string, string]>, top: number, bottom: number, m: Mode) {
  const lead = numericLead(k);
  centredRows(c, rows.length, top, bottom, { gap: c.pick(14, 12, 18), maxH: lead ? c.pick(104, 92, 128) : c.pick(124, 108, 150) }).forEach((b, i) => {
    const id = `row-${i + 1}`;
    const row = rows[i];
    const first = i === 0;
    const lit = m.night ? first : true;
    rect(c, `${id}-bg`, b, { fill: lit ? WHITE : GLASS, radius: m.night ? b.h / 2 : 30, stroke: { color: lit ? "@primary" : GLASS_EDGE, width: lit ? 3 : 2 } });
    let mx: number;
    if (lead) {
      const d = b.h - 18;
      ellipse(c, `${id}-lead-bg`, { x: b.x + 9, y: b.y + 9, w: d, h: d }, { fill: first ? "@accent" : "@primary" });
      tx(c, `${id}-lead`, row[0], { x: b.x + 9, y: b.y + 9 + d * 0.16, w: d, h: d * 0.68 }, { size: Math.round(d * 0.5), color: first ? NAVY : WHITE, num: true, align: "center", fit: true, lh: 1 });
      mx = b.x + d + 34;
    } else {
      tx(c, `${id}-lead`, row[0], { x: b.x + 30, y: b.y + b.h * 0.22, w: b.w * 0.3, h: b.h * 0.56 }, { size: Math.round(b.h * 0.34), color: "@primary", upper: true, fit: true });
      mx = b.x + 30 + b.w * 0.3 + 16;
    }
    const tw = lead ? 150 : 230;
    tx(c, `${id}-main`, row[1], { x: mx, y: b.y + b.h * 0.24, w: b.x + b.w - tw - 30 - mx, h: b.h * 0.52 }, lead
      ? { size: Math.round(b.h * 0.36), color: lit ? "@ink" : WHITE, upper: true, fit: true }
      : { size: Math.round(b.h * 0.24), body: true, weight: 600, color: "@ink", fit: true });
    if (lead) {
      tx(c, `${id}-trail`, row[2], { x: b.x + b.w - tw - 20, y: b.y + b.h * 0.18, w: tw - 10, h: b.h * 0.64 }, { size: Math.round(b.h * 0.44), color: lit ? "@primary" : "@accent", align: "end", fit: true, lh: 1 });
    } else {
      // Prices sit in a navy pill: neon only ever on navy.
      tx(c, `${id}-trail`, row[2], { x: b.x + b.w - tw - 16, y: b.y + b.h * 0.18, w: tw, h: b.h * 0.64 }, { size: Math.round(b.h * 0.26), color: "@accent", align: "end", upper: true, fit: true, lh: 1.15, bg: { color: NAVY, padding: Math.round(b.h * 0.1), radius: 999 } });
    }
  });
}

/** Line-up photo tiles: a bubbly card (glass at night, sky by day), a big friendly number, a rounded name pill. */
function tileLook(m: Mode): TileLook {
  return {
    backdrop: (c, id, b, i) => {
      rect(c, id, b, m.night ? { fill: GLASS, radius: 32, stroke: { color: GLASS_EDGE, width: 2 } } : { fill: WHITE, radius: 32, stroke: { color: NAVY, width: 4 } });
      // A disc behind the figure, sized to the tile so it never spills out of a short tile.
      const d = Math.round(Math.min(b.w * 0.72, b.h * 0.86));
      ellipse(c, `${id}-dot`, { x: b.x + (b.w - d) / 2, y: b.y + (b.h - d) / 2, w: d, h: d }, { fill: i % 2 ? "@accent" : "@primary", opacity: m.night ? 0.5 : 0.9 });
    },
    bar: (c, id, b) => rect(c, id, b, { fill: m.night ? WHITE : NAVY, radius: b.h / 2 }),
    num: { font: "display", color: m.num, weight: 800, shadow: { color: m.numShadow, blur: 0, x: 0, y: 6 } },
    name: { font: "display", color: m.night ? NAVY : WHITE, weight: 800 },
    pos: { font: "display", color: m.night ? "@primary" : "@accent", weight: 800 },
    shadow: NAVY,
    cardRadius: 26,
    // Three across, the number on a neon badge over the photo: two-digit
    // numbers used to sit beside the figure and run into the players' heads.
    cols: 3,
    numberAt: "badge",
    badge: { fill: "@accent", ring: WHITE, color: NAVY },
    text: (c, id, value, b, o) => tx(c, id, value, b, o),
  };
}

const list: StyleKit["list"] = (c, k) => {
  const m = ground(c, k);
  const top = lockup(c, k, m);
  const ky = top + 30;
  sticker(c, "kicker", k.kicker, c.M, ky, c.CW, { rot: -3 });
  const hs = c.pick(92, 74, 104);
  const hy = ky + stickerH(c) + 14;
  const hb: Box = { x: c.M, y: hy, w: c.CW, h: Math.round(hs * 1.1) };
  if (!m.night && SWASH.has(k.key)) swashLine(c, "headline", k.headline ?? "", hb, hs);
  else headline(c, "headline", k.headline ?? "", hb, hs, m);
  const rowsTop = hy + hb.h + 30;
  const foot: StackItem[] = [
    ...k.meta.map((line, i) => ({ h: 38, gap: 8, draw: (y: number) => tx(c, `meta-${i + 1}`, line, { x: c.M, y, w: c.CW, h: 38 }, { size: 30, body: true, weight: 700, color: m.soft, upper: true, ls: 1, align: "center", fit: true }) })),
    k.cta && { h: ctaH(c), draw: (y: number) => cta(c, "cta", k.cta!, y, m) },
  ];
  const fh = stackHeight(foot);
  const bottom = c.B - fh - (fh ? 30 : 0);
  const rows = k.rows ?? [];
  if (k.key === "lineup" || k.key === "callup") rowsOrTiles(c, k, { x: c.M, y: rowsTop, w: c.CW, h: bottom - rowsTop }, tileLook(m), () => numberGrid(c, rows, rowsTop, bottom));
  else if (k.key === "matchstats") statRows(c, rows, rowsTop, bottom);
  else barRows(c, k, rows, rowsTop, bottom, m);
  stackUp(c.B, foot);
};

// ── Promo ───────────────────────────────────────────────────────────────────

const promo: StyleKit["promo"] = (c, k) => {
  const m = ground(c, k);
  const top = lockup(c, k, m);
  if (k.options) {
    const ky = top + 30;
    sticker(c, "kicker", k.kicker, c.M, ky, c.CW, { rot: -3 });
    const hs = c.pick(110, 88, 124);
    const hy = ky + stickerH(c) + 14;
    const hb: Box = { x: c.M, y: hy, w: c.CW, h: Math.round(hs * 1.1) };
    if (m.night) headline(c, "headline", k.headline ?? "", hb, hs, m);
    else swashLine(c, "headline", k.headline ?? "", hb, hs);
    const py = hy + hb.h + 60;
    const gap = 44;
    const cw = (c.CW - gap) / 2 - 14;
    const ch = c.B - 70 - py;
    k.options.forEach((opt, i) => {
      const x = c.M + 14 + i * (cw + gap + 14);
      photo(c, `option-${i + 1}-photo`, { x, y: py, w: cw, h: ch - 40 }, m, { path: `more.${i}`, rot: i ? 2 : -2 });
      const d = 104;
      ellipse(c, `option-${i + 1}-key-bg`, { x: x - 18, y: py - 30, w: d, h: d }, { fill: i ? "@accent" : "@primary", stroke: { color: WHITE, width: 6 } });
      tx(c, `option-${i + 1}-key`, optionKey(c.ar, i), { x: x - 18, y: py - 30 + d * 0.2, w: d, h: d * 0.6 }, { size: 56, color: i ? NAVY : WHITE, align: "center", fit: true, lh: 1 });
      sticker(c, `option-${i + 1}`, opt, x + 16, py + ch - 40 - stickerH(c, 48) / 2, cw - 32, { size: 48, rot: i ? -3 : 3, fill: WHITE, ink: "@primary", align: "center" });
    });
    tx(c, "meta-1", k.meta[0] ?? "", { x: c.M, y: c.B - 40, w: c.CW, h: 40 }, { size: 30, body: true, weight: 700, color: m.soft, upper: true, align: "center", fit: true });
    return;
  }
  const manifesto = k.key === "manifesto";
  const days = "{{custom.days}}";
  const countdown = k.key === "countdown" && (k.headline ?? "").includes(days);
  const swash = !m.night && SWASH.has(k.key);
  const hs = c.pick(manifesto ? 88 : 120, manifesto ? 70 : 96, manifesto ? 100 : 136);
  const ns = c.pick(280, 210, 320);
  const subH = c.pick(92, 80, 100);
  const items: StackItem[] = [
    countdown ? { h: Math.round(ns * 0.92), gap: 18, draw: (y) => {
      // "2 | DAYS TO GO": the count huge in neon, the words beside it, as in the deck.
      const nw = c.pick(330, 260, 360);
      const rowH = Math.round(ns * 0.92);
      bigNumber(c, "number", days, { x: c.M, y, w: nw, h: rowH }, ns, m, { align: "center" });
      const words = (k.headline ?? "").replace(days, " ").replace(/\s+/g, " ").trim();
      headline(c, "headline", words, { x: c.M + nw + 24, y: y + rowH * 0.12, w: c.CW - nw - 24, h: rowH * 0.76 }, c.pick(96, 76, 108), m, { lh: 0.98 });
    } } : swash ? { h: Math.round(hs * 1.1), gap: 18, draw: (y) => swashLine(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: Math.round(hs * 1.1) }, hs) }
      : { h: Math.round(hs * (manifesto ? 3.1 : 2.05)), gap: 18, draw: (y) => headline(c, "headline", k.headline ?? "", { x: c.M, y, w: c.CW, h: Math.round(hs * (manifesto ? 3.1 : 2.05)) }, hs, m) },
    has(k.sub) && { h: subH, gap: 22, draw: (y) => body(c, "sub", k.sub!, y, subH, m) },
    ...pillRows(c, k.pills, m, 22),
    has(k.cta) && { h: ctaH(c), draw: (y) => cta(c, "cta", k.cta!, y, m) },
  ];
  const y = c.B - stackHeight(items);
  const pb: Box = { x: c.M, y: top + 40, w: c.CW, h: y - 48 - (top + 40) };
  const shown = photo(c, "photo", pb, m);
  if (shown && k.key === "map") pin(c, pb.x + pb.w / 2, pb.y + pb.h / 2, "@primary");
  if (shown && has(k.badge)) {
    const d = c.pick(220, 180, 240);
    const bx = c.W - c.M - d + 14;
    const by = pb.y + pb.h - d * 0.72;
    ellipse(c, "badge-bubble", { x: bx, y: by, w: d, h: d }, { fill: "@accent", stroke: { color: m.night ? NAVY : WHITE, width: 10 }, rotation: 8 });
    tx(c, "badge", k.badge!, { x: bx + d * 0.13, y: by + d * 0.3, w: d * 0.74, h: d * 0.4 }, { size: Math.round(d * 0.3), color: NAVY, upper: true, align: "center", fit: true, rotation: 8, lh: 1 });
  }
  stackDown(y, items);
  if (has(k.kicker)) sticker(c, "kicker", k.kicker, c.M + 24, shown ? pb.y - 26 : top + 30, c.CW - 48, { rot: -4 });
};

// ── Video ───────────────────────────────────────────────────────────────────

const skin: StyleKit["skin"] = {
  shade: (c) => {
    rect(c, "shade-top", { x: 0, y: 0, w: c.W, h: 440 }, { gradient: { from: "#0D1F5CCC", to: NAVY_CLEAR } });
    rect(c, "shade", { x: 0, y: c.H - 860, w: c.W, h: 860 }, { gradient: { from: NAVY_CLEAR, to: "#0D1F5CF0" } });
  },
  frame: (c, k, t) => { lockup(c, k, NIGHT, t); },
  tag: (c, k, t) => { sticker(c, "kicker", k.kicker, c.M, c.B - 560, c.CW, { size: 44, rot: -4, ...t }); },
  goal: (c, k, t) => {
    const s = k.score!;
    bigNumber(c, "number", `#${k.number ?? ""}`, { x: c.M, y: c.B - 460, w: 460, h: 250 }, 260, { ...NIGHT, num: WHITE }, t);
    tx(c, "name", k.name ?? "", { x: c.M + 480, y: c.B - 370, w: c.CW - 480, h: 70 }, { size: 56, color: WHITE, fit: true, ...t });
    // The deck's score bug: navy pill with a white rim, the score in a neon chip.
    const h = 112;
    const y = c.B - 170;
    rect(c, "score-bg", { x: c.M, y, w: c.CW, h }, { fill: NAVY, radius: h / 2, stroke: { color: WHITE, width: 3 }, ...t });
    const chip = 230;
    const side = (c.CW - chip - 80) / 2;
    tx(c, "own", s.ownName, { x: c.M + 30, y: y + 26, w: side, h: 60 }, { size: 40, color: WHITE, upper: true, align: "end", fit: true, ...t });
    tx(c, "score", c.ar ? `${s.opp}–${s.own}` : `${s.own}–${s.opp}`, { x: c.W / 2 - chip / 2, y: y + 12, w: chip, h: h - 24 }, { size: 64, color: NAVY, num: true, align: "center", fit: true, lh: 1.05, mirror: false, bg: { color: "@accent", padding: 6, radius: 24 }, ...t });
    tx(c, "opp", s.oppName, { x: c.W / 2 + chip / 2 + 20, y: y + 26, w: side, h: 60 }, { size: 40, color: WHITE, upper: true, align: "start", fit: true, ...t });
  },
  speaker: (c, k, t) => {
    rect(c, "speaker-bg", { x: c.M, y: c.B - 420, w: c.CW, h: 150 }, { fill: WHITE, radius: 40, ...t });
    tx(c, "speaker", k.headline ?? "", { x: c.M + 40, y: c.B - 396, w: c.CW - 80, h: 100 }, { size: 64, color: "@ink", fit: true, ...t });
    sticker(c, "role", k.sub ?? "", c.M + 30, c.B - 300, c.CW - 60, { fill: "@primary", ink: WHITE, rot: 2, upper: false, ...t });
  },
  title: (c, k, t) => {
    headline(c, "headline", k.headline ?? "", { x: c.M, y: c.B - 440, w: c.CW, h: 270 }, 130, NIGHT, t);
    sticker(c, "meta-1", k.meta[0] ?? "", c.M, c.B - 130, c.CW, { fill: WHITE, ink: "@primary", rot: 2, ...t });
  },
  caption: (c, id, value, t) => tx(c, id, value, { x: c.M, y: c.B - 220, w: c.CW, h: 180 }, { size: 46, color: "@ink", align: "center", lh: 1.2, fit: true, bg: { color: WHITE, padding: 22, radius: 36 }, ...t }),
  end: (c, k, t) => {
    rect(c, "end-bg", { x: 0, y: 0, w: c.W, h: c.H }, { gradient: { from: "@primary", to: NAVY }, ...t });
    ellipse(c, "end-glow", { x: c.W / 2 - 420, y: c.H / 2 - 560, w: 840, h: 840 }, { fill: "@primary", opacity: 0.55, name: "bleed", ...t });
    confetti(c, NIGHT, "end-bit", t);
    crest(c, "end-crest", { x: c.W / 2 - 160, y: c.H / 2 - 300, w: 320, h: 320 }, t);
    headline(c, "end-name", k.academy, { x: c.M, y: c.H / 2 + 60, w: c.CW, h: 120 }, 96, NIGHT, { align: "center", ...t });
    rect(c, "end-bar", { x: c.W / 2 - 300, y: c.H / 2 + 200, w: 600, h: 22 }, { fill: "@accent", radius: 11, rotation: -2, ...t });
  },
};

export const pack_jufa: StyleKit = { background: NAVY, plate: { opacity: 1, above: "sky" }, score, fixture, hero, list, promo, skin };
