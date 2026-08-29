export interface ClaimBox {
  frame: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClaimTrack {
  id: string;
  label?: string | null;
  startFrame: number;
  endFrame: number;
  boxes: ClaimBox[];
}

export interface ClaimCrossing {
  frame: number;
  trackId: string;
  otherTrackId: string;
  confidence?: number;
}

export interface ClaimInPlaySpan {
  start: number;
  end: number;
}

export interface ClaimBundle {
  version: number;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  duration: number;
  /** display only - added to tracking time so the clock reads like the match */
  matchOffset: number;
  /** where tracking frame 0 sits inside the video file, in seconds */
  videoStartSeconds: number;
  tracks: ClaimTrack[];
  crossings: ClaimCrossing[];
  inPlaySpans: ClaimInPlaySpan[];
  events: Array<{ type: string; time: number; label?: string | null; clipId?: string | null }>;
}

export type NarrowingAnswer = "yes" | "no" | "not-sure";

export interface NarrowingState {
  lowerSeconds: number;
  upperSeconds: number;
  crossings: number[];
  questionCount: number;
}

export interface NarrowingQuestion {
  kind: "question" | "picker" | "complete";
  momentSeconds: number;
  dotCount: number;
  crossingCount: number;
}

/**
 * THREE CLOCKS, and conflating any two of them puts every box on empty grass.
 *
 *   tracking   0 .. duration. The canonical clock. Frames, crossings, in-play
 *              spans and events are all expressed in it, and so is every piece
 *              of stored progress. Prefer it everywhere.
 *   video      what you assign to video.currentTime. The recording is usually
 *              longer than the tracked window - the 2026-08-24 recording is two
 *              hours and tracking starts 18 minutes in - so this is tracking
 *              time plus videoStartSeconds.
 *   display    what the person reads on screen. Tracking time plus matchOffset,
 *              so an hour that is really minutes 40-100 of a match reads that
 *              way. NEVER seek with this.
 *
 * The original code had one offset doing the jobs of two, which is why the
 * overlays sat on grass while the tracking itself was fine.
 */
export function frameToTrackingSeconds(frame: number, bundle: ClaimBundle): number {
  return Math.max(0, frame / bundle.frameRate);
}

export function trackingSecondsToFrame(seconds: number, bundle: ClaimBundle): number {
  return Math.max(0, Math.round(seconds * bundle.frameRate));
}

export function trackingToVideoTime(seconds: number, bundle: ClaimBundle): number {
  return Math.max(0, seconds + (bundle.videoStartSeconds || 0));
}

export function videoTimeToTracking(seconds: number, bundle: ClaimBundle): number {
  return seconds - (bundle.videoStartSeconds || 0);
}

/** clamp a tracking time to the window we actually have tracking for */
export function clampToTracked(seconds: number, bundle: ClaimBundle): number {
  return Math.max(0, Math.min(bundle.duration, seconds));
}

export function trackingToDisplay(seconds: number, bundle: ClaimBundle): number {
  return Math.max(0, seconds + (bundle.matchOffset || 0));
}

export function crossingsForWindow(
  bundle: ClaimBundle,
  trackId: string,
  lowerSeconds: number,
  upperSeconds: number,
): number[] {
  const crossings = bundle.crossings
    .filter((crossing) => crossing.trackId === trackId)
    .map((crossing) => frameToTrackingSeconds(crossing.frame, bundle))
    .filter((seconds) => seconds > lowerSeconds && seconds < upperSeconds)
    .sort((a, b) => a - b);
  return groupDenseCrossings(crossings);
}

/**
 * A run of crossings inside a few seconds is one hard passage, not a reason
 * to interrupt the viewer several times.
 */
export function groupDenseCrossings(crossings: number[], maxGapSeconds = 4): number[] {
  if (crossings.length < 2) return [...crossings];
  const groups: number[][] = [[crossings[0]]];
  for (const crossing of crossings.slice(1)) {
    const group = groups[groups.length - 1];
    if (crossing - group[group.length - 1] <= maxGapSeconds) group.push(crossing);
    else groups.push([crossing]);
  }
  return groups.map((group) => group[Math.floor(group.length / 2)]);
}

export function startNarrowing(
  crossings: number[],
  confirmedFromSeconds: number,
  observedAtSeconds: number,
): NarrowingState {
  return {
    lowerSeconds: confirmedFromSeconds,
    upperSeconds: observedAtSeconds,
    crossings: groupDenseCrossings(
      crossings
        .filter((seconds) => seconds > confirmedFromSeconds && seconds < observedAtSeconds)
        .sort((a, b) => a - b),
    ),
    questionCount: 0,
  };
}

export function nextNarrowingQuestion(state: NarrowingState): NarrowingQuestion {
  if (state.crossings.length === 0) {
    return {
      kind: "complete",
      momentSeconds: state.upperSeconds,
      dotCount: state.questionCount,
      crossingCount: 0,
    };
  }
  if (state.crossings.length === 1 || state.questionCount >= 3) {
    return {
      kind: "picker",
      momentSeconds: Math.min(state.upperSeconds, state.crossings[0] + 0.75),
      dotCount: state.questionCount,
      crossingCount: state.crossings.length,
    };
  }
  const middleIndex = Math.floor(state.crossings.length / 2);
  return {
    kind: "question",
    momentSeconds: state.crossings[middleIndex],
    dotCount: state.questionCount,
    crossingCount: state.crossings.length,
  };
}

export function answerNarrowing(
  state: NarrowingState,
  answer: NarrowingAnswer,
  momentSeconds: number,
): NarrowingState {
  if (answer === "not-sure") return state;
  const remaining = answer === "yes"
    ? state.crossings.filter((crossing) => crossing > momentSeconds)
    : state.crossings.filter((crossing) => crossing <= momentSeconds);
  return {
    lowerSeconds: answer === "yes" ? momentSeconds : state.lowerSeconds,
    upperSeconds: answer === "yes" ? state.upperSeconds : momentSeconds,
    crossings: remaining,
    questionCount: state.questionCount + 1,
  };
}

export function isInPlay(seconds: number, spans: ClaimInPlaySpan[]): boolean {
  return spans.some((span) => seconds >= span.start && seconds <= span.end);
}

export function skipToClearPassage(
  currentSeconds: number,
  spans: ClaimInPlaySpan[],
  duration: number,
): number {
  const target = Math.min(duration, currentSeconds + 30);
  const containing = spans.find((span) => target >= span.start && target <= span.end);
  if (containing) return Math.min(duration, Math.max(target, containing.start));
  const next = spans.find((span) => span.start >= target);
  return Math.min(duration, next?.start ?? target);
}

/**
 * Nearest box to a frame. Boxes are exported sorted by frame, so this is a
 * binary search; a track with 300+ boxes is looked up in ~9 steps instead of a
 * full scan, which matters now that the overlay updates every tracking frame.
 */
export function boxAtFrame(track: ClaimTrack, frame: number): ClaimBox | null {
  const boxes = track.boxes;
  if (boxes.length === 0 || frame < track.startFrame || frame > track.endFrame) return null;
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].frame < frame) lo = mid + 1;
    else hi = mid;
  }
  const after = boxes[lo];
  const before = lo > 0 ? boxes[lo - 1] : null;
  if (before && Math.abs(before.frame - frame) < Math.abs(after.frame - frame)) return before;
  return after;
}

