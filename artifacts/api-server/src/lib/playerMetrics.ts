/**
 * Player metrics: distance, speed and heatmap, from the frames a person has
 * been claimed on.
 *
 * The input is a set of claimed ranges -- {trackId, fromFrame, toFrame} -- and
 * nothing about how they were claimed. That is deliberate. This used to take
 * the old flow's correction rows and re-resolve identities from them, which
 * tied every metric to a data model that no longer exists. A chain part is
 * already exactly a claimed range, so the chain hands these straight over.
 */
import type { TrackingManifest, TrackingSegmentPayload } from "@workspace/db";

import { hasUsablePitchModel, interpolatePitchPosition } from "./pitchModel";

export type ClaimedRange = { trackId: string; fromFrame: number; toFrame: number };
export type OffPitchWindow = { fromSeconds: number; toSeconds: number };

export type UnavailablePlayerMetric = {
  value: null;
  available: false;
  unavailableReason: "ball_tracking_and_possession_attribution_unavailable";
};

export function unavailablePlayerMetric(): UnavailablePlayerMetric {
  return {
    value: null,
    available: false,
    unavailableReason: "ball_tracking_and_possession_attribution_unavailable",
  };
}

type PositionSample = { frame: number; x: number; y: number };
type MappedPosition = PositionSample & { pitchX: number; pitchY: number; nx: number; ny: number };

function positionSamplesForRanges(
  manifest: TrackingManifest,
  fullSegments: TrackingSegmentPayload[],
  claimed: ClaimedRange[],
): PositionSample[] {
  const rangesByTrack = new Map<string, Array<[number, number]>>();
  for (const range of claimed) {
    if (range.toFrame < range.fromFrame) continue;
    const existing = rangesByTrack.get(range.trackId);
    if (existing) existing.push([range.fromFrame, range.toFrame]);
    else rangesByTrack.set(range.trackId, [[range.fromFrame, range.toFrame]]);
  }

  const byFrame = new Map<number, PositionSample>();
  for (const segment of fullSegments) {
    for (const track of segment.tracks) {
      const ranges = rangesByTrack.get(track.id);
      if (!ranges?.length) continue;
      for (const box of track.boxes) {
        if (
          ranges.some(([fromFrame, toFrame]) => box.frame >= fromFrame && box.frame <= toFrame)
          && !byFrame.has(box.frame)
        ) {
          byFrame.set(box.frame, {
            frame: box.frame,
            // The bottom centre is the player's ground contact proxy. The box
            // centre is at chest height and creates a systematic pitch error.
            x: box.x + box.w / 2,
            y: box.y + box.h,
          });
        }
      }
    }
  }
  const ordered = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  const step = Math.max(1, Math.round(manifest.frameRate / 10));
  const sampled: PositionSample[] = [];
  for (const sample of ordered) {
    const previous = sampled.at(-1);
    if (!previous || sample.frame - previous.frame >= step) sampled.push(sample);
  }
  return sampled;
}

type SpeedSummary = {
  topSpeedMetresPerSecond: number | null;
  topSpeedUsableTimeFraction: number | null;
};

