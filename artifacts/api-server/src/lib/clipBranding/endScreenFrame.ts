import type { Image, SKRSContext2D } from "@napi-rs/canvas";
import {
  FLOODLIGHT,
  TEXT,
  VOID,
  arabic,
  brightOnDark,
  drawArrowLeft,
  drawCrest,
  drawQr,
  drawTriangle,
  drawWatermark,
  fitSize,
  formatNumber,
  inkOn,
  latin,
  phase,
  roundRect,
  safeColor,
  shadowed,
  stackName,
} from "./draw";
import type { EndScreen, StatLine } from "./types";

/**
 * One frame of an end screen, drawn over the (already blurred) clip.
 *
 * Coordinates are design units: 1080×1920 portrait, 1920×1080 landscape. The
 * caller scales the context. `t` is seconds since the end screen began.
 *
 * Timeline at the default 3 s (shorter screens run the same beats faster):
 *   0.00–0.40  the footage darkens (the blur itself is ffmpeg's)
 *   0.35–0.70  the venue colour wipes in, angled edge first
 *   0.60–1.00  crest punches in, name drops in
 *   0.90–1.20  player / score
 *   1.05–1.75  stat rows, 100 ms apart, numbers counting up
 *   1.75–2.05  call to action and QR, then everything holds
 * Straight cuts and fast ease-outs only: nothing bounces or floats.
 */
export type FrameOptions = {
  portrait: boolean;
  /** Seconds the end screen lasts. */
  total: number;
  /** 0–1: how dark the footage goes under the card. */
  dim: number;
  mark: Image | null;
};

const BAND_H: Record<EndScreen["kind"], number> = { player: 780, academy: 780, match: 600, signOff: 1180 };
const BAND_W = 760;

