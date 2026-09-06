/**
 * The claim chain flow, as pure functions.
 *
 * The interaction is:
 *
 *     seek anywhere -> tap yourself -> play forward
 *       -> we stop where we are no longer sure -> answer -> repeat
 *
 * and the part that has to be right is "when do we stop". The model this
 * replaces answered that with "every 75 seconds", which asks where nothing is
 * happening and never asks where the tracker actually failed. The server
 * computes the stop from geometry (claimChain.ts, nextUncertainty); everything
 * here is about honouring it exactly, which mostly means not overshooting it.
 *
 * No React, no fetch, no clock -- so the rule is testable against constructed
 * chains rather than against a video.
 */
import type { ClaimChain, ClaimChainPart } from "@workspace/api-client-react";
import type { ClaimBox, ClaimBundle, ClaimTrack } from "./claim-match-engine";
import { detectionAtFrame } from "./claim-match-bundle";

export type ChainStage =
  /** Nothing claimed yet: seek freely, boxes on, tap yourself. */
  | "identify"
  /** Following the chain forward. */
  | "following"
  /** Stopped at an uncertainty, waiting for an answer. */
  | "asking";

/** The chain part covering a frame, if the chain covers it at all. */
export function partAtFrame(chain: ClaimChainPart[], frame: number): ClaimChainPart | null {
  return chain.find((part) => frame >= part.fromFrame && frame <= part.toFrame) ?? null;
}

/** The last frame the chain reaches, or null for an empty chain. */
export function chainEndFrame(chain: ClaimChainPart[]): number | null {
  if (!chain.length) return null;
  return Math.max(...chain.map((part) => part.toFrame));
}

export function chainStartFrame(chain: ClaimChainPart[]): number | null {
  if (!chain.length) return null;
  return Math.min(...chain.map((part) => part.fromFrame));
}

/**
 * The frame where playback must stop.
 *
 * Null means there is nothing left to ask, which is what a finished claim
 * looks like -- not a special "complete" flag, just no remaining uncertainty.
 */
export function stopFrame(chain: ClaimChain): number | null {
  return chain.nextUncertainty?.frame ?? null;
}

export function stopSeconds(chain: ClaimChain): number | null {
  const frame = stopFrame(chain);
  if (frame === null) return null;
  return frame / Math.max(chain.frameRate, 0.001);
}

/**
 * Whether playback has reached the stop.
 *
 * Deliberately >=, and checked on every timeupdate rather than by scheduling a
 * pause: timeupdate fires roughly every 250ms and a seek can jump straight
 * past the frame, so anything that waits for an exact moment will sail through
 * the question and attribute footage to the wrong person.
 */
export function reachedStop(chain: ClaimChain, trackingSeconds: number): boolean {
  const stop = stopSeconds(chain);
  return stop !== null && trackingSeconds >= stop;
}

/**
 * Which of the three things the person is doing right now.
 *
 * The rule that matters: if the chain does not cover where we are, we are
 * LOOKING for them, whatever else is true. That is the state right after "not
 * me from here", after an undo, and any time they scrub back to a stretch they
 * never claimed -- and in every one of those the only useful thing on screen is
 * "tap yourself". Deciding this from a flag instead of from the chain left the
 * panel saying "following you" over footage nobody was following anyone in.
 */
export function stageFor(
  chain: ClaimChain | null,
  frame: number,
  answered: boolean,
): ChainStage {
  if (!chain || chain.chain.length === 0) return "identify";
  if (!answered) return "asking";
  return partAtFrame(chain.chain, frame) ? "following" : "identify";
}

/**
 * The track the chain is following at this frame, if any.
 *
 * Chain parts name SOURCE track ids, which is why the chain flow builds its
 * bundle without merging identities -- see segmentAsBundle's mergeIdentities.
 */
export function followedTrack(
  bundle: ClaimBundle,
  chain: ClaimChainPart[],
  frame: number,
): ClaimTrack | null {
  const part = partAtFrame(chain, frame);
  if (!part) return null;
  return bundle.tracks.find((track) => track.id === part.trackId) ?? null;
}

export type ChainCandidate = {
  id: string;
  label: string;
  box: ClaimBox;
  /** This is the track the chain is currently following. */
  mine: boolean;
  /** The other party to the crossing that stopped us here. */
  suspect: boolean;
};

