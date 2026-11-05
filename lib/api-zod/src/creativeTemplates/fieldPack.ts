import type { CreativeData, CreativeFormat, MediaSource, Scene, SceneLayer } from "../creativeScene";
import { Ctx as Canvas, crest, ellipse, image, rect, text as kitText, video, type Box, type Ctx, type Locale, type TextOpts, type Timing } from "./kit";

/**
 * Football fields' template pack (Mohammed, 2026-11-04; design canvas "Field template pack").
 *
 * One look for every field, driven only by its branding: the crest ({type:"crest"}, an initials
 * shield when there is none), the main colour (@primary, with @on-primary for type on it), and the
 * field's name, phone and booking line through {{bindings}}. The background is the dark @ink, so
 * any main colour reads. Changing a field's branding restyles every template; nothing here names
 * a field.
 *
 * Video templates run as one sequence:
 *   1. the opening card (crest pop, title, a count-up number, the facts), on its own;
 *   2. a wipe in the main colour crosses the canvas and hides the cut;
 *   3. the clip, with a small award tag on top and the facts at the bottom;
 *   4. the end card over the same clip, blurred and dimmed: crest, field name, booking line.
 * "Which is nicer" (versus) runs two clips: split, A full, B pushes up over it, split again
 * and the vote. Top 5 counts five clips down. The thank-you shows the week's numbers over
 * live footage. Carousel slides (nominees) are short and 4:5.
 *
 * Numbers that count up are frames of text, `custom.<key>_1` … `custom.<key>_7` then
 * `custom.<key>`, each on screen for a moment: fieldCountSteps() makes them from the value.
 *
 * Kept out of the academies' catalogue: the field console's Instagram autopilot makes these.
 */

export const FIELD_STYLE = "field" as const;

export type FieldTemplateKey =
  | "field-booking-clip"
  | "field-award"
  | "field-potm"
  | "field-potw"
  | "field-match-week"
  | "field-top5"
  | "field-versus"
  | "field-versus-story"
  | "field-nominee-slide"
  | "field-nominees-cover"
  | "field-thanks"
  | "field-milestone"
  | "field-open-slots"
  | "field-leaderboard"
  | "field-match-highlights"
  | "field-day-best";

type FieldDef = {
  key: FieldTemplateKey;
  title: { en: string; ar: string };
  formats: CreativeFormat[];
  build: (c: Ctx) => number | undefined;
  sample: (ar: boolean) => CreativeData;
};

const STORY: CreativeFormat[] = ["story"];
const STORY_POST: CreativeFormat[] = ["story", "post"];
const POST_STORY: CreativeFormat[] = ["post", "story"];

/** Opening card, wipe, end card (ms). */
export const FIELD_TIMING = { intro: 2500, wipe: 600, end: 3000, steps: 7, countFrom: 700, countTo: 1700 } as const;

const PAPER = "@paper";
const INK = "@ink";
const MAIN = "@primary";
const ON_MAIN = "@on-primary";

/**
 * The pack's skin: which colour each role takes, the type and the background. The field pack
 * wears its own (the main colour does everything); the academy pack wears the Souqar look
 * (clubPack.ts: CLUB_SKIN). A build runs synchronously inside withSkin, so the pieces read the
 * skin of the pack being built.
 */
export type PackSkin = {
  /** Pills (kickers, tags, calls to action) and their words. */
  pill: string; onPill: string;
  /** Solid highlights (the booking band, a badge, the first row) and their words. */
  hi: string; onHi: string;
  /** Big numbers and the end card's line. */
  accent: string;
  /** Rings, rules and the REPLAY mark. */
  metal: string;
  /** Faces by role (Montserrat display, Inter body, Cairo Arabic); none = the house faces. */
  family?: { display: string; body: string; arabic: string };
  /** Display capitals with a glow in this colour. */
  glow?: string;
  /** The background behind cards: none = the field pack's dark with two bands. */
  backdrop?: (c: Ctx, id: string, t: Timing) => void;
};
const FIELD_SKIN: PackSkin = { pill: MAIN, onPill: ON_MAIN, hi: MAIN, onHi: ON_MAIN, accent: MAIN, metal: MAIN };
let skin: PackSkin = FIELD_SKIN;
/** Build with another pack's skin (synchronous). */
export function withSkin<T>(s: PackSkin, build: () => T): T {
  const before = skin;
  skin = s;
  try { return build(); } finally { skin = before; }
}

/** A text layer in the skin's faces; big display words in capitals with its glow. */
function text(c: Ctx, id: string, value: string, b: Box, o: TextOpts): SceneLayer {
  const display = o.font === "display" || o.font === "condensed" || (o.weight ?? 400) >= 900;
  const big = display && (o.size ?? 0) >= 56 && !o.num;
  const layer = kitText(c, id, value, b, skin.glow && big ? { ...o, upper: o.upper ?? true, ...(o.shadow || o.bg ? {} : { shadow: { color: skin.glow, blur: 36, x: 0, y: 0 } }) } : o);
  if (skin.family && layer.kind === "text") {
    layer.family = layer.font.startsWith("arabic") ? skin.family.arabic : display ? skin.family.display : skin.family.body;
  }
  return layer;
}

/** The count-up frames for a number: fieldCountSteps(25.5, 1) → ["3.6", …, "21.9"] then the value itself. */
export function fieldCountSteps(value: number, decimals = 0, steps: number = FIELD_TIMING.steps): string[] {
  const out: string[] = [];
  for (let i = 1; i <= steps; i++) {
    const eased = 1 - Math.pow(1 - i / (steps + 1), 3);
    out.push(formatNumber(value * eased, decimals));
  }
  return out;
}

