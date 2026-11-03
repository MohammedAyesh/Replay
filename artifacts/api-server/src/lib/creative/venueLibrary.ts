/**
 * Creative hub and Studio for a field (an academies row with kind = 'venue').
 *
 * An academy builds from its own sessions and its members' clips. A field owns
 * the camera, so it builds from everything filmed at its fields:
 *
 *   matches   every recording at the field's fields (no academy sessions here:
 *             a "match" id is the recording id)
 *   moments   one recording: the analysis' goals, chances and dribbles, and every
 *             clip anyone saved from it
 *   clips     every clip cut from the field's footage: by players by hand
 *             ("player"), or by Replay from the match analysis ("auto"), plus
 *             clips cut from the owner's own footage share links
 *
 * Players here are adults at a public pitch, but their clips are theirs: a
 * clip's title is shown, its maker only as a first name.
 */
import { and, desc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import {
  academiesTable,
  db,
  footageRequestsTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  userClipsTable,
  usersTable,
  venuePitchesTable,
  type TrackingManifest,
  type UserClipRow,
} from "@workspace/db";
import type { MediaSource } from "@workspace/api-zod";
import { getBunnyProxiedThumbnailUrl, isBunnyConfigured } from "../bunny";
import { logger } from "../logger";
import { academyClipStatus } from "../userClipExportState";
import { extractBunnyVideoId } from "../publicFootage";
import {
  ammanClock,
  ammanDate,
  bunnyVideoIdOf,
  frameSource,
  matchMinute,
  pageOf,
  recordingSeconds,
  savedClipWindow,
  windowSource,
  type LibraryFilters,
  type RecordingWindow,
} from "./library";
import { analysisMoments, filterMoments, trackPlayerLookup, type LibraryMoment } from "./libraryMoments";

/** The fields a venue films: its own field and every pitch linked to a camera field. Null for an academy. */
export async function venueFieldIds(academyId: number): Promise<number[] | null> {
  const [row] = await db.select({ kind: academiesTable.kind, fieldId: academiesTable.fieldId }).from(academiesTable).where(eq(academiesTable.id, academyId));
  if (!row || row.kind !== "venue") return null;
  const pitches = await db.select({ fieldId: venuePitchesTable.fieldId }).from(venuePitchesTable)
    .where(and(eq(venuePitchesTable.academyId, academyId), isNotNull(venuePitchesTable.fieldId)));
  const ids = new Set<number>();
  if (row.fieldId) ids.add(row.fieldId);
  for (const p of pitches) if (p.fieldId) ids.add(p.fieldId);
  return [...ids];
}

export async function isVenue(academyId: number): Promise<boolean> {
  const [row] = await db.select({ kind: academiesTable.kind }).from(academiesTable).where(eq(academiesTable.id, academyId));
  return row?.kind === "venue";
}

type VenueRecording = { id: number; fieldId: number; court: string; date: string; timeSlot: string; duration: string; videoUrl: string; createdAt: Date };

async function venueRecordings(fieldIds: number[]): Promise<VenueRecording[]> {
  if (!fieldIds.length) return [];
  const rows = await db.select({
    id: recordingsTable.id,
    fieldId: recordingsTable.fieldId,
    court: recordingsTable.court,
    date: recordingsTable.date,
    timeSlot: recordingsTable.timeSlot,
    duration: recordingsTable.duration,
    videoUrl: recordingsTable.videoUrl,
    createdAt: recordingsTable.createdAt,
  }).from(recordingsTable)
    .where(and(inArray(recordingsTable.fieldId, fieldIds), sql`${recordingsTable.videoUrl} <> ''`))
    .orderBy(desc(recordingsTable.date), desc(recordingsTable.timeSlot), desc(recordingsTable.id))
    .limit(2000);
  return rows;
}

/** A recording at one of the venue's fields, or null. */
export async function venueRecording(academyId: number, recordingId: number): Promise<{ id: number; videoUrl: string } | null> {
  const fields = await venueFieldIds(academyId);
  if (!fields?.length) return null;
  const [row] = await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl }).from(recordingsTable)
    .where(and(eq(recordingsTable.id, recordingId), inArray(recordingsTable.fieldId, fields))).limit(1);
  return row && row.videoUrl ? row : null;
}

