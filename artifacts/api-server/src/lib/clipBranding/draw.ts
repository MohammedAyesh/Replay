import type { Image, SKRSContext2D } from "@napi-rs/canvas";
import QRCode from "qrcode";
import { FONT } from "./assets";
import type { BrandLook } from "./types";

/**
 * Drawing primitives shared by the overlays and the end screens.
 *
 * Everything is laid out in design units — 1080 wide for portrait, 1920 wide
 * for landscape — and the caller scales the context to the real export size
 * (608×1080 portrait today). That keeps every coordinate here comparable with
 * the approved concept boards.
 */

export const VOID = "#0B0F1A";
export const TEXT = "#F2F4F8";
export const FLOODLIGHT = "#D4FF4F";

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);
/** 0 before `start`, 1 after `start + dur`, eased in between. */
export const phase = (t: number, start: number, dur: number) => easeOut((t - start) / dur);

export function parseHex(hex: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function safeColor(hex: string | null | undefined, fallback: string): string {
  return parseHex(hex) ? `#${/^#?([0-9a-f]{6})$/i.exec(hex!)![1].toUpperCase()}` : fallback;
}

export function rgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? [47, 216, 196];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** Void on a light venue colour, white on a dark one — whichever reads. */
export function inkOn(hex: string): string {
  return luminance(hex) > 0.22 ? VOID : "#FFFFFF";
}

function luminance(hex: string): number {
  const rgb = parseHex(hex) ?? [47, 216, 196];
  const lin = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * A venue colour that reads on dark footage: the accent if the primary is too
 * dark (JUFA's navy is unreadable as text on a night pitch), else the primary
 * lightened toward white.
 */
export function brightOnDark(look: { primaryColor: string; accentColor: string | null }): string {
  for (const candidate of [look.primaryColor, look.accentColor]) {
    if (parseHex(candidate) && luminance(candidate!) >= 0.16) return safeColor(candidate, "#2FD8C4");
  }
  const rgb = parseHex(look.primaryColor) ?? [47, 216, 196];
  const mix = rgb.map((c) => Math.round(c + (255 - c) * 0.55));
  return `#${mix.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** An up or down triangle (Rajdhani has no glyph for ▲ ▼), centred on (cx, cy). */
export function drawTriangle(ctx: SKRSContext2D, cx: number, cy: number, size: number, up: boolean, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(cx, cy - size / 2);
    ctx.lineTo(cx + size / 2, cy + size / 2);
    ctx.lineTo(cx - size / 2, cy + size / 2);
  } else {
    ctx.moveTo(cx - size / 2, cy - size / 2);
    ctx.lineTo(cx + size / 2, cy - size / 2);
    ctx.lineTo(cx, cy + size / 2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "R";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Latin display text (Rajdhani). */
export function latin(ctx: SKRSContext2D, size: number, weight: 600 | 700 = 700): void {
  ctx.font = `${weight} ${size}px ${weight === 700 ? FONT.display : FONT.displaySemi}`;
  ctx.direction = "ltr";
}

/** Arabic text (Cairo), shaped right-to-left. */
export function arabic(ctx: SKRSContext2D, size: number, weight: 700 | 900 = 700): void {
  ctx.font = `${weight} ${size}px ${weight === 900 ? FONT.arabicBlack : FONT.arabicBold}`;
  ctx.direction = "rtl";
}

/** The largest size ≤ max at which `text` fits in `width`, in the current family. */
export function fitSize(
  ctx: SKRSContext2D,
  text: string,
  width: number,
  max: number,
  min: number,
  setFont: (size: number) => void,
): number {
  let size = max;
  while (size > min) {
    setFont(size);
    if (ctx.measureText(text).width <= width) return size;
    size -= 2;
  }
  setFont(min);
  return min;
}

/** Split a venue name into at most two stacked lines, balancing their widths. */
export function stackName(name: string): string[] {
  const words = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words.length ? words : [""];
  let best: string[] = [name.toUpperCase()];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) { bestDiff = diff; best = [a, b]; }
  }
  return best;
}

/**
 * The venue's crest, contained in a size×size box centred on (cx, cy). With no
 * uploaded crest, an initials badge in the venue colour — a shield for an
 * academy, a ring for a field.
 */
export function drawCrest(
  ctx: SKRSContext2D,
  look: BrandLook,
  cx: number,
  cy: number,
  size: number,
  opts: { onBand?: boolean } = {},
): void {
  if (look.crest) {
    const img = look.crest as Image;
    const k = Math.min(size / img.width, size / img.height);
    const w = img.width * k;
    const h = img.height * k;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = size * 0.06;
    ctx.shadowOffsetY = size * 0.02;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
    return;
  }
  const venue = safeColor(look.primaryColor, "#2FD8C4");
  const r = size / 2;
  ctx.save();
  if (look.isAcademy) {
    const top = cy - r;
    const w = size * 0.86;
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx + w / 2, top + size * 0.12);
    ctx.lineTo(cx + w / 2, top + size * 0.5);
    ctx.bezierCurveTo(cx + w / 2, top + size * 0.78, cx + w * 0.22, top + size * 0.93, cx, cy + r);
    ctx.bezierCurveTo(cx - w * 0.22, top + size * 0.93, cx - w / 2, top + size * 0.78, cx - w / 2, top + size * 0.5);
    ctx.lineTo(cx - w / 2, top + size * 0.12);
    ctx.closePath();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = VOID;
  ctx.fill();
  ctx.lineWidth = size * (opts.onBand ? 0.0 : 0.05);
  if (!opts.onBand) {
    ctx.strokeStyle = venue;
    ctx.stroke();
  }
  ctx.fillStyle = venue;
  latin(ctx, size * 0.36);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials(look.nameEn), cx, cy + size * 0.02);
  ctx.restore();
}

/** A left-pointing arrow — "go on" in a right-to-left line. Cairo has no glyph for it. */
export function drawArrowLeft(ctx: SKRSContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x + size, y);
  ctx.lineTo(x, y);
  ctx.moveTo(x + size * 0.42, y - size * 0.42);
  ctx.lineTo(x, y);
  ctx.lineTo(x + size * 0.42, y + size * 0.42);
  ctx.stroke();
  ctx.restore();
}

const qrCache = new Map<string, { size: number; data: Uint8Array }>();

function qrModules(text: string): { size: number; data: Uint8Array } {
  let hit = qrCache.get(text);
  if (!hit) {
    // Level L: the fewest modules, so each is as large as possible on a 608 px
    // wide export. The tile is drawn flat on white, so damage is not the risk.
    const code = QRCode.create(text, { errorCorrectionLevel: "L" });
    hit = { size: code.modules.size, data: code.modules.data as unknown as Uint8Array };
    if (qrCache.size > 200) qrCache.clear();
    qrCache.set(text, hit);
  }
  return hit;
}

/** A real, scannable QR code on a white tile. */
export function drawQr(ctx: SKRSContext2D, text: string, x: number, y: number, size: number): void {
  const { size: n, data } = qrModules(text);
  // A quiet zone of ~2 modules: scanners need the white margin.
  const pad = size * 0.11;
  ctx.save();
  ctx.fillStyle = "#FFFFFF";
  roundRect(ctx, x, y, size, size, size * 0.05);
  ctx.fill();
  const cell = (size - pad * 2) / n;
  ctx.fillStyle = VOID;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (data[r * n + c]) {
        ctx.fillRect(x + pad + c * cell, y + pad + r * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
  ctx.restore();
}

export function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** The Replay mark and a short line, bottom-left, at ~70%: the only quiet element. */
export function drawWatermark(
  ctx: SKRSContext2D,
  mark: Image | null,
  x: number,
  baselineY: number,
  height: number,
  label: string,
): void {
  ctx.save();
  ctx.globalAlpha *= 0.72;
  let textX = x;
  if (mark) {
    const w = (mark.width / mark.height) * height;
    ctx.drawImage(mark, x, baselineY - height * 0.8, w, height);
    textX = x + w + height * 0.25;
  }
  ctx.fillStyle = TEXT;
  latin(ctx, height * 0.58);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, textX, baselineY);
  ctx.restore();
}

/** Text with a soft shadow so it reads over moving, blurred footage. */
export function shadowed(ctx: SKRSContext2D, draw: () => void, blur = 18): void {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = 3;
  draw();
  ctx.restore();
}

export function formatNumber(value: number, decimals: number): string {
  return value.toFixed(decimals);
}