/** 1840 → "1,840"; 25.47 → "25.5". */
export function formatNumber(value: number, decimals = 0): string {
  const fixed = Math.max(0, value).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

/** custom.<key>_1 … _7 and custom.<key> for a number. */
export function countData(key: string, value: number, decimals = 0): Record<string, string> {
  const out: Record<string, string> = { [key]: formatNumber(value, decimals) };
  fieldCountSteps(value, decimals).forEach((v, i) => { out[`${key}_${i + 1}`] = v; });
  return out;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

const C = (path: string) => `{{custom.${path}}}`;
const when = (path: string) => [{ path: `custom.${path}` }];
/** A player's own photo (data.player.photo), and its absence. */
const PHOTO = [{ path: "player.photo" }];
const NO_PHOTO = [{ path: "player.photo", not: true }];

/** The dark background, with two quiet diagonal bands of the main colour across the lower corner. */
function backdrop(c: Ctx, id: string, t: Timing = {}) {
  if (skin.backdrop) { skin.backdrop(c, id, t); return; }
  rect(c, `${id}-ink`, { x: 0, y: 0, w: c.W, h: c.H }, { ...t, fill: INK, name: "bleed" });
  // Two diagonal bands in the main colour across the lower corner: quiet enough for any colour.
  const y = c.H * c.pick(0.8, 0.8, 0.82);
  rect(c, `${id}-band`, { x: -300, y, w: c.W + 600, h: c.pick(170, 160, 210) }, { ...t, fill: MAIN, opacity: 0.1, rotation: -12, name: "bleed" });
  rect(c, `${id}-line`, { x: -300, y: y - c.pick(52, 48, 62), w: c.W + 600, h: 14 }, { ...t, fill: MAIN, opacity: 0.4, rotation: -12, name: "bleed" });
}

/** A pill: words on the main colour. */
function pill(c: Ctx, id: string, value: string, y: number, o: { size?: number; startMs?: number; endMs?: number; enter?: Timing["enter"]; align?: "start" | "center" | "end"; x?: number; w?: number } = {}) {
  const size = o.size ?? c.pick(40, 36, 44);
  const w = o.w ?? c.CW;
  const x = o.x ?? c.M;
  return text(c, id, value, { x, y, w, h: size * 1.9 }, {
    size, weight: 900, font: "condensed", color: skin.onPill, align: o.align ?? "center",
    bg: { color: skin.pill, padding: Math.round(size * 0.42), radius: 999 },
    startMs: o.startMs, endMs: o.endMs, enter: o.enter, arScale: 0.95,
  });
}

/** A square (or round) badge in the main colour with a number or letter in the middle. */
function badge(c: Ctx, id: string, value: string, b: Box, o: Timing & { radius?: number; size?: number; mirror?: boolean } = {}) {
  const t = { startMs: o.startMs, endMs: o.endMs, enter: o.enter, mirror: o.mirror };
  rect(c, `${id}-bg`, b, { ...t, fill: skin.hi, radius: o.radius ?? Math.round(b.w * 0.24) });
  text(c, id, value, { x: b.x, y: b.y + b.h * 0.12, w: b.w, h: b.h * 0.76 }, {
    ...t, size: o.size ?? b.h * 0.56, weight: 900, color: skin.onHi, align: "center", num: true, fit: true,
  });
}

/** Crest and field name at the top; the REPLAY mark at the far side. */
function header(c: Ctx, id: string, t: Timing, o: { crestSize?: number } = {}) {
  const s = o.crestSize ?? c.pick(84, 76, 96);
  const y = c.T - c.pick(0, 0, 40);
  crest(c, `${id}-crest`, { x: c.M, y, w: s, h: s }, t);
  text(c, `${id}-name`, C("field"), { x: c.M + s + 22, y: y + s * 0.12, w: c.CW - s - 22 - 220, h: s * 0.8 }, {
    ...t, size: c.pick(34, 32, 38), weight: 800, color: PAPER, fit: true, shadow: { color: "#00000099", blur: 12, x: 0, y: 2 },
  });
  text(c, `${id}-replay`, "REPLAY", { x: c.W - c.M - 190, y: y + s * 0.22, w: 190, h: s * 0.56 }, {
    ...t, size: c.pick(28, 26, 30), weight: 800, font: "condensed", color: skin.accent, align: "end", ls: 6, num: true,
  });
}

/** The booking band near the bottom (inside Instagram's safe area). */
function bookingBand(c: Ctx, id: string, t: Timing) {
  const h = c.pick(104, 96, 112);
  const y = c.B - h;
  rect(c, `${id}-band`, { x: c.M, y, w: c.CW, h }, { ...t, fill: skin.hi, radius: 28 });
  // A skin's wider faces (Montserrat) need a gap between the line and the phone.
  text(c, `${id}-line`, C("bookLine"), { x: c.M + 34, y: y + h * 0.22, w: c.CW * 0.58 - (skin.family ? 56 : 0), h: h * 0.56 }, {
    ...t, size: c.pick(34, 32, 36), weight: 900, color: skin.onHi, fit: true,
  });
  text(c, `${id}-phone`, "{{academy.phone}}", { x: c.M + c.CW * 0.58, y: y + h * 0.18, w: c.CW * 0.42 - 34, h: h * 0.64 }, {
    ...t, size: c.pick(48, 44, 52), weight: 800, font: "condensed", color: skin.onHi, align: "end", num: true, fit: true,
  });
}

/** A number that counts up: frames custom.<key>_1… then custom.<key>, from `from` to `to` ms. */
function countUp(c: Ctx, id: string, key: string, b: Box, o: TextOpts & { from: number; to: number; endMs?: number }) {
  const steps = FIELD_TIMING.steps;
  const span = (o.to - o.from) / steps;
  const { from, to, endMs, ...rest } = o;
  c.only(when(key), () => {
    for (let i = 1; i <= steps; i++) {
      const a = Math.round(from + (i - 1) * span);
      text(c, `${id}-${i}`, C(`${key}_${i}`), b, { ...rest, startMs: a, endMs: Math.round(from + i * span), ...(i === 1 ? { enter: "fade" } : {}) });
    }
    text(c, id, C(key), b, { ...rest, startMs: to, endMs });
  });
}

/** The brand-colour wipe that hides a cut at `at` ms (it covers the canvas there). */
function wipe(c: Ctx, id: string, at: number, o: { edge?: boolean } = {}) {
  const startMs = Math.round(at - FIELD_TIMING.wipe / 2);
  const endMs = Math.round(at + FIELD_TIMING.wipe / 2);
  rect(c, id, { x: 0, y: 0, w: c.W, h: c.H }, { fill: MAIN, startMs, endMs, enter: "wipe", mirror: false, name: "bleed" });
  if (o.edge !== false) rect(c, `${id}-edge`, { x: 0, y: 0, w: 56, h: c.H }, { fill: INK, startMs, endMs, enter: "wipe", mirror: false, name: "bleed" });
}

/** Footage filling the canvas from `startMs`, blurred from `blurFrom` (the end card's clip). */
function footage(c: Ctx, id: string, o: { startMs: number; endMs?: number; path?: string; blurFrom?: number; box?: Box; enter?: Timing["enter"]; muted?: boolean }): SceneLayer {
  const layer = video(c, id, o.box ?? { x: 0, y: 0, w: c.W, h: c.H }, {
    startMs: o.startMs, ...(o.endMs !== undefined ? { endMs: o.endMs } : {}), path: o.path, muted: o.muted, enter: o.enter, mirror: false, name: "bleed",
  });
  if (o.blurFrom !== undefined) (layer as Extract<SceneLayer, { kind: "video" }>).blur = { fromMs: o.blurFrom, px: 22 };
  return layer;
}

/** Shades over footage so the top and bottom words read. */
function footShade(c: Ctx, id: string, t: Timing) {
  rect(c, `${id}-top`, { x: 0, y: 0, w: c.W, h: c.pick(420, 380, 560) }, { ...t, gradient: { from: "#000000A6", to: "#00000000" }, name: "bleed" });
  rect(c, `${id}-bottom`, { x: 0, y: c.H - c.pick(620, 560, 840), w: c.W, h: c.pick(620, 560, 840) }, { ...t, gradient: { from: "#00000000", to: "#000000D9" }, name: "bleed" });
}

/** The tag on the clip: small crest and the award in a pill, top; headline and facts, bottom. */
/**
 * Words over a clip. Only the tag and the headline move (each moving layer is its own overlay in
 * the MP4 render, and a five-clip top 5 would otherwise take minutes); `still` keeps the tag still too.
 */
function onClip(c: Ctx, id: string, t: Timing, o: { tag?: string; headline?: string; meta?: string; still?: boolean } = {}) {
  footShade(c, `${id}-shade`, { startMs: t.startMs, endMs: t.endMs });
  const s = c.pick(72, 64, 84);
  const y = c.T - c.pick(0, 0, 40);
  crest(c, `${id}-crest`, { x: c.M, y, w: s, h: s }, { startMs: t.startMs, endMs: t.endMs });
  if (o.tag) pill(c, `${id}-tag`, o.tag, y + s * 0.08, { x: c.M + s + 18, w: c.CW * 0.62, align: "start", size: c.pick(32, 30, 36), startMs: t.startMs, endMs: t.endMs, enter: o.still ? undefined : "slide-left" });
  text(c, `${id}-replay`, "REPLAY", { x: c.W - c.M - 180, y: y + s * 0.2, w: 180, h: s * 0.6 }, {
    startMs: t.startMs, endMs: t.endMs, size: c.pick(26, 24, 28), weight: 800, font: "condensed", color: skin.accent, align: "end", ls: 6, num: true,
  });
  const by = c.B - c.pick(150, 140, 190);
  if (o.headline) text(c, `${id}-head`, o.headline, { x: c.M, y: by - c.pick(96, 88, 112), w: c.CW, h: c.pick(96, 88, 112) }, {
    ...t, enter: "slide-up", size: c.pick(76, 68, 88), weight: 900, font: "condensed", color: PAPER, fit: true,
  });
  if (o.meta) text(c, `${id}-meta`, o.meta, { x: c.M, y: by + 12, w: c.CW, h: c.pick(52, 48, 58) }, {
    startMs: t.startMs, endMs: t.endMs, size: c.pick(32, 30, 36), weight: 600, color: PAPER, opacity: 0.9,
  });
}

/** The end card over the softened clip: dimmer, crest, name, booking line, the big line, Replay. */
function endCard(c: Ctx, id: string, at: number, end: number) {
  const t = { startMs: at, endMs: end };
  rect(c, `${id}-dim`, { x: 0, y: 0, w: c.W, h: c.H }, { ...t, enter: "fade", fill: INK, opacity: 0.62, name: "bleed" });
  const s = c.pick(250, 210, 290);
  const top = c.H / 2 - c.pick(330, 300, 420);
  crest(c, `${id}-crest`, { x: (c.W - s) / 2, y: top, w: s, h: s }, { startMs: at + 150, endMs: end, enter: "pop", mirror: false });
  text(c, `${id}-name`, C("field"), { x: c.M, y: top + s + 34, w: c.CW, h: c.pick(80, 72, 90) }, {
    startMs: at + 300, endMs: end, size: c.pick(60, 54, 68), weight: 900, color: PAPER, align: "center", fit: true,
  });
  text(c, `${id}-line`, C("endLine"), { x: c.M, y: top + s + c.pick(140, 126, 160), w: c.CW, h: c.pick(60, 54, 68) }, {
    startMs: at + 450, endMs: end, enter: "slide-up", size: c.pick(40, 36, 44), weight: 700, color: PAPER, align: "center", opacity: 0.92,
  });
  text(c, `${id}-big`, C("endBig"), { x: c.M, y: top + s + c.pick(210, 190, 236), w: c.CW, h: c.pick(120, 110, 136) }, {
    startMs: at + 550, endMs: end, enter: "slide-up", size: c.pick(104, 94, 118), weight: 800, font: "condensed", color: skin.accent, align: "center", num: true, fit: true,
  });
  text(c, `${id}-small`, C("endSmall"), { x: c.M, y: top + s + c.pick(342, 312, 384), w: c.CW, h: c.pick(52, 48, 58) }, {
    startMs: at + 650, endMs: end, size: c.pick(32, 30, 36), weight: 600, color: PAPER, align: "center", opacity: 0.85,
  });
  text(c, `${id}-mark`, "FILMED BY REPLAY", { x: c.M, y: c.B - c.pick(60, 56, 70), w: c.CW, h: c.pick(48, 44, 54) }, {
    startMs: at + 700, endMs: end, size: c.pick(26, 24, 30), weight: 700, font: "condensed", color: PAPER, align: "center", ls: 8, num: true, opacity: 0.7,
  });
}

/** The opening card: glow, big crest, kicker pill, title, a counting number with its label, the facts. */
function openingCard(c: Ctx, id: string, o: { end: number; stat?: string; statLabel?: string; titleSize?: number; avatar?: boolean; reserve?: number }): number {
  const t = { startMs: 0, endMs: o.end };
  backdrop(c, `${id}-bg`, t);
  const s = c.pick(200, 170, 236);
  // The block's height, so it sits in the middle of the safe area with or without a number.
  const lead = (o.avatar ? c.pick(300, 250, 340) : s) + c.pick(56, 44, 80) + c.pick(100, 92, 116) + c.pick(150, 132, 176) + c.pick(56, 48, 70);
  const statH = o.stat ? c.pick(190, 160, 220) + (o.statLabel ? c.pick(76, 68, 88) : 0) : 0;
  const height = lead + statH + c.pick(80, 74, 88) + (o.reserve ?? 0);
  const top = Math.round(c.T + Math.max(0, (c.B - c.T - height) / 2) - c.pick(20, 10, 40));
  if (o.avatar) {
    // Player cards: the player's photo in a disc in the main colour's ring when there is one (an
    // academy that shows names, a family that agreed), else his initials or shirt number.
    const d = c.pick(300, 250, 340);
    ellipse(c, `${id}-ring`, { x: (c.W - d) / 2, y: top, w: d, h: d }, { startMs: 80, endMs: o.end, enter: "pop", fill: "#FFFFFF14", stroke: { color: skin.metal, width: 12 }, mirror: false });
    const inset = 14;
    image(c, `${id}-photo`, { type: "binding", path: "player.photo" }, { x: (c.W - d) / 2 + inset, y: top + inset, w: d - inset * 2, h: d - inset * 2 }, {
      startMs: 120, endMs: o.end, enter: "pop", fit: "cover", radius: (d - inset * 2) / 2, when: PHOTO, mirror: false, name: "Player photo",
    });
    c.only(NO_PHOTO, () => text(c, `${id}-initials`, C("initials"), { x: (c.W - d) / 2, y: top + d * 0.26, w: d, h: d * 0.48 }, {
      startMs: 200, endMs: o.end, enter: "fade", size: c.pick(110, 96, 124), weight: 900, color: PAPER, align: "center", mirror: false,
    }));
    crest(c, `${id}-crest`, { x: (c.W + d) / 2 - 86, y: top + d - 96, w: 96, h: 96 }, { startMs: 300, endMs: o.end, enter: "pop", mirror: false });
  } else {
    crest(c, `${id}-crest`, { x: (c.W - s) / 2, y: top, w: s, h: s }, { startMs: 80, endMs: o.end, enter: "pop", mirror: false });
  }
  const below = top + (o.avatar ? c.pick(300, 250, 340) : s) + c.pick(56, 44, 80);
  pill(c, `${id}-kicker`, C("kicker"), below, { startMs: 300, endMs: o.end, enter: "slide-up" });
  const titleH = c.pick(150, 132, 176);
  text(c, `${id}-title`, C("title"), { x: c.M, y: below + c.pick(100, 92, 116), w: c.CW, h: titleH }, {
    startMs: 450, endMs: o.end, enter: "slide-up", size: o.titleSize ?? c.pick(128, 112, 148), weight: 900, font: "condensed", color: PAPER, align: "center", fit: true,
  });
  rect(c, `${id}-rule`, { x: (c.W - 140) / 2, y: below + c.pick(100, 92, 116) + titleH + 14, w: 140, h: 12 }, { startMs: 500, endMs: o.end, enter: "fade", fill: skin.metal, radius: 6, mirror: false });
  let y = below + c.pick(100, 92, 116) + titleH + c.pick(56, 48, 70);
  if (o.stat) {
    const h = c.pick(190, 160, 220);
    countUp(c, `${id}-stat`, o.stat, { x: c.M, y, w: c.CW, h }, {
      from: FIELD_TIMING.countFrom, to: FIELD_TIMING.countTo, endMs: o.end,
      size: c.pick(190, 160, 220), weight: 800, font: "condensed", color: skin.accent, align: "center", num: true, fit: true,
    });
    y += h;
    if (o.statLabel) {
      c.only(when(o.statLabel), () => text(c, `${id}-statlabel`, C(o.statLabel!), { x: c.M, y, w: c.CW, h: c.pick(56, 50, 64) }, {
        startMs: 900, endMs: o.end, enter: "fade", size: c.pick(40, 36, 46), weight: 800, color: PAPER, align: "center",
      }));
      y += c.pick(76, 68, 88);
    }
  }
  c.only(when("meta"), () => text(c, `${id}-meta`, C("meta"), { x: c.M + 40, y: y + 10, w: c.CW - 80, h: c.pick(70, 64, 78) }, {
    startMs: 1100, endMs: o.end, enter: "fade", size: c.pick(32, 30, 36), weight: 600, color: PAPER, align: "center",
    bg: { color: "#FFFFFF1F", padding: 18, radius: 999 },
  }));
  return y + c.pick(80, 74, 88);
}

/** The whole award / clip sequence; returns its length. */
function clipSequence(c: Ctx, o: { intro?: number; duration?: number; stat?: string; statLabel?: string; avatar?: boolean; tag?: string; headline?: string; meta?: string; statsRow?: boolean }): number {
  const D = o.duration ?? 15000;
  const intro = o.intro ?? FIELD_TIMING.intro;
  const endAt = D - FIELD_TIMING.end;
  footage(c, "video", { startMs: intro, blurFrom: endAt });
  onClip(c, "clip", { startMs: intro + 300, endMs: endAt }, { tag: o.tag, headline: o.headline, meta: o.meta });
  const rowH = c.pick(150, 136, 176);
  const below = openingCard(c, "open", { end: intro, stat: o.stat, statLabel: o.statLabel, avatar: o.avatar, reserve: o.statsRow ? rowH + 30 : 0 });
  if (o.statsRow) statsRow(c, "row", intro, below + 30, rowH);
  wipe(c, "wipe", intro);
  endCard(c, "end", endAt, D);
  return D;
}

/** Four small numbers under a player's card (goals, shots, km, top speed). */
function statsRow(c: Ctx, id: string, end: number, y: number, h: number) {
  const gap = 18;
  const w = (c.CW - gap * 3) / 4;
  for (let i = 1; i <= 4; i++) {
    const x = c.M + (i - 1) * (w + gap);
    c.only(when(`s${i}v`), () => {
      rect(c, `${id}-${i}-card`, { x, y, w, h }, { startMs: 1200 + i * 80, endMs: end, enter: "slide-up", fill: "#FFFFFF14", radius: 26 });
      text(c, `${id}-${i}-v`, C(`s${i}v`), { x, y: y + 16, w, h: h * 0.5 }, { startMs: 1200 + i * 80, endMs: end, enter: "slide-up", size: c.pick(70, 62, 80), weight: 800, font: "condensed", color: skin.accent, align: "center", num: true, fit: true });
      text(c, `${id}-${i}-l`, C(`s${i}l`), { x: x + 8, y: y + h * 0.62, w: w - 16, h: h * 0.3 }, { startMs: 1200 + i * 80, endMs: end, enter: "slide-up", size: c.pick(26, 24, 30), weight: 700, color: PAPER, align: "center", fit: true });
    });
  }
}

// ── Templates ───────────────────────────────────────────────────────────────

function bookingClip(c: Ctx) {
  return clipSequence(c, { intro: 1800, headline: C("headline"), meta: C("meta"), tag: C("kicker") });
}

function award(c: Ctx) {
  return clipSequence(c, { stat: "stat", statLabel: "statLabel", tag: C("kicker"), headline: C("title"), meta: C("meta") });
}

function playerCard(c: Ctx) {
  return clipSequence(c, { avatar: true, stat: "stat", statLabel: "statLabel", statsRow: true, tag: C("kicker"), headline: C("title"), meta: C("meta"), intro: 3200, duration: 16000 });
}

function matchWeek(c: Ctx) {
  const intro = 3000;
  const D = 16000;
  const endAt = D - FIELD_TIMING.end;
  footage(c, "video", { startMs: intro, blurFrom: endAt });
  onClip(c, "clip", { startMs: intro + 300, endMs: endAt }, { tag: C("kicker"), headline: C("headline"), meta: C("meta") });
  const t = { startMs: 0, endMs: intro };
  backdrop(c, "open-bg", t);
  // Pickup games: no score and no sides (nobody keeps the score, and the analysis can't always
  // tell the teams apart). The confirmed goal count is the big number.
  const top = Math.round(c.T + Math.max(0, (c.B - c.T - c.pick(840, 760, 1000)) / 2));
  pill(c, "open-kicker", C("kicker"), top, { startMs: 200, endMs: intro, enter: "slide-up" });
  const sy = top + c.pick(170, 150, 260);
  countUp(c, "open-goals-big", "goals", { x: c.M, y: sy + 60, w: c.CW, h: c.pick(300, 260, 340) }, {
    from: 500, to: 1700, endMs: intro, size: c.pick(250, 220, 300), weight: 800, font: "condensed", color: skin.accent, align: "center", num: true, fit: true,
  });
  c.only(when("goalsLabel"), () => text(c, "open-goals-label-big", C("goalsLabel"), { x: c.M, y: sy + 60 + c.pick(300, 260, 340) + 10, w: c.CW, h: 64 }, {
    startMs: 1000, endMs: intro, enter: "fade", size: c.pick(40, 36, 46), weight: 800, color: PAPER, align: "center",
  }));
  c.only(when("meta"), () => text(c, "open-meta-big", C("meta"), { x: c.M + 40, y: sy + 60 + c.pick(300, 260, 340) + 100, w: c.CW - 80, h: 70 }, {
    startMs: 1300, endMs: intro, enter: "fade", size: c.pick(32, 30, 36), weight: 600, color: PAPER, align: "center", bg: { color: "#FFFFFF1F", padding: 18, radius: 999 },
  }));
  wipe(c, "wipe", intro);
  endCard(c, "end", endAt, D);
  return D;
}

/** Top 5: the opening list, then five clips counting down, each behind its number, then the end card. */
function top5(c: Ctx) {
  const intro = 2600;
  const per = 3200;
  const D = intro + per * 5 + FIELD_TIMING.end;
  const endAt = D - FIELD_TIMING.end;
  // Clips, last one (the best) is data.media; 5 → 2 are more.3 … more.0.
  const paths = ["more.3", "more.2", "more.1", "more.0", "media"];
  paths.forEach((path, i) => {
    const s = intro + i * per;
    const last = i === 4;
    footage(c, `video-${i + 1}`, { startMs: s, endMs: last ? D : s + per, path, blurFrom: last ? endAt : undefined, muted: true });
  });
  paths.forEach((_, i) => {
    const s = intro + i * per;
    const n = 5 - i;
    onClip(c, `clip-${n}`, { startMs: s + 250, endMs: i === 4 ? endAt : s + per }, { tag: C("kicker"), headline: C(`l${n}`), meta: C(`m${n}`), still: i > 0 });
    // The big number, on its own for a moment as the clip comes in.
    text(c, `num-${n}`, String(n), { x: c.M, y: c.H / 2 - 260, w: c.CW, h: 520 }, {
      startMs: s, endMs: s + 900, enter: "pop", size: 520, weight: 800, font: "condensed", color: skin.accent, align: "center", num: true,
      shadow: { color: "#000000AA", blur: 40, x: 0, y: 8 },
    });
  });
  const t = { startMs: 0, endMs: intro };
  backdrop(c, "open-bg", t);
  const top = c.T + c.pick(20, 10, 80);
  crest(c, "open-crest", { x: (c.W - 150) / 2, y: top, w: 150, h: 150 }, { startMs: 60, endMs: intro, enter: "pop", mirror: false });
  pill(c, "open-kicker", C("kicker"), top + 190, { startMs: 250, endMs: intro, enter: "slide-up" });
  text(c, "open-title", C("title"), { x: c.M, y: top + c.pick(290, 270, 300), w: c.CW, h: c.pick(140, 120, 160) }, { startMs: 400, endMs: intro, enter: "slide-up", size: c.pick(120, 104, 140), weight: 900, font: "condensed", color: PAPER, align: "center", fit: true });
  const rowsTop = top + c.pick(470, 430, 520);
  const rowH = c.pick(118, 96, 150);
  for (let n = 5; n >= 1; n--) {
    const y = rowsTop + (5 - n) * (rowH + 14);
    // The rows build one by one (no slide: fifteen moving layers would slow the render a lot).
    const at = 600 + (5 - n) * 140;
    rect(c, `open-row-${n}`, { x: c.M, y, w: c.CW, h: rowH }, { startMs: at, endMs: intro, fill: n === 1 ? skin.hi : "#FFFFFF14", radius: 24 });
    text(c, `open-row-${n}-n`, String(n), { x: c.M + 24, y: y + rowH * 0.12, w: 80, h: rowH * 0.76 }, { startMs: at, endMs: intro, size: rowH * 0.66, weight: 800, font: "condensed", color: n === 1 ? skin.onHi : skin.accent, align: "center", num: true, mirror: true });
    text(c, `open-row-${n}-l`, C(`l${n}`), { x: c.M + 130, y: y + rowH * 0.22, w: c.CW - 160, h: rowH * 0.56 }, { startMs: at, endMs: intro, size: rowH * 0.36, weight: 800, color: n === 1 ? skin.onHi : PAPER, fit: true });
  }
  wipe(c, "wipe", intro);
  for (let i = 1; i < 5; i++) wipe(c, `wipe-${i}`, intro + i * per, { edge: false });
  endCard(c, "end", endAt, D);
  return D;
}

/** Montage clips: from 2 to 5, played in order (data.media first, then more.0 …). */
export const MONTAGE = { min: 2, max: 5, default: 4, per: 4200, intro: 2600 } as const;

/**
 * A montage (match highlights, the day's best): the opening card (crest, kicker, the date big,
 * the time and place under it), then `n` clips one after another, each behind a wipe in the main
 * colour with its label, then the end card over the last clip. One clip per data slot, in play
 * order: media, more.0, more.1 … (a montage made for fewer clips is shorter, buildFieldMontage).
 */
function montage(c: Ctx, n: number = MONTAGE.default) {
  const count = Math.max(MONTAGE.min, Math.min(MONTAGE.max, Math.round(n)));
  const intro = MONTAGE.intro;
  const per = MONTAGE.per;
  const D = intro + per * count + FIELD_TIMING.end;
  const endAt = D - FIELD_TIMING.end;
  const paths = ["media", ...Array.from({ length: count - 1 }, (_, i) => `more.${i}`)];
  paths.forEach((path, i) => {
    const s = intro + i * per;
    const last = i === count - 1;
    footage(c, `video-${i + 1}`, { startMs: s, endMs: last ? D : s + per, path, blurFrom: last ? endAt : undefined, muted: !last });
  });
  paths.forEach((_, i) => {
    const s = intro + i * per;
    const k = i + 1;
    onClip(c, `clip-${k}`, { startMs: s + 250, endMs: i === count - 1 ? endAt : s + per }, { tag: C(`l${k}`), headline: i === 0 ? C("headline") : undefined, meta: C(`m${k}`), still: i > 0 });
  });
  const t = { startMs: 0, endMs: intro };
  backdrop(c, "open-bg", t);
  const s = c.pick(190, 160, 220);
  const top = Math.round(c.T + Math.max(0, (c.B - c.T - c.pick(760, 680, 880)) / 2));
  crest(c, "open-crest", { x: (c.W - s) / 2, y: top, w: s, h: s }, { startMs: 80, endMs: intro, enter: "pop", mirror: false });
  pill(c, "open-kicker", C("kicker"), top + s + c.pick(44, 36, 60), { startMs: 300, endMs: intro, enter: "slide-up" });
  const ty = top + s + c.pick(150, 132, 190);
  text(c, "open-title", C("title"), { x: c.M, y: ty, w: c.CW, h: c.pick(150, 132, 176) }, {
    startMs: 450, endMs: intro, enter: "slide-up", size: c.pick(124, 108, 144), weight: 900, font: "condensed", color: PAPER, align: "center", fit: true,
  });
  c.only(when("meta"), () => text(c, "open-meta", C("meta"), { x: c.M + 40, y: ty + c.pick(170, 150, 200), w: c.CW - 80, h: c.pick(70, 64, 78) }, {
    startMs: 700, endMs: intro, enter: "fade", size: c.pick(34, 32, 38), weight: 700, color: ON_MAIN, align: "center", bg: { color: MAIN, padding: 18, radius: 999 },
  }));
  c.only(when("sub"), () => text(c, "open-sub", C("sub"), { x: c.M, y: ty + c.pick(270, 240, 310), w: c.CW, h: 60 }, {
    startMs: 1000, endMs: intro, enter: "fade", size: c.pick(34, 30, 38), weight: 600, color: PAPER, align: "center", opacity: 0.9,
  }));
  wipe(c, "wipe", intro);
  for (let i = 1; i < count; i++) wipe(c, `wipe-${i}`, intro + i * per, { edge: false });
  endCard(c, "end", endAt, D);
  return D;
}

/** Which is nicer: A on top, B below; A fills the screen; B pushes up over it; both again; the vote. */
function versus(c: Ctx, story: boolean) {
  const split = 2000;
  const aEnd = 7400;
  const bEnd = 12800;
  const D = 18000;
  const half = c.H / 2;
  // Split screen, then A, then B, then split again with the vote.
  footage(c, "a-split", { startMs: 0, endMs: split + 600, path: "media", box: { x: 0, y: 0, w: c.W, h: half }, muted: true });
  footage(c, "b-split", { startMs: 0, endMs: split + 600, path: "more.0", box: { x: 0, y: half, w: c.W, h: half }, muted: true });
  footage(c, "a-full", { startMs: split, endMs: aEnd + 600, path: "media", enter: "push-down" });
  footage(c, "b-full", { startMs: aEnd, endMs: bEnd + 600, path: "more.0", enter: "push-up" });
  footage(c, "a-again", { startMs: bEnd, path: "media", box: { x: 0, y: 0, w: c.W, h: half }, enter: "push-down", muted: true });
  footage(c, "b-again", { startMs: bEnd, path: "more.0", box: { x: 0, y: half, w: c.W, h: half }, enter: "push-up", muted: true });
  rect(c, "seam-1", { x: 0, y: half - 5, w: c.W, h: 10 }, { startMs: 0, endMs: split, fill: INK, mirror: false });
  rect(c, "seam-2", { x: 0, y: half - 5, w: c.W, h: 10 }, { startMs: bEnd + 600, endMs: D, enter: "fade", fill: INK, mirror: false });
  footShade(c, "shade", { startMs: 0, endMs: D });
  // Letters on each clip.
  const L = c.pick(120, 110, 140);
  const letter = (id: string, value: string, y: number, t: Timing) => badge(c, id, value, { x: c.M, y, w: L, h: L }, { ...t, radius: 28 });
  letter("a-letter-1", C("labelA"), c.T + 110, { startMs: 200, endMs: split, enter: "pop" });
  letter("b-letter-1", C("labelB"), half + 40, { startMs: 350, endMs: split, enter: "pop" });
  letter("a-letter-2", C("labelA"), c.T + 110, { startMs: split + 400, endMs: aEnd, enter: "pop" });
  letter("b-letter-2", C("labelB"), c.T + 110, { startMs: aEnd + 400, endMs: bEnd, enter: "pop" });
  letter("a-letter-3", C("labelA"), c.T + 110, { startMs: bEnd + 500, endMs: D, enter: "pop" });
  letter("b-letter-3", C("labelB"), half + 40, { startMs: bEnd + 600, endMs: D, enter: "pop" });
  // Facts while each plays full screen.
  const by = c.B - c.pick(150, 140, 190);
  text(c, "a-meta", C("metaA"), { x: c.M, y: by, w: c.CW, h: 60 }, { startMs: split + 600, endMs: aEnd, enter: "slide-up", size: c.pick(34, 32, 38), weight: 700, color: PAPER });
  text(c, "b-meta", C("metaB"), { x: c.M, y: by, w: c.CW, h: 60 }, { startMs: aEnd + 600, endMs: bEnd, enter: "slide-up", size: c.pick(34, 32, 38), weight: 700, color: PAPER });
  // The question on the seam, at the start and with the vote.
  const qh = c.pick(120, 110, 140);
  pill(c, "question-1", C("question"), half - qh / 2, { startMs: 100, endMs: split - 100, enter: "pop", size: c.pick(60, 54, 70) });
  pill(c, "question-2", C("question"), half - qh / 2, { startMs: bEnd + 700, endMs: D, enter: "pop", size: c.pick(60, 54, 70) });
  // The vote: comment A or B (Reel), or room for the poll sticker the owner adds (Story).
  const vy = half + qh / 2 + 40;
  if (story) {
    // Beside the B badge, not under it.
    rect(c, "sticker-room", { x: c.M + L + 40, y: vy, w: c.CW - L - 40, h: 220 }, { startMs: bEnd + 900, endMs: D, enter: "fade", fill: "#00000059", stroke: { color: "#FFFFFFCC", width: 4 }, radius: 40 });
  } else {
    text(c, "comment-cta", C("cta"), { x: c.M + L + 40, y: vy + 40, w: c.CW - L - 40, h: c.pick(100, 92, 112) }, {
      startMs: bEnd + 900, endMs: D, enter: "slide-up", size: c.pick(48, 44, 54), weight: 900, color: PAPER, align: "center",
      bg: { color: "#0B0F1AE6", padding: 26, radius: 32 },
    });
  }
  header(c, "head", { startMs: 0, endMs: D });
  bookingBand(c, "band", { startMs: bEnd + 1100, endMs: D, enter: "fade" });
  return D;
}

/** One nominee in a carousel: its number, the clip, "comment N". 4:5 by default. */
function nomineeSlide(c: Ctx) {
  const intro = 1200;
  const D = 12000;
  footage(c, "video", { startMs: 0, blurFrom: D - 2200 });
  footShade(c, "shade", { startMs: 0, endMs: D });
  const n = c.pick(220, 190, 260);
  badge(c, "number", C("n"), { x: (c.W - n) / 2, y: c.H / 2 - n / 2, w: n, h: n }, { startMs: 0, endMs: intro, enter: "pop", radius: n / 2, mirror: false });
  const s = c.pick(72, 64, 84);
  crest(c, "crest", { x: c.M, y: c.T - c.pick(0, 0, 40), w: s, h: s }, { startMs: 0, endMs: D });
  badge(c, "corner-number", C("n"), { x: c.W - c.M - 110, y: c.T - c.pick(0, 0, 40), w: 110, h: 110 }, { startMs: intro, endMs: D, enter: "pop", radius: 30 });
  text(c, "label", C("label"), { x: c.M, y: c.B - c.pick(220, 200, 260), w: c.CW, h: 70 }, { startMs: intro, endMs: D, enter: "slide-up", size: c.pick(40, 36, 46), weight: 800, color: PAPER });
  text(c, "cta", C("cta"), { x: c.M, y: c.B - c.pick(130, 120, 160), w: c.CW, h: 90 }, {
    startMs: intro + 400, endMs: D, enter: "slide-up", size: c.pick(46, 42, 52), weight: 900, color: skin.onPill, align: "start", bg: { color: skin.pill, padding: 22, radius: 999 },
  });
  return D;
}

/** The carousel's first slide (a still): the award, the nominees, how to vote. */
function nomineesCover(c: Ctx) {
  backdrop(c, "bg");
  header(c, "head", {});
  const top = c.T + c.pick(150, 140, 210);
  pill(c, "kicker", C("kicker"), top, { align: "start", w: c.CW * 0.7 });
  text(c, "title", C("title"), { x: c.M, y: top + c.pick(100, 92, 116), w: c.CW, h: c.pick(150, 130, 180) }, { size: c.pick(110, 96, 130), weight: 900, font: "condensed", color: PAPER, fit: true });
  const rowsTop = top + c.pick(290, 260, 340);
  const rowH = c.pick(128, 108, 150);
  for (let i = 1; i <= 4; i++) {
    c.only(when(`n${i}`), () => {
      const y = rowsTop + (i - 1) * (rowH + 16);
      rect(c, `row-${i}`, { x: c.M, y, w: c.CW, h: rowH }, { fill: "#FFFFFF14", radius: 26 });
      badge(c, `row-${i}-n`, String(i), { x: c.M + 20, y: y + 14, w: rowH - 28, h: rowH - 28 }, { radius: 22 });
      text(c, `row-${i}-l`, C(`n${i}`), { x: c.M + rowH + 10, y: y + rowH * 0.25, w: c.CW - rowH - 40, h: rowH * 0.5 }, { size: rowH * 0.3, weight: 800, color: PAPER, fit: true });
    });
  }
  text(c, "cta", C("cta"), { x: c.M, y: rowsTop + 4 * (rowH + 16) + c.pick(24, 20, 40), w: c.CW, h: 90 }, { size: c.pick(44, 40, 50), weight: 900, color: skin.onPill, align: "center", bg: { color: skin.pill, padding: 22, radius: 999 } });
  return undefined;
}

/** Thank you: the week's numbers counting up over live footage, one after another. */
function thanks(c: Ctx, milestone: boolean) {
  const intro = 2200;
  const D = 16000;
  const endAt = D - FIELD_TIMING.end;
  footage(c, "video", { startMs: intro, blurFrom: endAt });
  rect(c, "dim", { x: 0, y: 0, w: c.W, h: c.H }, { startMs: intro, endMs: endAt, fill: INK, opacity: 0.45, name: "bleed" });
  header(c, "head", { startMs: intro + 200, endMs: endAt, enter: "fade" });
  const t = { startMs: 0, endMs: intro };
  backdrop(c, "open-bg", t);
  const top = c.T + c.pick(120, 80, 260);
  crest(c, "open-crest", { x: (c.W - 220) / 2, y: top, w: 220, h: 220 }, { startMs: 60, endMs: intro, enter: "pop", mirror: false });
  text(c, "open-title", C("title"), { x: c.M, y: top + 270, w: c.CW, h: c.pick(170, 150, 200) }, { startMs: 300, endMs: intro, enter: "slide-up", size: c.pick(128, 112, 150), weight: 900, font: "condensed", color: PAPER, align: "center", fit: true });
  c.only(when("sub"), () => text(c, "open-sub", C("sub"), { x: c.M, y: top + c.pick(460, 430, 500), w: c.CW, h: 64 }, { startMs: 600, endMs: intro, enter: "fade", size: c.pick(38, 34, 44), weight: 700, color: PAPER, align: "center", opacity: 0.9 }));
  if (milestone) {
    const s = intro + 400;
    countUp(c, "big", "big", { x: c.M, y: c.H / 2 - 260, w: c.CW, h: 320 }, { from: s, to: s + 1600, endMs: endAt, size: 300, weight: 800, font: "condensed", color: skin.accent, align: "center", num: true, fit: true, shadow: { color: "#000000AA", blur: 30, x: 0, y: 6 } });
    text(c, "big-label", C("bigLabel"), { x: c.M, y: c.H / 2 + 80, w: c.CW, h: 120 }, { startMs: s + 400, endMs: endAt, enter: "slide-up", size: c.pick(64, 58, 76), weight: 900, color: PAPER, align: "center", fit: true });
    c.only(when("bigSub"), () => text(c, "big-sub", C("bigSub"), { x: c.M, y: c.H / 2 + 220, w: c.CW, h: 70 }, { startMs: s + 900, endMs: endAt, enter: "fade", size: c.pick(38, 34, 44), weight: 700, color: PAPER, align: "center", opacity: 0.9 }));
  } else {
    // Three numbers in turn: matches, goals, km.
    const rows: Array<[string, string]> = [["matches", "matchesLabel"], ["goals", "goalsLabel"], ["km", "kmLabel"]];
    const blockH = c.pick(250, 210, 300);
    const first = c.H / 2 - (blockH * 3) / 2 + c.pick(30, 20, 40);
    rows.forEach(([key, label], i) => {
      const s = intro + 500 + i * 1700;
      const y = first + i * blockH;
      c.only(when(key), () => {
        countUp(c, `n-${key}`, key, { x: c.M, y, w: c.CW, h: blockH * 0.68 }, { from: s, to: s + 1100, endMs: endAt, size: blockH * 0.62, weight: 800, font: "condensed", color: skin.accent, align: "center", num: true, fit: true, shadow: { color: "#000000AA", blur: 24, x: 0, y: 4 } });
        text(c, `n-${key}-label`, C(label), { x: c.M, y: y + blockH * 0.66, w: c.CW, h: blockH * 0.26 }, { startMs: s + 200, endMs: endAt, enter: "slide-up", size: c.pick(44, 38, 52), weight: 800, color: PAPER, align: "center", fit: true });
      });
    });
  }
  wipe(c, "wipe", intro);
  endCard(c, "end", endAt, D);
  return D;
}

/** Tonight's free slots (a still): up to four rows, each "free". */
function openSlots(c: Ctx) {
  backdrop(c, "bg");
  header(c, "head", {});
  const top = c.T + c.pick(150, 140, 220);
  pill(c, "kicker", C("kicker"), top, { align: "start", w: c.CW * 0.4 });
  text(c, "title", C("title"), { x: c.M, y: top + c.pick(100, 92, 116), w: c.CW, h: c.pick(140, 124, 170) }, { size: c.pick(104, 92, 124), weight: 900, font: "condensed", color: PAPER, fit: true });
  c.only(when("sub"), () => text(c, "sub", C("sub"), { x: c.M, y: top + c.pick(250, 230, 300), w: c.CW, h: 60 }, { size: c.pick(34, 32, 38), weight: 600, color: PAPER, opacity: 0.9 }));
  const rowsTop = top + c.pick(350, 320, 420);
  const rowH = c.pick(140, 116, 170);
  for (let i = 1; i <= 4; i++) {
    c.only(when(`t${i}`), () => {
      const y = rowsTop + (i - 1) * (rowH + 18);
      rect(c, `row-${i}`, { x: c.M, y, w: c.CW, h: rowH }, { fill: "#FFFFFF14", radius: 28 });
      text(c, `row-${i}-t`, C(`t${i}`), { x: c.M + 34, y: y + rowH * 0.12, w: c.CW * 0.55, h: rowH * 0.46 }, { size: rowH * 0.36, weight: 900, color: PAPER, fit: true });
      text(c, `row-${i}-p`, C(`p${i}`), { x: c.M + 34, y: y + rowH * 0.56, w: c.CW * 0.55, h: rowH * 0.32 }, { size: rowH * 0.22, weight: 600, color: PAPER, opacity: 0.85, fit: true });
      text(c, `row-${i}-free`, C("free"), { x: c.M + c.CW - 34 - 220, y: y + rowH * 0.27, w: 220, h: rowH * 0.46 }, { size: rowH * 0.22, weight: 900, color: skin.onPill, align: "center", bg: { color: skin.pill, padding: 14, radius: 999 } });
    });
  }
  bookingBand(c, "band", {});
  return undefined;
}

/** Top scorers of the month (a still): only players who agreed to show their name. */
function leaderboard(c: Ctx) {
  backdrop(c, "bg");
  header(c, "head", {});
  const top = c.T + c.pick(150, 140, 150);
  pill(c, "kicker", C("kicker"), top, { align: "start", w: c.CW * 0.5 });
  text(c, "title", C("title"), { x: c.M, y: top + c.pick(100, 92, 116), w: c.CW, h: c.pick(140, 124, 170) }, { size: c.pick(104, 92, 124), weight: 900, font: "condensed", color: PAPER, fit: true });
  const rowsTop = top + c.pick(290, 260, 330);
  const rowH = c.pick(104, 90, 130);
  for (let i = 1; i <= 5; i++) {
    c.only(when(`r${i}n`), () => {
      const y = rowsTop + (i - 1) * (rowH + 14);
      const first = i === 1;
      rect(c, `row-${i}`, { x: c.M, y, w: c.CW, h: rowH }, { fill: first ? skin.hi : "#FFFFFF14", radius: 26 });
      text(c, `row-${i}-rank`, String(i), { x: c.M + 20, y: y + rowH * 0.14, w: 70, h: rowH * 0.72 }, { size: rowH * 0.56, weight: 800, font: "condensed", color: first ? skin.onHi : skin.accent, align: "center", num: true, mirror: true });
      text(c, `row-${i}-name`, C(`r${i}n`), { x: c.M + 110, y: y + rowH * 0.24, w: c.CW * 0.6, h: rowH * 0.52 }, { size: rowH * 0.34, weight: 900, color: first ? skin.onHi : PAPER, fit: true });
      text(c, `row-${i}-v`, C(`r${i}v`), { x: c.M + c.CW - 30 - 260, y: y + rowH * 0.18, w: 260, h: rowH * 0.64 }, { size: rowH * 0.44, weight: 800, font: "condensed", color: first ? skin.onHi : PAPER, align: "end", num: true, fit: true });
    });
  }
  c.only(when("note"), () => text(c, "note", C("note"), { x: c.M, y: rowsTop + 5 * (rowH + 14) + 6, w: c.CW, h: 54 }, { size: c.pick(28, 26, 32), weight: 600, color: PAPER, opacity: 0.8 }));
  bookingBand(c, "band", {});
  return undefined;
}

// ── Catalogue ───────────────────────────────────────────────────────────────

const art = (key: string): MediaSource => ({ type: "artwork", key: `sample/${key}` });
/** Labels for a montage's clips: l1 … ln and m1 … mn. */
const montageLabels = (ar: boolean, n: number) => {
  const kinds = ar ? ["جول", "مراوغة", "تسديدة", "تصدّي", "جول"] : ["Goal", "Dribble", "Shot", "Save", "Goal"];
  const out: Record<string, string> = {};
  for (let i = 1; i <= n; i++) {
    out[`l${i}`] = kinds[(i - 1) % kinds.length];
    out[`m${i}`] = ar ? `الدقيقة ${i * 9}` : `Minute ${i * 9}`;
  }
  return out;
};
const sampleCommon = (ar: boolean) => ({
  academy: { name: "Jordan Galaxy", nameAr: "ملاعب جوردن جلاكسي", phone: "07 9920 4098" },
});
const fieldName = (ar: boolean) => (ar ? "ملاعب جوردن جلاكسي" : "Jordan Galaxy");
const endBits = (ar: boolean, ref?: string) => ({
  endLine: ref ? (ar ? "حجز" : "Booking") : (ar ? "احجز ملعبك، وماتشك بيتصوّر" : "Book a pitch, your game gets filmed"),
  endBig: ref ?? "07 9920 4098",
  endSmall: ar ? "كل ماتش إله فيديو" : "Every game gets its video",
  bookLine: ar ? "احجز ملعبك · كل ماتش متصوّر" : "Book a pitch · every game filmed",
  field: fieldName(ar),
});

const FIELD_DEFS: FieldDef[] = [
  {
    key: "field-booking-clip", title: { en: "Booking clip", ar: "لقطة من الحجز" }, formats: STORY,
    build: bookingClip,
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar, "JG-4F7K2Q"), kicker: ar ? "على أرضنا" : "On our pitch", title: ar ? "جووول!" : "Goal!", headline: ar ? "جووول!" : "Goal!", meta: ar ? "الخميس 9:00 م · ملعب 2" : "Thu 9:00 PM · Pitch 2",
    } }),
  },
  {
    key: "field-award", title: { en: "Award winner", ar: "الفايز بالجائزة" }, formats: STORY,
    build: award,
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "فايز هالأسبوع" : "This week's winner", title: ar ? "جول الأسبوع" : "Goal of the week",
      meta: ar ? "الثلاثاء 10:30 م · ملعب 1" : "Tue 10:30 PM · Pitch 1",
    } }),
  },
  {
    key: "field-potm", title: { en: "Player of the match", ar: "نجم الماتش" }, formats: STORY,
    build: playerCard,
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "نجم الماتش" : "Player of the match", title: ar ? "محمد أ." : "Mohammed A.", initials: ar ? "م.أ" : "MA",
      ...countData("stat", 8.7, 1), statLabel: ar ? "تقييم ريبلاي" : "Replay rating", meta: ar ? "الخميس 9:00 م · ملعب 2" : "Thu 9:00 PM · Pitch 2",
      s1v: "3", s1l: ar ? "أهداف" : "Goals", s2v: "6", s2l: ar ? "تسديدات" : "Shots", s3v: "4.2", s3l: ar ? "كم ركض" : "km run", s4v: "24.1", s4l: ar ? "كم/س" : "km/h",
    } }),
  },
  {
    key: "field-potw", title: { en: "Player of the week", ar: "لاعب الأسبوع" }, formats: STORY,
    build: playerCard,
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "لاعب الأسبوع" : "Player of the week", title: ar ? "أحمد ك." : "Ahmad K.", initials: ar ? "أ.ك" : "AK",
      ...countData("stat", 9), statLabel: ar ? "أهداف بـ 4 ماتشات" : "goals in 4 games", meta: ar ? "من 26 تشرين الأول لـ 1 تشرين الثاني" : "26 Oct – 1 Nov",
      s1v: "8.4", s1l: ar ? "معدّل التقييم" : "Avg rating", s2v: "3", s2l: ar ? "أسيست" : "Assists", s3v: "15.8", s3l: ar ? "كم ركض" : "km run", s4v: "4", s4l: ar ? "ماتشات" : "Games",
    } }),
  },
  {
    key: "field-match-week", title: { en: "Match of the week", ar: "ماتش الأسبوع" }, formats: STORY,
    build: matchWeek,
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "ماتش الأسبوع" : "Match of the week",
      ...countData("goals", 13), goalsLabel: ar ? "جول بساعة وحدة" : "goals in one hour", headline: ar ? "13 جول بماتش واحد" : "13 goals, one game", meta: ar ? "الخميس 10:00 م · ملعب 2" : "Thu 10:00 PM · Pitch 2",
    } }),
  },
  {
    key: "field-top5", title: { en: "Top 5 clips of the week", ar: "أحلى 5 لقطات بالأسبوع" }, formats: STORY,
    build: top5,
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), more: [art("goal-clip"), art("goal-clip"), art("goal-clip"), art("goal-clip")], custom: {
      ...endBits(ar), kicker: ar ? "هالأسبوع على أرضنا" : "This week on our pitches", title: ar ? "أحلى 5 لقطات" : "Top 5 clips",
      l5: ar ? "تسديدة على الطاير" : "Volley", m5: ar ? "الأحد · ملعب 2" : "Sun · Pitch 2",
      l4: ar ? "مراوغة بين لاعبين" : "Through two players", m4: ar ? "الاثنين · ملعب 1" : "Mon · Pitch 1",
      l3: ar ? "تصدّي من قريب" : "Point-blank save", m3: ar ? "الأربعاء · ملعب 3" : "Wed · Pitch 3",
      l2: ar ? "جول من نص الملعب" : "From halfway", m2: ar ? "الخميس · ملعب 1" : "Thu · Pitch 1",
      l1: ar ? "جول الأسبوع" : "Goal of the week", m1: ar ? "الجمعة · ملعب 2" : "Fri · Pitch 2",
    } }),
  },
  ...(["field-versus", "field-versus-story"] as const).map((key): FieldDef => ({
    key, title: key === "field-versus" ? { en: "Which is nicer? (Reel)", ar: "أي واحد أحلى؟ (ريل)" } : { en: "Which is nicer? (Story)", ar: "أي واحد أحلى؟ (ستوري)" },
    formats: STORY,
    build: (c) => versus(c, key === "field-versus-story"),
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), more: [art("goal-clip")], custom: {
      ...endBits(ar), question: ar ? "أي جول أحلى؟" : "Which goal is nicer?", labelA: ar ? "أ" : "A", labelB: ar ? "ب" : "B",
      metaA: ar ? "الثلاثاء 10:30 م · ملعب 1" : "Tue 10:30 PM · Pitch 1", metaB: ar ? "الجمعة 11:00 م · ملعب 2" : "Fri 11:00 PM · Pitch 2",
      cta: ar ? "علّقوا: أ ولا ب؟" : "Comment: A or B?",
    } }),
  })),
  {
    key: "field-nominee-slide", title: { en: "Nominee (carousel slide)", ar: "مرشّح (شريحة)" }, formats: POST_STORY,
    build: nomineeSlide,
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar), n: "1", label: ar ? "الأحد 8:00 م · ملعب 1" : "Sun 8:00 PM · Pitch 1", cta: ar ? "علّق 1 إذا عجبتك" : "Comment 1 if it's your pick",
    } }),
  },
  {
    key: "field-nominees-cover", title: { en: "Nominees (carousel cover)", ar: "المرشّحين (غلاف)" }, formats: POST_STORY,
    build: nomineesCover,
    sample: (ar) => ({ ...sampleCommon(ar), custom: {
      ...endBits(ar), kicker: ar ? "صوّتوا" : "Vote", title: ar ? "جول الأسبوع" : "Goal of the week",
      n1: ar ? "الأحد 8:00 م · ملعب 1" : "Sun 8:00 PM · Pitch 1", n2: ar ? "الاثنين 10:00 م · ملعب 2" : "Mon 10:00 PM · Pitch 2",
      n3: ar ? "الأربعاء 9:30 م · ملعب 3" : "Wed 9:30 PM · Pitch 3", n4: ar ? "الجمعة 11:00 م · ملعب 1" : "Fri 11:00 PM · Pitch 1",
      cta: ar ? "اسحبوا وعلّقوا برقم اللقطة" : "Swipe, then comment its number",
    } }),
  },
  {
    key: "field-thanks", title: { en: "Thank you (the week in numbers)", ar: "شكراً (الأسبوع بالأرقام)" }, formats: STORY,
    build: (c) => thanks(c, false),
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar), title: ar ? "شكراً إلكم" : "Thank you", sub: ar ? "على أسبوع حلو معنا" : "for a great week with us",
      ...countData("matches", 126), matchesLabel: ar ? "ماتش متصوّر" : "games filmed",
      ...countData("goals", 512), goalsLabel: ar ? "جول" : "goals",
      ...countData("km", 1840), kmLabel: ar ? "كم ركضتوا كلكم" : "km you all ran",
    } }),
  },
  {
    key: "field-milestone", title: { en: "Milestone", ar: "إنجاز" }, formats: STORY,
    build: (c) => thanks(c, true),
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), custom: {
      ...endBits(ar), title: ar ? "شكراً إلكم" : "Thank you", sub: ar ? "وصلنا لرقم كبير" : "We reached a big one",
      ...countData("big", 1000), bigLabel: ar ? "ماتش متصوّر على أرضنا" : "games filmed on our pitches", bigSub: ar ? "وكل واحد إله فيديو" : "and every one has its video",
    } }),
  },
  {
    key: "field-open-slots", title: { en: "Open slots tonight", ar: "ملاعب فاضية الليلة" }, formats: STORY_POST,
    build: openSlots,
    sample: (ar) => ({ ...sampleCommon(ar), custom: {
      ...endBits(ar), kicker: ar ? "الليلة" : "Tonight", title: ar ? "في ملاعب فاضية" : "Pitches free tonight", sub: ar ? "احجز، والماتش بيتصوّر وبيوصلك فيديو" : "Book now: your game gets filmed",
      free: ar ? "فاضي" : "Free", t1: ar ? "8:00 م" : "8:00 PM", p1: ar ? "ملعب 1 · خماسي" : "Pitch 1 · 5-a-side", t2: ar ? "10:00 م" : "10:00 PM", p2: ar ? "ملعب 2 · سداسي" : "Pitch 2 · 6-a-side", t3: ar ? "11:00 م" : "11:00 PM", p3: ar ? "ملعب 3 · خماسي" : "Pitch 3 · 5-a-side",
    } }),
  },
  {
    key: "field-leaderboard", title: { en: "Top scorers of the month", ar: "هدّافين الشهر" }, formats: STORY_POST,
    build: leaderboard,
    sample: (ar) => ({ ...sampleCommon(ar), custom: {
      ...endBits(ar), kicker: ar ? "تشرين الثاني" : "November", title: ar ? "هدّافين الشهر" : "Top scorers",
      r1n: ar ? "أحمد ك." : "Ahmad K.", r1v: "21", r2n: ar ? "يزن ر." : "Yazan R.", r2v: "18", r3n: ar ? "محمد أ." : "Mohammed A.", r3v: "16", r4n: ar ? "عمر ح." : "Omar H.", r4v: "14", r5n: ar ? "كريم س." : "Karim S.", r5v: "12",
      note: ar ? "بس اللاعبين اللي وافقوا يظهر اسمهم" : "Only players who chose to show their name",
    } }),
  },
];

