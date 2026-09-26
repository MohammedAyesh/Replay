/**
 * Shirt-number readings for one tracking segment. The analysis worker may
 * include its full per-frame retuning log in `reads`; this parser deliberately
 * emits only the compact track map and a rebuilt number-to-tracks index.
 */
export type JerseyTrackReading = {
  number: string;
  seenFrames: number;
  confidence: number;
  /** Absolute recording frames, when the source includes the contributing frames. */
  frames?: number[];
};

export type JerseySidecar = {
  v: 1;
  tracks: Record<string, JerseyTrackReading>;
  numbers: Record<string, string[]>;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function firstValue(source: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function frameList(source: UnknownRecord): number[] {
  const value = firstValue(source, [
    "frameNumbers", "frame_numbers", "observedFrames", "observed_frames", "frames",
  ]);
  const frames = Array.isArray(value)
    ? value
      .map(finiteNumber)
      .filter((frame): frame is number => frame !== null)
      .map(Math.round)
    : [];
  for (const key of ["frame", "f", "firstFrame", "first_frame", "lastFrame", "last_frame"]) {
    const frame = finiteNumber(source[key]);
    if (frame !== null) frames.push(Math.round(frame));
  }
  return [...new Set(frames)].sort((a, b) => a - b);
}

function trackRecord(value: unknown): UnknownRecord | null {
  if (Array.isArray(value)) {
    return {
      number: value[0],
      seenFrames: value[1],
      confidence: value[2],
      frames: value[3],
    };
  }
  return record(value);
}

/**
 * Validate and namespace a jersey sidecar from one bundle segment.
 *
 * Jersey numbers are accepted only when they were observed on at least three
 * frames and are not multi-digit values with a leading zero. A segment's
 * frames are lifted with the same whole-file heuristic as sprite strips:
 * when any stored frame is below the segment start, all stored frames are
 * treated as chunk-local and shifted by that start.
 */
export function parseJerseySidecar(
  input: unknown,
  segmentIndex: number,
  startFrame = 0,
): JerseySidecar | null {
  const raw = record(input);
  if (!raw) return null;

  const sourceTracks = record(firstValue(raw, [
    "tracks", "byTrack", "by_track", "trackNumbers", "track_numbers",
    "trackToNumber", "track_to_number", "byTrackId", "by_track_id",
    "jerseyByTrack", "jersey_by_track", "numberByTrack", "number_by_track",
    "perTrack", "per_track", "readings",
  ]));
  const prefix = `s${segmentIndex}:`;
  const hasChunkLocalFrames = startFrame > 0
    && Object.values(sourceTracks ?? {})
      .some((value) => {
        const row = trackRecord(value);
        return row !== null && frameList(row).some((frame) => frame < startFrame);
      });
  const parsedRows: Array<{
    id: string;
    number: string;
    seenFrames: number;
    confidence: number;
    frames: number[];
  }> = [];

  for (const [rawId, value] of Object.entries(sourceTracks ?? {})) {
    if (!rawId) continue;
    const row = trackRecord(value);
    if (!row) continue;
    const rawNumber = firstValue(row, [
      "number", "shirtNumber", "shirt_number", "jerseyNumber", "jersey_number",
      "jersey", "shirt", "value",
    ]);
    const number = typeof rawNumber === "string" || typeof rawNumber === "number"
      ? String(rawNumber).trim()
      : "";
    if (!/^\d+$/.test(number)) continue;
    if (number.length > 1 && number.startsWith("0")) continue;

    const frames = frameList(row);
    const rawCount = firstValue(row, [
      "seenFrames", "seen_frames", "frameCount", "frame_count", "framesSeen",
      "frames_seen", "count", "nFrames", "n_frames", "numFrames", "num_frames",
      "framesCount", "frames_count", "seen", "hits",
    ]);
    const count = finiteNumber(rawCount)
      ?? (typeof row.frames === "number" ? finiteNumber(row.frames) : null)
      ?? frames.length;
    const seenFrames = Math.max(0, Math.floor(count));
    if (seenFrames < 3) continue;

    const rawConfidence = firstValue(row, [
      "bestConfidence", "best_confidence", "confidence", "bestConf", "best_conf",
      "bestScore", "best_score",
    ]);
    const confidence = finiteNumber(rawConfidence) ?? 0;
    parsedRows.push({
      id: rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`,
      number,
      seenFrames,
      confidence,
      frames,
    });
  }

  // Match namespaceSprites: if even one frame proves this chunk used local
  // numbering, lift every stored frame in the sidecar by the segment offset.
  const tracks: JerseySidecar["tracks"] = {};
  const numbers: JerseySidecar["numbers"] = {};
  for (const row of parsedRows) {
    const frames = hasChunkLocalFrames
      ? row.frames.map((frame) => frame + startFrame)
      : row.frames;
    tracks[row.id] = {
      number: row.number,
      seenFrames: row.seenFrames,
      confidence: row.confidence,
      ...(frames.length ? { frames } : {}),
    };
    (numbers[row.number] ??= []).push(row.id);
  }
  for (const ids of Object.values(numbers)) ids.sort((a, b) => a.localeCompare(b));

  return { v: 1, tracks, numbers };
}