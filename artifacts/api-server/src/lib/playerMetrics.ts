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

/**
 * Where the player was each second: the median of that second's pitch
 * positions, in time order. Distance is the path through these points.
 *
 * Summing every 10 Hz step instead counted the detection box's wobble as
 * running: the box's bottom edge moves a few pixels every frame as the legs
 * and arms move, and at the far touchline a few pixels is half a metre. On
 * rec 392 that added 20-25% (Ib 8.1 km against 6.5 km on per-second
 * positions), 0.3 km of it while the player stood still. See
 * claude/distance-is-inflated-about-20-percent-by-box-wobble-ib-ran-6-5-km-not-8-2026-10-05.md.
 */
export function perSecondPath(
  samples: ReadonlyArray<{ frame: number; pitchX: number; pitchY: number }>,
  frameRate: number,
): Array<{ second: number; frame: number; x: number; y: number }> {
  const fps = Math.max(frameRate, 0.001);
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const out: Array<{ second: number; frame: number; x: number; y: number }> = [];
  let i = 0;
  const ordered = [...samples].sort((a, b) => a.frame - b.frame);
  while (i < ordered.length) {
    const second = Math.floor(ordered[i].frame / fps);
    const xs: number[] = [];
    const ys: number[] = [];
    const firstFrame = ordered[i].frame;
    while (i < ordered.length && Math.floor(ordered[i].frame / fps) === second) {
      xs.push(ordered[i].pitchX);
      ys.push(ordered[i].pitchY);
      i++;
    }
    out.push({ second, frame: firstFrame, x: median(xs), y: median(ys) });
  }
  return out;
}

type SpeedSummary = {
  topSpeedMetresPerSecond: number | null;
  topSpeedUsableTimeFraction: number | null;
  /** frame where the fastest one-second window starts (not part of the admin payload) */
  topSpeedFrame?: number | null;
};

/**
 * Top speed: the fastest pace the player held for a full second.
 *
 * Measured one claimed piece (one track) at a time, never across a switch
 * from one track to the next: a hand-over between two tracks is a jump in
 * position, not a sprint. Pieces shorter than 8 s are skipped: on recording
 * 388 a 6.8 s fragment set the top speed (30.9 km/h, 28.2 without it).
 * Within a piece, positions are taken every 0.5 s as
 * the median foot point of the boxes within ±0.25 s, which removes the
 * frame-to-frame box jitter that 10 Hz differencing reads as acceleration.
 * A 0.5 s step is dropped when:
 *   - it is faster than 9 m/s (the tracker changed its mind about who it was
 *     following; the step is dropped, never clipped);
 *   - the box height changes by more than 25% (a detector swap);
 *   - it is within 0.5 s of the piece's start or 1 s of its end, where a
 *     track is most often on the wrong person;
 *   - it is in the far third of the pitch, where a pixel is too many metres;
 *   - its speed changes by more than 4 m/s from the step before.
 * The top speed is the best average of two consecutive kept steps.
 *
 * This replaces a 10 Hz version whose neighbour-rejection loop marked samples
 * invalid in place while walking forwards, so one bad sample invalidated the
 * whole rest of the match: recording 388 (2026-09-29) kept 0.23% of its time
 * and reported 0.53 m/s. See
 * claude/top-speed-read-1-9-kmh-because-one-bad-sample-voided-the-rest-of-the-match-2026-10-03.md.
 */
export const TOP_SPEED = {
  stepSeconds: 0.5,
  halfWindowSeconds: 0.25,
  minBoxesPerSample: 3,
  ceilingMetresPerSecond: 9,
  heightJump: 0.25,
  edgeStartSeconds: 0.5,
  edgeEndSeconds: 1,
  farThird: 1 / 3,
  maxSpeedChange: 4,
  minPieceSeconds: 8,
} as const;

type SpeedBox = { frame: number; x: number; y: number; w: number; h: number };

