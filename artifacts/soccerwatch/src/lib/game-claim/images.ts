import type { AnyPiece, Chunk } from "./model";

export type PiecePicture = {
  key: string;
  localTime: number;
  nearby: boolean;
};

type FrameCrop = { key: string; frame: number };

const cropIndexCache = new WeakMap<Record<string, string>, Map<string, FrameCrop[]>>();

function cropsForTrack(crops: Record<string, string>, trackId: string): FrameCrop[] {
  let byTrack = cropIndexCache.get(crops);
  if (!byTrack) {
    byTrack = new Map();
    cropIndexCache.set(crops, byTrack);
  }

  const cached = byTrack.get(trackId);
  if (cached) return cached;

  const prefix = `${trackId}#`;
  const found: FrameCrop[] = [];
  for (const [key, jpeg] of Object.entries(crops)) {
    if (!jpeg || !key.startsWith(prefix)) continue;
    const frame = Number(key.slice(prefix.length));
    if (Number.isFinite(frame) && frame >= 0) found.push({ key, frame });
  }
  found.sort((a, b) => a.frame - b.frame);
  byTrack.set(trackId, found);
  return found;
}

/** Select a crop from this exact track, preferring crops inside the piece's span. */
export function pictureForPiece(
  chunk: Pick<Chunk, "crops" | "start">,
  piece: AnyPiece | null | undefined,
  targetTime: number,
  frameRate: number,
  preferredRange?: [number, number],
): PiecePicture | null {
  if (!piece) return null;
  const trackId = piece.manual ? piece.src : piece.id;
  if (!trackId) return null;

  const fps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 20;
  const start = Math.min(piece.t0, piece.t1);
  const end = Math.max(piece.t0, piece.t1);
  const target = Number.isFinite(targetTime) ? targetTime : (start + end) / 2;
  const requestedRange = preferredRange
    ? [Math.min(...preferredRange), Math.max(...preferredRange)] as [number, number]
    : [start, end] as [number, number];
  const rangeStart = Math.max(start, Math.min(end, requestedRange[0]));
  const rangeEnd = Math.max(rangeStart, Math.max(start, Math.min(end, requestedRange[1])));
  const candidates = cropsForTrack(chunk.crops, trackId).map(({ key, frame }) => {
    const localTime = frame / fps - chunk.start;
    const inSpan = localTime >= rangeStart - 0.01 && localTime <= rangeEnd + 0.01;
    const spanDistance = Math.max(rangeStart - localTime, 0, localTime - rangeEnd);
    return { key, localTime, inSpan, spanDistance };
  });
  if (!candidates.length) return null;

  const inSpan = candidates.filter((candidate) => candidate.inSpan);
  const pool = inSpan.length ? inSpan : candidates;
  pool.sort((a, b) => {
    const aDistance = inSpan.length ? Math.abs(a.localTime - target) : a.spanDistance;
    const bDistance = inSpan.length ? Math.abs(b.localTime - target) : b.spanDistance;
    return aDistance - bDistance
      || Math.abs(a.localTime - target) - Math.abs(b.localTime - target)
      || a.localTime - b.localTime;
  });

  return {
    key: pool[0].key,
    localTime: pool[0].localTime,
    nearby: inSpan.length === 0,
  };
}