/** Which clips are footage of the venue: by source recording, by the recording's video, or by the owner's footage request. */
async function clipScope(fieldIds: number[]) {
  const recs = await venueRecordings(fieldIds);
  const byVideo = new Map<string, VenueRecording>();
  for (const r of recs) {
    const id = extractBunnyVideoId(r.videoUrl)?.toLowerCase();
    if (id) byVideo.set(id, r);
  }
  const requests = fieldIds.length
    ? await db.select({ id: footageRequestsTable.id }).from(footageRequestsTable).where(inArray(footageRequestsTable.fieldId, fieldIds))
    : [];
  const recById = new Map(recs.map((r) => [r.id, r]));
  const conditions: SQL[] = [];
  if (recs.length) conditions.push(inArray(userClipsTable.sourceRecordingId, recs.map((r) => r.id)));
  if (byVideo.size) conditions.push(inArray(sql<string>`lower(${userClipsTable.videoId})`, [...byVideo.keys()]));
  if (requests.length) conditions.push(inArray(userClipsTable.footageRequestId, requests.map((r) => r.id)));
  const recordingOf = (clip: Pick<UserClipRow, "sourceRecordingId" | "videoId">): VenueRecording | null =>
    (clip.sourceRecordingId ? recById.get(clip.sourceRecordingId) : undefined) ?? byVideo.get(clip.videoId.toLowerCase()) ?? null;
  return { recs, recById, where: conditions.length ? or(...conditions)! : null, recordingOf };
}

/** A clip cut from the venue's footage, not deleted. */
export async function venueClip(academyId: number, clipId: number): Promise<UserClipRow | null> {
  const fields = await venueFieldIds(academyId);
  if (!fields?.length) return null;
  const scope = await clipScope(fields);
  if (!scope.where) return null;
  const [row] = await db.select().from(userClipsTable).where(and(eq(userClipsTable.id, clipId), scope.where)).limit(1);
  if (!row || row.hiddenReason === "deleted") return null;
  return row;
}

/**
 * Who made a clip. Replay's own clips (a player's moments from the match
 * analysis, made when he claims his game) are written with no source link at
 * all; anything a person cut by hand records the recording, the footage share
 * or the match room it came from.
 */
export function clipOrigin(clip: Pick<UserClipRow, "sourceRecordingId" | "footageRequestId" | "matchCode" | "academyId">): "auto" | "player" {
  return clip.sourceRecordingId === null && clip.footageRequestId === null && clip.matchCode === null && clip.academyId === null ? "auto" : "player";
}

// ── Matches ─────────────────────────────────────────────────────────────────

/** "2026-11-02" + "20:00" (Amman) → the instant. */
function recordingStart(r: Pick<VenueRecording, "date" | "timeSlot" | "createdAt">): Date {
  const time = /^\d{1,2}:\d{2}/.exec(r.timeSlot ?? "")?.[0];
  if (!time) return r.createdAt;
  const [h, m] = time.split(":").map(Number);
  const d = new Date(`${r.date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+03:00`);
  return Number.isNaN(d.getTime()) ? r.createdAt : d;
}

function thumbAt(videoUrl: string | null | undefined, seconds: number): string | null {
  const id = bunnyVideoIdOf(videoUrl);
  if (!id || !isBunnyConfigured()) return null;
  return getBunnyProxiedThumbnailUrl(id, Math.max(0, seconds));
}

export async function venueLibraryMatches(fieldIds: number[], f: LibraryFilters) {
  let recs = await venueRecordings(fieldIds);
  if (f.from) recs = recs.filter((r) => recordingStart(r) >= f.from!);
  if (f.until) recs = recs.filter((r) => recordingStart(r) < f.until!);
  const page = pageOf(recs, f);
  const ids = page.items.map((r) => r.id);
  const bundles = ids.length
    ? await db.select({ recordingId: recordingTrackingBundlesTable.recordingId }).from(recordingTrackingBundlesTable).where(inArray(recordingTrackingBundlesTable.recordingId, ids))
    : [];
  const analysed = new Set(bundles.map((b) => b.recordingId));
  const matches = page.items.map((r) => {
    const seconds = recordingSeconds(r.duration);
    const thumbSec = seconds ? Math.min(600, seconds / 4) : 60;
    const at = recordingStart(r);
    return {
      sessionId: r.id,
      type: "match" as const,
      startsAt: at.toISOString(),
      date: ammanDate(at),
      time: ammanClock(at),
      location: r.court ? `Pitch ${r.court}` : null,
      opponent: null,
      ownScore: null,
      opponentScore: null,
      squad: null,
      durationMs: seconds ? Math.round(seconds * 1000) : null,
      recordingIds: [r.id],
      recordingId: r.id,
      analysed: analysed.has(r.id),
      still: frameSource(r.id, thumbSec * 1000),
      thumbnailUrl: thumbAt(r.videoUrl, thumbSec),
      /** A field's matches are recordings: there is no academy session behind them. */
      wholeMatch: false,
    };
  });
  return { matches, total: page.total, nextOffset: page.nextOffset };
}

