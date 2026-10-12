import { kept, MIN_PLAYABLE_SECONDS, ovPos, Y, type Ctx } from "./claim";
import { OUT, overlapSeconds, union, type ManualPiece } from "./model";

/**
 * What the claim means to the rest of Replay.
 *
 * The identity board, player stats, earned clips and "claimed matches" all
 * read a claimant's identity row: parts of tracks, in absolute frames. Every
 * piece kept in the claim -- a whole track from a picked group, or the stretch
 * of a track a tap landed on -- becomes one part. A tap on empty grass has no
 * track and makes no part. Bench time becomes the claimant's off-pitch spans.
 */

export type ChainPartOut = { trackId: string; fromFrame: number; toFrame: number };
export type RosterPartIn = { trackId: string; fromFrame: number; toFrame: number };

function rosterManualId(part: { trackId: string; fromFrame: number; toFrame: number }): string {
  return `roster:${part.trackId}:${part.fromFrame}:${part.toFrame}`;
}

/** Convert exact roster ranges into reviewable pieces as their chunks load. */
export function materializeRosterParts(ctx: Ctx, k: number): void {
  const chunk = ctx.CH[k];
  if (!chunk) return;
  const answers = Y(ctx, k);
  const pending = answers.rosterParts ?? [];
  const unresolved: typeof pending = [];
  const fps = ctx.game.frameRate > 0 ? ctx.game.frameRate : 20;

  for (const part of pending) {
    const id = rosterManualId(part);
    if (answers.manual.some((piece) => piece.id === id)) continue;
    const source = chunk.pieces[part.trackId];
    if (!source) {
      unresolved.push(part);
      continue;
    }
    const t0 = Math.max(source.t0, part.fromFrame / fps - chunk.start);
    const t1 = Math.min(source.t1, part.toFrame / fps - chunk.start);
    if (t1 <= t0) {
      unresolved.push(part);
      continue;
    }
    const start = ovPos(ctx, k, part.trackId, t0);
    const end = ovPos(ctx, k, part.trackId, t1);
    const piece: ManualPiece = {
      id,
      manual: true,
      t0,
      t1,
      a: start?.foot ?? source.a,
      b: end?.foot ?? source.b,
      h0: start?.h ?? source.h0,
      h1: end?.h ?? source.h1,
      img: source.img,
      s: source.s,
      e: source.e,
      src: part.trackId,
    };
    answers.manual.push(piece);
  }
  answers.rosterParts = unresolved;
}

/** Save exact roster ranges and materialize them immediately when the chunk is already loaded. */
export function seedRosterParts(ctx: Ctx, k: number, parts: RosterPartIn[]): void {
  Y(ctx, k).rosterParts = parts;
  materializeRosterParts(ctx, k);
}

/** Seconds of this player's roster ranges that remain after out-of-play ranges are removed. */
export function rosterPartSeconds(ctx: Ctx, k: number, parts: RosterPartIn[]): number {
  const chunk = ctx.game.chunks.find((candidate) => candidate.k === k);
  if (!chunk || !parts.length) return 0;
  const fps = ctx.game.frameRate > 0 ? ctx.game.frameRate : 20;
  const ranges = union(parts.flatMap((part) => {
    const start = Math.max(chunk.start, part.fromFrame / fps);
    const end = Math.min(chunk.start + chunk.dur, part.toFrame / fps);
    return end > start ? [[start, end] as [number, number]] : [];
  }));
  const out = union(ctx.S.off.filter((range) => OUT(range[2])).map(([start, end]) => [start, end] as [number, number]));
  return ranges.reduce(
    (seconds, [start, end]) => seconds + Math.max(0, end - start - overlapSeconds(start, end, out)),
    0,
  );
}

/** First chunk with enough in-play roster footage, or the highest-scoring available chunk. */
export function firstRosterChunk(
  ctx: Ctx,
  byChunk: Map<number, RosterPartIn[]>,
): number | null {
  const available = ctx.game.chunks.filter(
    ({ k }) => byChunk.has(k) && !Y(ctx, k).skipped,
  );
  if (!available.length) return null;
  const scores = available.map(({ k }) => ({
    k,
    seconds: rosterPartSeconds(ctx, k, byChunk.get(k) ?? []),
  }));
  return scores.find(({ seconds }) => seconds >= MIN_PLAYABLE_SECONDS)?.k
    ?? scores.reduce((best, current) => current.seconds > best.seconds ? current : best).k;
}

export function chainParts(ctx: Ctx): ChainPartOut[] {
  const fps = ctx.game.frameRate > 0 ? ctx.game.frameRate : 20;
  const byTrack = new Map<string, Array<[number, number]>>();
  for (const key of Object.keys(ctx.S.you)) {
    const k = Number(key);
    const y = ctx.S.you[key];
    const chunk = ctx.CH[k];
    if (y.skipped) continue;
    if (chunk) {
      for (const p of kept(ctx, k)) {
        const trackId = p.manual ? p.src : p.id;
        if (!trackId) continue;
        const from = Math.round((chunk.start + p.t0) * fps);
        const to = Math.round((chunk.start + p.t1) * fps);
        if (to <= from) continue;
        byTrack.set(trackId, [...(byTrack.get(trackId) ?? []), [from, to]]);
      }
    }
    for (const part of y.rosterParts ?? []) {
      if (part.toFrame <= part.fromFrame) continue;
      byTrack.set(part.trackId, [
        ...(byTrack.get(part.trackId) ?? []),
        [part.fromFrame, part.toFrame],
      ]);
    }
  }
  const parts: ChainPartOut[] = [];
  for (const [trackId, spans] of byTrack) {
    for (const [fromFrame, toFrame] of union(spans)) parts.push({ trackId, fromFrame, toFrame });
  }
  return parts.sort((a, b) => a.fromFrame - b.fromFrame || a.trackId.localeCompare(b.trackId));
}

/** Bench time, in tracking seconds, as the claimant's off-pitch spans. */
export function benchSpansOut(ctx: Ctx): Array<{ fromSeconds: number; toSeconds: number }> {
  return union(ctx.S.off.filter((r) => r[2] === "bench").map((r) => [r[0], r[1]] as [number, number]))
    .map(([fromSeconds, toSeconds]) => ({ fromSeconds, toSeconds }));
}
