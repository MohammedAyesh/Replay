import type { Game, PitchGrid } from "./model";

/**
 * Image pixels to pitch metres, through the bundle's camera-to-pitch grid.
 *
 * The grid is the manifest's pitchModel: rows run top to bottom of the image,
 * columns left to right, and each point is where that image position lands on
 * the pitch. Bilinear inside a cell, as the prototype's toPitch().
 */
export function toPitch(game: Pick<Game, "pitch" | "srcW" | "srcH">, x: number, y: number): [number, number] {
  const pitch = game.pitch;
  if (!pitch) return [0, 0];
  const g = pitch.grid;
  const ny = g.length;
  const nx = g[0].length;
  const u = Math.min(Math.max(x / game.srcW, 0), 1) * (nx - 1);
  const v = Math.min(Math.max(y / game.srcH, 0), 1) * (ny - 1);
  const x0 = Math.min(Math.floor(u), nx - 2);
  const y0 = Math.min(Math.floor(v), ny - 2);
  const fx = u - x0;
  const fy = v - y0;
  const L = (a: [number, number], b: [number, number], f: number): [number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const top = L(g[y0][x0], g[y0][x0 + 1], fx);
  const bot = L(g[y0 + 1][x0], g[y0 + 1][x0 + 1], fx);
  return L(top, bot, fy);
}

/** The manifest's pitch model in this module's shape, or null when it is unusable. */
export function pitchFromManifest(model: {
  pitchWidthMetres: number;
  pitchHeightMetres: number;
  grid: Array<Array<{ x: number; y: number }>>;
} | null | undefined): PitchGrid | null {
  if (!model || !Array.isArray(model.grid) || model.grid.length < 2) return null;
  const cols = model.grid[0]?.length ?? 0;
  if (cols < 2 || model.grid.some((row) => row.length !== cols)) return null;
  if (!(model.pitchWidthMetres > 0) || !(model.pitchHeightMetres > 0)) return null;
  return {
    w: model.pitchWidthMetres,
    h: model.pitchHeightMetres,
    grid: model.grid.map((row) => row.map((p) => [p.x, p.y] as [number, number])),
  };
}
