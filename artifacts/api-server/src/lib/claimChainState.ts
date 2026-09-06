/**
 * What a chain claim is worth: coverage, clips, and whether it is finished.
 *
 * The anchor model derived all of this from votes on sampled checkpoints. That
 * is why its rules look the way they do -- a clip was awarded to an event
 * within twelve seconds of a checkpoint you happened to be asked about, which
 * is a proximity gate standing in for the thing nobody could measure: whether
 * you were actually on the pitch when it happened. A chain measures that
 * directly and continuously, so the stand-in goes and the real rule is used.
 *
 * Pure. No database, no clock. The award rule is the part people will argue
 * about, so it is the part that must be testable without a video.
 */
import type { TrackingManifest } from "@workspace/db";
import { chainIntervals, totalSeconds, type ChainPart } from "./claimChain";

/** Kept identical to the anchor flow's ids so a clip already materialised for
 * a person is recognised rather than duplicated when they re-claim. */
const CLIP_EVENT_TYPES = new Set(["goal", "shot", "kickoff", "second-half", "second_half"]);

export type ChainEarnedClip = {
  id: string;
  title: string;
  momentSeconds: number;
  kind: string;
  status: string;
};

export const CHAIN_COMPLETION = {
  /**
   * Carried over from the anchor model unchanged, deliberately. The evidence
   * behind the number is stronger here -- it is watched, confirmed time rather
   * than an extrapolation from a checkpoint -- so moving the bar at the same
   * time as changing what it measures would make the two impossible to
   * compare.
   */
  requiredCoveragePercent: 60,
  shortMatchSeconds: 120,
  shortMatchCoveragePercent: 55,
};

export type ChainClaimEvent = {
  type: string;
  time: number;
  label?: string | null;
  clipId?: string | null;
};

export type ChainClaimSegment = {
  tracks: Array<{ id: string }>;
  events: ChainClaimEvent[];
};

export type ChainClaimState = {
  attributed: Array<{ startSeconds: number; endSeconds: number }>;
  coverageSeconds: number;
  coveragePercent: number;
  /**
   * Every part of the chain, as a vouched fragment.
   *
   * This is the whole of it, and it is why the chain is stronger evidence than
   * what it replaces: an anchor answer vouched for one instant and the rest of
   * the track was inferred around it, so `inferredSeconds` was usually most of
   * the claim. Here the person watched every second they are claiming, so
   * vouched and attributed are the same set and inferred time is zero.
   */
  vouchedFragments: ChainPart[];
  earnedClips: ChainEarnedClip[];
  matchedEvents: number;
  trackedSegments: number;
  completed: boolean;
  completionReason: string;
};

function formatMoment(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * The clips a chain earns: every scoreable event inside the stretch the person
 * is confirmed to have been on the pitch for.
 *
 * The anchor flow additionally required the event to be within twelve seconds
 * of an answered checkpoint. That was never the rule anyone wanted -- it was
 * the only way to approximate "were you there" from eight samples, and it lost
 * every goal that happened to fall between checkpoints.
 */
export function clipsForIntervals(
  segments: ChainClaimSegment[],
  attributed: Array<{ startSeconds: number; endSeconds: number }>,
): ChainEarnedClip[] {
  const byId = new Map<string, ChainEarnedClip>();
  for (const event of segments.flatMap((segment) => segment.events)) {
    if (!CLIP_EVENT_TYPES.has(event.type.toLowerCase())) continue;
    const inside = attributed.some((interval) =>
      event.time >= interval.startSeconds && event.time <= interval.endSeconds);
    if (!inside) continue;
    const clip: ChainEarnedClip = {
      id: event.clipId ?? `claim-${event.type}-${Math.round(event.time)}`,
      title: event.label ?? `${event.type.replace(/[-_]/g, " ")} at ${formatMoment(event.time)}`,
      momentSeconds: event.time,
      kind: event.type,
      status: "ready",
    };
    byId.set(clip.id, clip);
  }
  return [...byId.values()].sort((a, b) => a.momentSeconds - b.momentSeconds);
}

export function deriveChainClaimState(
  manifest: Pick<TrackingManifest, "frameRate" | "duration">,
  segments: ChainClaimSegment[],
  chain: ChainPart[],
  opts: {
    offPitch?: Array<{ fromSeconds: number; toSeconds: number }>;
    /** True while an uncertainty is still waiting for an answer. */
    hasOpenQuestion: boolean;
  },
): ChainClaimState {
  const offPitch = opts.offPitch ?? [];
  const attributed = chainIntervals(chain, manifest, offPitch);
  const coverageSeconds = totalSeconds(attributed);
  const offPitchSeconds = totalSeconds(offPitch.map((span) => ({
    startSeconds: span.fromSeconds,
    endSeconds: span.toSeconds,
  })));
  const denominator = Math.max(manifest.duration - offPitchSeconds, 1);
  const coveragePercent = Math.min(
    100,
    Math.round((coverageSeconds / denominator) * 10000) / 100,
  );

  const required = manifest.duration < CHAIN_COMPLETION.shortMatchSeconds
    ? CHAIN_COMPLETION.shortMatchCoveragePercent
    : CHAIN_COMPLETION.requiredCoveragePercent;

  const claimedTrackIds = new Set(chain.map((part) => part.trackId));
  const trackedSegments = segments.filter((segment) =>
    segment.tracks.some((track) => claimedTrackIds.has(track.id))).length;

  const earnedClips = clipsForIntervals(segments, attributed);
  const matchedEvents = segments
    .flatMap((segment) => segment.events)
    .filter((event) => attributed.some((interval) =>
      event.time >= interval.startSeconds && event.time <= interval.endSeconds))
    .length;

  // An open question blocks completion on purpose. The person is mid-answer
  // about a stretch we are not sure of, and awarding the match on the strength
  // of a claim we are actively querying would be settling the question by
  // ignoring it.
  const completed = chain.length > 0
    && !opts.hasOpenQuestion
    && coveragePercent >= required;
  const completionReason = completed
    ? `Followed for ${coverageSeconds.toFixed(1)}s (${coveragePercent}% of the match) with nothing left to check.`
    : chain.length === 0
      ? "No part of the match has been claimed yet."
      : opts.hasOpenQuestion
        ? "There is still a moment waiting for an answer."
        : `Coverage is ${coveragePercent}%; ${required}% is needed.`;

  return {
    attributed,
    coverageSeconds,
    coveragePercent,
    vouchedFragments: chain.map((part) => ({ ...part })),
    earnedClips,
    matchedEvents,
    trackedSegments,
    completed,
    completionReason,
  };
}
