/**
 * Where a saved clip sits in its video, in seconds.
 *
 * user_clips.start_time / end_time are shares (0–1) of the whole video's
 * length: the export multiplies them by the length Bunny reports
 * (routes/userClips.ts renderClip). The Creative hub used to read them as
 * seconds, so a clip in a design played from the first second of the match.
 *
 * The length comes from Bunny first (what the export uses), then from the
 * recording's own duration text. Values above 1 are taken as seconds already
 * (nothing writes those today; it keeps a bad row from turning into an hour).
 */
import { eq, like, or } from "drizzle-orm";
import { db, recordingsTable, type UserClipRow } from "@workspace/db";
import { getBunnyVideoInfo, isBunnyConfigured } from "../bunny";
import { extractBunnyVideoId } from "../publicFootage";
import { recordingSeconds } from "./library";

const lengths = new Map<string, { seconds: number | null; at: number }>();
const LENGTH_TTL_MS = 30 * 60_000;

/** The video's length in seconds (Bunny, else the recording's duration text), or null. */
export async function videoLengthSeconds(videoId: string, recordingDuration?: string | null): Promise<number | null> {
  const key = videoId.toLowerCase();
  const hit = lengths.get(key);
  if (hit && Date.now() - hit.at < LENGTH_TTL_MS && hit.seconds) return hit.seconds;
  let seconds: number | null = null;
  if (isBunnyConfigured() && !videoId.startsWith("live:")) {
    seconds = await getBunnyVideoInfo(videoId).then((i) => i.duration).catch(() => null);
  }
  if (!seconds) {
    let text = recordingDuration ?? null;
    if (text === undefined || text === null) {
      const [rec] = await db.select({ duration: recordingsTable.duration, videoUrl: recordingsTable.videoUrl }).from(recordingsTable)
        .where(or(like(recordingsTable.videoUrl, `%/${videoId}/%`), eq(recordingsTable.videoUrl, videoId))).limit(5)
        .then((rows) => rows.filter((r) => extractBunnyVideoId(r.videoUrl)?.toLowerCase() === key));
      text = rec?.duration ?? null;
    }
    seconds = recordingSeconds(text);
  }
  lengths.set(key, { seconds, at: Date.now() });
  if (lengths.size > 500) lengths.delete(lengths.keys().next().value!);
  return seconds;
}

export type ClipSpan = { startSec: number; endSec: number; thumbSec: number | null; videoSeconds: number | null };

/** thumbnail_time is already in seconds (the poster's second); kept only inside the clip. */
const within = (t: number | null, a: number, b: number) => (t !== null && Number.isFinite(t) && t >= a && t <= b ? t : null);

/** Pure: start and end as shares (or seconds, when above 1) to seconds, given the video's length. */
export function spanOf(start: number, end: number, thumb: number | null, videoSeconds: number | null): ClipSpan | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end <= 1.0001) {
    if (!videoSeconds) return null;
    const startSec = start * videoSeconds;
    const endSec = end * videoSeconds;
    return { startSec, endSec, thumbSec: within(thumb, startSec, endSec), videoSeconds };
  }
  return { startSec: start, endSec: end, thumbSec: within(thumb, start, end), videoSeconds };
}

/** A clip's stretch of its video in seconds, or null when its video's length can't be found. */
export async function clipSpan(
  clip: Pick<UserClipRow, "videoId" | "startTime" | "endTime" | "thumbnailTime">,
  recordingDuration?: string | null,
): Promise<ClipSpan | null> {
  const start = Number(clip.startTime);
  const end = Number(clip.endTime);
  const thumb = clip.thumbnailTime != null ? Number(clip.thumbnailTime) : null;
  const videoSeconds = end <= 1.0001 ? await videoLengthSeconds(clip.videoId, recordingDuration) : null;
  return spanOf(start, end, thumb, videoSeconds);
}

/** For tests. */
export function clearClipSpanCache(): void {
  lengths.clear();
}

/** Spans for many clips: each video's length is looked up once, eight at a time. */
export async function clipSpans(
  clips: Array<Pick<UserClipRow, "id" | "videoId" | "startTime" | "endTime" | "thumbnailTime">>,
  durationOf?: (clip: Pick<UserClipRow, "id" | "videoId">) => string | null | undefined,
): Promise<Map<number, ClipSpan | null>> {
  const need = new Map<string, string | null | undefined>();
  for (const c of clips) {
    if (Number(c.endTime) <= 1.0001 && !c.videoId.startsWith("live:") && !need.has(c.videoId.toLowerCase())) need.set(c.videoId.toLowerCase(), durationOf?.(c));
  }
  const ids = [...need.keys()];
  const got = new Map<string, number | null>();
  for (let i = 0; i < ids.length; i += 8) {
    const batch = ids.slice(i, i + 8);
    const seconds = await Promise.all(batch.map((id) => videoLengthSeconds(id, need.get(id))));
    batch.forEach((id, j) => got.set(id, seconds[j]));
  }
  const out = new Map<number, ClipSpan | null>();
  for (const c of clips) {
    const thumb = c.thumbnailTime != null ? Number(c.thumbnailTime) : null;
    out.set(c.id, spanOf(Number(c.startTime), Number(c.endTime), thumb, got.get(c.videoId.toLowerCase()) ?? null));
  }
  return out;
}
