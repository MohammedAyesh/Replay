import type { CoachBall, CoachBox } from "@workspace/api-zod";
import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";
import type { MatchRoster } from "./matchRoster";

/**
 * Tracked players for the coach board and the player reel: each match roster
 * player's boxes through a stretch of the video, as shares of the frame, on
 * the video's own clock (tracking seconds + manifest.videoStartSeconds, the
 * same offset every overlay uses).
 */

type Boxes = ReadonlyArray<{ frame: number; x: number; y: number; w: number; h: number }>;
type Segments = ReadonlyArray<{ tracks: ReadonlyArray<{ id: string; boxes: Boxes }> }>;

/** Boxes per track id, built once per loaded play (the segments array is the play's own). */
const indexes = new WeakMap<object, Map<string, Boxes>>();
export function trackIndex(segments: Segments | TrackingSegmentPayload[]): Map<string, Boxes> {
  const key = segments as object;
  const hit = indexes.get(key);
  if (hit) return hit;
  const map = new Map<string, Boxes>();
  for (const segment of segments as Segments) for (const track of segment.tracks) map.set(track.id, track.boxes);
  indexes.set(key, map);
  return map;
}

/** First index whose frame is >= f. */
function firstAtOrAfter(boxes: Boxes, f: number): number {
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].frame < f) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export type TrackWindowManifest = Pick<TrackingManifest, "frameRate" | "width" | "height"> & { videoStartSeconds?: number | null };

/** The video seconds a frame of the tracking shows at. */
export const frameVideoSeconds = (frame: number, m: TrackWindowManifest) => frame / (m.frameRate > 0 ? m.frameRate : 20) + (m.videoStartSeconds ?? 0);

/**
 * One roster player's boxes from `fromSec` to `toSec` (video seconds), at most
 * `perSecond` a second, sorted by time. A player's parts never overlap in
 * time, so the result is one path.
 */
export function partsBoxes(
  index: Map<string, Boxes>,
  parts: ReadonlyArray<{ trackId: string; fromFrame: number; toFrame: number }>,
  m: TrackWindowManifest,
  fromSec: number,
  toSec: number,
  perSecond = 10,
): CoachBox[] {
  if (!(m.width > 0 && m.height > 0) || !(toSec > fromSec)) return [];
  const fps = m.frameRate > 0 ? m.frameRate : 20;
  const offset = m.videoStartSeconds ?? 0;
  const fa = Math.floor((fromSec - offset) * fps);
  const fb = Math.ceil((toSec - offset) * fps);
  const minStep = perSecond > 0 ? fps / perSecond : 1;
  const out: CoachBox[] = [];
  const sorted = [...parts].sort((a, b) => a.fromFrame - b.fromFrame);
  for (const part of sorted) {
    const lo = Math.max(fa, part.fromFrame);
    const hi = Math.min(fb, part.toFrame);
    if (hi < lo) continue;
    const boxes = index.get(part.trackId);
    if (!boxes?.length) continue;
    let lastFrame = -Infinity;
    for (let i = firstAtOrAfter(boxes, lo); i < boxes.length && boxes[i].frame <= hi; i++) {
      const b = boxes[i];
      // Keep the last box of a part as well, so a spotlight holds to the end of what was seen.
      const isLast = i + 1 >= boxes.length || boxes[i + 1].frame > hi;
      if (b.frame - lastFrame < minStep - 1e-6 && !isLast) continue;
      lastFrame = b.frame;
      out.push([r2(b.frame / fps + offset), r4(b.x / m.width), r4(b.y / m.height), r4(b.w / m.width), r4(b.h / m.height)]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Every roster player's boxes through the window, keyed by roster id (players not seen there are left out). */
export function rosterBoxes(
  index: Map<string, Boxes>,
  roster: Pick<MatchRoster, "players">,
  m: TrackWindowManifest,
  fromSec: number,
  toSec: number,
  opts: { only?: ReadonlySet<string>; perSecond?: number } = {},
): Record<string, CoachBox[]> {
  const out: Record<string, CoachBox[]> = {};
  for (const player of roster.players) {
    if (opts.only && !opts.only.has(player.id)) continue;
    const boxes = partsBoxes(index, player.parts, m, fromSec, toSec, opts.perSecond ?? 10);
    if (boxes.length) out[player.id] = boxes;
  }
  return out;
}

/** The ball path's samples ([video seconds, x, y]) inside the window, rounded. */
export function ballInWindow(samples: ReadonlyArray<readonly [number, number, number]> | null | undefined, fromSec: number, toSec: number): CoachBall[] {
  if (!samples?.length) return [];
  return samples.filter((s) => s[0] >= fromSec && s[0] <= toSec).map((s) => [r2(s[0]), r4(s[1]), r4(s[2])]);
}

/**
 * Where a player is through a window, as [video seconds, x, y] at the middle of
 * his upper body: a camera that follows him keeps his body, not his feet, in
 * the middle. The same shape as ball samples, so the ball framing's smoothing
 * (framing.ts ballKeys) can turn it into a moving camera.
 */
export function playerCentreSamples(boxes: ReadonlyArray<CoachBox>): Array<[number, number, number]> {
  return boxes.map(([t, x, y, w, h]) => [t, x + w / 2, y + h * 0.45] as [number, number, number]);
}
