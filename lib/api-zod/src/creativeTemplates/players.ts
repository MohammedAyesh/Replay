import type { Content } from "./content";
import { ellipse, image, rect, text, type Box, type Ctx, type LatinFont, type LayerCondition, type TextOpts } from "./kit";

/**
 * Line-ups with player photos (templates `lineup` and `callup`).
 *
 * A line-up carries two versions of its rows. With player photos in the data
 * (data.photos, filled only for an academy that shows names) it draws a grid
 * of player tiles; without, the style's own numbers-only rows, exactly as
 * before. Each tile:
 *
 *   - the style's backdrop shape (a glow, a slant, a band, a card…), set a
 *     little below the tile's top so a cut-out can rise over it;
 *   - the shirt number, large, beside / behind the figure (or alone and centred
 *     when that player has no photo);
 *   - the photo: a cut-out (transparent PNG) drawn whole ("contain"), standing
 *     on the bar with a soft shadow under it; an ordinary photo drawn as a
 *     rounded card inside the backdrop instead;
 *   - a bar at the bottom with the first name and the position.
 *
 * Which parts show is decided per row by layer conditions on photos.N and
 * photos.N.cutout (SceneLayer.when), so the layout is fixed and the data picks.
 * Shared layer ids: row-N-photo (the cut-out), row-N-card (the card photo),
 * row-N-num, row-N-name, row-N-pos.
 */

export const PHOTOS_ON: LayerCondition[] = [{ path: "photos" }];
export const PHOTOS_OFF: LayerCondition[] = [{ path: "photos", not: true }];
export const rowPhotoPath = (i: number) => `photos.${i}`;

export type TileLook = {
  /** The shape behind the number and the figure (draw inside b; ids start with `id`). */
  backdrop: (c: Ctx, id: string, b: Box, i: number) => void;
  /** The bar under the figure that carries the name and position. */
  bar: (c: Ctx, id: string, b: Box, i: number) => void;
  num: { font: LatinFont; color: string; weight?: number; opacity?: number; italic?: boolean; stroke?: { color: string; width: number }; shadow?: TextOpts["shadow"] };
  name: { font: LatinFont; color: string; weight?: number; italic?: boolean; ls?: number };
  pos: { font: LatinFont; color: string; weight?: number; ls?: number };
  /** Shadow colour under a cut-out (#RRGGBB). */
  shadow?: string;
  /** Corner radius of an ordinary (opaque) photo card. */
  cardRadius?: number;
  /** Gap between tiles. */
  gap?: number;
  /** How tall the bar is, as a share of the tile (default 0.2). */
  barShare?: number;
  /** Where the number sits when there is a photo: beside the figure (default) or centred behind it. */
  numberAt?: "side" | "behind";
  /** The style's text function (a pack's typefaces); default kit.text. */
  text?: (c: Ctx, id: string, value: string, b: Box, o: TextOpts) => unknown;
};

/** Tiles for n players in a region: as many columns as make portrait tiles (about 3:4), the last row centred. */
export function tileGrid(n: number, region: Box, gap = 18): Box[] {
  if (n <= 0) return [];
  let best: { cols: number; w: number; h: number; score: number } | null = null;
  for (let cols = 2; cols <= 5; cols += 1) {
    const rows = Math.ceil(n / cols);
    const w = (region.w - (cols - 1) * gap) / cols;
    const hAvail = (region.h - (rows - 1) * gap) / rows;
    const h = Math.min(hAvail, w * 1.7);
    if (w < 150 || h < 150) continue;
    // Prefer about 1.3 tall per wide, then bigger tiles, then rows filled.
    const score = Math.abs(h / w - 1.35) * 1.5 - (w * h) / 80_000 + (rows * cols - n) * 0.05;
    if (!best || score < best.score) best = { cols, w, h, score };
  }
  if (!best) {
    const cols = Math.min(n, 5);
    const rows = Math.ceil(n / cols);
    best = { cols, w: (region.w - (cols - 1) * gap) / cols, h: (region.h - (rows - 1) * gap) / rows, score: 0 };
  }
  const { cols, w, h } = best;
  const rows = Math.ceil(n / cols);
  const total = rows * h + (rows - 1) * gap;
  const top = region.y + Math.max(0, (region.h - total) / 2);
  const out: Box[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const left = region.x + (region.w - (inRow * w + (inRow - 1) * gap)) / 2;
    out.push({ x: left + (i % cols) * (w + gap), y: top + r * (h + gap), w, h });
  }
  return out;
}

