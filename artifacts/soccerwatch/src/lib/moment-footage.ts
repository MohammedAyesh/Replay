import { useQuery } from "@tanstack/react-query";
import { apiBase, matchKey } from "@/lib/match-api";

/**
 * The Moments tab's popup player (2026-11-01): a moment plays in place, with
 * -5 s / +5 s, instead of opening the watch page.
 *
 * The match's footage comes as ten-second tiles on a fixed grid of each
 * recording's video clock (tile k = [10k, 10k + 10) s), each one small MP4 cut
 * once on the server, stored on Bunny and downloaded from its edge
 * (routes/matchRooms.ts, lib/momentTiles.ts on the API). A moment opens on the
 * tile 5 s before it; -5 / +5 and playing on only ever need the tile next door,
 * which is downloaded while the one on screen plays. Tiles are kept in memory
 * for the visit, so a moment opened twice, or a neighbour's tile, is instant.
 */

export type MomentPiece = {
  recordingId: number;
  srcW: number;
  srcH: number;
  /** booking seconds this recording covers */
  from: number;
  to: number;
  /** video seconds = booking seconds + shift */
  shift: number;
};

/** [video seconds, x, y] of the ball, x and y as fractions of the frame */
export type BallPoint = [number, number, number];

export type TileInfo = { url: string | null; focus: BallPoint[] };

export type MomentFootage = {
  tileSeconds: number;
  /** a moment plays from this many seconds before it */
  lead: number;
  pieces: MomentPiece[];
  /** `${recordingId}:${k}` -> the tile's MP4 on Bunny when cut, and the ball through it */
  tiles: Record<string, TileInfo>;
};

export const TILE_SECONDS = 10;
export const tileOf = (videoSeconds: number) => Math.max(0, Math.floor(videoSeconds / TILE_SECONDS));
export const tileKey = (recordingId: number, k: number) => `${recordingId}:${k}`;

/** The piece a booking second plays from: the one holding it, else the nearest within 30 s. */
export function pieceAt(pieces: readonly MomentPiece[], at: number): MomentPiece | null {
  let best: MomentPiece | null = null;
  let gap = Infinity;
  for (const piece of pieces) {
    const d = at < piece.from ? piece.from - at : at > piece.to ? at - piece.to : 0;
    if (d < gap) { gap = d; best = piece; }
  }
  return gap <= 30 ? best : null;
}

/** Where a moment opens, video seconds: [lead] before it, inside its recording's footage. */
export function momentStart(piece: MomentPiece, at: number, lead: number): number {
  const lo = piece.from + piece.shift;
  const hi = piece.to + piece.shift;
  return Math.min(hi - 0.5, Math.max(lo, at + piece.shift - lead));
}

/** Seconds rounded so the list of moments makes a stable query key. */
const keyOf = (ats: readonly number[]) => ats.map((a) => Math.round(a * 10) / 10);

export function useMomentFootage(code: string, ats: readonly number[], enabled: boolean) {
  const at = keyOf(ats);
  return useQuery({
    queryKey: [...matchKey(code), "moment-footage", at] as const,
    queryFn: async (): Promise<MomentFootage> => {
      const response = await fetch(`${apiBase}/m/${encodeURIComponent(code)}/moments/footage`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at }),
      });
      if (!response.ok) throw new Error(`moment footage ${response.status}`);
      const footage = (await response.json()) as MomentFootage;
      for (const [id, tile] of Object.entries(footage.tiles)) learn(id, tile);
      return footage;
    },
    enabled: Boolean(code) && enabled && at.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/* ----------------------------------------------------------- the tiles */

export type TileFile = { url: string; offset: number };

/** what is known about each tile: its Bunny address (once cut) and the ball through it */
const known = new Map<string, TileInfo & { offset?: number }>();
/** downloaded tiles, as blob URLs, most recently used last */
const files = new Map<string, TileFile>();
const loading = new Map<string, Promise<TileFile>>();
/** tiles a player on screen is using: never released */
const pinned = new Set<string>();
const listeners = new Set<() => void>();
/** ~0.7 MB each */
const KEEP = 18;
const PARALLEL = 3;

function learn(id: string, tile: TileInfo & { offset?: number }) {
  const before = known.get(id);
  known.set(id, { url: tile.url ?? before?.url ?? null, focus: tile.focus?.length ? tile.focus : before?.focus ?? [], offset: tile.offset ?? before?.offset });
}

export function tileFocus(id: string): BallPoint[] | null {
  return known.get(id)?.focus ?? null;
}

export function readyTile(id: string): TileFile | null {
  const file = files.get(id);
  if (file) {
    // most recently used last
    files.delete(id);
    files.set(id, file);
  }
  return file ?? null;
}