/**
 * Where the track is at a frame, even inside an internal gap: the linker keeps a
 * track alive through an occlusion (no detection for a few seconds) and the
 * page must not treat that as "tracking ended". Returns the real box when one
 * is within `tolerance` frames, otherwise a box interpolated between the
 * neighbouring detections when the gap is at most `maxGapSeconds`, flagged
 * `interpolated`. Null only outside the track's life or across a longer gap.
 */
export function positionAtFrame(
  track: ClaimTrack,
  frame: number,
  bundle: ClaimBundle,
  tolerance = 2,
  maxGapSeconds = 10,
): (ClaimBox & { interpolated?: boolean }) | null {
  const boxes = track.boxes;
  if (boxes.length === 0 || frame < track.startFrame || frame > track.endFrame) return null;
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].frame < frame) lo = mid + 1;
    else hi = mid;
  }
  const after = boxes[lo];
  const before = lo > 0 ? boxes[lo - 1] : after;
  const nearest = Math.abs(before.frame - frame) <= Math.abs(after.frame - frame) ? before : after;
  if (Math.abs(nearest.frame - frame) <= tolerance) return nearest;
  if (after.frame <= before.frame) return null;
  if ((after.frame - before.frame) / bundle.frameRate > maxGapSeconds) return null;
  const t = (frame - before.frame) / (after.frame - before.frame);
  return {
    frame,
    x: before.x + (after.x - before.x) * t,
    y: before.y + (after.y - before.y) * t,
    w: before.w + (after.w - before.w) * t,
    h: before.h + (after.h - before.h) * t,
    interpolated: true,
  };
}