/**
 * Draws a list's rows: the numbers-only rows (`drawRows`) for every list, and
 * for a line-up the photo tiles too, each version under its condition.
 */
export function rowsOrTiles(c: Ctx, k: Content, region: Box, look: TileLook, drawRows: () => void): void {
  if (!k.playerRows) { drawRows(); return; }
  c.only(PHOTOS_OFF, drawRows);
  c.only(PHOTOS_ON, () => playerTiles(c, k, region, look));
}

export function playerTiles(c: Ctx, k: Content, region: Box, look: TileLook): void {
  const rows = k.rows ?? [];
  const tiles = tileGrid(rows.length, region, look.gap ?? 18);
  tiles.forEach((t, i) => playerTile(c, `row-${i + 1}`, t, rows[i], i, look));
}

function playerTile(c: Ctx, id: string, t: Box, row: [string, string, string], i: number, look: TileLook): void {
  const photo = rowPhotoPath(i);
  const has: LayerCondition[] = [{ path: photo }];
  const none: LayerCondition[] = [{ path: photo, not: true }];
  const cutout: LayerCondition[] = [{ path: `${photo}.cutout` }];
  const card: LayerCondition[] = [{ path: photo }, { path: `${photo}.cutout`, not: true }];

  const barH = Math.round(Math.max(54, Math.min(110, t.h * (look.barShare ?? 0.2))));
  const rise = Math.round(t.h * 0.14);
  const bar: Box = { x: t.x, y: t.y + t.h - barH, w: t.w, h: barH };
  const back: Box = { x: t.x, y: t.y + rise, w: t.w, h: t.h - rise - barH };

  look.backdrop(c, `${id}-tile`, back, i);

  // The number: beside the figure with a photo, centred and large without one.
  const tx = look.text ?? text;
  const n = look.num;
  const numOpts = {
    font: n.font, weight: n.weight ?? 800, color: n.color, num: true, fit: true, italic: n.italic,
    ...(n.opacity !== undefined ? { opacity: n.opacity } : {}), ...(n.stroke ? { stroke: n.stroke } : {}), ...(n.shadow ? { shadow: n.shadow } : {}),
  };
  c.only(has, () => {
    const behind = look.numberAt === "behind";
    const nb: Box = behind
      ? { x: back.x, y: back.y + back.h * 0.02, w: back.w, h: back.h * 0.62 }
      : { x: back.x + back.w * 0.05, y: back.y + back.h * 0.03, w: back.w * 0.6, h: back.h * 0.46 };
    tx(c, `${id}-num`, row[0], nb, { ...numOpts, size: Math.round(nb.h * 0.92), align: behind ? "center" : "start", lh: 1 });
  });
  c.only(none, () => {
    const nb: Box = { x: back.x, y: back.y + back.h * 0.12, w: back.w, h: back.h * 0.76 };
    tx(c, `${id}-num-solo`, row[0], nb, { ...numOpts, opacity: 1, size: Math.round(nb.h * 0.86), align: "center", lh: 1 });
  });

  // An ordinary photo: a rounded card inside the backdrop.
  const inset = Math.round(Math.min(back.w, back.h) * 0.06);
  image(c, `${id}-card`, { type: "binding", path: photo }, { x: back.x + inset, y: back.y + inset, w: back.w - 2 * inset, h: back.h - inset + Math.round(barH * 0.3) }, { fit: "cover", radius: look.cardRadius ?? 18, when: card, name: `Player ${i + 1} photo` });

  // A cut-out: shadow on the bar, the figure whole, rising above the backdrop.
  const shadow = look.shadow ?? "#000000";
  c.only(cutout, () => {
    ellipse(c, `${id}-shadow-2`, { x: t.x + t.w * 0.1, y: bar.y - 20, w: t.w * 0.8, h: 40 }, { fill: shadow, opacity: 0.18 });
    ellipse(c, `${id}-shadow`, { x: t.x + t.w * 0.22, y: bar.y - 12, w: t.w * 0.56, h: 24 }, { fill: shadow, opacity: 0.32 });
  });
  // Off-centre towards the far side when the number stands beside the figure.
  const fw = Math.min(t.w * 1.1, (t.h - barH * 0.6) * 1.05);
  const shift = look.numberAt === "behind" ? 0 : t.w * 0.1;
  image(c, `${id}-photo`, { type: "binding", path: photo }, { x: Math.min(t.x + (t.w - fw) / 2 + shift, c.W - fw), y: t.y, w: fw, h: t.h - barH + Math.round(barH * 0.4) }, { fit: "contain", when: cutout, name: `Player ${i + 1} cut-out` });

  look.bar(c, `${id}-bar`, bar, i);
  const nm = look.name;
  tx(c, `${id}-name`, row[1], { x: bar.x + 8, y: bar.y + barH * 0.08, w: bar.w - 16, h: barH * 0.5 }, {
    size: Math.round(barH * 0.5), font: nm.font, weight: nm.weight ?? 800, color: nm.color, align: "center", upper: true, fit: true, italic: nm.italic, ls: nm.ls,
  });
  const ps = look.pos;
  tx(c, `${id}-pos`, row[2], { x: bar.x + 8, y: bar.y + barH * 0.58, w: bar.w - 16, h: barH * 0.34 }, {
    size: Math.round(barH * 0.28), font: ps.font, weight: ps.weight ?? 700, color: ps.color, align: "center", upper: true, fit: true, ls: ps.ls ?? 2,
  });
}

