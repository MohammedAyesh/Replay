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
  matchOffset: number;
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

export function frameToMatchSeconds(frame: number, bundle: ClaimBundle): number {
  return Math.max(0, frame / bundle.frameRate + bundle.matchOffset);
}

export function matchSecondsToFrame(seconds: number, bundle: ClaimBundle): number {
  return Math.max(0, Math.round((seconds - bundle.matchOffset) * bundle.frameRate));
}

export function crossingsForWindow(
  bundle: ClaimBundle,
  trackId: string,
  lowerSeconds: number,
  upperSeconds: number,
): number[] {
  const crossings = bundle.crossings
    .filter((crossing) => crossing.trackId === trackId)
    .map((crossing) => frameToMatchSeconds(crossing.frame, bundle))
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

export function boxAtFrame(track: ClaimTrack, frame: number): ClaimBox | null {
  if (track.boxes.length === 0 || frame < track.startFrame || frame > track.endFrame) return null;
  let nearest = track.boxes[0];
  for (const box of track.boxes) {
    if (Math.abs(box.frame - frame) < Math.abs(nearest.frame - frame)) nearest = box;
  }
  return nearest;
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