import { Readable } from "node:stream";
import type { Response as ExpressResponse } from "express";

const SEGMENT_PATH = /(?:^|\/)seg\/([A-Za-z0-9._-]+\.(?:ts|m4s|mp4))(?:\?.*)?$/i;
const BARE_SEGMENT = /^([A-Za-z0-9._-]+\.(?:ts|m4s|mp4))(?:\?.*)?$/i;

export function rewriteLivePlaylist(
  playlist: string,
  prefix: string,
  earliestProgramTime?: Date,
): string | null {
  const rewriteUri = (uri: string): string | null => {
    const match = SEGMENT_PATH.exec(uri) ?? BARE_SEGMENT.exec(uri);
    return match ? `${prefix}${match[1]}` : null;
  };
  const lines = playlist.split(/\r?\n/);
  const output: string[] = [];
  let removedSegments = 0;
  let mediaSequenceIndex = -1;
  let pending: string[] = [];
  let programTime: number | null = null;
  let sawSegment = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequenceIndex = output.length;
      output.push(line);
      continue;
    }
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      programTime = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
    }
    if (line.startsWith("#")) {
      const rewritten = line.replace(/URI="([^"]+)"/g, (full, uri: string) => {
        const proxied = rewriteUri(uri);
        return proxied ? `URI="${proxied}"` : full;
      });
      if (/URI="https?:\/\//i.test(rewritten)) return null;
      if (sawSegment || line.startsWith("#EXTINF") || line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) pending.push(rewritten);
      else output.push(rewritten);
      continue;
    }
    if (!line.trim()) continue;
    const proxied = rewriteUri(line.trim());
    if (!proxied || /^https?:\/\//i.test(line.trim())) return null;
    if (earliestProgramTime) {
      if (programTime === null || !Number.isFinite(programTime)) return null;
      if (programTime >= earliestProgramTime.getTime()) output.push(...pending, proxied);
      else removedSegments += 1;
    } else {
      output.push(...pending, proxied);
    }
    pending = [];
    programTime = null;
    sawSegment = true;
  }
  if (mediaSequenceIndex >= 0 && removedSegments > 0) {
    const match = /^#EXT-X-MEDIA-SEQUENCE:(\d+)$/.exec(output[mediaSequenceIndex] ?? "");
    if (match) output[mediaSequenceIndex] = `#EXT-X-MEDIA-SEQUENCE:${Number(match[1]) + removedSegments}`;
  }
  if (pending.length) output.push(...pending);
  return output.join("\n");
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
