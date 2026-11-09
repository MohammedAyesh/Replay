import { promises as fs } from "fs";

export type HlsByteRange = {
  url: string;
  start: number;
  end: number;
  length: number;
};

export type HlsTimedByteRange = HlsByteRange & {
  startTime: number;
  endTime: number;
};

export type HlsByteRangePlan = {
  init: HlsByteRange;
  segments: HlsTimedByteRange[];
  requestedStart: number;
  requestedEnd: number;
  selectedStartTime: number;
};

/** The pull zone serves large objects in 5 MiB chunks; never span a chunk boundary in one Range request. */
export const HLS_RANGE_CHUNK_BYTES = 5 * 1024 * 1024;

/** Total source timeline duration in an fMP4 media playlist. */
export function hlsPlaylistDuration(body: string): number {
  if (!body.trimStart().startsWith("#EXTM3U")) throw new Error("Source is not an HLS playlist");
  let total = 0;
  let count = 0;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXTINF:")) continue;
    const duration = Number.parseFloat(trimmed.slice("#EXTINF:".length).split(",")[0] ?? "");
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`Invalid HLS segment duration: ${trimmed}`);
    }
    total += duration;
    count++;
  }
  if (count === 0 || !Number.isFinite(total) || total <= 0) {
    throw new Error("fMP4 HLS playlist has no timed media segments");
  }
  return total;
}

export function calculateSourceTimestampOffset(formatStartTime: number, selectedStartTime: number): number {
  const offset = formatStartTime - selectedStartTime;
  if (!Number.isFinite(offset) || Math.abs(offset) > 2) {
    throw new Error(
      `Unexpected HLS source timestamp offset ${Number.isFinite(offset) ? offset.toFixed(3) : String(offset)}s`,
    );
  }
  return offset;
}

function parseRange(value: string, implicitOffset: number | null, label: string): HlsByteRange {
  const match = /^\s*(\d+)(?:@(\d+))?\s*$/.exec(value);
  if (!match) throw new Error(`Invalid ${label} byte range: ${value}`);
  const length = Number(match[1]);
  const start = match[2] === undefined ? implicitOffset : Number(match[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || start === null || !Number.isSafeInteger(start) || start < 0) {
    throw new Error(`Missing or invalid offset in ${label} byte range: ${value}`);
  }
  return { url: "", start, end: start + length - 1, length };
}

/**
 * Read an fMP4 HLS playlist and select only the init section plus byte ranges
 * overlapping the requested source-time window. The source fragments retain
 * their tfdt timestamps; callers must trim those on the absolute timeline.
 */
export function parseHlsByteRangePlan(
  body: string,
  playlistUrl: string,
  startSec: number,
  endSec: number,
  options: { prerollSeconds?: number; postrollSeconds?: number } = {},
): HlsByteRangePlan {
  if (!body.trimStart().startsWith("#EXTM3U")) throw new Error("Source is not an HLS playlist");
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    throw new Error("Invalid HLS source-time window");
  }

  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const base = new URL(playlistUrl);
  const resolveMediaUrl = (uri: string) => {
    const resolved = new URL(uri, base);
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
      throw new Error(`Unsupported HLS media URL scheme: ${resolved.protocol}`);
    }
    if (resolved.origin !== base.origin) {
      throw new Error("HLS byte-range playlist references media on a different origin");
    }
    return resolved.toString();
  };
  const previousSegmentEndByUrl = new Map<string, number>();
  let init: HlsByteRange | null = null;
  let duration: number | null = null;
  let rangeSpec: string | null = null;
  let elapsed = 0;
  const segments: HlsTimedByteRange[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = line.slice("#EXT-X-MAP:".length);
      const uri = /(?:^|,)URI=(?:"([^"]+)"|'([^']+)'|([^,]+))/i.exec(attrs);
      const byteRange = /(?:^|,)BYTERANGE=(?:"([^"]+)"|'([^']+)'|([^,]+))/i.exec(attrs);
      if (!uri || !byteRange) throw new Error("fMP4 HLS playlist is missing an init byte range");
      const resolved = resolveMediaUrl(uri[1] ?? uri[2] ?? uri[3]!);
      const spec = byteRange[1] ?? byteRange[2] ?? byteRange[3]!;
      const parsed = parseRange(spec, 0, "init");
      if (init && (init.url !== resolved || init.start !== parsed.start || init.end !== parsed.end)) {
        throw new Error("HLS byte-range playlist changes its init section");
      }
      init = { ...parsed, url: resolved };
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const parsed = Number.parseFloat(line.slice("#EXTINF:".length).split(",")[0] ?? "");
      duration = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      rangeSpec = line.slice("#EXT-X-BYTERANGE:".length);
      continue;
    }
    if (line.startsWith("#")) continue;
    if (duration === null || rangeSpec === null) continue;

    const resolved = resolveMediaUrl(line);
    const parsed = parseRange(rangeSpec, previousSegmentEndByUrl.get(resolved) ?? null, "segment");
    previousSegmentEndByUrl.set(resolved, parsed.end + 1);
    const segmentStart = elapsed;
    const segmentEnd = segmentStart + duration;
    segments.push({
      ...parsed,
      url: resolved,
      startTime: segmentStart,
      endTime: segmentEnd,
    });
    elapsed = segmentEnd;
    duration = null;
    rangeSpec = null;
  }

  if (!init) throw new Error("fMP4 HLS playlist has no EXT-X-MAP init byte range");
  if (segments.length === 0) throw new Error("fMP4 HLS playlist has no byte-range media segments");
  const preroll = Math.max(0, options.prerollSeconds ?? 4);
  const postroll = Math.max(0, options.postrollSeconds ?? 1);
  const requestedStart = Math.max(0, startSec - preroll);
  const requestedEnd = endSec + postroll;
  const selected = segments.filter(
    (segment) => segment.endTime >= requestedStart && segment.startTime <= requestedEnd,
  );
  if (selected.length === 0) {
    throw new Error(`No HLS byte-range segments overlap ${requestedStart.toFixed(3)}–${requestedEnd.toFixed(3)}s`);
  }
  return {
    init,
    segments: selected,
    requestedStart,
    requestedEnd,
    selectedStartTime: selected[0]!.startTime,
  };
}