function topSpeedSummary(
  manifest: TrackingManifest,
  mapped: MappedPosition[],
  coveredSeconds: number,
): SpeedSummary {
  if (!hasUsablePitchModel(manifest) || mapped.length < 2) {
    return { topSpeedMetresPerSecond: null, topSpeedUsableTimeFraction: coveredSeconds > 0 ? 0 : null };
  }

  const maxDirectGapSeconds = Math.max(0.2, 3 / Math.max(manifest.frameRate, 0.001));
  const intervals = mapped.slice(1).map((current, index) => {
    const previous = mapped[index];
    const seconds = (current.frame - previous.frame) / Math.max(manifest.frameRate, 0.001);
    const distance = Math.hypot(current.pitchX - previous.pitchX, current.pitchY - previous.pitchY);
    const speed = seconds > 0 ? distance / seconds : Number.POSITIVE_INFINITY;
    const valid = seconds > 0
      && seconds <= maxDirectGapSeconds
      && speed <= 11
      // Image-space y increases toward the camera, so the far third is ny < 1/3.
      && previous.ny >= 1 / 3
      && current.ny >= 1 / 3;
    return { seconds, distance, speed, valid };
  });

  // A rejected sample invalidates its surrounding speed window. This prevents
  // an erroneous spike from being clipped into an apparently plausible sprint.
  for (let index = 0; index < intervals.length; index++) {
    if (!intervals[index].valid) {
      if (intervals[index - 1]) intervals[index - 1].valid = false;
      if (intervals[index + 1]) intervals[index + 1].valid = false;
    }
  }
  for (let index = 1; index < intervals.length; index++) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (!previous.valid || !current.valid) continue;
    const elapsed = Math.max((previous.seconds + current.seconds) / 2, 0.001);
    if (Math.abs(current.speed - previous.speed) / elapsed > 10) {
      previous.valid = false;
      current.valid = false;
      if (intervals[index - 2]) intervals[index - 2].valid = false;
      if (intervals[index + 1]) intervals[index + 1].valid = false;
    }
  }

  const usableSeconds = intervals.reduce(
    (total, interval) => total + (interval.valid ? interval.seconds : 0),
    0,
  );
  let topSpeed: number | null = null;
  for (let start = 0; start < intervals.length; start++) {
    if (!intervals[start].valid) continue;
    let elapsed = 0;
    let distance = 0;
    for (let end = start; end < intervals.length && intervals[end].valid; end++) {
      const interval = intervals[end];
      if (elapsed + interval.seconds >= 1) {
        const remaining = 1 - elapsed;
        distance += interval.distance * (remaining / interval.seconds);
        const average = distance;
        topSpeed = topSpeed === null ? average : Math.max(topSpeed, average);
        break;
      }
      elapsed += interval.seconds;
      distance += interval.distance;
    }
  }
  return {
    topSpeedMetresPerSecond: topSpeed === null ? null : Math.round(topSpeed * 100) / 100,
    topSpeedUsableTimeFraction: coveredSeconds > 0
      ? Math.min(1, Math.max(0, Math.round((usableSeconds / coveredSeconds) * 10_000) / 10_000))
      : null,
  };
}