/** Tell a player when a tile it may want has arrived. */
export function onTiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function pinTiles(ids: Iterable<string>): void {
  pinned.clear();
  for (const id of ids) pinned.add(id);
}

function release() {
  for (const [id, file] of files) {
    if (files.size <= KEEP) break;
    if (pinned.has(id)) continue;
    URL.revokeObjectURL(file.url);
    files.delete(id);
  }
}

/* a small queue: a tile a viewer is waiting for jumps ahead of tiles fetched ahead of time */
type Job = { id: string; urgent: boolean; run: () => Promise<void> };
const queue: Job[] = [];
let running = 0;
function pump() {
  while (running < PARALLEL && queue.length) {
    const job = queue.shift()!;
    running++;
    void job.run().finally(() => { running--; pump(); });
  }
}
function enqueue(job: Job) {
  if (job.urgent) {
    const at = queue.findIndex((j) => !j.urgent);
    queue.splice(at < 0 ? queue.length : at, 0, job);
  } else {
    queue.push(job);
  }
  pump();
}
/** a tile queued ahead of time that a viewer now waits for goes to the front */
function hurry(id: string) {
  const at = queue.findIndex((j) => j.id === id && !j.urgent);
  if (at < 0) return;
  const [job] = queue.splice(at, 1);
  job.urgent = true;
  enqueue(job);
}

async function locate(code: string, recordingId: number, k: number): Promise<{ url: string; offset: number }> {
  const id = tileKey(recordingId, k);
  const info = known.get(id);
  if (info?.url) return { url: info.url, offset: info.offset ?? k * TILE_SECONDS };
  const response = await fetch(`${apiBase}/m/${encodeURIComponent(code)}/moments/tile?recordingId=${recordingId}&k=${k}`, { credentials: "include" });
  if (!response.ok) throw new Error(`tile ${response.status}`);
  const tile = (await response.json()) as { url: string; offset: number; focus: BallPoint[] };
  learn(id, tile);
  return { url: tile.url, offset: tile.offset };
}

/**
 * A tile's MP4 in memory, as a blob URL: from Bunny's edge when it is already
 * cut, else after asking the API to cut it (a viewer waiting puts it first).
 * One failed download is tried again before giving up.
 */
export function loadTile(code: string, recordingId: number, k: number, urgent: boolean): Promise<TileFile> {
  const id = tileKey(recordingId, k);
  const have = files.get(id);
  if (have) return Promise.resolve(have);
  const going = loading.get(id);
  if (going) {
    if (urgent) hurry(id);
    return going;
  }
  const job = new Promise<TileFile>((resolve, reject) => {
    enqueue({
      id,
      urgent,
      run: async () => {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const where = await locate(code, recordingId, k);
            // Bunny's edge is cross-origin and needs no cookies; in development the API serves it
            const sameOrigin = where.url.startsWith("/");
            const response = await fetch(where.url, { credentials: sameOrigin ? "include" : "omit" });
            if (!response.ok) throw new Error(`tile file ${response.status}`);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "video/mp4" }));
            const file = { url, offset: Number(response.headers.get("X-Clip-Offset")) || where.offset };
            files.set(id, file);
            release();
            resolve(file);
            for (const l of listeners) l();
            return;
          } catch (error) {
            lastError = error;
            // a stored address that failed may be stale: ask the API next time
            const info = known.get(id);
            if (info) known.set(id, { ...info, url: null });
          }
        }
        reject(lastError);
      },
    });
  });
  loading.set(id, job);
  void job.finally(() => loading.delete(id)).catch(() => {});
  return job;
}

/**
 * Start downloading the tile a moment opens on (and with `both`, the one after
 * too), so a tap plays at once. By default only tiles already cut (the server
 * cuts every moment's opening tiles ahead itself); with `ask`, a tile not known
 * to be cut is asked of the API too (the popup's next and previous moments,
 * which a thumb is about to open).
 */
export function prefetchMoment(code: string, footage: MomentFootage | undefined, at: number, both = false, ask = false): void {
  if (!footage) return;
  const piece = pieceAt(footage.pieces, at);
  if (!piece) return;
  const start = momentStart(piece, at, footage.lead);
  const ks = both ? [tileOf(start), tileOf(start + footage.lead + 0.01)] : [tileOf(start)];
  for (const k of new Set(ks)) {
    if (ask || known.get(tileKey(piece.recordingId, k))?.url) void loadTile(code, piece.recordingId, k, false).catch(() => {});
  }
}

/** The ball at a moment, from the points of the tiles around it (linear between points). */
export function ballAt(points: readonly BallPoint[], t: number): [number, number] | null {
  if (!points.length) return null;
  if (t <= points[0][0]) return [points[0][1], points[0][2]];
  const last = points[points.length - 1];
  if (t >= last[0]) return [last[1], last[2]];
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid][0] <= t) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi], f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
