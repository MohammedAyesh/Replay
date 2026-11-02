import type { Content } from "./content";
import { ellipse, video, type Box, type Ctx, type Timing } from "./kit";

/** Something to place in a vertical stack: its height, the gap after it and how to draw it at y. */
export type StackItem = { h: number; gap?: number; draw: (y: number) => void } | null | undefined | false | "" | 0;

const real = (items: StackItem[]) => items.filter((i): i is Exclude<StackItem, null | undefined | false | "" | 0> => !!i);

/** Draws items top-down from y; returns the y under the last one. */
export function stackDown(y: number, items: StackItem[]): number {
  let cur = y;
  const list = real(items);
  list.forEach((item, i) => {
    item.draw(cur);
    cur += item.h + (i < list.length - 1 ? item.gap ?? 0 : 0);
  });
  return cur;
}

/** Draws items so the last one ends at `bottom`; returns the top y. */
export function stackUp(bottom: number, items: StackItem[]): number {
  const list = real(items);
  const total = list.reduce((sum, item, i) => sum + item.h + (i < list.length - 1 ? item.gap ?? 0 : 0), 0);
  stackDown(bottom - total, list);
  return bottom - total;
}

/** True when a content slot has something to show. */
export const has = (s: string | undefined): s is string => typeof s === "string" && s.trim().length > 0;

/** A map pin: a ring and a dot. */
export function pin(c: Ctx, cx: number, cy: number, color: string, ring = "#FFFFFF") {
  ellipse(c, "pin-ring", { x: cx - 46, y: cy - 46, w: 92, h: 92 }, { fill: color, opacity: 0.28, mirror: false });
  ellipse(c, "pin", { x: cx - 24, y: cy - 24, w: 48, h: 48 }, { fill: color, stroke: { color: ring, width: 6 }, mirror: false });
}

// ── Video ───────────────────────────────────────────────────────────────────

export const END_CARD_MS = 2500;

/**
 * How a style dresses a video. The composer below decides what appears when;
 * each style decides what it looks like.
 */
export type VideoSkin = {
  /** Gradients over the footage, for the whole clip. */
  shade: (c: Ctx) => void;
  /** Crest and name in a corner until the end card. */
  frame: (c: Ctx, k: Content, t: Timing) => void;
  /** A short label (GOAL, TRAINING, COACH'S CORNER). */
  tag: (c: Ctx, k: Content, t: Timing) => void;
  /** Scorer's number and the scoreline. */
  goal: (c: Ctx, k: Content, t: Timing) => void;
  /** Lower third with a speaker's name and role. */
  speaker: (c: Ctx, k: Content, t: Timing) => void;
  /** Title card: headline and meta. */
  title: (c: Ctx, k: Content, t: Timing) => void;
  /** One subtitle line. */
  caption: (c: Ctx, id: string, text: string, t: Timing) => void;
  /** The crest end card over everything. */
  end: (c: Ctx, k: Content, t: Timing) => void;
};

export function composeVideo(c: Ctx, k: Content, skin: VideoSkin): number {
  const d = k.video?.durationMs ?? 15000;
  const endAt = d - END_CARD_MS;
  video(c, "video", { x: 0, y: 0, w: c.W, h: c.H }, { name: "Footage" });
  skin.shade(c);
  skin.frame(c, k, { startMs: 0, endMs: endAt });
  switch (k.video?.variant) {
    case "goal":
      skin.tag(c, k, { startMs: 2000, endMs: endAt, enter: "pop" });
      skin.goal(c, k, { startMs: 2000, endMs: endAt, enter: "slide-left" });
      break;
    case "talk": {
      skin.tag(c, k, { startMs: 0, endMs: endAt, enter: "fade" });
      skin.speaker(c, k, { startMs: 400, endMs: 5200, enter: "slide-left" });
      const windows: Array<[number, number]> = [[800, 4800], [4800, 8800], [8800, endAt]];
      (k.video.captions ?? []).slice(0, 3).forEach((line, i) =>
        skin.caption(c, `caption-${i + 1}`, line, { startMs: windows[i][0], endMs: windows[i][1], enter: "fade" }));
      break;
    }
    default:
      skin.tag(c, k, { startMs: 300, endMs: endAt, enter: "fade" });
      skin.title(c, k, { startMs: 800, endMs: endAt, enter: "slide-up" });
  }
  skin.end(c, k, { startMs: endAt, endMs: d, enter: "fade" });
  return d;
}

/**
 * Boxes for a list's rows between top and bottom: one column, or two when
 * one column would make the rows shorter than minH (a 7-player line-up in a
 * square post).
 */
export function rowBoxes(n: number, top: number, bottom: number, x: number, w: number, o: { gap?: number; maxH?: number; minH?: number; colGap?: number } = {}): Box[] {
  const gap = o.gap ?? 8;
  const maxH = o.maxH ?? 112;
  const minH = o.minH ?? 64;
  const avail = bottom - top;
  const one = Math.floor((avail + gap) / Math.max(1, n)) - gap;
  if (one >= minH || n < 7) {
    const h = Math.max(24, Math.min(maxH, one));
    return Array.from({ length: n }, (_, i) => ({ x, y: top + i * (h + gap), w, h }));
  }
  const perCol = Math.ceil(n / 2);
  const colGap = o.colGap ?? 24;
  const cw = (w - colGap) / 2;
  const h = Math.max(24, Math.min(maxH, Math.floor((avail + gap) / perCol) - gap));
  return Array.from({ length: n }, (_, i) => ({ x: x + (i < perCol ? 0 : cw + colGap), y: top + (i % perCol) * (h + gap), w: cw, h }));
}

/** Total height a stack of items takes. */
export function stackHeight(items: StackItem[]): number {
  const list = real(items);
  return list.reduce((sum, item, i) => sum + item.h + (i < list.length - 1 ? item.gap ?? 0 : 0), 0);
}