FIELD_DEFS.push(
  {
    key: "field-match-highlights", title: { en: "Match highlights", ar: "ملخص الماتش" }, formats: STORY,
    build: (c) => montage(c),
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), more: [art("goal-clip"), art("goal-clip"), art("goal-clip")], custom: {
      ...endBits(ar, "JG-4F7K2Q"), kicker: ar ? "ملخص الماتش" : "Match highlights", title: ar ? "الخميس 6 تشرين الثاني" : "Thu 6 Nov",
      meta: ar ? "9:00 م · ملعب 2" : "9:00 PM · Pitch 2", headline: ar ? "ماتش ناري" : "What a game", ...montageLabels(ar, 4),
    } }),
  },
  {
    key: "field-day-best", title: { en: "Best clips of the day", ar: "أحلى لقطات اليوم" }, formats: STORY,
    build: (c) => montage(c),
    sample: (ar) => ({ ...sampleCommon(ar), media: art("goal-clip"), more: [art("goal-clip"), art("goal-clip"), art("goal-clip")], custom: {
      ...endBits(ar), kicker: ar ? "أحلى لقطات اليوم" : "Best of the day", title: ar ? "الأربعاء 5 تشرين الثاني" : "Wed 5 Nov",
      meta: ar ? "من 7 ماتشات" : "From 7 games", headline: ar ? "أحلى لقطة اليوم" : "Clip of the day", ...montageLabels(ar, 4),
    } }),
  },
);

