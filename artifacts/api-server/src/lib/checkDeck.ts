/**
 * "Is this you?" (2026-10-25): the moments Replay is not sure were the
 * claimant's, for him to swipe through after claiming himself.
 *
 * A claim is pieces of tracks. A moment (a shot, a take-on, a long pass, a
 * goal) is credited to whoever holds the ball's touch, so it is wrong when
 * the piece under it is someone else. The places a piece goes wrong are
 * known: where a team-mate brushes past (the tracker can swap them), where two
 * pieces were stitched together, where someone else stands right next to him,
 * and on short pieces. A moment at one of those places is UNSURE: it waits
 * for the claimant's answer before it becomes a clip.
 *
 *   yes  -- it becomes a clip and counts;
 *   no   -- the stretch of that piece around the moment comes off his claim;
 *   skip -- it stays out and is not asked again.
 *
 * Goal candidates nobody has confirmed ride in the same deck (goalReview).
 * Everything here is pure; the route reads and writes.
 */
import type { TrackingManifest } from "@workspace/db";
import { interpolatePitchPosition } from "./pitchModel";
import { kitDistance, type ClaimedPart, type Lab } from "./matchPlay";
import type { PersonalMoment } from "./personalMoments";
import type { ReviewedGoal } from "./goalReview";

export const CHECK = {
  /**
   * someone in his colours came this close (feet, the minimap) within
   * teammateSeconds of the moment: the kit veto keeps the tracker from
   * swapping him with an opponent, not with a team-mate. On recording 394 and
   * job 27 this flags ~15% of credited moments (10 of 53, 8 of 61). The
   * bundle's own "crossings" are no use here: ~3,300 per 10 minutes.
   */
  teammateMetres: 1.5,
  teammateSeconds: 2,
  /** two shirts this close (kitDistance) are the same colours */
  sameKit: 15,
  /** a stitch to another track's piece this close to the moment, seconds */
  joinSeconds: 2.5,
  /** ...a stitch: the other piece ends or starts within this of this one, seconds */
  joinGapSeconds: 2,
  /** another player's feet this close to his at the moment, metres (the minimap) */
  crowdMetres: 1.2,
  /** a piece shorter than this is itself a doubt, seconds */
  shortPieceSeconds: 8,
  /** cards per deck: his moments, then goal candidates */
  maxYou: 10,
  maxGoals: 3,
  /**
   * how much of the video a card plays, around the moment, seconds. Short on
   * purpose: a card costs the HLS fragments it covers (3840x1080, ~7 Mbit/s),
   * and six seconds is enough to see who it was.
   */
  youBefore: 2.5,
  youAfter: 3.5,
  goalBefore: 4,
  goalAfter: 2.5,
  /** "not me" takes this much of the piece either side of the moment off the claim, seconds */
  cutSeconds: 5,
  /** focus keyframes every this, seconds */
  focusStep: 0.25,
} as const;

/** The moment kinds a claimant is credited with (personalMoments), the ones a deck can ask about. */
export const CHECKABLE = ["your-goal", "your-shot", "dribble", "long-pass"] as const;

export type CheckReason = "teammate" | "join" | "crowd" | "short";

export type UnsureMoment = {
  moment: PersonalMoment;
  part: ClaimedPart;
  frame: number;
  reasons: CheckReason[];
};

type Box = { frame: number; x: number; y: number; w: number; h: number };
type SegmentLike = {
  tracks: ReadonlyArray<{ id: string; boxes: ReadonlyArray<Box> }>;
};

export function boxNear(boxes: ReadonlyArray<Box> | undefined, frame: number, within: number): Box | null {
  if (!boxes?.length) return null;
  let lo = 0, hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].frame < frame) lo = mid + 1; else hi = mid;
  }
  let best: Box | null = null;
  for (const i of [lo - 1, lo]) {
    const b = boxes[i];
    if (b && Math.abs(b.frame - frame) <= within && (!best || Math.abs(b.frame - frame) < Math.abs(best.frame - frame))) best = b;
  }
  return best;
}

export function trackIndex(segments: readonly SegmentLike[]): Map<string, ReadonlyArray<Box>> {
  const out = new Map<string, ReadonlyArray<Box>>();
  for (const segment of segments) for (const track of segment.tracks) out.set(track.id, track.boxes);
  return out;
}

/**
 * The claimant's moments that sit where a piece can be someone else, with the
 * reasons, the surest-to-be-wrong first. Deterministic for the same inputs: the
 * deck and the clip award must agree on which moments wait.
 */
