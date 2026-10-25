import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { ensureBrandingFonts } from "./assets";
import {
  VOID,
  arabic,
  brightOnDark,
  drawCrest,
  drawWatermark,
  fitSize,
  inkOn,
  latin,
  safeColor,
} from "./draw";
import type { BrandLook, Dims, OverlayStyle } from "./types";

/**
 * The venue's mark during the clip, as one transparent PNG at the export size.
 *
 * It goes through exactly the path an uploaded overlay goes through — composited
 * at 0,0 in the main encode — so it costs nothing extra and inherits that path's
 * "branding never costs a clip" handling.
 *
 * Laid out in design units (1080×1920 portrait, 1920×1080 landscape). The crest
 * sits in the top-left corner (Mohammed, 2026-10-25), which on Reels and TikTok
 * is under their top bar; the watermark stays out of the bottom caption zone.
 */
export type OverlayInput = {
  style: Exclude<OverlayStyle, "uploaded">;
  look: BrandLook;
  dims: Dims;
  /** Shown by the name bar: "SAT 24 OCT · 22:00". */
  dateLabel?: string | null;
  /** Shown by the academy frame: the squad's age group. */
  tag?: string | null;
  mark?: import("@napi-rs/canvas").Image | null;
};

export function renderOverlayPng(input: OverlayInput): Buffer {
  ensureBrandingFonts();
  const { w, h } = input.dims;
  const portrait = h > w;
  const designW = portrait ? 1080 : 1920;
  const s = w / designW;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.scale(s, s);
  const DH = h / s;
  const venue = safeColor(input.look.primaryColor, "#2FD8C4");

  const top = portrait ? 40 : 36;
  const left = portrait ? 40 : 44;
  const crest = portrait ? 170 : 130;

  if (input.style === "academyFrame") {
    // A full-height stripe in the academy's colour down the left edge.
    ctx.fillStyle = safeColor(input.look.accentColor, venue);
    ctx.fillRect(0, 0, portrait ? 18 : 14, DH);
  }

  const tabHeight = portrait ? 110 : 82;
  const nameTop = top + (crest - tabHeight) / 2;
  const tabX = left + crest * 0.62;
  // The Arabic name rides under the English one, except on the name bar,
  // where the date strip takes that place.
  const tagLine = input.style === "broadcastBar" ? null : input.look.nameAr;
  drawNameTab(ctx, input.look, tabX, nameTop, tabHeight, crest * 0.5, portrait ? 640 : 760, tagLine);

  if (input.style === "broadcastBar" && input.dateLabel) {
    // The date strip hangs under the tab: a plain Void block, venue-coloured type.
    latin(ctx, portrait ? 30 : 24);
    const text = input.dateLabel;
    const pad = portrait ? 22 : 18;
    const tw = ctx.measureText(text).width + pad * 2;
    const y = nameTop + tabHeight;
    ctx.fillStyle = VOID;
    ctx.fillRect(tabX + crest * 0.5, y, tw, portrait ? 52 : 40);
    ctx.fillStyle = brightOnDark(input.look);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, tabX + crest * 0.5 + pad, y + (portrait ? 27 : 21));
  }

  const onDark = brightOnDark(input.look);
  if (input.style === "academyFrame" && input.tag) {
    latin(ctx, portrait ? 30 : 24);
    const pad = portrait ? 20 : 16;
    const tw = ctx.measureText(input.tag).width + pad * 2;
    const y = top + crest + (portrait ? 18 : 12);
    ctx.fillStyle = VOID;
    ctx.fillRect(left + crest * 0.7, y, tw, portrait ? 50 : 40);
    ctx.fillStyle = onDark;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(input.tag, left + crest * 0.7 + pad, y + (portrait ? 26 : 21));
  }

  drawCrest(ctx, input.look, left + crest / 2, top + crest / 2, crest);

  const markH = portrait ? 44 : 38;
  drawWatermark(
    ctx,
    input.mark ?? null,
    portrait ? 56 : designW - 300,
    portrait ? DH - 140 : DH - 40,
    markH,
    "replayjo.com",
  );

  return canvas.toBuffer("image/png");
}

/**
 * The solid tab carrying the venue's name, attached to the crest's right side
 * with a 30-unit angled end. `indent` is how far the text starts in, past the
 * part of the tab the crest covers.
 */
function drawNameTab(
  ctx: SKRSContext2D,
  look: BrandLook,
  x: number,
  y: number,
  height: number,
  indent: number,
  maxWidth: number,
  subAr: string | null,
): void {
  const venue = safeColor(look.primaryColor, "#2FD8C4");
  const ink = inkOn(venue);
  const name = look.nameEn.toUpperCase();
  const mainSize = fitSize(ctx, name, maxWidth - indent - 70, height * 0.53, height * 0.3, (sz) => latin(ctx, sz));
  const nameWidth = ctx.measureText(name).width;
  let subWidth = 0;
  let subSize = height * 0.26;
  if (subAr) {
    subSize = fitSize(ctx, subAr, maxWidth - indent - 70, height * 0.27, height * 0.18, (sz) => arabic(ctx, sz, 900));
    subWidth = ctx.measureText(subAr).width;
  }
  const width = indent + Math.max(nameWidth, subWidth) + 70;

  ctx.save();
  ctx.fillStyle = venue;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width - 30, y + height);
  ctx.lineTo(x, y + height);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  latin(ctx, mainSize);
  const nameY = subAr ? y + height * 0.55 : y + height * 0.5 + mainSize * 0.34;
  ctx.fillText(name, x + indent, nameY);
  if (subAr) {
    arabic(ctx, subSize, 900);
    ctx.textAlign = "left";
    ctx.fillText(subAr, x + indent, y + height * 0.88);
  }
  ctx.restore();
}
