import { randomBytes } from "node:crypto";
import { and, eq, inArray, lt, ne } from "drizzle-orm";
import {
  academiesTable,
  academyMatchPlayerStatsTable,
  academyPlayerClipsTable,
  academyPlayersTable,
  academySessionsTable,
  db,
  recordingsTable,
  userClipsTable,
  type AcademyPlayerClip,
} from "@workspace/db";
import { clip as clipParts, resolveBindings, type AcademyPlayerStats } from "../academyMatchStats";
import { goalVotesFor } from "../goalReview";
import { loadRecordingPlay } from "../matchPlayLoad";
import { clipRangeToMatchWindow } from "../matchWindow";
import { followCrop, followPath, personalMoments, type FollowPoint } from "../personalMoments";
import { logger } from "../logger";
import { blockedPhones, enqueueMessages, getWhatsappSettings, optedOutPhones, senderSessionFor } from "../whatsapp/queue";
import { resolveAudience } from "../whatsapp/recipients";
import { effectiveAutomations, formatDate, formatDay, renderTemplate, type WhatsappLocale } from "../whatsapp/templates";
import { publicBaseUrl } from "../whatsapp/waha";
import { extractBunnyVideoId, isLiveVideoId, parseRecordingDuration, queueUserClipExport } from "../../routes/userClips";
import { loadContext, loadSession } from "../../routes/academyMatches";
import { bestMoment, momentWords, noteWords, ownBaselineNote, type BaselineNote, type StatLine } from "./rules";
import { recordFeatures } from "./store";

/**
 * A private clip for every child after every analysed match, sent to his own
 * parents: his best moment (a goal, a shot, a won dribble … or just him in
 * action), framed on him, and how it compares with HIS OWN earlier matches.
 *
 *   prepare  (automatic once the match is analysed, or from Matches): one row
 *            per bound child, with a user clip framed on him queued for export
 *   send     (the owner presses Send): one WhatsApp per family; a parent with
 *            two children in the match gets one message with both clips
 *
 * The clip opens at /kc/<token> without an account (routes/kidClips.ts).
 */

const HALF = 8; // seconds either side of the moment, as claim moments

export type ClipRowView = {
  id: number;
  playerId: number;
  playerName: string;
  number: number | null;
  status: AcademyPlayerClip["status"];
  momentKind: string | null;
  momentSeconds: number | null;
  note: BaselineNote | null;
  exportStatus: string | null;
  url: string;
  sentAt: string | null;
  openedAt: string | null;
};

export const kidClipUrl = (token: string) => `${publicBaseUrl()}/kc/${token}`;
const newToken = () => randomBytes(16).toString("hex");
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function statLine(s: AcademyPlayerStats | null | undefined): StatLine {
  if (!s) return {};
  return { goals: s.goals, dribblesWon: s.dribblesWon, passesCompleted: s.passesCompleted, touches: s.touches, distanceKm: s.distanceKm, topSpeedKmh: s.topSpeedKmh };
}

/** One line per child for the family's message: "• Omar: his dribble — 3 dribbles won, more than his usual 1\n<link>". */
export function clipLines(children: Array<{ name: string; momentKind: string | null; note: BaselineNote | null; url: string }>, locale: WhatsappLocale): string {
  return children.map((c) => `• ${firstName(c.name)}: ${momentWords(c.momentKind ?? "presence", locale)}${noteWords(c.note, locale)}\n${c.url}`).join("\n");
}

export type PrepareResult = { prepared: number; already: number; noFootage: number[]; reason?: "not_analysed" | "no_recording" | "not_a_match" };

