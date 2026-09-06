import type { ClaimMatchResponse, TrackingSegment } from "@workspace/api-client-react";
import { applyClaimIdentities, identityMapMatchesBundle } from "./claim-match-identities";
import type { ClaimBox, ClaimBundle, ClaimTrack } from "./claim-match-engine";

/**
 * One tracking segment, assembled into the bundle the player and the overlay
 * both read.
 *
 * `mergeIdentities` is the difference between the two claim flows, and it
 * matters more than it looks.
 *
 * The anchor flow shows PEOPLE: applyClaimIdentities rewrites the segment so a
 * track covered by an identity comes back keyed by that identity's id, with
 * the unassigned stretches split off as "unclaimed:..." pieces. Picking one is
 * picking a person.
 *
 * The chain flow shows TRACKS. A chain part names a source track id, so if the
 * boxes were re-keyed to identity ids a tap would send an id the server has
 * never heard of -- and worse, the claimant's own identity would swallow their
 * own tracks the moment they made their first tap, so the second tap would be
 * on a track that no longer exists under that name. The board's merges are not
 * lost by doing this: extendChain applies them server-side, where the identity
 * map actually lives.
 *
 * identityDecisions are applied either way. A piece the board struck off is
 * struck off regardless of which flow is looking at it, and regardless of
 * whether the identity map still matches this bundle -- offering a deleted
 * player is worse than offering an ungrouped one.
 */
export function segmentAsBundle(
  manifest: ClaimMatchResponse["manifest"],
  segment: TrackingSegment,
  options: { mergeIdentities?: boolean } = {},
): ClaimBundle {
  const mergeIdentities = options.mergeIdentities ?? true;
  const identities = mergeIdentities && identityMapMatchesBundle(manifest)
    ? manifest.identities
    : undefined;
  const applied = applyClaimIdentities(segment, identities, manifest.identityDecisions);
  const totalDuration = Math.max(
    manifest.duration,
    ...manifest.segments.map((range) => range.endSeconds),
  );
  return {
    version: manifest.version,
    label: manifest.label,
    width: manifest.width,
    height: manifest.height,
    frameRate: manifest.frameRate,
    frameCount: manifest.frameCount,
    duration: totalDuration,
    matchOffset: manifest.matchOffset,
    videoStartSeconds: manifest.videoStartSeconds ?? 0,
    tracks: applied.tracks,
    crossings: applied.crossings,
    inPlaySpans: segment.inPlaySpans,
    events: segment.events,
  };
}

/** The nearest detection to a frame, or null if the track is not there. */
export function detectionAtFrame(
  track: ClaimTrack,
  frame: number,
  tolerance = 2,
): ClaimBox | null {
  return track.boxes.reduce<ClaimBox | null>((nearest, candidate) => {
    if (Math.abs(candidate.frame - frame) > tolerance) return nearest;
    if (!nearest || Math.abs(candidate.frame - frame) < Math.abs(nearest.frame - frame)) {
      return candidate;
    }
    return nearest;
  }, null);
}