// ── One recording: its moments ──────────────────────────────────────────────

async function analysisFor(rec: VenueRecording): Promise<{ state: "ready" | "none" | "failed"; moments: LibraryMoment[]; manifest: TrackingManifest | null }> {
  const [{ latestBundle, loadMatchRoster }, { loadRecordingPlay }, { goalVotesFor, reviewedGoalsOf }, { clipRangeToMatchWindow, readMatchWindow }] = await Promise.all([
    import("../academyMatchStats"),
    import("../matchPlayLoad"),
    import("../goalReview"),
    import("../matchWindow"),
  ]);
  const bundle = await latestBundle(rec.id);
  if (!bundle) return { state: "none", moments: [], manifest: null };
  try {
    const manifest = bundle.manifest;
    const [roster, play, votes] = await Promise.all([loadMatchRoster(manifest), loadRecordingPlay(rec.id), goalVotesFor([rec.id])]);
    if (!play) return { state: "none", moments: [], manifest };
    const games = (play.phases ?? []).filter((p) => p.kind === "game");
    const stored = readMatchWindow(manifest);
    const window = clipRangeToMatchWindow(0, manifest.duration, manifest)
      ?? (games.length ? { fromSeconds: games[0].start, toSeconds: games[games.length - 1].end } : null);
    const kickOff = stored?.startSeconds ?? games[0]?.start ?? 0;
    const reviewed = play.hasBall ? reviewedGoalsOf(play, votes.get(rec.id) ?? []) : [];
    const moments = analysisMoments({
      recordingId: rec.id,
      videoStartSeconds: manifest.videoStartSeconds ?? 0,
      durationSec: recordingSeconds(rec.duration),
      kickOffSeconds: kickOff,
      window,
      fps: play.fps,
      chances: reviewed.map((g) => ({ t: g.t, status: g.status, trackId: g.trackId, touchF: g.touchF, ownGoal: g.ownGoal })),
      dribbles: play.hasBall ? play.dribbles : [],
      // No line-up at a public pitch: moments carry no player.
      playerAt: trackPlayerLookup(roster, new Map()),
      thumbnailAt: (atMs) => thumbAt(rec.videoUrl, atMs / 1000),
    });
    return { state: "ready", moments, manifest };
  } catch (error) {
    logger.warn({ recordingId: rec.id, error: (error as Error).message }, "Venue library: match analysis moments failed");
    return { state: "failed", moments: [], manifest: bundle.manifest };
  }
}

export async function venueRecordingMoments(fieldIds: number[], recordingId: number, f: LibraryFilters) {
  const scope = await clipScope(fieldIds);
  const rec = scope.recById.get(recordingId);
  if (!rec) return null;
  const analysis = await analysisFor(rec);
  const videoId = extractBunnyVideoId(rec.videoUrl)?.toLowerCase();
  const clipRows = await db.select().from(userClipsTable).where(and(
    or(eq(userClipsTable.sourceRecordingId, rec.id), videoId ? eq(sql`lower(${userClipsTable.videoId})`, videoId) : sql`false`)!,
    eq(userClipsTable.isHidden, false),
  )).orderBy(userClipsTable.startTime).limit(500);
  const manifest = analysis.manifest;
  const kickOff = (manifest?.provenance as { matchWindow?: { startSeconds?: number } } | undefined)?.matchWindow?.startSeconds ?? 0;
  const saved: LibraryMoment[] = [];
  for (const clip of clipRows) {
    if (clip.hiddenReason || clip.videoId.startsWith("live:")) continue;
    const w = savedClipWindow(rec.id, Number(clip.startTime), Number(clip.endTime), clip.thumbnailTime != null ? Number(clip.thumbnailTime) : null);
    if (!w) continue;
    const window: RecordingWindow = { recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs };
    const tracking = Number(clip.startTime) - (manifest?.videoStartSeconds ?? 0);
    saved.push({
      id: `saved:${clip.id}`,
      type: "saved",
      recordingId: rec.id,
      window,
      atMs: w.atMs,
      durationMs: w.toMs - w.fromMs,
      minute: manifest ? matchMinute(tracking, kickOff) : Math.floor(Number(clip.startTime) / 60) + 1,
      player: null,
      ours: null,
      ownGoal: false,
      title: clip.title.slice(0, 80),
      clipId: clip.id,
      source: windowSource(window),
      still: frameSource(rec.id, w.atMs),
      thumbnailUrl: thumbAt(rec.videoUrl, w.atMs / 1000),
    });
  }
  const all = [...analysis.moments, ...saved].sort((a, b) => a.window.fromMs - b.window.fromMs || a.id.localeCompare(b.id));
  const counts = { goal: 0, chance: 0, highlight: 0, saved: 0 };
  for (const m of all) counts[m.type]++;
  const page = pageOf(filterMoments(all, f), f);
  return { sessionId: rec.id, analysis: analysis.state, recordingIds: [rec.id], counts, moments: page.items, total: page.total, nextOffset: page.nextOffset };
}

