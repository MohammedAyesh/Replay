/**
 * The claim chain.
 *
 * A claim is no longer eight sampled checkpoints and a vote. It is one ordered
 * chain of track pieces — the same shape the Identity Board already stores as
 * `TrackingIdentity.parts` — built by a person watching the recording:
 *
 *     seek anywhere -> tap yourself -> play forward -> we stop when we lose you
 *     -> tap yourself again -> repeat
 *
 * Because the chain IS an identity, everything the board does and everything
 * the claim does are edits to the same object. A merge in the video is a merge
 * on the board because there is only one map.
 *
 * WHY THE OLD MODEL WENT
 *
 * A continuous chain was tried before and deleted on 2026-09-01, for a reason
 * worth keeping in view: it had no principled answer to "when do we interrupt".
 * It guessed, auto-stitched to stay alive, and needed undo for the guesses.
 * The anchor model that replaced it answered "when" with "every 75 seconds",
 * which is not an answer either — it asks where nothing is happening and it
 * never asks where the tracker actually failed.
 *
 * This module is the missing answer. Playback stops at a computed uncertainty
 * and nowhere else:
 *
 *   TRACK END   the chain has no continuation. Definitive, not a judgement.
 *   SWAP        a crossing where the geometry says the tracker probably
 *               exchanged two identities. Judged, and only raised when the
 *               evidence passes a threshold — a crossing on its own is not a
 *               reason to interrupt someone.
 *
 * Everything here is pure. No database, no manifest mutation, no clock. That
 * is deliberate: the interrupt rule is the part that has to be right, so it is
 * the part that is fully unit-testable against constructed geometry.
 */

import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";

type Box = TrackingSegmentPayload["tracks"][number]["boxes"][number];
type Track = TrackingSegmentPayload["tracks"][number];
type Crossing = TrackingSegmentPayload["crossings"][number];

/** One link of the chain: this source track, for this stretch of frames. */
export type ChainPart = {
  trackId: string;
  fromFrame: number;
  toFrame: number;
};

export type UncertaintyKind = "track-end" | "swap";

export type Uncertainty = {
  kind: UncertaintyKind;
  /** Frame at which playback should stop and ask. */
  frame: number;
  /** The chain part that runs out or is suspected of having been swapped. */
  trackId: string;
  /** For a swap, the track the identity may have been exchanged with. */
  otherTrackId?: string;
  /** 0..1. Always 1 for a track end — there is nothing to judge. */
  confidence: number;
  /** Plain sentence for the UI and the logs. Never a code. */
  reason: string;
};

/* ------------------------------------------------------------------ *
 * Tunables. Exported so tests pin them and so a recording with unusual
 * geometry can be tuned without editing logic.
 * ------------------------------------------------------------------ */

export const CHAIN_TUNING = {
  /**
   * Frames either side of a crossing used to measure a trajectory. Too short
   * and one noisy box dominates; too long and a genuine turn looks like a
   * swap. Eight frames is roughly 0.4 s at 20 fps.
   */
  velocityWindowFrames: 8,
  /**
   * How much better the swapped hypothesis must fit before we interrupt.
   * A crossing is common and an interruption is expensive, so this is a
   * margin, not a coin flip: the swap must explain the geometry clearly
   * better than the straight-through reading.
   */
  swapMarginPx: 6,
  /**
   * Apparent height is a depth and build proxy. Weighted below velocity
   * because a box height jitters more than a centre does.
   */
  heightWeight: 0.5,
  /**
   * A crossing the tracker itself reported low confidence in is raised on
   * that basis even when the geometry is inconclusive.
   */
  lowConfidenceBelow: 0.35,
  /** A detection gap longer than this ends the part rather than bridging it. */
  maxBridgeGapFrames: 12,
};

/* ------------------------------------------------------------------ *
 * Board decisions
 * ------------------------------------------------------------------ */

export type IdentityDecision = {
  trackId: string;
  fromFrame: number;
  toFrame: number;
  action: "parked" | "deleted";
};

/**
 * Whether a frame of a track has been struck off on the Identity Board.
 *
 * `identityDecisions` has been written by the board, stored on the manifest
 * and validated on save since it was introduced — and read by nothing else.
 * Deleting a person on the board therefore left them fully present in the
 * video and in every candidate list. This is the function that makes a board
 * deletion mean something everywhere.
 *
 * "parked" and "deleted" both remove the piece from play. They differ only in
 * intent on the board (parked = set aside, deleted = not a player), and
 * neither should ever be offered as someone to claim.
 */