/** Montage templates: their clip count can be 2 to 5 (buildFieldMontage). */
export const isMontageTemplate = (key: string) => key === "field-match-highlights" || key === "field-day-best" || key === "club-highlights";

export const FIELD_TEMPLATE_KEYS = FIELD_DEFS.map((d) => d.key);
export const isFieldTemplate = (key: string): key is FieldTemplateKey => FIELD_DEFS.some((d) => d.key === key);
export const fieldTemplateTitle = (key: string, ar: boolean) => {
  const d = FIELD_DEFS.find((x) => x.key === key);
  return d ? (ar ? d.title.ar : d.title.en) : key;
};
export const fieldTemplateFormats = (key: string): CreativeFormat[] => FIELD_DEFS.find((d) => d.key === key)?.formats ?? STORY;
/** Every field template's title and formats, in the pack's order (the Creative hub's "Field pack"). */
export const FIELD_TEMPLATE_DEFS: { key: FieldTemplateKey; title: { en: string; ar: string }; formats: CreativeFormat[] }[] =
  FIELD_DEFS.map(({ key, title, formats }) => ({ key, title, formats }));

/** A field template laid out in a format (the first of its formats when it isn't one of them). */
export function buildFieldScene(key: FieldTemplateKey, format: CreativeFormat, locale: Locale): Scene {
  const def = FIELD_DEFS.find((d) => d.key === key)!;
  const f = def.formats.includes(format) ? format : def.formats[0];
  const c = new Canvas(f, locale);
  const durationMs = def.build(c);
  return {
    v: 1,
    format: f,
    ...(durationMs !== undefined ? { durationMs } : {}),
    background: INK,
    layers: [...c.layers],
    template: { key, style: FIELD_STYLE },
    locale,
  } as Scene;
}

