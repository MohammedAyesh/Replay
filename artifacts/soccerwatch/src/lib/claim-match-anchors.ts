export type AnchorAnswer = "yes" | "no" | "skip";

export type CoverageInterval = {
  startSeconds: number;
  endSeconds: number;
};

export type ClaimAnchor = {
  id: string;
  momentSeconds: number;
};

export function mergeCoverageIntervals(
  intervals: CoverageInterval[],
  duration: number,
): CoverageInterval[] {
  const sorted = intervals
    .map((interval) => ({
      startSeconds: Math.max(0, Math.min(duration, interval.startSeconds)),
      endSeconds: Math.max(0, Math.min(duration, interval.endSeconds)),
    }))
    .filter((interval) => interval.endSeconds > interval.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: CoverageInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startSeconds > previous.endSeconds) {
      merged.push({ ...interval });
    } else {
      previous.endSeconds = Math.max(previous.endSeconds, interval.endSeconds);
    }
  }
  return merged;
}

export function coverageSeconds(
  intervals: CoverageInterval[],
  duration: number,
): number {
  return mergeCoverageIntervals(intervals, duration)
    .reduce((total, interval) => total + interval.endSeconds - interval.startSeconds, 0);
}

/**
 * Anchor moments are deliberately independent: they are spread through the
 * tracked window instead of being checkpoints on one continuous identity
 * chain. Event times are preferred when they are far enough apart, then the
 * evenly distributed fallback moments fill the gaps.
 */
export function buildClaimAnchors(
  duration: number,
  eventTimes: number[] = [],
  desiredCount = 8,
): ClaimAnchor[] {
  const safeDuration = Math.max(1, duration);
  const minGap = Math.max(8, safeDuration / Math.max(desiredCount * 2, 1));
  const candidates = [
    ...eventTimes,
    ...Array.from(
      { length: Math.max(1, desiredCount) },
      (_, index) => safeDuration * ((index + 0.5) / Math.max(1, desiredCount)),
    ),
  ]
    .map((momentSeconds) => Math.max(0, Math.min(safeDuration, momentSeconds)))
    .sort((a, b) => a - b);
  const selected: number[] = [];
  for (const moment of candidates) {
    if (selected.every((chosen) => Math.abs(chosen - moment) >= minGap)) {
      selected.push(moment);
    }
  }
  return selected
    .sort((a, b) => a - b)
    .map((momentSeconds, index) => ({
      id: `anchor-${index + 1}`,
      momentSeconds,
    }));
}

export function nextUnansweredAnchor(
  anchors: ClaimAnchor[],
  answeredMoments: number[],
  toleranceSeconds = 0.5,
): number {
  return anchors.findIndex(
    (anchor) => !answeredMoments.some(
      (answered) => Math.abs(answered - anchor.momentSeconds) <= toleranceSeconds,
    ),
  );
}

export function claimCompletionThreshold(duration: number): {
  coveragePercent: number;
  acceptedAnchors: number;
} {
  return {
    coveragePercent: duration < 120 ? 55 : 60,
    acceptedAnchors: duration < 120 ? 1 : 3,
  };
}