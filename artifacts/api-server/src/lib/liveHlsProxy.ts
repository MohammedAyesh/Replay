import { Readable } from "node:stream";
import type { Response as ExpressResponse } from "express";

const SEGMENT_PATH = /(?:^|\/)seg\/([A-Za-z0-9._-]+\.(?:ts|m4s|mp4))(?:\?.*)?$/i;
const BARE_SEGMENT = /^([A-Za-z0-9._-]+\.(?:ts|m4s|mp4))(?:\?.*)?$/i;
const MEDIA_SEQUENCE = "#EXT-X-MEDIA-SEQUENCE:";
const DISCONTINUITY_SEQUENCE = "#EXT-X-DISCONTINUITY-SEQUENCE:";
const DISCONTINUITY = "#EXT-X-DISCONTINUITY";

type TrimmedPlaylist = { playlist: string; segments: string[] };

function segmentName(uri: string): string | null {
  const match = SEGMENT_PATH.exec(uri) ?? BARE_SEGMENT.exec(uri);
  return match ? match[1] : null;
}

function isSegmentTag(line: string): boolean {
  return line.startsWith("#EXTINF") || line.startsWith("#EXT-X-PROGRAM-DATE-TIME:") || line === DISCONTINUITY;
}

function trimLivePlaylist(
  playlist: string,
  prefix: string,
  earliestProgramTime?: Date,
): TrimmedPlaylist | null {
  const rewriteUri = (uri: string): string | null => {
    const name = segmentName(uri);
    return name ? `${prefix}${name}` : null;
  };
  const lines = playlist.split(/\r?\n/);
  const output: string[] = [];
  const segments: string[] = [];
  let pending: string[] = [];
  // Wall-clock start of the next segment. An EXT-X-PROGRAM-DATE-TIME tag sets it;
  // otherwise it runs on from the last tagged segment by the EXTINF durations, as
  // the HLS spec defines. vps1's VAR playlist tags only some segments (98 of 450 on
  // 2026-11-02), so requiring a tag on every one rejected every academy playlist.
  // Camera gaps only push real time later than the run-on clock, so a segment kept
  // by it really is at or after the cut; a segment before any tag is dropped.
  let clock: number | null = null;
  let duration = 0;
  let sawTimestamp = false;
  let sawSegment = false;
  let keptSegment = false;
  // Segments (and the discontinuities they carry) dropped ahead of the first kept
  // segment. The sequence numbers are advanced by these counts so every kept segment
  // keeps the media sequence number vps1 gave it, and stays stable across reloads.
  let droppedSegments = 0;
  let droppedDiscontinuities = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const parsed = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      clock = Number.isFinite(parsed) ? parsed : null;
    } else if (line.startsWith("#EXTINF:")) {
      const seconds = Number.parseFloat(line.slice("#EXTINF:".length));
      duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    }
    if (line.startsWith("#")) {
      const rewritten = line.replace(/URI="([^"]+)"/g, (full, uri: string) => {
        const proxied = rewriteUri(uri);
        return proxied ? `URI="${proxied}"` : full;
      });
      if (/URI="https?:\/\//i.test(rewritten)) return null;
      if (sawSegment || isSegmentTag(line)) pending.push(rewritten);
      else output.push(rewritten);
      continue;
    }
    if (!line.trim()) continue;
    const name = segmentName(line.trim());
    if (!name || /^https?:\/\//i.test(line.trim())) return null;
    const startedAt = clock;
    let keep = true;
    if (earliestProgramTime) {
      keep = startedAt !== null && startedAt >= earliestProgramTime.getTime();
      if (startedAt !== null) sawTimestamp = true;
    }
    if (keep) {
      output.push(...pending, `${prefix}${name}`);
      segments.push(name);
      keptSegment = true;
    } else if (!keptSegment) {
      droppedSegments += 1;
      droppedDiscontinuities += pending.filter((tag) => tag === DISCONTINUITY).length;
    }
    pending = [];
    clock = startedAt !== null && duration > 0 ? startedAt + duration * 1000 : null;
    duration = 0;
    sawSegment = true;
  }
  // Asked to cut, but no segment carried a usable time: nothing can be shown safely.
  if (earliestProgramTime && sawSegment && !sawTimestamp) return null;
  if (pending.length) output.push(...pending);
  if (droppedSegments > 0) advanceSequences(output, droppedSegments, droppedDiscontinuities);
  return { playlist: output.join("\n"), segments };
}

function advanceSequences(output: string[], segments: number, discontinuities: number): void {
  const bump = (tag: string, by: number): boolean => {
    const index = output.findIndex((line) => line.startsWith(tag));
    if (index < 0) return false;
    const current = Number(output[index].slice(tag.length).trim());
    output[index] = `${tag}${(Number.isSafeInteger(current) ? current : 0) + by}`;
    return true;
  };
  // An absent tag means a sequence of 0; a missing one is added among the header tags,
  // which all precede the first segment's tags.
  const headerEnd = () => {
    const index = output.findIndex((line) => !line.startsWith("#") || isSegmentTag(line));
    return index < 0 ? output.length : index;
  };
  if (!bump(MEDIA_SEQUENCE, segments)) output.splice(headerEnd(), 0, `${MEDIA_SEQUENCE}${segments}`);
  if (discontinuities > 0 && !bump(DISCONTINUITY_SEQUENCE, discontinuities)) {
    output.splice(headerEnd(), 0, `${DISCONTINUITY_SEQUENCE}${discontinuities}`);
  }
}

export function rewriteLivePlaylist(
  playlist: string,
  prefix: string,
  earliestProgramTime?: Date,
): string | null {
  return trimLivePlaylist(playlist, prefix, earliestProgramTime)?.playlist ?? null;
}

/**
 * The segment names the playlist rewritten with the same cut would list. A segment
 * proxy uses it to refuse anything else still in vps1's rolling window, such as
 * footage from before a booking started. Null when the playlist cannot be trimmed.
 */
export function liveSegmentNames(playlist: string, earliestProgramTime?: Date): Set<string> | null {
  const trimmed = trimLivePlaylist(playlist, "", earliestProgramTime);
  return trimmed ? new Set(trimmed.segments) : null;
}

export function pipeLiveSegment(
  upstream: globalThis.Response,
  response: ExpressResponse,
  onError: (error: unknown) => void,
): void {
  if (!upstream.ok || !upstream.body) {
    response.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
      .json({ error: "Live segment unavailable" });
    return;
  }
  const contentType = upstream.headers.get("content-type");
  if (contentType) response.set("Content-Type", contentType);
  response.set("Cache-Control", "private, max-age=60");
  const stream = Readable.fromWeb(upstream.body as globalThis.ReadableStream<Uint8Array>);
  stream.once("error", (error) => {
    onError(error);
    if (!response.headersSent && !response.destroyed) response.status(502).json({ error: "Live segment unavailable" });
    else if (!response.destroyed) response.destroy();
  });
  response.once("close", () => {
    if (!response.writableFinished) stream.destroy();
  });
  stream.pipe(response);
}