export function drawEndScreenFrame(ctx: SKRSContext2D, spec: EndScreen, t: number, opts: FrameOptions): void {
  const k = Math.min(1, Math.max(0.5, opts.total / 3));
  const tt = t / k;
  const DW = opts.portrait ? 1080 : 1920;
  const DH = opts.portrait ? 1920 : 1080;

  // 1. Darken the footage.
  const dimNow = opts.dim * phase(tt, 0, 0.4);
  if (dimNow > 0) {
    ctx.fillStyle = `rgba(11,15,26,${dimNow})`;
    ctx.fillRect(0, 0, DW, DH);
    // A touch more at the bottom, where the call to action sits.
    const grad = ctx.createLinearGradient(0, DH * 0.55, 0, DH);
    grad.addColorStop(0, "rgba(11,15,26,0)");
    grad.addColorStop(1, `rgba(11,15,26,${Math.min(0.35, dimNow * 0.6)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, DW, DH);
  }

  // 2. The venue band.
  const wipe = phase(tt, 0.35, 0.35);
  if (wipe > 0) drawBand(ctx, spec, tt, wipe, opts.portrait);

  // 3. The content under (portrait) or beside (landscape) the band.
  drawContent(ctx, spec, tt, opts.portrait);

  // 4. Call to action.
  drawCta(ctx, spec, tt, opts.portrait);

  // 5. Watermark: there from the start, it is the platform's mark not the venue's.
  if (opts.portrait) drawWatermark(ctx, opts.mark, 64, DH - 140, 44, "Filmed by Replay");
  else drawWatermark(ctx, opts.mark, DW - 360, DH - 40, 38, "Filmed by Replay");
}

function drawBand(ctx: SKRSContext2D, spec: EndScreen, tt: number, wipe: number, portrait: boolean): void {
  const look = spec.look;
  const venue = safeColor(look.primaryColor, "#2FD8C4");
  const ink = inkOn(venue);
  ctx.save();
  if (portrait) {
    const H = BAND_H[spec.kind];
    ctx.translate(0, -(1 - wipe) * H);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(1080, 0);
    ctx.lineTo(1080, H - 120);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = venue;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ringWatermark(ctx, ink, spec.kind === "signOff" ? 540 : 900, spec.kind === "signOff" ? 900 : 250, spec.kind === "signOff" ? 760 : 430);
    ctx.restore();
  } else {
    ctx.translate(-(1 - wipe) * BAND_W, 0);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(BAND_W, 0);
    ctx.lineTo(BAND_W - 120, 1080);
    ctx.lineTo(0, 1080);
    ctx.closePath();
    ctx.fillStyle = venue;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ringWatermark(ctx, ink, 120, 900, 520);
    ctx.restore();
  }

  const crestIn = phase(tt, 0.6, 0.3);
  const nameIn = phase(tt, 0.7, 0.3);
  const lines = stackName(look.nameEn);

  if (portrait && spec.kind === "signOff") {
    const size = 320;
    drawCrestAnimated(ctx, spec, 540, 250 + size / 2, size, crestIn);
    ctx.globalAlpha = nameIn;
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    let y = 250 + size + 40 + (1 - nameIn) * 20;
    const nameSize = Math.min(...lines.map((l) => fitSize(ctx, l, 940, 176, 80, (sz) => latin(ctx, sz))));
    latin(ctx, nameSize);
    for (const line of lines) { y += nameSize * 0.8; ctx.fillText(line, 540, y); }
    if (look.taglineAr) {
      const sz = fitSize(ctx, look.taglineAr, 940, 64, 36, (v) => arabic(ctx, v, 900));
      arabic(ctx, sz, 900);
      ctx.textAlign = "center";
      y += sz * 1.45;
      ctx.fillText(look.taglineAr, 540, y);
    } else if (look.nameAr) {
      const sz = fitSize(ctx, look.nameAr, 940, 56, 32, (v) => arabic(ctx, v, 900));
      arabic(ctx, sz, 900);
      ctx.textAlign = "center";
      y += sz * 1.45;
      ctx.fillText(look.nameAr, 540, y);
    }
    if (spec.dateLabel) {
      latin(ctx, 28);
      ctx.globalAlpha = nameIn * 0.75;
      y += 52;
      ctx.fillText(spec.dateLabel, 540, y);
    }
    ctx.restore();
    return;
  }

  if (portrait) {
    const crestSize = spec.kind === "match" ? 190 : 230;
    const crestTop = 244;
    drawCrestAnimated(ctx, spec, 64 + crestSize / 2, crestTop + crestSize / 2, crestSize, crestIn);
    const textX = 64 + crestSize + 34;
    const maxW = 1080 - textX - 110;
    ctx.globalAlpha = nameIn;
    ctx.fillStyle = ink;
    ctx.textAlign = "left";
    const nameSize = Math.min(...lines.map((l) => fitSize(ctx, l, maxW, spec.kind === "match" ? 112 : 128, 56, (sz) => latin(ctx, sz))));
    latin(ctx, nameSize);
    let y = crestTop + 8 + (1 - nameIn) * 20;
    for (const line of lines) { y += nameSize * 0.8; ctx.fillText(line, textX, y); }
    if (look.nameAr) {
      const sz = fitSize(ctx, look.nameAr, maxW, 44, 28, (v) => arabic(ctx, v, 900));
      arabic(ctx, sz, 900);
      ctx.textAlign = "left";
      y += sz * 1.35;
      ctx.fillText(look.nameAr, textX, y);
    }
    if (spec.dateLabel) {
      latin(ctx, 28);
      ctx.textAlign = "left";
      ctx.globalAlpha = nameIn * 0.75;
      y += 46;
      ctx.fillText(spec.dateLabel, textX, y);
    }
    ctx.globalAlpha = 1;
    // A Void tag under the crest: the academy's age group.
    if (spec.kind === "academy" && spec.ageGroup) {
      latin(ctx, 34);
      const tw = ctx.measureText(spec.ageGroup).width + 48;
      ctx.globalAlpha = nameIn;
      ctx.fillStyle = VOID;
      ctx.fillRect(64, 520, tw, 64);
      ctx.fillStyle = brightOnDark(look);
      ctx.textBaseline = "middle";
      ctx.fillText(spec.ageGroup, 88, 553);
      ctx.textBaseline = "alphabetic";
    }
    ctx.restore();
    return;
  }

  // Landscape: crest on top, name stacked under it, all centred in the band.
  const cx = (BAND_W - 60) / 2;
  const crestSize = 300;
  drawCrestAnimated(ctx, spec, cx, 110 + crestSize / 2, crestSize, crestIn);
  ctx.globalAlpha = nameIn;
  ctx.fillStyle = ink;
  ctx.textAlign = "center";
  const nameSize = Math.min(...lines.map((l) => fitSize(ctx, l, 600, 112, 56, (sz) => latin(ctx, sz))));
  latin(ctx, nameSize);
  let y = 110 + crestSize + 30 + (1 - nameIn) * 20;
  for (const line of lines) { y += nameSize * 0.8; ctx.fillText(line, cx, y); }
  const subAr = spec.kind === "signOff" ? (look.taglineAr ?? look.nameAr) : look.nameAr;
  if (subAr) {
    const sz = fitSize(ctx, subAr, 600, 44, 26, (v) => arabic(ctx, v, 900));
    arabic(ctx, sz, 900);
    ctx.textAlign = "center";
    y += sz * 1.4;
    ctx.fillText(subAr, cx, y);
  }
  if (spec.dateLabel) {
    latin(ctx, 26);
    ctx.globalAlpha = nameIn * 0.75;
    y += 44;
    ctx.fillText(spec.dateLabel, cx, y);
  }
  if (spec.kind === "academy" && spec.ageGroup) {
    ctx.globalAlpha = nameIn;
    latin(ctx, 30);
    const tw = ctx.measureText(spec.ageGroup).width + 40;
    ctx.fillStyle = VOID;
    ctx.fillRect(cx - tw / 2, y + 30, tw, 56);
    ctx.fillStyle = brightOnDark(look);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(spec.ageGroup, cx, y + 59);
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

function ringWatermark(ctx: SKRSContext2D, ink: string, cx: number, cy: number, r: number): void {
  ctx.strokeStyle = ink === VOID ? "rgba(11,15,26,0.07)" : "rgba(255,255,255,0.08)";
  ctx.lineWidth = r * 0.16;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawCrestAnimated(ctx: SKRSContext2D, spec: EndScreen, cx: number, cy: number, size: number, p: number): void {
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha = p;
  const scale = 1.12 - 0.12 * p;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  drawCrest(ctx, spec.look, 0, 0, size, { onBand: true });
  ctx.restore();
}

function drawContent(ctx: SKRSContext2D, spec: EndScreen, tt: number, portrait: boolean): void {
  const left = portrait ? 64 : 820;
  const width = portrait ? 896 : 1040;
  // Anything in the venue colour below the band sits on dark footage.
  const venue = brightOnDark(spec.look);
  const head = phase(tt, 0.9, 0.3);

  if (spec.kind === "signOff") {
    const top = portrait ? 1196 : 300;
    if (!portrait) {
      // Landscape has room the band does not use: the tagline, large.
      const line = spec.look.taglineAr ?? "كل ماتش هون متصوّر";
      ctx.save();
      ctx.globalAlpha = head;
      ctx.fillStyle = TEXT;
      const sz = fitSize(ctx, line, width, 96, 48, (v) => arabic(ctx, v, 900));
      arabic(ctx, sz, 900);
      ctx.textAlign = "right";
      shadowed(ctx, () => ctx.fillText(line, left + width, 220));
      ctx.restore();
    }
    drawContactLine(ctx, spec, left, width, portrait ? top + 56 : top + 160, head);
    return;
  }

  if (spec.kind === "match") {
    drawScore(ctx, spec, left, width, portrait ? 640 : 140, head, portrait);
    return;
  }

  // Player and academy: the big line, then the stat sheet.
  const top = portrait ? 800 : 120;
  ctx.save();
  ctx.globalAlpha = head;
  ctx.fillStyle = TEXT;
  ctx.textAlign = "left";
  const big = spec.player.big;
  const bigSize = fitSize(ctx, big, width * 0.55, 210, 90, (v) => latin(ctx, v));
  latin(ctx, bigSize);
  const bigW = ctx.measureText(big).width;
  const baseline = top + bigSize * 0.78 + (1 - head) * 16;
  shadowed(ctx, () => ctx.fillText(big, left, baseline));
  const subX = left + bigW + 28;
  const subW = left + width - subX;
  let y = baseline - 6;
  const award = spec.kind === "player" ? spec.player.awardAr : null;
  if (award) {
    const sz = fitSize(ctx, award, subW, 40, 24, (v) => arabic(ctx, v, 900));
    arabic(ctx, sz, 900);
    ctx.textAlign = "left";
    shadowed(ctx, () => ctx.fillText(award, subX, y));
    y -= sz * 1.35;
  }
  if (spec.player.sub) {
    const sub = spec.player.sub;
    const isArabic = /[؀-ۿ]/.test(sub);
    if (isArabic) arabic(ctx, fitSize(ctx, sub, subW, 34, 22, (v) => arabic(ctx, v)), 700);
    else latin(ctx, fitSize(ctx, sub.toUpperCase(), subW, 34, 20, (v) => latin(ctx, v)));
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(242,244,248,0.75)";
    shadowed(ctx, () => ctx.fillText(isArabic ? sub : sub.toUpperCase(), subX, y));
  }
  ctx.restore();

  const stats = spec.stats;
  if (!stats.length) return;
  const sheetTop = portrait ? (spec.kind === "academy" ? 1046 : 1010) : 380;
  const rowH = portrait ? 72 : 88;
  if (spec.kind === "academy") {
    ctx.save();
    ctx.globalAlpha = head;
    arabic(ctx, 26);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(242,244,248,0.7)";
    ctx.fillText("مقارنة بآخر ٥ مرات", left + width, sheetTop - 16);
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = phase(tt, 1.0, 0.2);
  ctx.fillStyle = "rgba(242,244,248,0.9)";
  ctx.fillRect(left, sheetTop, width, 2);
  ctx.restore();
  stats.slice(0, 4).forEach((line, i) => {
    drawStatRow(ctx, line, i, left, width, sheetTop + 2 + i * rowH, rowH, tt, venue, portrait);
  });
}

function drawStatRow(
  ctx: SKRSContext2D,
  line: StatLine,
  i: number,
  left: number,
  width: number,
  top: number,
  rowH: number,
  tt: number,
  venue: string,
  portrait: boolean,
): void {
  const start = 1.05 + i * 0.1;
  const p = phase(tt, start, 0.3);
  if (p <= 0) return;
  const count = phase(tt, start, 0.6);
  ctx.save();
  ctx.globalAlpha = p;
  ctx.translate((1 - p) * -24, 0);
  ctx.fillStyle = "rgba(242,244,248,0.22)";
  ctx.fillRect(left, top + rowH - 1, width, 1);

  const mid = top + rowH / 2;
  const valueSize = portrait ? 64 : 72;
  const valueColor = line.best ? venue : TEXT;
  latin(ctx, valueSize);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const text = formatNumber(line.value * count, line.decimals);
  ctx.fillStyle = valueColor;
  shadowed(ctx, () => ctx.fillText(text, left, mid + 4), 10);
  let x = left + ctx.measureText(formatNumber(line.value, line.decimals)).width + 12;
  if (line.unit) {
    latin(ctx, valueSize * 0.44, 600);
    ctx.fillStyle = "rgba(242,244,248,0.65)";
    ctx.fillText(line.unit, x, mid + 10);
    x += ctx.measureText(line.unit).width + 16;
  }
  if (line.best) {
    arabic(ctx, portrait ? 22 : 24, 900);
    const tag = "أحسن رقم إلك";
    const tw = ctx.measureText(tag).width + 24;
    ctx.fillStyle = venue;
    ctx.fillRect(x, mid - 18, tw, 36);
    ctx.fillStyle = inkOn(venue);
    ctx.textAlign = "left";
    ctx.fillText(tag, x + 12, mid + 2);
  }
  if (line.delta) {
    const color = line.delta.up ? venue : "rgba(242,244,248,0.6)";
    const size = portrait ? 32 : 34;
    latin(ctx, size);
    ctx.textAlign = "left";
    const x0 = left + width * 0.5;
    drawTriangle(ctx, x0, mid, size * 0.5, line.delta.up, color);
    ctx.fillStyle = color;
    ctx.fillText(line.delta.text, x0 + size * 0.5, mid + 4);
  }
  arabic(ctx, portrait ? 34 : 36, 700);
  ctx.textAlign = "right";
  ctx.fillStyle = TEXT;
  shadowed(ctx, () => ctx.fillText(line.labelAr, left + width, mid + 2), 10);
  ctx.restore();
}

function drawScore(
  ctx: SKRSContext2D,
  spec: Extract<EndScreen, { kind: "match" }>,
  left: number,
  width: number,
  top: number,
  p: number,
  portrait: boolean,
): void {
  const { score } = spec;
  ctx.save();
  ctx.globalAlpha = p;
  const center = left + width / 2;
  const bigSize = portrait ? 260 : 280;
  latin(ctx, bigSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const baseline = top + bigSize * 0.78 + 20;
  ctx.fillStyle = TEXT;
  shadowed(ctx, () => {
    const dash = " – ";
    const a = String(score.a);
    const b = String(score.b);
    const wa = ctx.measureText(a).width;
    const wd = ctx.measureText(dash).width;
    const wb = ctx.measureText(b).width;
    const x0 = center - (wa + wd + wb) / 2;
    ctx.textAlign = "left";
    ctx.fillStyle = score.a >= score.b ? TEXT : "rgba(242,244,248,0.6)";
    ctx.fillText(a, x0, baseline);
    ctx.fillStyle = "rgba(242,244,248,0.45)";
    ctx.fillText(dash, x0 + wa, baseline);
    ctx.fillStyle = score.b >= score.a ? TEXT : "rgba(242,244,248,0.6)";
    ctx.fillText(b, x0 + wa + wd, baseline);
  }, 30);

  // Team names with kit swatches, under the score, one each side.
  const rowY = baseline + (portrait ? 80 : 90);
  for (const side of ["a", "b"] as const) {
    const name = (side === "a" ? score.aName : score.bName).toUpperCase();
    const color = side === "a" ? score.aColor : score.bColor;
    const goals = side === "a" ? score.aGoals : score.bGoals;
    latin(ctx, 36);
    const tw = ctx.measureText(name).width;
    const swatch = 30;
    const block = swatch + 14 + tw;
    const x = side === "a" ? center - 60 - block : center + 60;
    ctx.fillStyle = safeColor(color, "#F2F4F8");
    ctx.fillRect(x, rowY - swatch + 4, swatch, swatch);
    ctx.fillStyle = TEXT;
    ctx.textAlign = "left";
    ctx.fillText(name, x + swatch + 14, rowY + 2);
    if (goals && goals.length) {
      latin(ctx, 28, 600);
      ctx.fillStyle = "rgba(242,244,248,0.7)";
      const text = goals.map((m) => `${m}'`).join("  ");
      ctx.textAlign = side === "a" ? "right" : "left";
      ctx.fillText(text, side === "a" ? x + block : x, rowY + 48);
    }
  }

  arabic(ctx, 36, 900);
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(242,244,248,0.8)";
  ctx.fillText("نهاية الماتش", center, rowY + (portrait ? 130 : 120));

  if (spec.motm) {
    const y = rowY + (portrait ? 230 : 200);
    ctx.fillStyle = "rgba(242,244,248,0.22)";
    ctx.fillRect(left, y - 50, width, 1);
    latin(ctx, 40);
    ctx.textAlign = "left";
    ctx.fillStyle = TEXT;
    ctx.fillText(spec.motm.toUpperCase(), left, y + 6);
    arabic(ctx, 34, 900);
    ctx.textAlign = "right";
    ctx.fillStyle = brightOnDark(spec.look);
    ctx.fillText("نجم الماتش", left + width, y + 4);
  }
  ctx.restore();
}