async function fetchRange(
  range: HlsByteRange,
  referer: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Uint8Array> {
  const response = await fetcher(range.url, {
    headers: { Referer: referer, Range: `bytes=${range.start}-${range.end}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 206) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`Byte-range request returned HTTP ${response.status}`);
  }
  const contentRange = response.headers.get("content-range");
  if (contentRange) {
    const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange.trim());
    if (!match || Number(match[1]) !== range.start || Number(match[2]) !== range.end) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      throw new Error(`Unexpected Content-Range for bytes ${range.start}-${range.end}: ${contentRange}`);
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== range.length) {
    throw new Error(`Range ${range.start}-${range.end} returned ${bytes.byteLength} bytes; expected ${range.length}`);
  }
  return bytes;
}

async function fetchRangeWithoutCrossingChunks(
  range: HlsByteRange,
  referer: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Uint8Array> {
  const pieces: HlsByteRange[] = [];
  for (let start = range.start; start <= range.end;) {
    const nextBoundary = (Math.floor(start / HLS_RANGE_CHUNK_BYTES) + 1) * HLS_RANGE_CHUNK_BYTES;
    const end = Math.min(range.end, nextBoundary - 1);
    pieces.push({ ...range, start, end, length: end - start + 1 });
    start = end + 1;
  }
  if (pieces.length === 1) return fetchRange(pieces[0]!, referer, fetcher, timeoutMs);

  const buffers = await Promise.all(pieces.map((piece) => fetchRange(piece, referer, fetcher, timeoutMs)));
  const combined = new Uint8Array(range.length);
  let offset = 0;
  for (const buffer of buffers) {
    combined.set(buffer, offset);
    offset += buffer.byteLength;
  }
  return combined;
}

/** Fetch selected ranges in bounded parallel batches and assemble in timeline order. */
export async function downloadHlsByteRangePlan(
  plan: HlsByteRangePlan,
  outputPath: string,
  referer: string,
  options: { fetcher?: typeof fetch; concurrency?: number; timeoutMs?: number } = {},
): Promise<number> {
  const fetcher = options.fetcher ?? fetch;
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 6)));
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  let totalBytes = 0;
  try {
    const init = await fetchRange(plan.init, referer, fetcher, timeoutMs);
    await fs.writeFile(outputPath, init);
    totalBytes += init.byteLength;
    for (let offset = 0; offset < plan.segments.length; offset += concurrency) {
      const batch = plan.segments.slice(offset, offset + concurrency);
      const buffers = await Promise.all(batch.map((range) =>
        fetchRangeWithoutCrossingChunks(range, referer, fetcher, timeoutMs)));
      for (const bytes of buffers) {
        await fs.appendFile(outputPath, bytes);
        totalBytes += bytes.byteLength;
      }
    }
    return totalBytes;
  } catch (err) {
    try { await fs.unlink(outputPath); } catch { /* partial output already removed */ }
    throw err;
  }
}