export function unsureMoments(
  moments: readonly PersonalMoment[],
  parts: readonly ClaimedPart[],
  segments: readonly SegmentLike[],
  manifest: Pick<TrackingManifest, "frameRate" | "width" | "height" | "pitchModel">,
  /** every track's shirt (RecordingPlay.kits), for telling team-mates */
  kits: ReadonlyMap<string, Lab> = new Map(),
): UnsureMoment[] {
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const tracks = trackIndex(segments);
  const feetAt = (id: string, f: number, within: number) => {
    const b = boxNear(tracks.get(id), f, within);
    return b ? interpolatePitchPosition(b.x + b.w / 2, b.y + b.h, manifest as TrackingManifest) : null;
  };
  const out: UnsureMoment[] = [];
  for (const moment of moments) {
    if (!(CHECKABLE as readonly string[]).includes(moment.kind)) continue;
    const frame = Math.round(moment.momentSeconds * fps);
    const part = parts.find((p) => frame >= p.fromFrame && frame <= p.toFrame);
    if (!part) continue;
    const reasons: CheckReason[] = [];
    const myKit = kits.get(part.trackId);
    if (manifest.pitchModel && myKit) {
      const mates = [...tracks.keys()].filter((id) => id !== part.trackId && kits.has(id) && kitDistance(kits.get(id)!, myKit) < CHECK.sameKit);
      const span = Math.round(CHECK.teammateSeconds * fps), step = Math.max(1, Math.round(fps / 5));
      outer: for (let f = frame - span; f <= frame + span; f += step) {
        const me = feetAt(part.trackId, f, step);
        if (!me) continue;
        for (const id of mates) {
          const o = feetAt(id, f, step);
          if (o && Math.hypot(o.x - me.x, o.y - me.y) <= CHECK.teammateMetres) { reasons.push("teammate"); break outer; }
        }
      }
    }
    const gap = CHECK.joinGapSeconds * fps;
    const nearStart = frame - part.fromFrame <= CHECK.joinSeconds * fps
      && parts.some((p) => p !== part && p.trackId !== part.trackId && p.toFrame >= part.fromFrame - gap && p.toFrame <= part.fromFrame + 1);
    const nearEnd = part.toFrame - frame <= CHECK.joinSeconds * fps
      && parts.some((p) => p !== part && p.trackId !== part.trackId && p.fromFrame <= part.toFrame + gap && p.fromFrame >= part.toFrame - 1);
    if (nearStart || nearEnd) reasons.push("join");
    if (manifest.pitchModel) {
      const me = feetAt(part.trackId, frame, fps / 2);
      if (me) {
        for (const id of tracks.keys()) {
          if (id === part.trackId) continue;
          const p = feetAt(id, frame, fps / 4);
          if (p && Math.hypot(p.x - me.x, p.y - me.y) <= CHECK.crowdMetres) { reasons.push("crowd"); break; }
        }
      }
    }
    if ((part.toFrame - part.fromFrame) / fps < CHECK.shortPieceSeconds) reasons.push("short");
    if (reasons.length) out.push({ moment, part, frame, reasons });
  }
  return out.sort((a, b) => b.reasons.length - a.reasons.length || a.moment.momentSeconds - b.moment.momentSeconds);
}

/** The stretch of the piece a "not me" takes off the claim. */
export function notMeCut(unsure: Pick<UnsureMoment, "part" | "frame">, frameRate: number): ClaimedPart {
  const fps = frameRate > 0 ? frameRate : 20;
  const half = Math.round(CHECK.cutSeconds * fps);
  return {
    trackId: unsure.part.trackId,
    fromFrame: Math.max(unsure.part.fromFrame, unsure.frame - half),
    toFrame: Math.min(unsure.part.toFrame, unsure.frame + half),
  };
}

/** Take every cut off a claim's parts, splitting a part the cut lands inside. */
export function applyCuts<T extends ClaimedPart>(parts: readonly T[], cuts: readonly ClaimedPart[]): T[] {
  let out = parts.map((part) => ({ ...part }));
  for (const cut of cuts) {
    const next: T[] = [];
    for (const part of out) {
      if (part.trackId !== cut.trackId || part.toFrame < cut.fromFrame || part.fromFrame > cut.toFrame) { next.push(part); continue; }
      if (part.fromFrame < cut.fromFrame) next.push({ ...part, toFrame: cut.fromFrame - 1 });
      if (part.toFrame > cut.toFrame) next.push({ ...part, fromFrame: cut.toFrame + 1 });
    }
    out = next;
  }
  return out;
}

/* ------------------------------------------------------------------ cards */

/** [video seconds, centre x, centre y, width, height], fractions of the frame */
export type FocusPoint = [number, number, number, number, number];