// ── Player posts: the player's own cut-out over the main picture ─────────────

export const PLAYER_CUTOUT: LayerCondition[] = [{ path: "player.photo.cutout" }];
export const PLAYER_CARD: LayerCondition[] = [{ path: "player.photo" }, { path: "player.photo.cutout", not: true }];

/**
 * The player's own photo in a player post (potm, birthday, welcome…): a
 * cut-out standing at the bottom of the main picture with a soft shadow, or,
 * for an ordinary photo, a rounded portrait card. `box` is where the figure
 * stands (its bottom edge is the ground).
 */
export function playerFigure(c: Ctx, box: Box, o: { shadow?: string; card?: { stroke: string; radius?: number } } = {}): void {
  const shadow = o.shadow ?? "#000000";
  c.only(PLAYER_CUTOUT, () => {
    ellipse(c, "player-shadow-2", { x: box.x + box.w * 0.12, y: box.y + box.h - 52, w: box.w * 0.76, h: 52 }, { fill: shadow, opacity: 0.2 });
    ellipse(c, "player-shadow", { x: box.x + box.w * 0.24, y: box.y + box.h - 36, w: box.w * 0.52, h: 32 }, { fill: shadow, opacity: 0.34 });
    image(c, "player-photo", { type: "binding", path: "player.photo" }, box, { fit: "contain", name: "Player cut-out" });
  });
  const cw = Math.round(box.h * 0.62 * 0.78);
  const ch = Math.round(box.h * 0.62);
  const cb: Box = { x: box.x + box.w - cw - 8, y: box.y + box.h - ch - 8, w: cw, h: ch };
  const radius = o.card?.radius ?? 28;
  c.only(PLAYER_CARD, () => {
    rect(c, "player-card-frame", { x: cb.x - 8, y: cb.y - 8, w: cb.w + 16, h: cb.h + 16 }, { fill: o.card?.stroke ?? "#FFFFFF", radius: radius + 8 });
    image(c, "player-card", { type: "binding", path: "player.photo" }, cb, { fit: "cover", radius, name: "Player photo" });
  });
}
