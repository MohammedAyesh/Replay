import { kept, type Ctx } from "./claim";
import { union } from "./model";

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

export function chainParts(ctx: Ctx): ChainPartOut[] {
  const fps = ctx.game.frameRate > 0 ? ctx.game.frameRate : 20;
  const byTrack = new Map<string, Array<[number, number]>>();
  for (const key of Object.keys(ctx.S.you)) {
    const k = Number(key);
    const y = ctx.S.you[key];
    const chunk = ctx.CH[k];
    if (!chunk || y.skipped) continue;
    for (const p of kept(ctx, k)) {
      const trackId = p.manual ? p.src : p.id;
      if (!trackId) continue;
      const from = Math.round((chunk.start + p.t0) * fps);
      const to = Math.round((chunk.start + p.t1) * fps);
      if (to <= from) continue;
      byTrack.set(trackId, [...(byTrack.get(trackId) ?? []), [from, to]]);
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
