/**
 * Bounded byte-range streaming of a finished clip export.
 *
 * Two constraints meet here:
 *
 *   - The Replit host rejects any response whose Content-Length is over
 *     32 MiB. `Range: bytes=0-` is answered by the storage origin with a 206
 *     carrying the whole file's length, so forwarding it as-is breaks big
 *     exports exactly like a full download used to.
 *   - /user-clips/:id/playback is not a download and must not be usable as one:
 *     downloads are metered (five per rolling window on the free plan) through
 *     /download, and an unmetered full-file response would sidestep that.
 *
 * So every playback/preview response is a 206 of at most `maxBytes`, whatever
 * the client asked for. A <video> element reads Content-Range and requests the
 * next window itself; a plain `fetch()` or "save link as" only gets the first
 * window.
 */
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Response as ExpressResponse } from "express";
import { CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES } from "./backupExport";

/** Admin preview: any window under the host's fixed-length limit will do. */
export const ADMIN_PREVIEW_RANGE_MAX_BYTES = Math.min(
  16 * 1024 * 1024,
  CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES,
);
/**
 * In-app playback for players. Small enough that one request is not the whole
 * of a typical clip, large enough that a player needs only a handful of them.
 */
export const CLIP_PLAYBACK_RANGE_MAX_BYTES = 2 * 1024 * 1024;

export type ExportRangePlan = {
  /** The bounded Range header to send upstream. */
  upstreamRange: string;
  /** First byte asked for, or null for a suffix range (`bytes=-N`). */
  start: number | null;
  /** Last byte asked for after capping, or null for a suffix range. */
  end: number | null;
  /** Suffix length after capping, for `bytes=-N`. */
  suffix: number | null;
  maxBytes: number;
};

/**
 * Turn whatever Range the client sent (or none) into a bounded upstream
 * request. A missing, multi-part or unreadable Range is treated as a request
 * for the start of the file.
 */
export function planExportRange(header: string | undefined, maxBytes: number): ExportRangePlan {
  const value = header?.trim() ?? "";
  const single = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (single && single[1] === "" && single[2] !== "") {
    const suffix = Math.min(Number(single[2]), maxBytes);
    if (Number.isSafeInteger(suffix) && suffix > 0) {
      return { upstreamRange: `bytes=-${suffix}`, start: null, end: null, suffix, maxBytes };
    }
  } else if (single && single[1] !== "") {
    const start = Number(single[1]);
    const askedEnd = single[2] === "" ? null : Number(single[2]);
    if (
      Number.isSafeInteger(start)
      && (askedEnd == null || (Number.isSafeInteger(askedEnd) && askedEnd >= start))
    ) {
      const end = Math.min(askedEnd ?? Number.MAX_SAFE_INTEGER, start + maxBytes - 1);
      return { upstreamRange: `bytes=${start}-${end}`, start, end, suffix: null, maxBytes };
    }
  }
  return { upstreamRange: `bytes=0-${maxBytes - 1}`, start: 0, end: maxBytes - 1, suffix: null, maxBytes };
}

type ParsedRange = { start: number; end: number; total: number | null };

function parseContentRange(value: string | null): ParsedRange | null {
  const match = value?.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total != null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

/** Skip `skip` bytes of `source`, then emit at most `take` bytes and stop. */
function sliceStream(source: Readable, skip: number, take: number): Readable {
  return Readable.from((async function* () {
    let toSkip = skip;
    let toTake = take;
    try {
      for await (const chunk of source) {
        let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (toSkip > 0) {
          if (buf.length <= toSkip) {
            toSkip -= buf.length;
            continue;
          }
          buf = buf.subarray(toSkip);
          toSkip = 0;
        }
        if (buf.length >= toTake) {
          if (toTake > 0) yield buf.subarray(0, toTake);
          return;
        }
        toTake -= buf.length;
        yield buf;
      }
    } finally {
      source.destroy();
    }
  })(), { objectMode: false });
}

export type BoundedExportResult = "sent" | "unsatisfiable" | "unusable";

/**
 * Stream an upstream export response to the client as a bounded 206.
 *
 * Handles the upstream answering 206 (the normal case), 200 (an origin that
 * ignored the Range: the requested window is cut out of the body) and 416
 * (forwarded as 416). Returns "unusable" without writing anything when the
 * upstream answer cannot be turned into an honest bounded response; the
 * caller decides what error to send then.
 */
export async function sendBoundedExport(
  res: ExpressResponse,
  upstream: Response,
  plan: ExportRangePlan,
  headers: Record<string, string> = {},
): Promise<BoundedExportResult> {
  if (upstream.status === 416) {
    await upstream.body?.cancel().catch(() => {});
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);
    res.setHeader("Accept-Ranges", "bytes");
    res.status(416).end();
    return "unsatisfiable";
  }
  if (!upstream.body || (upstream.status !== 200 && upstream.status !== 206)) return "unusable";

  const body = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
  let first: number;
  let last: number;
  let total: number | null;
  let skip = 0;

  if (upstream.status === 206) {
    const range = parseContentRange(upstream.headers.get("content-range"));
    if (!range) {
      body.destroy();
      return "unusable";
    }
    first = range.start;
    last = Math.min(range.end, range.start + plan.maxBytes - 1);
    total = range.total;
  } else {
    // The origin ignored the Range and is sending the whole file. Its length
    // is needed to label the window honestly.
    const length = Number(upstream.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length <= 0) {
      body.destroy();
      return "unusable";
    }
    total = length;
    first = plan.start ?? Math.max(0, length - (plan.suffix ?? plan.maxBytes));
    if (first >= length) {
      body.destroy();
      res.setHeader("Content-Range", `bytes */${length}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.status(416).end();
      return "unsatisfiable";
    }
    last = Math.min(length - 1, plan.end ?? length - 1, first + plan.maxBytes - 1);
    skip = first;
  }

  const byteCount = last - first + 1;
  res.status(206);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Range", `bytes ${first}-${last}/${total ?? "*"}`);
  res.setHeader("Content-Length", String(byteCount));
  await pipeline(sliceStream(body, skip, byteCount), res);
  return "sent";
}