const medianOf = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function topSpeedSummary(
  manifest: TrackingManifest,
  fullSegments: TrackingSegmentPayload[],
  claimed: ClaimedRange[],
  offPitchSpans: OffPitchWindow[],
  coveredSeconds: number,
): SpeedSummary {
  if (!hasUsablePitchModel(manifest)) {
    return { topSpeedMetresPerSecond: null, topSpeedUsableTimeFraction: coveredSeconds > 0 ? 0 : null };
  }
  const fps = Math.max(manifest.frameRate, 0.001);
  const pitchHeight = manifest.pitchModel!.pitchHeightMetres;
  const boxesByTrack = new Map<string, SpeedBox[]>();
  for (const segment of fullSegments) {
    for (const track of segment.tracks) {
      const list = boxesByTrack.get(track.id) ?? [];
      for (const box of track.boxes) list.push(box);
      boxesByTrack.set(track.id, list);
    }
  }
  const offPitch = (seconds: number) => offPitchSpans.some((span) => seconds >= span.fromSeconds && seconds < span.toSeconds);
  const T = TOP_SPEED;
  let best: { speed: number; frame: number } | null = null;
  let usableSeconds = 0;
  for (const range of claimed) {
    if (range.toFrame < range.fromFrame) continue;
    const boxes = (boxesByTrack.get(range.trackId) ?? [])
      .filter((box) => box.frame >= range.fromFrame && box.frame <= range.toFrame && !offPitch(box.frame / fps))
      .sort((a, b) => a.frame - b.frame);
    if (boxes.length < T.minBoxesPerSample * 2) continue;
    const t0 = boxes[0].frame / fps;
    const t1 = boxes[boxes.length - 1].frame / fps;
    if (t1 - t0 < T.minPieceSeconds) continue;
    type Sample = { t: number; x: number; y: number; h: number; ny: number } | null;
    const samples: Sample[] = [];
    let first = 0;
    for (let t = t0; t <= t1 + 1e-9; t += T.stepSeconds) {
      while (first < boxes.length && boxes[first].frame / fps < t - T.halfWindowSeconds) first++;
      const inWindow: SpeedBox[] = [];
      for (let k = first; k < boxes.length && boxes[k].frame / fps <= t + T.halfWindowSeconds; k++) inWindow.push(boxes[k]);
      if (inWindow.length < T.minBoxesPerSample) {
        samples.push(null);
        continue;
      }
      const pitch = interpolatePitchPosition(
        medianOf(inWindow.map((box) => box.x + box.w / 2)),
        medianOf(inWindow.map((box) => box.y + box.h)),
        manifest,
      );
      if (!pitch) {
        samples.push(null);
        continue;
      }
      samples.push({ t, x: pitch.x, y: pitch.y, h: medianOf(inWindow.map((box) => box.h)), ny: Math.max(0, Math.min(1, pitch.y / pitchHeight)) });
    }
    const steps: Array<{ speed: number; ok: boolean; t: number }> = [];
    for (let index = 1; index < samples.length; index++) {
      const a = samples[index - 1];
      const b = samples[index];
      if (!a || !b) {
        steps.push({ speed: 0, ok: false, t: a?.t ?? b?.t ?? t0 });
        continue;
      }
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / T.stepSeconds;
      const ok = speed <= T.ceilingMetresPerSecond
        && Math.abs(b.h - a.h) / Math.max(a.h, 1) <= T.heightJump
        && a.t - t0 >= T.edgeStartSeconds
        && t1 - b.t >= T.edgeEndSeconds
        && a.ny >= T.farThird
        && b.ny >= T.farThird;
      steps.push({ speed, ok, t: a.t });
    }
    // Decided from the speeds as measured, so one rejection cannot spread.
    const jumps = steps.map((step, index) => index > 0
      && step.ok && steps[index - 1].ok
      && Math.abs(step.speed - steps[index - 1].speed) > T.maxSpeedChange);
    jumps.forEach((jump, index) => {
      if (jump) {
        steps[index].ok = false;
        steps[index - 1].ok = false;
      }
    });
    for (const step of steps) if (step.ok) usableSeconds += T.stepSeconds;
    for (let index = 1; index < steps.length; index++) {
      if (!steps[index].ok || !steps[index - 1].ok) continue;
      const speed = (steps[index].speed + steps[index - 1].speed) / 2;
      if (!best || speed > best.speed) best = { speed, frame: Math.round(steps[index - 1].t * fps) };
    }
  }
  return {
    topSpeedMetresPerSecond: best === null ? null : Math.round(best.speed * 100) / 100,
    topSpeedUsableTimeFraction: coveredSeconds > 0
      ? Math.min(1, Math.max(0, Math.round((usableSeconds / coveredSeconds) * 10_000) / 10_000))
      : null,
    topSpeedFrame: best?.frame ?? null,
  };
}

/**
 * Optional extras for the match report: distance split into buckets of the
 * caller's choosing (the report uses five-minute blocks of the booking), and
 * the frame of the fastest one-second window. Only computed when asked for,
 * so the claim screen's metrics are unchanged.
 */
export type PlayerMetricsTiming = {
  bucketOfFrame: (frame: number) => number;
};

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
  timing?: PlayerMetricsTiming,
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
  const distanceByBucket = new Map<number, number>();
  if (usablePitchModel) {
    distanceMetres = 0;
    const path = perSecondPath(mapped, manifest.frameRate);
    for (let index = 1; index < path.length; index++) {
      const previous = path[index - 1];
      const current = path[index];
      if (current.second - previous.second <= maxGapSeconds) {
        const step = Math.hypot(current.x - previous.x, current.y - previous.y);
        distanceMetres += step;
        if (timing) {
          const bucket = timing.bucketOfFrame(current.frame);
          distanceByBucket.set(bucket, (distanceByBucket.get(bucket) ?? 0) + step);
        }
      }
    }
    distanceMetres = Math.round(distanceMetres);
  }
  const averageSpeedMetresPerSecond = distanceMetres === null
    ? null
    : coveredSeconds > 0
      ? Math.round((distanceMetres / coveredSeconds) * 100) / 100
      : 0;
  const { topSpeedFrame, ...speedSummary } = topSpeedSummary(manifest, fullSegments, claimed, offPitchSpans, coveredSeconds);
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
    ...(timing ? {
      timing: {
        distanceByBucket: Object.fromEntries([...distanceByBucket.entries()].map(([bucket, metres]) => [bucket, Math.round(metres)])),
        topSpeedFrame: topSpeedFrame ?? null,
      },
    } : {}),
  };
}