export function buildPlayerMetrics(
  manifest: TrackingManifest,
  fullSegments: TrackingSegmentPayload[] | undefined,
  claimed: ClaimedRange[],
  coveredSeconds: number,
  coveragePercent: number,
  answeredMoments: number,
  acceptedMoments: number,
  trackedSegments: number,
  totalSegments: number,
  matchedEvents: number,
  offPitchSpans: OffPitchWindow[],
) {
  const base = {
    confirmedSeconds: Math.round(coveredSeconds * 100) / 100,
    minutesPlayed: Math.round((coveredSeconds / 60) * 100) / 100,
    coveragePercent,
    answeredMoments,
    acceptedMoments,
    trackedSegments,
    totalSegments,
    matchedEvents,
  };
  const usablePitchModel = hasUsablePitchModel(manifest);
  const coordinateSpace = usablePitchModel ? "pitch" as const : "camera" as const;
  if (!fullSegments) {
    return {
      ...base,
      heatmap: { coordinateSpace, cells: [] },
      distanceMetres: null,
      averageSpeedMetresPerSecond: null,
      touches: unavailablePlayerMetric(),
      passes: unavailablePlayerMetric(),
      shots: unavailablePlayerMetric(),
      dribbles: unavailablePlayerMetric(),
      adminPlayerStats: {
        topSpeedMetresPerSecond: null,
        topSpeedUsableTimeFraction: null,
      },
    };
  }

  const raw = positionSamplesForRanges(manifest, fullSegments, claimed)
    .filter((sample) => !offPitchSpans.some((span) => {
      const seconds = sample.frame / Math.max(manifest.frameRate, 0.001);
      return seconds >= span.fromSeconds && seconds < span.toSeconds;
    }));
  const mapped: MappedPosition[] = [];
  for (const sample of raw) {
    const pitch = interpolatePitchPosition(sample.x, sample.y, manifest);
    if (usablePitchModel && !pitch) continue;
    const pitchX = pitch?.x ?? sample.x;
    const pitchY = pitch?.y ?? sample.y;
    mapped.push({
      ...sample,
      pitchX,
      pitchY,
      nx: usablePitchModel
        ? Math.max(0, Math.min(1, pitchX / manifest.pitchModel!.pitchWidthMetres))
        : Math.max(0, Math.min(1, sample.x / Math.max(manifest.width, 1))),
      ny: usablePitchModel
        ? Math.max(0, Math.min(1, pitchY / manifest.pitchModel!.pitchHeightMetres))
        : Math.max(0, Math.min(1, sample.y / Math.max(manifest.height, 1))),
    });
  }

  const smoothed: MappedPosition[] = [];
  const smoothingSeconds = 0.35;
  const maxGapSeconds = 2;
  for (const sample of mapped) {
    const previous = smoothed.at(-1);
    const gapSeconds = previous ? (sample.frame - previous.frame) / Math.max(manifest.frameRate, 0.001) : 0;
    if (!previous || gapSeconds > maxGapSeconds) {
      smoothed.push(sample);
      continue;
    }
    const alpha = 1 - Math.exp(-gapSeconds / smoothingSeconds);
    smoothed.push({
      ...sample,
      pitchX: previous.pitchX + (sample.pitchX - previous.pitchX) * alpha,
      pitchY: previous.pitchY + (sample.pitchY - previous.pitchY) * alpha,
      nx: previous.nx + (sample.nx - previous.nx) * alpha,
      ny: previous.ny + (sample.ny - previous.ny) * alpha,
    });
  }

  const bins = new Map<string, number>();
  let totalWeight = 0;
  for (let index = 0; index < smoothed.length; index++) {
    const sample = smoothed[index];
    const previous = smoothed[index - 1];
    const gapSeconds = previous ? (sample.frame - previous.frame) / Math.max(manifest.frameRate, 0.001) : 1 / Math.max(manifest.frameRate, 0.001);
    const weight = previous && gapSeconds <= maxGapSeconds ? Math.max(0, gapSeconds) : 1 / Math.max(manifest.frameRate, 0.001);
    const column = Math.min(11, Math.floor(sample.nx * 12));
    const row = Math.min(7, Math.floor(sample.ny * 8));
    const key = `${column}:${row}`;
    bins.set(key, (bins.get(key) ?? 0) + weight);
    totalWeight += weight;
  }
  const heatmap = {
    coordinateSpace,
    cells: [...bins.entries()]
      .map(([key, weight]) => {
        const [column, row] = key.split(":").map(Number);
        return {
          x: (column + 0.5) / 12,
          y: (row + 0.5) / 8,
          weight: totalWeight > 0 ? Math.round((weight / totalWeight) * 10000) / 10000 : 0,
        };
      })
      .sort((a, b) => b.weight - a.weight),
  };
  let distanceMetres: number | null = null;
  if (usablePitchModel) {
    distanceMetres = 0;
    for (let index = 1; index < smoothed.length; index++) {
      const previous = smoothed[index - 1];
      const current = smoothed[index];
      const gapSeconds = (current.frame - previous.frame) / Math.max(manifest.frameRate, 0.001);
      if (gapSeconds <= maxGapSeconds) {
        distanceMetres += Math.hypot(current.pitchX - previous.pitchX, current.pitchY - previous.pitchY);
      }
    }
    distanceMetres = Math.round(distanceMetres);
  }
  const averageSpeedMetresPerSecond = distanceMetres === null
    ? null
    : coveredSeconds > 0
      ? Math.round((distanceMetres / coveredSeconds) * 100) / 100
      : 0;
  const speedSummary = topSpeedSummary(manifest, mapped, coveredSeconds);
  return {
    ...base,
    heatmap,
    distanceMetres,
    averageSpeedMetresPerSecond,
    touches: unavailablePlayerMetric(),
    passes: unavailablePlayerMetric(),
    shots: unavailablePlayerMetric(),
    dribbles: unavailablePlayerMetric(),
    adminPlayerStats: speedSummary,
  };
}