/** metres per pixel at a box, taking a standing player as 1.75 m */
export function metresPerPixel(box: ClaimBox): number {
  return 1.75 / Math.max(box.h, 1);
}

export interface Continuation {
  track: ClaimTrack;
  gapSeconds: number;
  distanceMetres: number;
  impliedSpeed: number;
}

/**
 * Tracks that could be the same player carrying on after `track` ends: they
 * start after it ends (so they never coexist - a hard constraint), within
 * `windowSeconds`, and within what a person can cover at `maxSpeed` m/s.
 * Sorted nearest first. Exactly one result is a silent stitch; several is a
 * question for the player; none means the picker.
 */
export function continuationsFor(
  bundle: ClaimBundle,
  track: ClaimTrack,
  windowSeconds = 3,
  maxSpeed = 8,
): Continuation[] {
  const last = track.boxes[track.boxes.length - 1];
  if (!last) return [];
  const cx = last.x + last.w / 2;
  const cy = last.y + last.h;
  const mpp = metresPerPixel(last);
  const out: Continuation[] = [];
  for (const other of bundle.tracks) {
    if (other.id === track.id || other.startFrame <= track.endFrame) continue;
    const gapSeconds = (other.startFrame - track.endFrame) / bundle.frameRate;
    if (gapSeconds > windowSeconds) continue;
    const first = other.boxes[0];
    if (!first) continue;
    const distanceMetres = Math.hypot(first.x + first.w / 2 - cx, first.y + first.h - cy) * mpp;
    const impliedSpeed = distanceMetres / Math.max(gapSeconds, 0.05);
    if (impliedSpeed > maxSpeed) continue;
    out.push({ track: other, gapSeconds, distanceMetres, impliedSpeed });
  }
  return out.sort((a, b) => a.distanceMetres - b.distanceMetres);
}

export function boxContainsPoint(box: ClaimBox, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

export function boxesOverlap(a: ClaimBox, b: ClaimBox): boolean {
  const overlapWidth = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const overlapHeight = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const overlapArea = overlapWidth * overlapHeight;
  const smallerArea = Math.min(a.w * a.h, b.w * b.h);
  return smallerArea > 0 && overlapArea / smallerArea >= 0.2;
}

export function findHitTracks(
  bundle: ClaimBundle,
  frame: number,
  x: number,
  y: number,
): Array<{ track: ClaimTrack; box: ClaimBox }> {
  return bundle.tracks
    .map((track) => ({ track, box: boxAtFrame(track, frame) }))
    .filter((candidate): candidate is { track: ClaimTrack; box: ClaimBox } =>
      candidate.box !== null && boxContainsPoint(candidate.box, x, y),
    );
}

export function laterSeparatedFrame(
  bundle: ClaimBundle,
  trackIds: string[],
  startingFrame: number,
  lookAheadSeconds = 4,
): number | null {
  const tracks = trackIds
    .map((id) => bundle.tracks.find((track) => track.id === id))
    .filter((track): track is ClaimTrack => Boolean(track));
  if (tracks.length < 2) return null;
  const endFrame = Math.min(bundle.frameCount - 1, startingFrame + Math.round(lookAheadSeconds * bundle.frameRate));
  for (let frame = startingFrame + 1; frame <= endFrame; frame++) {
    const boxes = tracks.map((track) => boxAtFrame(track, frame));
    if (boxes.every(Boolean) && !boxesOverlap(boxes[0]!, boxes[1]!)) return frame;
  }
  return null;
}

export function formatClaimTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}