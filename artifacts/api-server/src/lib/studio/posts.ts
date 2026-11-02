import { createCanvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { ensureBrandingFonts } from "../clipBranding/assets";
import {
  TEXT,
  VOID,
  arabic,
  brightOnDark,
  drawCrest,
  drawWatermark,
  fitSize,
  inkOn,
  latin,
  parseHex,
  roundRect,
  safeColor,
  shadowed,
} from "../clipBranding/draw";
import type { BrandLook } from "../clipBranding/types";

/**
 * Academy console → Studio: social posts and stories drawn in the academy's
 * own look, with the fonts, crest and colour handling the clip branding uses.
 *
 * Every format is 1080 wide, so layout is in real pixels at full size; the
 * console's live preview draws the same layout at half scale.
 *
 * Nothing in here decides whether a name may be printed: the route strips
 * names before they reach this module when the academy's profile does not
 * allow them. Most of these players are children.
 */

export const STUDIO_FORMATS = {
  post: { w: 1080, h: 1350 },
  square: { w: 1080, h: 1080 },
  story: { w: 1080, h: 1920 },
} as const;
export type StudioFormat = keyof typeof STUDIO_FORMATS;
export type StudioLocale = "en" | "ar";

export type Scorer = { number: number | null; name: string | null; goals: number };

export type StudioContent =
  | {
    template: "match";
    ownName: string;
    opponent: string;
    ownScore: number;
    opponentScore: number;
    dateLabel: string | null;
    squad: string | null;
    scorers: Scorer[];
  }
  | {
    template: "player";
    number: number | null;
    name: string | null;
    squad: string | null;
    ageGroup: string | null;
    line: string | null;
  }
  | {
    template: "training";
    rangeLabel: string | null;
    rows: Array<{ day: string; time: string; squad: string | null; place: string | null }>;
  }
  | {
    template: "registration";
    kind: "registration" | "trial";
    headline: string;
    ageGroups: string | null;
    startDate: string | null;
    priceJod: number | null;
    contact: string | null;
  }
  | { template: "announcement"; title: string; body: string | null };

export type StudioRenderInput = {
  look: BrandLook;
  format: StudioFormat;
  locale: StudioLocale;
  content: StudioContent;
  background: Image | null;
  photo: Image | null;
  mark: Image | null;
  /** 1 for the downloadable PNG; the console's preview passes 0.5. */
  scale?: number;
};

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
export const hasArabic = (s: string) => ARABIC.test(s);

const LTR_RUN = /[#@+×]?[A-Za-z0-9](?:[A-Za-z0-9#@+×:.,'’\-–\/_ ]*[A-Za-z0-9])?/g;

/**
 * Inside Arabic text, isolates each Latin or numeric run (a phone number, a
 * date range, "#10", "×2") so the bidi algorithm keeps it left-to-right.
 * Without it "079 543 3320" comes out as "3320 543 079" and "2 – 8" as "8 – 2".
 */
export function isolateLtrRuns(text: string): string {
  if (!hasArabic(text)) return text;
  return text.replace(LTR_RUN, (run) => `\u2066${run}\u2069`);
}

const COPY = {
  en: {
    match: "FULL TIME",
    scorers: "SCORERS",
    player: "PLAYER OF THE WEEK",
    training: "THIS WEEK'S TRAINING",
    noTraining: "No sessions this week",
    more: (n: number) => `+${n} more`,
    registration: "REGISTRATION OPEN",
    trial: "FREE TRIAL",
    ages: "AGES",
    starts: "STARTS",
    price: "PRICE",
    jod: (n: string) => `${n} JOD`,
    free: "FREE",
    announcement: "ANNOUNCEMENT",
  },
  ar: {
    match: "نهاية المباراة",
    scorers: "سجّلوا الأهداف",
    player: "لاعب الأسبوع",
    training: "تدريبات هالأسبوع",
    noTraining: "ما في تدريبات هالأسبوع",
    more: (n: number) => `و${n} غيرها`,
    registration: "التسجيل مفتوح",
    trial: "حصة تجريبية مجانية",
    ages: "الأعمار",
    starts: "البداية",
    price: "السعر",
    jod: (n: string) => `${n} دينار`,
    free: "مجاناً",
    announcement: "إعلان",
  },
} as const;

type Box = { x: number; w: number; top: number; bottom: number };

/** Sets the font for `text`: Cairo for anything with Arabic in it, Rajdhani otherwise. */
function fontFor(ctx: SKRSContext2D, text: string, size: number, heavy = true): void {
  if (hasArabic(text)) arabic(ctx, size, heavy ? 900 : 700);
  else latin(ctx, size, heavy ? 700 : 600);
}

/** Draws one line, aligned to the start side of the locale, shrinking it to fit. */
function line(
  ctx: SKRSContext2D,
  text: string,
  box: { x: number; w: number },
  y: number,
  opts: { size: number; min?: number; rtl: boolean; color?: string; heavy?: boolean; align?: "start" | "center" | "end"; upper?: boolean; shadow?: boolean },
): number {
  const t = isolateLtrRuns(opts.upper && !hasArabic(text) ? text.toUpperCase() : text);
  const size = fitSize(ctx, t, box.w, opts.size, opts.min ?? Math.round(opts.size * 0.55), (s) => fontFor(ctx, t, s, opts.heavy ?? true));
  fontFor(ctx, t, size, opts.heavy ?? true);
  const align = opts.align ?? "start";
  const right = (align === "start" && opts.rtl) || (align === "end" && !opts.rtl);
  ctx.textAlign = align === "center" ? "center" : right ? "right" : "left";
  ctx.textBaseline = "alphabetic";
  const x = align === "center" ? box.x + box.w / 2 : right ? box.x + box.w : box.x;
  ctx.fillStyle = opts.color ?? TEXT;
  if (opts.shadow) shadowed(ctx, () => ctx.fillText(t, x, y), 14);
  else ctx.fillText(t, x, y);
  return size;
}

/** Word-wraps `text` into at most `maxLines`, ellipsising the last one. */
function wrap(ctx: SKRSContext2D, text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
    const words = para.split(/\s+/);
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width <= width || !current) current = next;
      else { out.push(current); current = word; }
    }
    if (current) out.push(current);
  }
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return out;
}