/**
 * Everyone visible at this frame, with the followed track and the suspected
 * swap partner marked.
 *
 * Every detected player is offered, not a shortlist. The swap detector is
 * weakest exactly where swaps are most likely -- two players moving in
 * parallel, where both readings fit -- so a picker that only offered the
 * detector's guesses would make its misses unrecoverable.
 */
export function candidatesAtFrame(
  bundle: ClaimBundle,
  chain: ClaimChain | null,
  frame: number,
  tolerance = 2,
): ChainCandidate[] {
  const parts = chain?.chain ?? [];
  const mineId = partAtFrame(parts, frame)?.trackId ?? null;
  const suspectId = chain?.nextUncertainty?.otherTrackId ?? null;
  const out: ChainCandidate[] = [];
  for (const track of bundle.tracks) {
    const box = detectionAtFrame(track, frame, tolerance);
    if (!box) continue;
    out.push({
      id: track.id,
      label: track.id === mineId ? (chain?.name ?? "You") : (track.label ?? "Player"),
      box,
      mine: track.id === mineId,
      suspect: suspectId !== null && track.id === suspectId,
    });
  }
  return out.sort((a, b) => a.box.x - b.box.x);
}

/** Claimed stretches as seconds, merged, for drawing on the seek bar. */
export function chainSpans(
  chain: ClaimChainPart[],
  frameRate: number,
): Array<{ fromSeconds: number; toSeconds: number }> {
  const fps = Math.max(frameRate, 0.001);
  const raw = chain
    .map((part) => ({
      fromSeconds: Math.max(0, part.fromFrame / fps),
      toSeconds: (part.toFrame + 1) / fps,
    }))
    .filter((span) => span.toSeconds > span.fromSeconds)
    .sort((a, b) => a.fromSeconds - b.fromSeconds);

  const merged: typeof raw = [];
  for (const span of raw) {
    const last = merged[merged.length - 1];
    if (last && span.fromSeconds <= last.toSeconds) {
      last.toSeconds = Math.max(last.toSeconds, span.toSeconds);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/**
 * Where to resume from after an answer.
 *
 * One frame past the stop, so answering the same question twice is impossible.
 * Resuming AT the stop re-triggers it immediately -- reachedStop is >= -- and
 * the person gets the same prompt forever.
 */
export function resumeSecondsAfter(chain: ClaimChain, frame: number): number {
  return (frame + 1) / Math.max(chain.frameRate, 0.001);
}

/** A plain sentence for the person, never a code. */
export function questionFor(chain: ClaimChain | null): string | null {
  const uncertainty = chain?.nextUncertainty;
  if (!uncertainty) return null;
  return uncertainty.reason;
}

/**
 * Whether we can even ask "is this still you" here.
 *
 * At a swap there is a real proposition to confirm: the chain carries on onto
 * something and the person can say whether that something is them.
 *
 * At a track end there is nothing to confirm. The player we were following has
 * stopped existing, so the only useful answers are "tap whoever I am now" or
 * "leave it"; a confirm there would be a label on a track with no future,
 * which teaches nothing.
 */
export function canConfirmAtStop(chain: ClaimChain | null): boolean {
  return chain?.nextUncertainty?.kind === "swap";
}

/**
 * How long to play into a check before it arrives.
 *
 * Seeking straight onto the frame in question drops the person on a still with
 * no idea what just happened. A few seconds of run-up is what makes a crossing
 * readable -- and it is the difference between answering the question and
 * guessing at it.
 */
export const CHECK_LEAD_IN_SECONDS = 4;

/**
 * Where to jump to in order to reach the next check.
 *
 * The flow is "fast forward until he sees that he is lost", and playing the
 * whole stretch in real time is not that: with checks minutes apart the person
 * watches the match instead of claiming it. Jumping to just before the check
 * skips everything nobody has a question about, which is most of it.
 *
 * Null when there is nothing left to check, or when the check is already
 * behind or within the run-up -- in both cases the right move is to leave
 * playback alone rather than yank it backwards.
 */
export function approachSeconds(
  chain: ClaimChain | null,
  currentSeconds: number,
  leadIn = CHECK_LEAD_IN_SECONDS,
): number | null {
  if (!chain) return null;
  const stop = stopSeconds(chain);
  if (stop === null) return null;
  const target = Math.max(0, stop - leadIn);
  return target > currentSeconds ? target : null;
}