/** A montage template laid out for `clips` clips (2–5): shorter or longer, the same look. */
export function buildFieldMontage(key: FieldTemplateKey, clips: number, format: CreativeFormat, locale: Locale): Scene {
  const def = FIELD_DEFS.find((d) => d.key === key)!;
  const f = def.formats.includes(format) ? format : def.formats[0];
  const c = new Canvas(f, locale);
  const durationMs = montage(c, clips);
  return { v: 1, format: f, durationMs, background: INK, layers: [...c.layers], template: { key, style: FIELD_STYLE }, locale } as Scene;
}

export function fieldSampleData(key: string, locale: Locale): CreativeData {
  const def = FIELD_DEFS.find((d) => d.key === key);
  return def ? def.sample(locale === "ar") : {};
}

/**
 * The pack's pieces and layouts, for the academies' pack (clubPack.ts): the same look, other
 * words. Not part of the catalogue contract.
 */
export const FIELD_KIT = {
  PAPER, INK, MAIN, ON_MAIN, C, when, text, withSkin,
  backdrop, pill, badge, header, bookingBand, countUp, wipe, footage, footShade, onClip, endCard, openingCard, clipSequence, statsRow,
  layouts: { bookingClip, award, playerCard, top5, versus, nomineeSlide, nomineesCover, thanks, openSlots, leaderboard, montage },
};