/** A paragraph: wrapped, start-aligned, returns the y under its last line. */
function paragraph(
  ctx: SKRSContext2D,
  text: string,
  box: { x: number; w: number },
  top: number,
  opts: { size: number; maxLines: number; rtl: boolean; color?: string; heavy?: boolean; lineHeight?: number; align?: "start" | "center" },
): number {
  fontFor(ctx, text, opts.size, opts.heavy ?? false);
  const lines = wrap(ctx, text, box.w, opts.maxLines);
  const lh = opts.size * (opts.lineHeight ?? (hasArabic(text) ? 1.45 : 1.15));
  let y = top;
  for (const l of lines) {
    y += lh;
    line(ctx, l, box, y - lh * 0.22, { size: opts.size, min: opts.size, rtl: opts.rtl, color: opts.color, heavy: opts.heavy ?? false, align: opts.align });
  }
  return y;
}

function mixHex(a: string, b: string, t: number): string {
  const x = parseHex(a) ?? [0, 0, 0];
  const y = parseHex(b) ?? [0, 0, 0];
  const m = x.map((c, i) => Math.round(c + (y[i] - c) * t));
  return `#${m.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function drawCover(ctx: SKRSContext2D, img: Image, x: number, y: number, w: number, h: number): void {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k;
  const sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function drawBackground(ctx: SKRSContext2D, W: number, H: number, look: BrandLook, background: Image | null): void {
  const venue = safeColor(look.primaryColor, "#2FD8C4");
  if (background) {
    drawCover(ctx, background, 0, 0, W, H);
    ctx.fillStyle = "rgba(11,15,26,0.55)";
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, H * 0.35, 0, H);
    grad.addColorStop(0, "rgba(11,15,26,0)");
    grad.addColorStop(1, "rgba(11,15,26,0.85)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  // The brand-colour design: a dark tint of the academy's colour, two large
  // rings in it and a stripe in the second colour.
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, mixHex(VOID, venue, 0.28));
  grad.addColorStop(1, mixHex(VOID, venue, 0.08));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.strokeStyle = venue;
  ctx.globalAlpha = 0.12;
  ctx.lineWidth = 110;
  ctx.beginPath();
  ctx.arc(W * 0.92, H * 0.78, W * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.07;
  ctx.lineWidth = 60;
  ctx.beginPath();
  ctx.arc(W * 0.05, H * 0.58, W * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = safeColor(look.accentColor, venue);
  ctx.globalAlpha = 0.9;
  ctx.fillRect(0, H - 14, W, 14);
  ctx.globalAlpha = 1;
}

/** The venue band across the top: crest, the academy's name, the template's kicker. */
function drawHeader(ctx: SKRSContext2D, W: number, bandH: number, look: BrandLook, rtl: boolean, kicker: string): void {
  const venue = safeColor(look.primaryColor, "#2FD8C4");
  const ink = inkOn(venue);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, rtl ? bandH : bandH - 80);
  ctx.lineTo(0, rtl ? bandH - 80 : bandH);
  ctx.closePath();
  ctx.fillStyle = venue;
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = ink === VOID ? "rgba(11,15,26,0.07)" : "rgba(255,255,255,0.08)";
  ctx.lineWidth = 70;
  ctx.beginPath();
  ctx.arc(rtl ? 120 : W - 120, bandH * 0.35, bandH * 0.8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const pad = 64;
  const crest = Math.round(bandH * 0.46);
  const crestTop = Math.round((bandH - 80 - crest) / 2);
  const crestCx = rtl ? W - pad - crest / 2 : pad + crest / 2;
  drawCrest(ctx, look, crestCx, crestTop + crest / 2, crest, { onBand: true });

  const textBox = { x: rtl ? pad : pad + crest + 36, w: W - pad * 2 - crest - 36 };
  const name = rtl ? (look.nameAr || look.nameEn) : look.nameEn;
  const sub = rtl ? (look.nameAr ? look.nameEn : null) : look.nameAr;
  const nameSize = Math.round(crest * 0.42);
  const centre = crestTop + crest / 2;
  const nameY = sub ? centre - 4 : centre + nameSize * 0.34;
  line(ctx, name, textBox, nameY, { size: nameSize, min: 34, rtl, color: ink, upper: true });
  if (sub) line(ctx, sub, textBox, centre + nameSize * 0.85, { size: Math.round(nameSize * 0.5), min: 24, rtl, color: ink });

  // The kicker: a Void tab hanging off the band.
  const k = hasArabic(kicker) ? kicker : kicker.toUpperCase();
  const kSize = Math.round(bandH * 0.1);
  fontFor(ctx, k, kSize);
  const kw = ctx.measureText(k).width + 56;
  const ky = bandH - 40;
  const kx = rtl ? W - pad - kw : pad;
  ctx.fillStyle = VOID;
  ctx.fillRect(kx, ky, kw, kSize * 1.7);
  ctx.fillStyle = brightOnDark(look);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(k, kx + kw / 2, ky + kSize * 0.88);
  ctx.textBaseline = "alphabetic";
}

function contactLine(look: BrandLook, override: string | null): string | null {
  const parts = [override ?? look.bookingPhone, look.instagram ? `@${look.instagram.replace(/^@/, "")}` : null].filter(Boolean);
  return parts.length ? parts.join("  ·  ") : null;
}

function drawFooter(ctx: SKRSContext2D, W: number, H: number, look: BrandLook, rtl: boolean, mark: Image | null): void {
  const pad = 64;
  const baseline = H - 64;
  const contact = contactLine(look, null);
  const markH = 34;
  latin(ctx, markH * 0.58);
  const markW = (mark ? (mark.width / mark.height) * markH + markH * 0.25 : 0) + ctx.measureText("replayjo.com").width;
  drawWatermark(ctx, mark, rtl ? pad : W - pad - markW, baseline, markH, "replayjo.com");
  if (contact) {
    const box = { x: rtl ? pad + markW + 40 : pad, w: W - pad * 2 - markW - 40 };
    ctx.globalAlpha = 0.85;
    line(ctx, contact, box, baseline, { size: 36, min: 24, rtl, heavy: false });
    ctx.globalAlpha = 1;
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

function drawMatch(ctx: SKRSContext2D, c: Extract<StudioContent, { template: "match" }>, box: Box, look: BrandLook, rtl: boolean): void {
  const copy = COPY[rtl ? "ar" : "en"];
  const avail = box.bottom - box.top;
  const scoreSize = Math.min(300, Math.round(avail * 0.3));
  const accent = brightOnDark(look);
  let y = box.top + scoreSize * 0.95;
  // The academy always sits on the reading side the post starts from.
  const left = rtl ? { name: c.opponent, score: c.opponentScore } : { name: c.ownName, score: c.ownScore };
  const right = rtl ? { name: c.ownName, score: c.ownScore } : { name: c.opponent, score: c.opponentScore };
  const half = box.w / 2;
  latin(ctx, scoreSize);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  ctx.fillStyle = TEXT;
  shadowed(ctx, () => ctx.fillText(String(left.score), box.x + half * 0.5, y));
  shadowed(ctx, () => ctx.fillText(String(right.score), box.x + half * 1.5, y));
  ctx.fillStyle = accent;
  ctx.fillText("–", box.x + half, y - scoreSize * 0.08);
  y += 70;
  const nameSize = Math.round(scoreSize * 0.2);
  const ownIsLeft = !rtl;
  line(ctx, left.name, { x: box.x, w: half - 20 }, y, { size: nameSize, min: 26, rtl, align: "center", upper: true, color: ownIsLeft ? accent : TEXT });
  line(ctx, right.name, { x: box.x + half + 20, w: half - 20 }, y, { size: nameSize, min: 26, rtl, align: "center", upper: true, color: ownIsLeft ? TEXT : accent });

  const meta = [c.squad, c.dateLabel].filter(Boolean).join("  ·  ");
  if (meta) {
    y += 70;
    ctx.globalAlpha = 0.8;
    line(ctx, meta, box, y, { size: 38, min: 26, rtl, align: "center", heavy: false });
    ctx.globalAlpha = 1;
  }

  const scorers = c.scorers.filter((s) => s.goals > 0 && (s.number !== null || s.name));
  if (scorers.length && box.bottom - y > 160) {
    y += 100;
    line(ctx, copy.scorers, box, y, { size: 34, rtl, align: "center", color: accent });
    const parts = scorers.map((s) => {
      const who = [s.number !== null ? `#${s.number}` : null, s.name].filter(Boolean).join(" ");
      return s.goals > 1 ? `${who} ×${s.goals}` : who;
    });
    paragraph(ctx, parts.join("   ·   "), box, y + 10, {
      size: 44, maxLines: Math.max(1, Math.floor((box.bottom - y - 20) / 62)), rtl, heavy: true, align: "center",
    });
  }
}