export type DeckCard = {
  id: string;
  kind: "you" | "goal";
  /** video seconds: the moment, and the stretch the card plays */
  at: number;
  start: number;
  end: number;
  /** "mm:ss" of the moment, as clips title it */
  clock: string;
  focus: FocusPoint[];
  you?: {
    momentId: string;
    momentKind: (typeof CHECKABLE)[number];
    metres: number | null;
    beaten: number | null;
    reasons: CheckReason[];
  };
  goal?: {
    recordingId: number;
    key: number;
    source: ReviewedGoal["source"];
    likely: boolean;
    /** whose goal it would be, from the claimant's shirt: his side's, the other side's, or not known */
    side: "yours" | "theirs" | null;
    ownGoal: boolean;
  };
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;
export const clockOf = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Where the claimant is through a card, from his pieces' boxes, every CHECK.focusStep. */
export function partsFocus(
  parts: readonly ClaimedPart[],
  tracks: Map<string, ReadonlyArray<Box>>,
  manifest: Pick<TrackingManifest, "frameRate" | "width" | "height">,
  fromSeconds: number,
  toSeconds: number,
  videoStartSeconds: number,
  prefer: string | null = null,
): FocusPoint[] {
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const out: FocusPoint[] = [];
  let last: FocusPoint | null = null;
  for (let t = fromSeconds; t <= toSeconds + 1e-6; t += CHECK.focusStep) {
    const f = Math.round(t * fps);
    const part = (prefer ? parts.find((p) => p.trackId === prefer && f >= p.fromFrame && f <= p.toFrame) : null)
      ?? parts.find((p) => f >= p.fromFrame && f <= p.toFrame);
    const trackId = part?.trackId ?? prefer;
    const b = trackId ? boxNear(tracks.get(trackId), f, fps / 2) : null;
    if (b) {
      last = [round3(t + videoStartSeconds), round3((b.x + b.w / 2) / manifest.width), round3((b.y + b.h / 2) / manifest.height),
        round3(b.w / manifest.width), round3(b.h / manifest.height)];
      out.push(last);
    } else if (last) {
      out.push([round3(t + videoStartSeconds), last[1], last[2], last[3], last[4]]);
    }
  }
  // before the first sighting, hold the first
  if (out.length && out[0][0] > fromSeconds + videoStartSeconds + 1e-3) {
    out.unshift([round3(fromSeconds + videoStartSeconds), out[0][1], out[0][2], out[0][3], out[0][4]]);
  }
  return out;
}

/** Where the ball is through a card (the 4 Hz sidecar samples), a small box round it. */
export function ballFocus(
  ball: ReadonlyArray<readonly [number, number, number, ...number[]]>,
  manifest: Pick<TrackingManifest, "frameRate" | "width" | "height">,
  fromSeconds: number,
  toSeconds: number,
  videoStartSeconds: number,
): FocusPoint[] {
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const near = ball.filter((b) => b[0] >= (fromSeconds - 1) * fps && b[0] <= (toSeconds + 1) * fps).slice().sort((a, b) => a[0] - b[0]);
  const out: FocusPoint[] = [];
  let last: FocusPoint | null = null;
  const size = 0.02;
  for (let t = fromSeconds; t <= toSeconds + 1e-6; t += CHECK.focusStep) {
    const f = t * fps;
    let best: readonly number[] | null = null;
    for (const b of near) if (Math.abs(b[0] - f) <= fps * 0.6 && (!best || Math.abs(b[0] - f) < Math.abs(best[0] - f))) best = b;
    if (best) last = [round3(t + videoStartSeconds), round3(best[1] / manifest.width), round3(best[2] / manifest.height), size, size * manifest.width / manifest.height];
    if (last) out.push([round3(t + videoStartSeconds), last[1], last[2], last[3], last[4]]);
  }
  if (out.length && out[0][0] > fromSeconds + videoStartSeconds + 1e-3) out.unshift([round3(fromSeconds + videoStartSeconds), out[0][1], out[0][2], out[0][3], out[0][4]]);
  return out;
}

/** "Your dribble · 9 m past 1 player · 12:03" -> 9 and 1; nothing found is null. */
export function momentNumbers(title: string): { metres: number | null; beaten: number | null } {
  const metres = /(\d+(?:\.\d+)?)\s*m\b/.exec(title);
  const beaten = /past (\d+) player/.exec(title);
  return { metres: metres ? Number(metres[1]) : null, beaten: beaten ? Number(beaten[1]) : null };
}

/**
 * Goal candidates for this claimant's deck: open ones he has not answered,
 * the detector's own first ("likely"), then goals.py events, then shots. The
 * shots are spread between players -- each claimant gets a different few, by
 * a stable hash of who he is -- so a match's chances get looked at by many
 * pairs of eyes instead of every player seeing the same three.
 */
export function goalCardsFor(reviewed: readonly ReviewedGoal[], userId: number, answeredKeys: ReadonlySet<number>, limit: number = CHECK.maxGoals): ReviewedGoal[] {
  const open = reviewed.filter((g) => g.status === "open" && !answeredKeys.has(g.key));
  const rank = (g: ReviewedGoal) => (g.source === "goal" ? 0 : g.source === "event" ? 1 : 2);
  const spread = (g: ReviewedGoal) => {
    let h = 2166136261 ^ userId;
    for (const c of String(g.key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  };
  return open.slice().sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? spread(a) - spread(b) : a.t - b.t)).slice(0, limit)
    .sort((a, b) => a.t - b.t);
}