// ── Clips ───────────────────────────────────────────────────────────────────

export type ClipOrigin = "auto" | "player";

/** Every clip cut from the venue's footage, newest first. `origin` narrows to Replay's or players'. */
export async function venueClipRows(fieldIds: number[], options: { origin?: ClipOrigin | null; from?: Date | null; until?: Date | null; limit?: number } = {}) {
  const scope = await clipScope(fieldIds);
  if (!scope.where) return { rows: [] as Array<{ clip: UserClipRow; creatorName: string | null; recording: VenueRecording | null; origin: ClipOrigin }>, scope };
  const where: SQL[] = [scope.where, isNotNull(userClipsTable.videoId)];
  if (options.from) where.push(sql`${userClipsTable.createdAt} >= ${options.from}`);
  if (options.until) where.push(sql`${userClipsTable.createdAt} < ${options.until}`);
  const rows = await db.select({ clip: userClipsTable, creatorName: usersTable.name })
    .from(userClipsTable)
    .leftJoin(usersTable, eq(usersTable.id, userClipsTable.userId))
    .where(and(...where))
    .orderBy(desc(userClipsTable.createdAt), desc(userClipsTable.id))
    .limit(options.limit ?? 1000);
  const out = [];
  for (const r of rows) {
    if (r.clip.hiddenReason === "deleted") continue;
    const origin = clipOrigin(r.clip);
    if (options.origin && origin !== options.origin) continue;
    out.push({ clip: r.clip, creatorName: r.creatorName, recording: scope.recordingOf(r.clip), origin });
  }
  return { rows: out, scope };
}

export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first.slice(0, 30) : null;
}

export async function venueLibraryClips(academyId: number, fieldIds: number[], f: LibraryFilters, origin: ClipOrigin | null) {
  const { rows } = await venueClipRows(fieldIds, { from: f.from, until: f.until });
  const clips = [];
  const counts = { all: 0, auto: 0, player: 0 };
  for (const { clip, creatorName, recording, origin: o } of rows) {
    const status = academyClipStatus(clip);
    if (status === "expired") continue;
    counts.all++;
    counts[o]++;
    if (origin && o !== origin) continue;
    const isLive = clip.videoId.startsWith("live:");
    const start = Number(clip.startTime);
    const end = Number(clip.endTime);
    const thumbTime = clip.thumbnailTime != null ? Number(clip.thumbnailTime) : start;
    const w = recording ? savedClipWindow(recording.id, start, end, thumbTime) : null;
    clips.push({
      clipId: clip.id,
      title: clip.title.slice(0, 80),
      status,
      aspectRatio: clip.aspectRatio === "9:16" ? "9:16" as const : "16:9" as const,
      createdAt: clip.createdAt.toISOString(),
      date: ammanDate(clip.createdAt),
      durationMs: w ? w.toMs - w.fromMs : Math.max(0, Math.round((end - start) * 1000)),
      sessionId: recording?.id ?? null,
      source: { type: "clip", clipId: clip.id } as Extract<MediaSource, { type: "clip" }>,
      window: w ? { recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs } : null,
      still: w ? frameSource(w.recordingId, w.atMs) : null,
      thumbnailUrl: !isLive && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(clip.videoId, thumbTime) : null,
      videoUrl: status === "ready" ? `/api/academy/console/academies/${academyId}/studio/clips/${clip.id}/video` : null,
      origin: o,
      madeBy: o === "auto" ? null : firstNameOf(creatorName),
    });
  }
  const page = pageOf(clips, f);
  return { clips: page.items, total: page.total, nextOffset: page.nextOffset, counts };
}