function drawContactLine(
  ctx: SKRSContext2D,
  spec: EndScreen,
  left: number,
  width: number,
  y: number,
  p: number,
): void {
  const look = spec.look;
  const contact = look.bookingPhone ?? (look.instagram ? `@${look.instagram.replace(/^@/, "")}` : null);
  if (!contact) return;
  ctx.save();
  ctx.globalAlpha = p;
  latin(ctx, 46);
  ctx.textAlign = "left";
  ctx.fillStyle = TEXT;
  shadowed(ctx, () => ctx.fillText(contact, left, y));
  arabic(ctx, 40, 900);
  ctx.textAlign = "right";
  shadowed(ctx, () => ctx.fillText(look.isAcademy ? "للتسجيل" : "احجز ملعبك", left + width, y));
  ctx.restore();
}

function drawCta(ctx: SKRSContext2D, spec: EndScreen, tt: number, portrait: boolean): void {
  const p = phase(tt, 1.75, 0.3);
  if (p <= 0) return;
  const x = portrait ? 64 : 820;
  const w = portrait ? 896 : 1040;
  const h = portrait ? 150 : 140;
  const y = (portrait ? 1340 : 860) + (1 - p) * 40;
  // The QR is taller than the bar on portrait, where the export is only 608 px
  // wide: at 210 design units it is ~118 px, about 3.5 px per module.
  const qrSize = portrait ? 210 : 140;
  const label =
    // The QR opens this clip's share card, so the line promises only that.
    spec.kind === "academy" ? "للأهل: شوفوا الكليب" : "شوف الكليب";
  ctx.save();
  ctx.globalAlpha = p;
  const qr = qrSize;
  const barW = w - qr - 16;
  ctx.fillStyle = FLOODLIGHT;
  roundRect(ctx, x, y, barW, h, 6);
  ctx.fill();
  ctx.fillStyle = VOID;
  latin(ctx, 30);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("replayjo.com", x + 36, y + h / 2 + 2);
  const labelSize = fitSize(ctx, label, barW - 300, 52, 30, (v) => arabic(ctx, v, 900));
  arabic(ctx, labelSize, 900);
  ctx.textAlign = "right";
  const labelRight = x + barW - 36;
  ctx.fillText(label, labelRight, y + h / 2 + 2);
  // The arrow sits after the words, i.e. to their left in a right-to-left line.
  const lw = ctx.measureText(label).width;
  drawArrowLeft(ctx, labelRight - lw - 54, y + h / 2 + 2, 36, VOID);
  ctx.textBaseline = "alphabetic";
  // Top-aligned with the bar, so a taller QR grows into the empty space below.
  drawQr(ctx, spec.link, x + barW + 16, y, qr);
  ctx.restore();
}
