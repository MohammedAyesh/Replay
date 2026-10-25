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
  let programTime: number | null = null;
  let sawSegment = false;
  let keptSegment = false;
  // Segments (and the discontinuities they carry) dropped ahead of the first kept
  // segment. The sequence numbers are advanced by these counts so every kept segment
  // keeps the media sequence number vps1 gave it, and stays stable across reloads.
  let droppedSegments = 0;
  let droppedDiscontinuities = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      programTime = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
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
    let keep = true;
    if (earliestProgramTime) {
      if (programTime === null || !Number.isFinite(programTime)) return null;
      keep = programTime >= earliestProgramTime.getTime();
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
    programTime = null;
    sawSegment = true;
  }
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