function drawPlayer(
  ctx: SKRSContext2D,
  c: Extract<StudioContent, { template: "player" }>,
  box: Box,
  look: BrandLook,
  rtl: boolean,
  photo: Image | null,
): void {
  const accent = brightOnDark(look);
  const avail = box.bottom - box.top;
  let textTop = box.top;
  if (photo) {
    const size = Math.min(box.w * 0.62, avail * 0.52);
    const px = box.x + (box.w - size) / 2;
    ctx.save();
    roundRect(ctx, px, box.top, size, size, size * 0.08);
    ctx.clip();
    drawCover(ctx, photo, px, box.top, size, size);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = safeColor(look.primaryColor, "#2FD8C4");
    ctx.lineWidth = 10;
    roundRect(ctx, px, box.top, size, size, size * 0.08);
    ctx.stroke();
    ctx.restore();
    textTop = box.top + size + 20;
  }
  const rest = box.bottom - textTop;
  const bigSize = Math.min(photo ? 200 : 360, Math.round(rest * (photo ? 0.48 : 0.5)));
  let y = textTop + bigSize * 0.9;
  const big = c.number !== null ? `#${c.number}` : (c.name ?? "");
  if (big) line(ctx, big, box, y, { size: bigSize, rtl, align: "center", color: accent, upper: true, shadow: true });
  if (c.number !== null && c.name) {
    y += Math.round(bigSize * 0.42) + 10;
    line(ctx, c.name, box, y, { size: Math.round(bigSize * 0.38), min: 40, rtl, align: "center", upper: true, shadow: true });
  }
  const meta = [c.squad, c.ageGroup].filter(Boolean).join("  ·  ");
  if (meta) {
    y += 70;
    ctx.globalAlpha = 0.85;
    line(ctx, meta, box, y, { size: 40, min: 26, rtl, align: "center", heavy: false });
    ctx.globalAlpha = 1;
  }
  if (c.line && box.bottom - y > 80) {
    paragraph(ctx, c.line, box, y + 20, { size: 42, maxLines: 2, rtl, align: "center", heavy: true });
  }
}