/** Make (or keep) each bound child's clip for this match. Idempotent: a child's row is made once. */
export async function preparePrivateClips(academyId: number, sessionId: number, ownerUserId: number): Promise<PrepareResult> {
  const session = await loadSession(academyId, sessionId);
  if (!session || session.type !== "match") return { prepared: 0, already: 0, noFootage: [], reason: "not_a_match" };
  const ctx = await loadContext(session);
  if (!ctx.recordingId) return { prepared: 0, already: 0, noFootage: [], reason: "no_recording" };
  if (!ctx.bundle || !ctx.roster) return { prepared: 0, already: 0, noFootage: [], reason: "not_analysed" };
  const bindings = resolveBindings(ctx.lineup, ctx.roster);
  const inSquad = new Set(ctx.lineup.filter((l) => l.inSquad && l.isActive).map((l) => l.playerId));
  const bound = bindings.filter((b) => inSquad.has(b.playerId));
  const noFootage = [...inSquad].filter((id) => !bound.some((b) => b.playerId === id));

  const existing = await db.select().from(academyPlayerClipsTable).where(eq(academyPlayerClipsTable.sessionId, sessionId));
  const done = new Set(existing.filter((r) => r.userClipId !== null || r.status === "no_moment").map((r) => r.playerId));
  const todo = bound.filter((b) => !done.has(b.playerId));
  if (!todo.length) return { prepared: 0, already: done.size, noFootage };

  const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, ctx.recordingId));
  const play = await loadRecordingPlay(ctx.recordingId, { keepSegments: true });
  if (!recording || !play?.segments) return { prepared: 0, already: done.size, noFootage, reason: "not_analysed" };
  const manifest = play.manifest;
  const votes = (await goalVotesFor([ctx.recordingId])).get(ctx.recordingId) ?? [];
  const window = clipRangeToMatchWindow(0, manifest.duration, manifest) ?? { fromSeconds: 0, toSeconds: manifest.duration };
  const rosterById = new Map(ctx.roster.players.map((p) => [p.id, p]));

  // His own earlier matches, for the note (never anyone else's).
  const ids = todo.map((b) => b.playerId);
  const [todayStats, history] = await Promise.all([
    db.select({ playerId: academyMatchPlayerStatsTable.playerId, stats: academyMatchPlayerStatsTable.stats })
      .from(academyMatchPlayerStatsTable)
      .where(and(eq(academyMatchPlayerStatsTable.sessionId, sessionId), inArray(academyMatchPlayerStatsTable.playerId, ids))),
    db.select({ playerId: academyMatchPlayerStatsTable.playerId, stats: academyMatchPlayerStatsTable.stats })
      .from(academyMatchPlayerStatsTable)
      .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyMatchPlayerStatsTable.sessionId))
      .where(and(
        inArray(academyMatchPlayerStatsTable.playerId, ids),
        ne(academyMatchPlayerStatsTable.sessionId, sessionId),
        lt(academySessionsTable.startsAt, session.startsAt),
      )),
  ]);

  const videoId = extractBunnyVideoId(recording.videoUrl);
  const duration = parseRecordingDuration(recording.duration) || manifest.duration;
  let prepared = 0;
  for (const b of todo) {
    const rp = rosterById.get(b.rosterPlayerId);
    const parts = rp ? clipParts(rp.parts.map((p) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame })), window.fromSeconds, window.toSeconds, play.fps) : [];
    const today = statLine(todayStats.find((s) => s.playerId === b.playerId)?.stats as AcademyPlayerStats | undefined);
    const note = ownBaselineNote(today, history.filter((h) => h.playerId === b.playerId).map((h) => statLine(h.stats as AcademyPlayerStats)));
    let moment: { kind: string; momentSeconds: number; follow?: FollowPoint[] } | null = null;
    if (parts.length) {
      const credited = play.hasBall ? personalMoments(play, parts, play.segments, manifest, votes) : [];
      moment = bestMoment(credited);
      if (!moment) {
        // Nothing credited (or no ball data): him in action, the middle of his longest stretch on camera.
        const longest = [...parts].sort((x, y) => (y.toFrame - y.fromFrame) - (x.toFrame - x.fromFrame))[0];
        const t = (longest.fromFrame + longest.toFrame) / 2 / play.fps;
        const follow = followPath(parts, play.segments, manifest, t);
        if (follow) moment = { kind: "presence", momentSeconds: t, follow };
      }
    }
    const base = { academyId, sessionId, playerId: b.playerId, recordingId: ctx.recordingId, updatedAt: new Date() };
    if (!moment || !videoId || isLiveVideoId(videoId) || duration <= 0) {
      await db.insert(academyPlayerClipsTable).values({ ...base, token: newToken(), status: "no_moment", note: note ?? null })
        .onConflictDoUpdate({ target: [academyPlayerClipsTable.sessionId, academyPlayerClipsTable.playerId], set: { status: "no_moment", updatedAt: new Date() } });
      continue;
    }
    try {
      const start = Math.max(0, moment.momentSeconds - HALF + manifest.videoStartSeconds);
      const end = Math.min(duration, moment.momentSeconds + HALF + manifest.videoStartSeconds);
      const [uc] = await db.insert(userClipsTable).values({
        userId: ownerUserId,
        videoId,
        title: `${firstName(ctx.lineup.find((l) => l.playerId === b.playerId)?.name ?? "")} · ${momentWords(moment.kind, "en")}`.slice(0, 120),
        startTime: String(Math.max(0, Math.min(1, start / duration))),
        endTime: String(Math.max(0, Math.min(1, end / duration))),
        cropPath: followCrop(moment.follow, manifest.videoStartSeconds, start, end, manifest.width / manifest.height),
        visibility: "private",
        aspectRatio: "16:9",
        academyId,
        sourceRecordingId: ctx.recordingId,
      }).returning();
      await db.insert(academyPlayerClipsTable).values({
        ...base, token: newToken(), userClipId: uc.id, momentKind: moment.kind, momentSeconds: moment.momentSeconds, note: note ?? null, status: "prepared",
      }).onConflictDoUpdate({
        target: [academyPlayerClipsTable.sessionId, academyPlayerClipsTable.playerId],
        set: { userClipId: uc.id, momentKind: moment.kind, momentSeconds: moment.momentSeconds, note: note ?? null, status: "prepared", updatedAt: new Date() },
      });
      prepared += 1;
      await queueUserClipExport(uc).catch((err) => logger.warn({ err, clipId: uc.id }, "Private clip export did not start"));
    } catch (err) {
      logger.warn({ err, academyId, sessionId, playerId: b.playerId }, "Private clip could not be prepared");
    }
  }
  return { prepared, already: done.size, noFootage };
}

