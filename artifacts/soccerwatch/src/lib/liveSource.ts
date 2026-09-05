/**
 * Asking the server where to play live from, and whether there is anything
 * there.
 *
 * Both halves come from one endpoint on purpose. The url alone is not enough:
 * when no camera is pushing, the origin keeps serving the playlist it last
 * wrote, so the fetch succeeds, the player attaches, and the viewer watches a
 * spinner over a frame that is days old. The server reads the timestamps in the
 * playlist and says so; this is the client's half of that.
 */

export type LiveStatusReason =
  | "live" | "stale" | "ended" | "empty" | "no-timestamps" | "unreachable";

export interface LiveStatus {
  live: boolean;
  reason: LiveStatusReason;
  /** How far back a viewer can scrub, in seconds. */
  dvrSeconds: number;
  behindSeconds: number | null;
  liveEdgeAt: string | null;
  segmentCount: number;
}

export interface LiveSource {
  camera: string;
  variant: "hls" | "hevc";
  /** The CDN playlist. Playing this keeps the app out of the byte path. */
  url: string;
  /** The same stream relayed by the app, for a client that cannot reach the CDN. */
  proxyUrl: string;
  status: LiveStatus;
  /** Ready to show a person, or null when the stream is fine. */
  message: string | null;
}

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export async function fetchLiveSource(
  camera: string,
  variant: "hls" | "hevc" = "hls",
): Promise<LiveSource> {
  const res = await fetch(`${basePath}/api/live/${camera}/source?variant=${variant}`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Could not reach the live service (${res.status})`);
  return body as LiveSource;
}

/**
 * How long to wait before asking again.
 *
 * A stream that is up needs a slow poll — the player has the playlist and does
 * its own refreshing, and this only exists to notice it going away. A stream
 * that is down needs a faster one, because somebody is standing at a pitch
 * waiting for it to come back and a minute of blank screen after the camera
 * starts is a minute they spend power-cycling something that was about to work.
 */
export function nextPollMs(status: LiveStatus | null): number {
  if (!status) return 15_000;
  return status.live ? 60_000 : 15_000;
}

/**
 * The scrubbable window, in seconds.
 *
 * Prefers what the server measured from the playlist over any hardcoded guess:
 * the VAR panel used to assume 300 while the VPS was keeping 900 for the
 * stream-copy rendition and about 1800 for the transcoded one, so two thirds of
 * the available window was unreachable.
 */
export function dvrWindowSeconds(status: LiveStatus | null, fallback = 900): number {
  if (!status || status.dvrSeconds <= 0) return fallback;
  // One target duration of slack: the newest segment is still being written.
  return Math.max(30, status.dvrSeconds);
}

/** "12:04:31" in the viewer's own clock, from a media-time/wall-clock anchor. */
export function formatWallClock(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale || undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

/** "live", or "−1:23" behind it. Negative is not shown as a negative duration. */
export function formatBehindLive(secondsBehind: number): string {
  const s = Math.max(0, Math.round(secondsBehind));
  if (s <= 2) return "live";
  const m = Math.floor(s / 60);
  return `−${m}:${String(s % 60).padStart(2, "0")}`;
}
