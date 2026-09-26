/**
 * Moments that are yours.
 *
 * Until now a claim earned a clip for every bundle event (goal, shot on
 * target, kick-off) that happened while the claimant was on the pitch --
 * "you were there", not "you did it". On a two-hour game that is eighty
 * shots, almost all of them other people's.
 *
 * With ball data the claim can say what the claimant did: the goals and shots
 * whose last touch was theirs, the take-ons they won, the long passes they
 * found a team-mate with. Each becomes a moment, and each carries a follow
 * path -- the claimant's own position through the clip's sixteen seconds --
 * so the exported clip is framed on them instead of the whole panorama.
 */
import type { CropKeyframe, TrackingManifest, TrackingSegmentPayload } from "@workspace/db";

import type { ChainEarnedClip } from "./claimChainState";
import {
  detectedGoals,
  detectedShots,
  kitOfParts,
  passEvents,
  playerMoments,
  playerPlay,
  seedTeams,
  type ClaimedPart,
} from "./matchPlay";
import type { RecordingPlay } from "./matchPlayLoad";

/** [tracking seconds, centre x, centre y] -- the claimant in the frame, as fractions of it. */
export type FollowPoint = [number, number, number];

export type PersonalMoment = ChainEarnedClip & { follow?: FollowPoint[] };

export const PERSONAL = {
  maxShots: 5,
  maxDribbles: 6,
  maxPasses: 4,
  /** a pass has to travel this far to be worth a clip, metres */
  longPassMetres: 12,
  /** half the clip, seconds (ensureClaimMomentUserClip cuts +/- 8 s) */
  halfWindow: 8,
} as const;

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * Where the claimant is, every second of a clip, as fractions of the frame.
 * Holes (off camera, between parts) keep the last known position so the
 * frame waits instead of jumping to the middle.
 */
export function followPath(
  parts: ClaimedPart[],
  segments: TrackingSegmentPayload[],
  manifest: Pick<TrackingManifest, "frameRate" | "width" | "height">,
  centreSeconds: number,
): FollowPoint[] | undefined {
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const tracks = new Map<string, Array<{ frame: number; x: number; y: number; w: number; h: number }>>();
  for (const segment of segments) for (const track of segment.tracks) tracks.set(track.id, track.boxes);
  const out: FollowPoint[] = [];
  let last: [number, number] | null = null;
  for (let k = -PERSONAL.halfWindow; k <= PERSONAL.halfWindow; k++) {
    const t = centreSeconds + k;
    const f = Math.round(t * fps);
    const part = parts.find((p) => f >= p.fromFrame && f <= p.toFrame);
    const boxes = part ? tracks.get(part.trackId) : undefined;
    let best: { frame: number; x: number; y: number; w: number; h: number } | null = null;
    if (boxes?.length) {
      let lo = 0;
      let hi = boxes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (boxes[mid].frame < f) lo = mid + 1; else hi = mid;
      }
      for (const i of [lo - 1, lo]) {
        const b = boxes[i];
        if (b && Math.abs(b.frame - f) <= fps / 2 && (!best || Math.abs(b.frame - f) < Math.abs(best.frame - f))) best = b;
      }
    }
    if (best) last = [(best.x + best.w / 2) / manifest.width, (best.y + best.h / 2) / manifest.height];
    if (last) out.push([t, last[0], last[1]]);
  }
  if (!out.length) return undefined;
  // positions before the first sighting take the first one
  const first = out[0];
  const filled: FollowPoint[] = [];
  for (let k = -PERSONAL.halfWindow; k <= PERSONAL.halfWindow; k++) {
    const t = centreSeconds + k;
    const hit = out.find((p) => p[0] === t) ?? (t < first[0] ? [t, first[1], first[2]] as FollowPoint : null);
    if (hit) filled.push(hit);
  }
  // a 3-point moving average: the tracker's box jitters, a camera should not
  return filled.map((p, i) => {
    const w = filled.slice(Math.max(0, i - 1), i + 2);
    return [p[0], w.reduce((s, q) => s + q[1], 0) / w.length, w.reduce((s, q) => s + q[2], 0) / w.length];
  });
}

/**
 * The follow path as crop keyframes for a clip cut from `startSeconds` to
 * `endSeconds` of the video: a 16:9 frame about a third of the panorama wide,
 * centred on the player, held inside the picture.
 */