export function isStruckOff(
  decisions: IdentityDecision[] | undefined,
  trackId: string,
  frame: number,
): boolean {
  if (!decisions?.length) return false;
  return decisions.some((d) =>
    d.trackId === trackId && frame >= d.fromFrame && frame <= d.toFrame);
}

/** Every frame range of a track that survives the board's decisions. */
export function survivingRanges(
  decisions: IdentityDecision[] | undefined,
  track: Pick<Track, "id" | "startFrame" | "endFrame">,
): Array<{ fromFrame: number; toFrame: number }> {
  const cuts = (decisions ?? [])
    .filter((d) => d.trackId === track.id)
    .map((d) => ({ from: Math.max(d.fromFrame, track.startFrame), to: Math.min(d.toFrame, track.endFrame) }))
    .filter((d) => d.to >= d.from)
    .sort((a, b) => a.from - b.from);
  if (!cuts.length) return [{ fromFrame: track.startFrame, toFrame: track.endFrame }];

  const out: Array<{ fromFrame: number; toFrame: number }> = [];
  let cursor = track.startFrame;
  for (const cut of cuts) {
    if (cut.from > cursor) out.push({ fromFrame: cursor, toFrame: cut.from - 1 });
    cursor = Math.max(cursor, cut.to + 1);
  }
  if (cursor <= track.endFrame) out.push({ fromFrame: cursor, toFrame: track.endFrame });
  return out;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function centre(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Boxes in [from, to], sorted by frame. */
function boxesBetween(track: Track, from: number, to: number): Box[] {
  return track.boxes
    .filter((b) => b.frame >= from && b.frame <= to)
    .sort((a, b) => a.frame - b.frame);
}

/**
 * Mean per-frame velocity and mean apparent height over a window.
 * Returns null when there is not enough of the track inside the window to
 * measure anything — an unmeasurable trajectory is never evidence of a swap.
 */
function trajectory(
  track: Track,
  from: number,
  to: number,
): { vx: number; vy: number; height: number } | null {
  const boxes = boxesBetween(track, from, to);
  if (boxes.length < 2) return null;
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  const span = last.frame - first.frame;
  if (span <= 0) return null;
  const a = centre(first);
  const b = centre(last);
  return {
    vx: (b.x - a.x) / span,
    vy: (b.y - a.y) / span,
    height: boxes.reduce((sum, box) => sum + box.h, 0) / boxes.length,
  };
}

/**
 * Cost of believing that `after` is the continuation of `before`.
 *
 * Velocity difference in pixels per frame, plus a weighted apparent-height
 * difference. Both are "how surprised are we", so lower is a better fit.
 */
function continuationCost(
  before: { vx: number; vy: number; height: number },
  after: { vx: number; vy: number; height: number },
): number {
  const dv = Math.hypot(after.vx - before.vx, after.vy - before.vy);
  const dh = Math.abs(after.height - before.height);
  return dv + CHAIN_TUNING.heightWeight * dh;
}

/**
 * How strongly the geometry says these two tracks were exchanged at this
 * crossing. Positive means the swapped reading fits better than the
 * straight-through one; the magnitude is in pixels per frame.
 *
 * The test is the useful one: not "did this track wobble", which every track
 * does at a crossing, but "does the OTHER track's approach continue into this
 * track's departure better than its own approach does". A wobble raises both
 * hypotheses equally and cancels; only a genuine exchange separates them.
 *
 * Returns null when either trajectory cannot be measured.
 */
export function swapEvidence(
  mine: Track,
  other: Track,
  crossingFrame: number,
  window = CHAIN_TUNING.velocityWindowFrames,
): number | null {
  const myBefore = trajectory(mine, crossingFrame - window, crossingFrame);
  const myAfter = trajectory(mine, crossingFrame, crossingFrame + window);
  const otherBefore = trajectory(other, crossingFrame - window, crossingFrame);
  const otherAfter = trajectory(other, crossingFrame, crossingFrame + window);
  if (!myBefore || !myAfter || !otherBefore || !otherAfter) return null;

  const straight = continuationCost(myBefore, myAfter) + continuationCost(otherBefore, otherAfter);
  const swapped = continuationCost(otherBefore, myAfter) + continuationCost(myBefore, otherAfter);
  return straight - swapped;
}

/* ------------------------------------------------------------------ *
 * The interrupt rule
 * ------------------------------------------------------------------ */

/**
 * Where playback should next stop, following `chain` forward from `fromFrame`.
 *
 * Returns null when the chain runs cleanly to its end with nothing to ask —
 * which is the state a finished claim is in.
 *
 * Order matters: the earliest uncertainty wins, because stopping late means
 * the viewer has already watched footage attributed to the wrong person.
 */
export function nextUncertainty(
  chain: ChainPart[],
  tracksById: Map<string, Track>,
  crossings: Crossing[],
  fromFrame: number,
  decisions?: IdentityDecision[],
): Uncertainty | null {
  const ordered = [...chain].sort((a, b) => a.fromFrame - b.fromFrame);
  const candidates: Uncertainty[] = [];

  for (const part of ordered) {
    if (part.toFrame < fromFrame) continue;
    const track = tracksById.get(part.trackId);
    if (!track) continue;

    // A swap inside the part we are actually watching.
    for (const crossing of crossings) {
      const involvesMe = crossing.trackId === part.trackId || crossing.otherTrackId === part.trackId;
      if (!involvesMe) continue;
      if (crossing.frame < Math.max(part.fromFrame, fromFrame) || crossing.frame > part.toFrame) continue;

      const otherId = crossing.trackId === part.trackId ? crossing.otherTrackId : crossing.trackId;
      const other = tracksById.get(otherId);
      if (!other) continue;
      if (isStruckOff(decisions, otherId, crossing.frame)) continue;

      const evidence = swapEvidence(track, other, crossing.frame);
      const lowConfidence = typeof crossing.confidence === "number"
        && crossing.confidence < CHAIN_TUNING.lowConfidenceBelow;

      // A crossing alone is not a reason to interrupt. Either the geometry
      // says the exchange fits clearly better, or the tracker itself said it
      // was unsure. Anything else plays straight through.
      if (evidence !== null && evidence > CHAIN_TUNING.swapMarginPx) {
        candidates.push({
          kind: "swap",
          frame: crossing.frame,
          trackId: part.trackId,
          otherTrackId: otherId,
          confidence: Math.min(1, evidence / (CHAIN_TUNING.swapMarginPx * 3)),
          reason: "Another player crossed here and the movement afterwards fits them better than you.",
        });
      } else if (lowConfidence) {
        candidates.push({
          kind: "swap",
          frame: crossing.frame,
          trackId: part.trackId,
          otherTrackId: otherId,
          confidence: 1 - (crossing.confidence ?? 0),
          reason: "The tracker was unsure which player was which here.",
        });
      }
    }

    // The part runs out. Only an uncertainty if nothing in the chain picks up.
    const continues = ordered.some((other) =>
      other !== part && other.fromFrame <= part.toFrame + 1 && other.toFrame > part.toFrame);
    if (!continues && part.toFrame >= fromFrame) {
      candidates.push({
        kind: "track-end",
        frame: part.toFrame,
        trackId: part.trackId,
        confidence: 1,
        reason: "We lost you here — the tracker stopped following this player.",
      });
    }
  }

  candidates.sort((a, b) => a.frame - b.frame || (a.kind === "swap" ? -1 : 1));
  return candidates.find((c) => c.frame >= fromFrame) ?? null;
}

/* ------------------------------------------------------------------ *
 * Chain algebra
 * ------------------------------------------------------------------ */

/**
 * Normalise a chain: drop empties, clamp to each track's real extent, sort,
 * and merge parts of the same track that touch or overlap.
 *
 * Everything that writes a chain goes through this, so a malformed chain
 * cannot reach storage no matter which endpoint produced it.
 */
export function normaliseChain(
  chain: ChainPart[],
  tracksById: Map<string, Track>,
): ChainPart[] {
  const clamped: ChainPart[] = [];
  for (const part of chain) {
    const track = tracksById.get(part.trackId);
    if (!track) continue;
    const fromFrame = Math.max(part.fromFrame, track.startFrame);
    const toFrame = Math.min(part.toFrame, track.endFrame);
    if (toFrame < fromFrame) continue;
    clamped.push({ trackId: part.trackId, fromFrame, toFrame });
  }

  clamped.sort((a, b) => a.fromFrame - b.fromFrame || a.trackId.localeCompare(b.trackId));

  const merged: ChainPart[] = [];
  for (const part of clamped) {
    const last = merged[merged.length - 1];
    if (last && last.trackId === part.trackId && part.fromFrame <= last.toFrame + 1) {
      last.toFrame = Math.max(last.toFrame, part.toFrame);
      continue;
    }
    merged.push({ ...part });
  }
  return merged;
}

/**
 * The person tapped themselves on track `trackId` at `frame`.
 *
 * The new part runs from that frame to wherever the track stops being usable:
 * its own end, the first frame struck off on the board, or the far side of a
 * detection gap longer than `maxBridgeGapFrames` (past that gap the tracker
 * has lost continuity and we should not claim through it silently).
 *
 * Any existing chain from `frame` onward is discarded. Tapping is a
 * correction, and a correction that left the old wrong answer in place would
 * attribute the same seconds to two people.
 */
export function extendChain(
  chain: ChainPart[],
  tracksById: Map<string, Track>,
  trackId: string,
  frame: number,
  decisions?: IdentityDecision[],
): ChainPart[] {
  const track = tracksById.get(trackId);
  if (!track) return normaliseChain(chain, tracksById);
  if (isStruckOff(decisions, trackId, frame)) return normaliseChain(chain, tracksById);

  const start = Math.max(frame, track.startFrame);
  const boxes = track.boxes.filter((b) => b.frame >= start).sort((a, b) => a.frame - b.frame);
  if (!boxes.length) return normaliseChain(chain, tracksById);

  let end = boxes[0].frame;
  for (let i = 1; i < boxes.length; i++) {
    const gap = boxes[i].frame - boxes[i - 1].frame;
    if (gap > CHAIN_TUNING.maxBridgeGapFrames) break;
    if (isStruckOff(decisions, trackId, boxes[i].frame)) break;
    end = boxes[i].frame;
  }

  const truncated = chain
    .map((part) => ({ ...part }))
    .filter((part) => part.fromFrame < start)
    .map((part) => ({ ...part, toFrame: Math.min(part.toFrame, start - 1) }))
    .filter((part) => part.toFrame >= part.fromFrame);

  return normaliseChain([...truncated, { trackId, fromFrame: start, toFrame: end }], tracksById);
}

/** Remove the last link. The undo for a mis-tap. */
export function dropLastPart(chain: ChainPart[]): ChainPart[] {
  const ordered = [...chain].sort((a, b) => a.fromFrame - b.fromFrame);
  ordered.pop();
  return ordered;
}

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

/**
 * Seconds the chain covers, as merged intervals, with off-pitch removed.
 *
 * This replaces the vote-and-union model outright. Coverage is now the span a
 * person actually confirmed by watching it, so it cannot be inflated by one
 * tap on a long track, and there is no tie that can collapse it to zero.
 */
export function chainIntervals(
  chain: ChainPart[],
  manifest: Pick<TrackingManifest, "frameRate" | "duration">,
  offPitch: Array<{ fromSeconds: number; toSeconds: number }> = [],
): Array<{ startSeconds: number; endSeconds: number }> {
  const fps = Math.max(manifest.frameRate, 0.001);
  const raw = chain
    .map((part) => ({
      startSeconds: Math.max(0, part.fromFrame / fps),
      endSeconds: Math.min(manifest.duration, (part.toFrame + 1) / fps),
    }))
    .filter((span) => span.endSeconds > span.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const merged: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (const span of raw) {
    const last = merged[merged.length - 1];
    if (last && span.startSeconds <= last.endSeconds) {
      last.endSeconds = Math.max(last.endSeconds, span.endSeconds);
      continue;
    }
    merged.push({ ...span });
  }

  if (!offPitch.length) return merged;

  const out: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (const span of merged) {
    let pieces = [span];
    for (const gap of offPitch) {
      const next: typeof pieces = [];
      for (const piece of pieces) {
        if (gap.toSeconds <= piece.startSeconds || gap.fromSeconds >= piece.endSeconds) {
          next.push(piece);
          continue;
        }
        if (gap.fromSeconds > piece.startSeconds) {
          next.push({ startSeconds: piece.startSeconds, endSeconds: gap.fromSeconds });
        }
        if (gap.toSeconds < piece.endSeconds) {
          next.push({ startSeconds: gap.toSeconds, endSeconds: piece.endSeconds });
        }
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out.filter((span) => span.endSeconds > span.startSeconds);
}

export function totalSeconds(
  spans: Array<{ startSeconds: number; endSeconds: number }>,
): number {
  return Math.round(spans.reduce((sum, s) => sum + (s.endSeconds - s.startSeconds), 0) * 100) / 100;
}