function drawTraining(ctx: SKRSContext2D, c: Extract<StudioContent, { template: "training" }>, box: Box, look: BrandLook, rtl: boolean): void {
  const copy = COPY[rtl ? "ar" : "en"];
  const accent = brightOnDark(look);
  let y = box.top;
  if (c.rangeLabel) {
    y += 56;
    line(ctx, c.rangeLabel, box, y, { size: 52, rtl, color: TEXT, upper: true });
    y += 20;
  }
  if (!c.rows.length) {
    line(ctx, copy.noTraining, box, y + 120, { size: 52, rtl, heavy: false });
    return;
  }
  const rowH = Math.min(150, Math.max(104, Math.floor((box.bottom - y - 20) / Math.max(4, c.rows.length))));
  const fit = Math.max(1, Math.floor((box.bottom - y - 10) / rowH));
  const shown = c.rows.length > fit ? c.rows.slice(0, fit - 1) : c.rows;
  const dayW = box.w * 0.36;
  const timeW = box.w * 0.22;
  for (const row of shown) {
    const top = y + 14;
    ctx.fillStyle = "rgba(11,15,26,0.55)";
    roundRect(ctx, box.x, top, box.w, rowH - 18, 18);
    ctx.fill();
    ctx.fillStyle = safeColor(look.primaryColor, "#2FD8C4");
    ctx.fillRect(rtl ? box.x + box.w - 10 : box.x, top, 10, rowH - 18);
    const mid = top + (rowH - 18) / 2;
    const dayBox = rtl ? { x: box.x + box.w - 34 - dayW, w: dayW } : { x: box.x + 34, w: dayW };
    const timeBox = rtl ? { x: dayBox.x - 16 - timeW, w: timeW } : { x: dayBox.x + dayW + 16, w: timeW };
    const restBox = rtl ? { x: box.x + 24, w: timeBox.x - 16 - box.x - 24 } : { x: timeBox.x + timeW + 16, w: box.x + box.w - 24 - timeBox.x - timeW - 16 };
    line(ctx, row.day, dayBox, mid + 14, { size: 40, min: 24, rtl, color: accent, upper: true });
    line(ctx, row.time, timeBox, mid + 14, { size: 42, min: 24, rtl, color: TEXT });
    const detail = [row.squad, row.place].filter(Boolean).join(" · ");
    if (detail) {
      ctx.globalAlpha = 0.85;
      line(ctx, detail, restBox, mid + 12, { size: 34, min: 20, rtl, heavy: false, align: "end" });
      ctx.globalAlpha = 1;
    }
    y += rowH;
  }
  if (shown.length < c.rows.length) {
    line(ctx, copy.more(c.rows.length - shown.length), box, y + 56, { size: 38, rtl, heavy: false, color: accent });
  }
}