export async function listPrivateClips(academyId: number, sessionId: number): Promise<ClipRowView[]> {
  const rows = await db.select({
    clip: academyPlayerClipsTable,
    playerName: academyPlayersTable.name,
    number: academyPlayersTable.jerseyNumber,
    exportStatus: userClipsTable.exportStatus,
  }).from(academyPlayerClipsTable)
    .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyPlayerClipsTable.playerId))
    .leftJoin(userClipsTable, eq(userClipsTable.id, academyPlayerClipsTable.userClipId))
    .where(and(eq(academyPlayerClipsTable.academyId, academyId), eq(academyPlayerClipsTable.sessionId, sessionId)));
  return rows
    .map((r) => ({
      id: r.clip.id,
      playerId: r.clip.playerId,
      playerName: r.playerName,
      number: r.number,
      status: r.clip.status as AcademyPlayerClip["status"],
      momentKind: r.clip.momentKind,
      momentSeconds: r.clip.momentSeconds,
      note: (r.clip.note as BaselineNote | null) ?? null,
      exportStatus: r.exportStatus,
      url: kidClipUrl(r.clip.token),
      sentAt: r.clip.sentAt?.toISOString() ?? null,
      openedAt: r.clip.openedAt?.toISOString() ?? null,
    }))
    .sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.playerName.localeCompare(b.playerName));
}