export function followCrop(
  follow: FollowPoint[] | undefined,
  videoStartSeconds: number,
  startSeconds: number,
  endSeconds: number,
  sourceAspect: number,
): CropKeyframe[] {
  if (!follow?.length || endSeconds <= startSeconds) return [];
  const w = 0.34;
  const h = Math.min(1, (w * sourceAspect) / (16 / 9));
  const clampOrigin = (v: number, size: number) => Math.max(Math.min(0, 1 - size), Math.min(Math.max(0, 1 - size), v));
  const span = endSeconds - startSeconds;
  const frames: CropKeyframe[] = [];
  for (const [t, cx, cy] of follow) {
    const at = (t + videoStartSeconds - startSeconds) / span;
    if (at < -0.05 || at > 1.05) continue;
    frames.push({
      t: Math.max(0, Math.min(1, at)),
      x: clampOrigin(cx - w / 2, w),
      // players' boxes sit low in the frame; keep a little more above them
      y: clampOrigin(cy - h * 0.55, h),
      w,
      h,
    });
  }
  return frames;
}

export function personalMoments(
  play: RecordingPlay,
  parts: ClaimedPart[],
  segments: TrackingSegmentPayload[],
  manifest: TrackingManifest,
): PersonalMoment[] {
  if (!play.hasBall || !parts.length) return [];
  const goals = detectedGoals(play.events, play.touches);
  const shots = detectedShots(play.events, play.touches);
  const own = playerMoments(parts, play.dribbles, goals, shots);
  const pick = seedTeams(kitOfParts(parts, play.sidecars, play.fps), play.kitOptions);
  const passes = playerPlay(play.touches, passEvents(play.touches, pick), parts, Boolean(pick)).passes
    .filter((p) => p.give && p.completed && p.metres >= PERSONAL.longPassMetres)
    .sort((a, b) => b.metres - a.metres)
    .slice(0, PERSONAL.maxPasses);
  const follow = (t: number) => followPath(parts, segments, manifest, t);
  const moments: PersonalMoment[] = [];
  for (const g of own.goals) {
    moments.push({ id: `me-goal-${Math.round(g.t)}`, title: `Your goal · ${clock(g.t)}`, momentSeconds: g.t, kind: "your-goal", status: "ready", follow: follow(g.t) });
  }
  for (const s of own.shots.slice(0, PERSONAL.maxShots)) {
    if (own.goals.some((g) => Math.abs(g.t - s.t) < 10)) continue;
    moments.push({ id: `me-shot-${Math.round(s.t)}`, title: `Your shot on target · ${clock(s.t)}`, momentSeconds: s.t, kind: "your-shot", status: "ready", follow: follow(s.t) });
  }
  const won = own.dribbles
    .filter((d) => d.outcome === "won")
    .sort((a, b) => (b.metres ?? 0) - (a.metres ?? 0) || a.closestMetres - b.closestMetres)
    .slice(0, PERSONAL.maxDribbles);
  for (const d of won) {
    const t = (d.t0 + d.t1) / 2;
    moments.push({ id: `me-dribble-${Math.round(d.t0)}`, title: `You beat your man · ${clock(d.t0)}`, momentSeconds: t, kind: "dribble", status: "ready", follow: follow(t) });
  }
  for (const p of passes) {
    const t = (p.t0 + p.t1) / 2;
    moments.push({ id: `me-pass-${Math.round(p.t0)}`, title: `Pass found · ${Math.round(p.metres)} m · ${clock(p.t0)}`, momentSeconds: t, kind: "long-pass", status: "ready", follow: follow(t) });
  }
  return moments.sort((a, b) => a.momentSeconds - b.momentSeconds);
}

/**
 * The claim's moments: its own, plus the bundle's events it was on the pitch
 * for -- but with ball data, only the goals among those (a shot on target by
 * someone else is not your moment), and none that repeat one of yours.
 */
export function mergeMoments(events: ChainEarnedClip[], mine: PersonalMoment[]): PersonalMoment[] {
  if (!mine.length) return events;
  const kept = events.filter((e) => {
    const kind = e.kind.toLowerCase();
    if (kind === "shot") return false;
    return !mine.some((m) => Math.abs(m.momentSeconds - e.momentSeconds) < 10);
  });
  return [...kept, ...mine].sort((a, b) => a.momentSeconds - b.momentSeconds);
}
