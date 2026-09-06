import type { TrackingIdentity, TrackingSegment } from "@workspace/api-client-react";

type Box = TrackingSegment["tracks"][number]["boxes"][number];

/**
 * A stretch of a track the identity board has set aside or ruled out.
 *
 * Mirrors TrackingManifest.identityDecisions. "parked" and "deleted" differ
 * only in intent on the board -- neither is a player anyone should be offered.
 */
export type ClaimIdentityDecision = {
  trackId: string;
  fromFrame: number;
  toFrame: number;
  action?: string;
};

function isStruckOff(
  decisions: ClaimIdentityDecision[] | undefined,
  trackId: string,
  frame: number,
): boolean {
  if (!decisions?.length) return false;
  return decisions.some((decision) =>
    decision.trackId === trackId && frame >= decision.fromFrame && frame <= decision.toFrame);
}

/**
 * Drop every box the board struck off, before anything else looks at them.
 *
 * identityDecisions has been written by the board, sent down on the manifest
 * and validated on save since it was introduced -- and read by nothing on this
 * side. Deleting a person on the identity board therefore left them fully
 * present in the video and in every candidate list, which is the whole of the
 * complaint that removing someone on the board did not remove them from the
 * video. Filtering here rather than at each use site means a struck-off
 * stretch cannot reappear through a path that forgot to ask.
 */
function withoutStruckOffBoxes(
  segment: TrackingSegment,
  decisions: ClaimIdentityDecision[] | undefined,
): TrackingSegment {
  if (!decisions?.length) return segment;
  const tracks = segment.tracks.map((track) => {
    const boxes = track.boxes.filter((box) => !isStruckOff(decisions, track.id, box.frame));
    if (boxes.length === track.boxes.length) return track;
    return {
      ...track,
      boxes,
      startFrame: boxes[0]?.frame ?? track.startFrame,
      endFrame: boxes.at(-1)?.frame ?? track.endFrame,
    };
  });
  const crossings = segment.crossings.filter((crossing) =>
    !isStruckOff(decisions, crossing.trackId, crossing.frame)
    && !isStruckOff(decisions, crossing.otherTrackId, crossing.frame));
  return { ...segment, tracks, crossings };
}
type Track = TrackingSegment["tracks"][number];
type Crossing = TrackingSegment["crossings"][number];

type IdentityApplication = {
  tracks: TrackingSegment["tracks"];
  crossings: TrackingSegment["crossings"];
};

type Piece = {
  outputId: string;
  sourceTrackId: string;
  fromFrame: number;
  toFrame: number;
};

function partForFrame(
  trackId: string,
  frame: number,
  identities: TrackingIdentity[],
): TrackingIdentity | null {
  return identities.find((identity) =>
    identity.parts.some((part) =>
      part.trackId === trackId && frame >= part.fromFrame && frame <= part.toFrame,
    ),
  ) ?? null;
}

function sourcePieceId(segmentIndex: number, trackId: string, fromFrame: number): string {
  return `unclaimed:${segmentIndex}:${trackId}:${fromFrame}`;
}

function trackBounds(boxes: Box[]): Pick<Track, "startFrame" | "endFrame"> {
  return {
    startFrame: boxes[0]?.frame ?? 0,
    endFrame: boxes.at(-1)?.frame ?? 0,
  };
}

/**
 * Apply frame-bounded identity parts without collapsing a split source track
 * into one global name. The generated unclaimed pieces intentionally retain a
 * distinct id so claim coverage cannot jump across an unassigned interval.
 */
