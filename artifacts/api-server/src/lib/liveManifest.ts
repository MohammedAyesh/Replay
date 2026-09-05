/**
 * Reading a live HLS playlist well enough to answer three questions the app
 * currently cannot: how far back can a viewer scrub, is anything actually
 * arriving, and what wall-clock moment is the live edge.
 *
 * No network here. The route fetches the text; this decides what it means.
 *
 * The third question is the one that matters most in practice. When no camera
 * is pushing, the origin keeps serving the last playlist it wrote — cam1's has
 * been served unchanged since 2026-09-01 — so every request succeeds, the
 * player attaches, and the viewer watches a spinner forever. A 200 is not
 * evidence of a live stream. The timestamps in the playlist are.
 */

export type LiveSegment = { name: string; durationSeconds: number };

export type LiveManifest = {
  segments: LiveSegment[];
  /** Sum of every EXTINF: how far back a viewer can scrub. */
  dvrSeconds: number;
  targetDurationSeconds: number;
  mediaSequence: number;
  /**
   * Wall-clock of the newest frame, derived from the last
   * EXT-X-PROGRAM-DATE-TIME plus the durations that follow it. Null when the
   * playlist carries no PDT, in which case freshness cannot be judged from the
   * playlist alone.
   */
  liveEdgeAt: Date | null;
  /** An EXT-X-ENDLIST means the stream has finished; there is no live edge. */
  ended: boolean;
};

const NUM = (line: string, tag: string): number | null => {
  if (!line.startsWith(tag)) return null;
  const value = Number(line.slice(tag.length).trim());
  return Number.isFinite(value) ? value : null;
};

export function parseLiveManifest(text: string): LiveManifest {
  const segments: LiveSegment[] = [];
  let targetDurationSeconds = 0;
  let mediaSequence = 0;
  let ended = false;

  // The live edge is the last PDT plus everything after it, not the first PDT
  // plus everything: these playlists carry a fresh PDT every few segments, and
  // anchoring on the first one accumulates the drift the later ones exist to
  // correct.
  let lastPdt: Date | null = null;
  let secondsSincePdt = 0;

  let pendingDuration: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      const target = NUM(line, "#EXT-X-TARGETDURATION:");
      if (target !== null) { targetDurationSeconds = target; continue; }
      const seq = NUM(line, "#EXT-X-MEDIA-SEQUENCE:");
      if (seq !== null) { mediaSequence = seq; continue; }
      if (line.startsWith("#EXT-X-ENDLIST")) { ended = true; continue; }
      if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
        const at = new Date(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim());
        if (!Number.isNaN(at.getTime())) { lastPdt = at; secondsSincePdt = 0; }
        continue;
      }
      if (line.startsWith("#EXTINF:")) {
        const value = Number.parseFloat(line.slice("#EXTINF:".length));
        pendingDuration = Number.isFinite(value) ? value : 0;
      }
      continue;
    }

    // A media line. Only counts if an EXTINF introduced it.
    if (pendingDuration === null) continue;
    segments.push({ name: line, durationSeconds: pendingDuration });
    if (lastPdt) secondsSincePdt += pendingDuration;
    pendingDuration = null;
  }

  const dvrSeconds = segments.reduce((total, s) => total + s.durationSeconds, 0);
  const liveEdgeAt = lastPdt ? new Date(lastPdt.getTime() + secondsSincePdt * 1000) : null;

  return { segments, dvrSeconds, targetDurationSeconds, mediaSequence, liveEdgeAt, ended };
}

/**
 * How stale is the live edge? Null when the playlist carries no PDT.
 *
 * Deliberately signed: a small negative value is normal, because the origin
 * writes a segment's PDT at the start of the wall-clock period it covers and
 * the encoder is a second or two ahead of the fetch.
 */
export function livenessSeconds(manifest: LiveManifest, now: Date): number | null {
  if (!manifest.liveEdgeAt) return null;
  return (now.getTime() - manifest.liveEdgeAt.getTime()) / 1000;
}

/**
 * The threshold past which a stream is not live any more.
 *
 * Three target durations, floored at 30 seconds. Tied to the playlist's own
 * segment length rather than a flat number because a stream cut into 4-second
 * segments and one cut into 10-second segments have very different definitions
 * of "a moment ago", and the playlist is the only thing that knows which it is.
 */
export function stalenessThresholdSeconds(manifest: LiveManifest): number {
  return Math.max(30, (manifest.targetDurationSeconds || 6) * 3);
}

export type LiveStatus = {
  live: boolean;
  reason: "live" | "stale" | "ended" | "empty" | "no-timestamps";
  dvrSeconds: number;
  behindSeconds: number | null;
  liveEdgeAt: string | null;
  segmentCount: number;
};

export function describeLive(manifest: LiveManifest, now: Date): LiveStatus {
  const behind = livenessSeconds(manifest, now);
  const base = {
    dvrSeconds: Math.round(manifest.dvrSeconds),
    behindSeconds: behind === null ? null : Math.round(behind),
    liveEdgeAt: manifest.liveEdgeAt?.toISOString() ?? null,
    segmentCount: manifest.segments.length,
  };
  if (manifest.segments.length === 0) return { live: false, reason: "empty", ...base };
  if (manifest.ended) return { live: false, reason: "ended", ...base };
  // No PDT: the playlist cannot prove it is live, and it cannot prove it is
  // not. Treated as live, because refusing to play a stream that is fine is
  // worse than showing one that has just stopped — and the viewer finds out in
  // seconds either way.
  if (behind === null) return { live: true, reason: "no-timestamps", ...base };
  return behind <= stalenessThresholdSeconds(manifest)
    ? { live: true, reason: "live", ...base }
    : { live: false, reason: "stale", ...base };
}

/** "4 days ago", for telling someone why the screen is black. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