function formatJod(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function drawRegistration(ctx: SKRSContext2D, c: Extract<StudioContent, { template: "registration" }>, box: Box, look: BrandLook, rtl: boolean): void {
  const copy = COPY[rtl ? "ar" : "en"];
  const accent = brightOnDark(look);
  const avail = box.bottom - box.top;
  const headSize = Math.min(120, Math.round(avail * 0.12));
  let y = paragraph(ctx, c.headline, box, box.top, { size: headSize, maxLines: 3, rtl, heavy: true, lineHeight: hasArabic(c.headline) ? 1.35 : 1.0 });
  const facts: Array<[string, string]> = [];
  if (c.ageGroups) facts.push([copy.ages, c.ageGroups]);
  if (c.startDate) facts.push([copy.starts, c.startDate]);
  if (c.priceJod !== null) facts.push([copy.price, c.priceJod === 0 ? copy.free : copy.jod(formatJod(c.priceJod))]);
  y += 30;
  const labelW = box.w * 0.3;
  for (const [label, value] of facts) {
    y += 84;
    const labelBox = rtl ? { x: box.x + box.w - labelW, w: labelW } : { x: box.x, w: labelW };
    const valueBox = rtl ? { x: box.x, w: box.w - labelW - 24 } : { x: box.x + labelW + 24, w: box.w - labelW - 24 };
    line(ctx, label, labelBox, y, { size: 36, min: 24, rtl, color: accent });
    line(ctx, value, valueBox, y, { size: 50, min: 28, rtl });
  }
  if (c.contact && box.bottom - y > 150) {
    const venue = safeColor(look.primaryColor, "#2FD8C4");
    const h = 120;
    const top = Math.min(box.bottom - h, y + 70);
    ctx.fillStyle = venue;
    roundRect(ctx, box.x, top, box.w, h, h / 2);
    ctx.fill();
    line(ctx, c.contact, { x: box.x + 40, w: box.w - 80 }, top + h / 2 + 18, { size: 54, min: 30, rtl, align: "center", color: inkOn(venue) });
  }
}

function drawAnnouncement(ctx: SKRSContext2D, c: Extract<StudioContent, { template: "announcement" }>, box: Box, rtl: boolean): void {
  const avail = box.bottom - box.top;
  const titleSize = Math.min(110, Math.round(avail * 0.11));
  let y = paragraph(ctx, c.title, box, box.top, { size: titleSize, maxLines: 3, rtl, heavy: true, lineHeight: hasArabic(c.title) ? 1.35 : 1.0 });
  if (c.body) {
    y += 30;
    const size = 44;
    const lh = size * (hasArabic(c.body) ? 1.45 : 1.15);
    paragraph(ctx, c.body, box, y, { size, maxLines: Math.max(1, Math.floor((box.bottom - y) / lh)), rtl, heavy: false, color: "rgba(242,244,248,0.9)" });
  }
}

export function kickerFor(content: StudioContent, locale: StudioLocale): string {
  const copy = COPY[locale];
  switch (content.template) {
    case "match": return copy.match;
    case "player": return copy.player;
    case "training": return copy.training;
    case "registration": return content.kind === "trial" ? copy.trial : copy.registration;
    default: return copy.announcement;
  }
}

/** The finished PNG. */
export function renderStudioPng(input: StudioRenderInput): Buffer {
  ensureBrandingFonts();
  const { w: W, h: H } = STUDIO_FORMATS[input.format];
  const scale = input.scale ?? 1;
  const canvas = createCanvas(Math.round(W * scale), Math.round(H * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const rtl = input.locale === "ar";

  drawBackground(ctx, W, H, input.look, input.background);
  const bandH = input.format === "story" ? 460 : input.format === "post" ? 380 : 330;
  drawHeader(ctx, W, bandH, input.look, rtl, kickerFor(input.content, input.locale));

  const pad = 72;
  const box: Box = {
    x: pad,
    w: W - pad * 2,
    // A story is tall: sit everything but the training list lower, nearer the middle.
    top: bandH + (input.format === "story" ? (input.content.template === "training" ? 120 : 280) : 80),
    bottom: H - (input.format === "story" ? 220 : 150),
  };
  const c = input.content;
  switch (c.template) {
    case "match": drawMatch(ctx, c, box, input.look, rtl); break;
    case "player": drawPlayer(ctx, c, box, input.look, rtl, input.photo); break;
    case "training": drawTraining(ctx, c, box, input.look, rtl); break;
    case "registration": drawRegistration(ctx, c, box, input.look, rtl); break;
    case "announcement": drawAnnouncement(ctx, c, box, rtl); break;
  }
  drawFooter(ctx, W, H, input.look, rtl, input.mark);
  return canvas.toBuffer("image/png");
}