export function applyClaimIdentities(
  segment: TrackingSegment,
  identities: TrackingIdentity[] | undefined,
  decisions?: ClaimIdentityDecision[],
): IdentityApplication {
  const source = withoutStruckOffBoxes(segment, decisions);
  const sourceTracks = source.tracks.filter((track) => track.boxes.length > 0);
  if (!identities?.length) {
    return {
      tracks: sourceTracks,
      crossings: source.crossings.filter((crossing) => crossing.trackId !== crossing.otherTrackId),
    };
  }

  const piecesBySource = new Map<string, Piece[]>();
  const assignedBoxes = new Map<string, Box[]>();
  const unclaimedBoxes = new Map<string, Box[]>();

  for (const track of sourceTracks) {
    const boxes = [...track.boxes].sort((a, b) => a.frame - b.frame);
    const sourcePieces: Piece[] = [];
    let currentUnclaimed: Piece | null = null;

    for (const box of boxes) {
      const identity = partForFrame(track.id, box.frame, identities);
      if (identity) {
        (assignedBoxes.get(identity.id) ?? (assignedBoxes.set(identity.id, []), assignedBoxes.get(identity.id)!)).push(box);
        currentUnclaimed = null;
        sourcePieces.push({
          outputId: identity.id,
          sourceTrackId: track.id,
          fromFrame: box.frame,
          toFrame: box.frame,
        });
        continue;
      }

      const previous = sourcePieces.at(-1);
      if (
        currentUnclaimed
        && previous?.outputId === currentUnclaimed.outputId
        && currentUnclaimed.toFrame + 1 >= box.frame
      ) {
        currentUnclaimed.toFrame = box.frame;
      } else {
        currentUnclaimed = {
          outputId: sourcePieceId(source.segmentIndex, track.id, box.frame),
          sourceTrackId: track.id,
          fromFrame: box.frame,
          toFrame: box.frame,
        };
        sourcePieces.push(currentUnclaimed);
      }
      (unclaimedBoxes.get(currentUnclaimed.outputId) ?? (unclaimedBoxes.set(currentUnclaimed.outputId, []), unclaimedBoxes.get(currentUnclaimed.outputId)!)).push(box);
    }
    piecesBySource.set(track.id, sourcePieces);
  }

  const merged: TrackingSegment["tracks"] = [];
  for (const identity of identities) {
    const boxes = assignedBoxes.get(identity.id);
    if (!boxes?.length) continue;
    boxes.sort((a, b) => a.frame - b.frame);
    merged.push({
      id: identity.id,
      label: identity.name ?? null,
      ...trackBounds(boxes),
      boxes,
    });
  }

  for (const track of sourceTracks) {
    const sourcePieces = piecesBySource.get(track.id) ?? [];
    const hasIdentityPiece = sourcePieces.some((piece) => !piece.outputId.startsWith("unclaimed:"));
    if (!hasIdentityPiece) {
      merged.push(track);
      continue;
    }
    for (const piece of sourcePieces.filter((item) => item.outputId.startsWith("unclaimed:"))) {
      const boxes = unclaimedBoxes.get(piece.outputId) ?? [];
      if (!boxes.length) continue;
      merged.push({
        id: piece.outputId,
        label: "Unclaimed",
        ...trackBounds(boxes),
        boxes,
      });
    }
  }

  const resolve = (trackId: string, frame: number): string => {
    // Crossings are event frames, not necessarily box frames. Prefer the
    // persisted identity interval so a sparse track is still remapped.
    const identity = partForFrame(trackId, frame, identities);
    if (identity) return identity.id;
    const pieces = piecesBySource.get(trackId);
    const piece = pieces?.find((item) => frame >= item.fromFrame && frame <= item.toFrame);
    return piece?.outputId ?? trackId;
  };
  const crossings: Crossing[] = [];
  for (const crossing of source.crossings) {
    const next = {
      ...crossing,
      trackId: resolve(crossing.trackId, crossing.frame),
      otherTrackId: resolve(crossing.otherTrackId, crossing.frame),
    };
    if (next.trackId !== next.otherTrackId) crossings.push(next);
  }

  return {
    tracks: merged.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)),
    crossings,
  };
}

export function identityMapMatchesBundle(
  manifest: { identities?: TrackingIdentity[]; provenance?: Record<string, unknown> },
): boolean {
  if (!manifest.identities?.length) return true;
  const provenance = manifest.provenance ?? {};
  return typeof provenance.bundleFingerprint === "string"
    && provenance.bundleFingerprint === provenance.identityMapBundleFingerprint;
}