export type SendResult = { messages: number; children: number; unreachable: Array<{ playerId: number; name: string; number: number | null }>; reason?: "whatsapp_off" | "nothing_to_send" };

/** Send every prepared clip of the match: one message per family phone. */
export async function sendPrivateClips(academyId: number, sessionId: number, createdBy: number, opts: { playerIds?: number[] } = {}): Promise<SendResult> {
  const settings = await getWhatsappSettings(academyId);
  if (!senderSessionFor(settings)) return { messages: 0, children: 0, unreachable: [], reason: "whatsapp_off" };
  const automation = effectiveAutomations(settings.automations, settings.locale).player_clip;
  const locale = settings.locale;
  const rows = (await listPrivateClips(academyId, sessionId))
    .filter((r) => r.status === "prepared" && (!opts.playerIds || opts.playerIds.includes(r.playerId)));
  if (!rows.length) return { messages: 0, children: 0, unreachable: [], reason: "nothing_to_send" };
  const [[academy], [session]] = await Promise.all([
    db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, academyId)),
    db.select({ startsAt: academySessionsTable.startsAt }).from(academySessionsTable).where(eq(academySessionsTable.id, sessionId)),
  ]);
  const roles = automation.audiences.filter((r) => r !== "coaches");
  const { recipients } = await resolveAudience(academyId, { roles: roles.length ? roles : ["parents"], squadIds: null, playerIds: rows.map((r) => r.playerId) });
  const [optOuts, blocked] = await Promise.all([optedOutPhones(academyId), blockedPhones(academyId)]);
  const byPhone = new Map<string, { name: string | null; role: string; playerIds: number[] }>();
  for (const r of recipients) {
    if (!r.playerId || optOuts.has(r.phone) || blocked.has(r.phone)) continue;
    const cur = byPhone.get(r.phone) ?? { name: r.name, role: r.role, playerIds: [] };
    if (!cur.playerIds.includes(r.playerId)) cur.playerIds.push(r.playerId);
    byPhone.set(r.phone, cur);
  }
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  const reached = new Set<number>();
  const messages = [...byPhone.entries()].map(([phone, who]) => {
    const kids = who.playerIds.map((id) => byPlayer.get(id)!).filter(Boolean).sort((a, b) => a.playerId - b.playerId);
    kids.forEach((k) => reached.add(k.playerId));
    return {
      academyId,
      kind: "player_clip",
      phone,
      recipientName: who.name,
      recipientRole: who.role,
      playerId: kids.length === 1 ? kids[0].playerId : null,
      createdBy,
      dedupeKey: `a${academyId}:pclip:s${sessionId}:${phone}:${kids.map((k) => k.playerId).join(".")}`,
      body: renderTemplate(automation.template, {
        academy: academy?.name ?? "",
        name: who.name ?? "",
        day: session ? formatDay(session.startsAt, locale) : "",
        date: session ? formatDate(session.startsAt, locale) : "",
        clips: clipLines(kids.map((k) => ({ name: k.playerName, momentKind: k.momentKind, note: k.note, url: k.url })), locale),
      }),
    };
  });
  const queued = await enqueueMessages(messages);
  const now = new Date();
  const sentIds = rows.filter((r) => reached.has(r.playerId)).map((r) => r.id);
  if (sentIds.length) {
    await db.update(academyPlayerClipsTable).set({ status: "sent", sentAt: now, updatedAt: now }).where(inArray(academyPlayerClipsTable.id, sentIds));
    await recordFeatures(academyId, rows.filter((r) => reached.has(r.playerId)).map((r) => ({
      playerIds: [r.playerId], solo: true, itemType: "clip" as const, itemId: String(r.id), visibility: "private" as const, at: now,
    })));
  }
  return {
    messages: queued,
    children: sentIds.length,
    unreachable: rows.filter((r) => !reached.has(r.playerId)).map((r) => ({ playerId: r.playerId, name: r.playerName, number: r.number })),
  };
}
