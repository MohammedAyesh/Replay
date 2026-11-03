/**
 * Trial sessions, as a marketing step (People stage "trial"):
 *
 *   1. The lead's child comes to a session: the owner or a coach sets it on the
 *      person in People (the stage moves to "trial").
 *   2. Once the session's video exists, they mark the child's moment; Replay
 *      cuts a 12-second clip from the recording and they send it to the family
 *      on WhatsApp — the aim is within 24 hours of the session ending.
 *   3. Some days later (the trial_follow_up timing, 2 by default) one follow-up
 *      goes out with the registration link, unless People already shows the
 *      family as joined or lost. Nothing is sent twice.
 *
 * The moment is picked by a person, not by AI: a trial child isn't on the
 * roster, so the match analysis can't know which one he is.
 */
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or } from "drizzle-orm";
import {
  academiesTable,
  academyContactsTable,
  academyRecordingsTable,
  academySessionsTable,
  academyTrialClipsTable,
  db,
  recordingsTable,
  userClipsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { blockedPhones, enqueueMessages, getWhatsappSettings, optedOutPhones, senderSessionFor } from "../whatsapp/queue";
import { effectiveAutomations, formatDate, formatDay, renderTemplate } from "../whatsapp/templates";
import { publicBaseUrl } from "../whatsapp/waha";
import { formatPhoneForDisplay } from "../whatsapp/phone";
import { extractBunnyVideoId, isLiveVideoId, parseRecordingDuration, queueUserClipExport } from "../../routes/userClips";

const HALF = 6;
const DAY = 86_400_000;
/** A session without an end time is taken to last 90 minutes. */
const DEFAULT_LENGTH_MS = 90 * 60_000;

export type TrialView = {
  contactId: number;
  name: string | null;
  phone: string;
  display: string;
  stage: string | null;
  session: { id: number; startsAt: string; endsAt: string | null; type: string; hasVideo: boolean } | null;
  /** 24 hours after the session ended: when the clip should be with the family. */
  dueBy: string | null;
  clip: {
    id: number;
    childName: string | null;
    momentSeconds: number;
    status: string;
    exportStatus: string | null;
    url: string;
    sentAt: string | null;
    openedAt: string | null;
    followUpStatus: string | null;
    followUpAt: string | null;
  } | null;
};

const newToken = () => randomBytes(16).toString("hex");
const sessionEnd = (s: { startsAt: Date; endsAt: Date | null }) => s.endsAt ?? new Date(s.startsAt.getTime() + DEFAULT_LENGTH_MS);

export function trialDueBy(session: { startsAt: Date; endsAt: Date | null }): Date {
  return new Date(sessionEnd(session).getTime() + DAY);
}

async function sessionVideo(academyId: number, sessionId: number) {
  const [row] = await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl, duration: recordingsTable.duration })
    .from(academyRecordingsTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
    .where(and(eq(academyRecordingsTable.academyId, academyId), eq(academyRecordingsTable.sessionId, sessionId)))
    .orderBy(asc(recordingsTable.id))
    .limit(1);
  return row ?? null;
}

/** Leads at the trial stage, and anyone whose trial session was in the last two weeks. */
export async function listTrials(academyId: number, now = new Date()): Promise<TrialView[]> {
  const since = new Date(now.getTime() - 14 * DAY);
  const contacts = await db.select().from(academyContactsTable).where(and(
    eq(academyContactsTable.academyId, academyId),
    or(eq(academyContactsTable.stage, "trial"), isNotNull(academyContactsTable.trialSessionId)),
  ));
  if (!contacts.length) return [];
  const sessionIds = [...new Set(contacts.map((c) => c.trialSessionId).filter((x): x is number => x !== null))];
  const [sessions, videos, clips] = await Promise.all([
    sessionIds.length ? db.select().from(academySessionsTable).where(inArray(academySessionsTable.id, sessionIds)) : Promise.resolve([] as Array<typeof academySessionsTable.$inferSelect>),
    sessionIds.length ? db.select({ sessionId: academyRecordingsTable.sessionId }).from(academyRecordingsTable)
      .where(and(eq(academyRecordingsTable.academyId, academyId), inArray(academyRecordingsTable.sessionId, sessionIds))) : Promise.resolve([] as Array<{ sessionId: number | null }>),
    db.select({ clip: academyTrialClipsTable, exportStatus: userClipsTable.exportStatus })
      .from(academyTrialClipsTable)
      .leftJoin(userClipsTable, eq(userClipsTable.id, academyTrialClipsTable.userClipId))
      .where(and(eq(academyTrialClipsTable.academyId, academyId), inArray(academyTrialClipsTable.contactId, contacts.map((c) => c.id))))
      .orderBy(desc(academyTrialClipsTable.id)),
  ]);
  const withVideo = new Set(videos.map((v) => v.sessionId));
  const base = publicBaseUrl();
  return contacts
    .map((c) => {
      const s = sessions.find((x) => x.id === c.trialSessionId) ?? null;
      const clipRow = clips.find((x) => x.clip.contactId === c.id && (!s || x.clip.sessionId === s.id)) ?? null;
      return {
        contactId: c.id,
        name: c.name,
        phone: c.phone,
        display: formatPhoneForDisplay(c.phone),
        stage: c.stage,
        session: s ? { id: s.id, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt?.toISOString() ?? null, type: s.type, hasVideo: withVideo.has(s.id) } : null,
        dueBy: s ? trialDueBy(s).toISOString() : null,
        clip: clipRow ? {
          id: clipRow.clip.id,
          childName: clipRow.clip.childName,
          momentSeconds: clipRow.clip.momentSeconds,
          status: clipRow.clip.status,
          exportStatus: clipRow.exportStatus ?? null,
          url: `${base}/kc/${clipRow.clip.token}`,
          sentAt: clipRow.clip.sentAt?.toISOString() ?? null,
          openedAt: clipRow.clip.openedAt?.toISOString() ?? null,
          followUpStatus: clipRow.clip.followUpStatus,
          followUpAt: clipRow.clip.followUpAt?.toISOString() ?? null,
        } : null,
      };
    })
    // Old trials that went nowhere drop off the list after two weeks.
    .filter((t) => t.stage === "trial" || (t.session && new Date(t.session.startsAt) >= since))
    .sort((a, b) => (a.dueBy ?? "9").localeCompare(b.dueBy ?? "9"));
}

export type TrialError = "not_found" | "not_in_academy" | "no_session" | "no_video" | "bad_moment";

/** Book the trial on the person: the session, and the stage moves to "trial" (unless they already joined). */
export async function setTrialSession(academyId: number, contactId: number, sessionId: number | null): Promise<TrialError | null> {
  const [contact] = await db.select().from(academyContactsTable).where(and(eq(academyContactsTable.id, contactId), eq(academyContactsTable.academyId, academyId)));
  if (!contact) return "not_found";
  if (sessionId !== null) {
    const [s] = await db.select({ id: academySessionsTable.id }).from(academySessionsTable).where(and(eq(academySessionsTable.id, sessionId), eq(academySessionsTable.academyId, academyId)));
    if (!s) return "not_in_academy";
  }
  const moveStage = sessionId !== null && (contact.kind === "lead" || contact.kind === "unknown") && contact.stage !== "joined" && contact.stage !== "lost";
  await db.update(academyContactsTable).set({
    trialSessionId: sessionId,
    ...(moveStage ? { kind: "lead", stage: "trial" } : {}),
    updatedAt: new Date(),
  }).where(eq(academyContactsTable.id, contactId));
  return null;
}

/** Cut the child's moment from the trial session's video (12 s around `momentSeconds`). */
export async function makeTrialClip(
  academyId: number,
  contactId: number,
  createdBy: number,
  input: { momentSeconds: number; childName: string | null },
): Promise<{ error: TrialError } | { clipId: number }> {
  const [contact] = await db.select().from(academyContactsTable).where(and(eq(academyContactsTable.id, contactId), eq(academyContactsTable.academyId, academyId)));
  if (!contact) return { error: "not_found" };
  if (!contact.trialSessionId) return { error: "no_session" };
  const recording = await sessionVideo(academyId, contact.trialSessionId);
  if (!recording) return { error: "no_video" };
  const videoId = extractBunnyVideoId(recording.videoUrl);
  const duration = parseRecordingDuration(recording.duration);
  if (!videoId || isLiveVideoId(videoId) || duration <= 0) return { error: "no_video" };
  if (!(input.momentSeconds >= 0 && input.momentSeconds < duration)) return { error: "bad_moment" };
  const start = Math.max(0, input.momentSeconds - HALF);
  const end = Math.min(duration, input.momentSeconds + HALF);
  const childName = input.childName?.trim().slice(0, 60) || null;
  const [uc] = await db.insert(userClipsTable).values({
    userId: createdBy,
    videoId,
    title: `Trial · ${childName ?? contact.name ?? contact.phone}`.slice(0, 120),
    startTime: String(start / duration),
    endTime: String(end / duration),
    visibility: "private",
    aspectRatio: "16:9",
    academyId,
    sourceRecordingId: recording.id,
  }).returning();
  // A clip not sent yet is replaced; a sent one stays as it was sent.
  await db.delete(academyTrialClipsTable).where(and(
    eq(academyTrialClipsTable.contactId, contactId),
    eq(academyTrialClipsTable.sessionId, contact.trialSessionId),
    eq(academyTrialClipsTable.status, "prepared"),
  ));
  const [row] = await db.insert(academyTrialClipsTable).values({
    academyId, contactId, sessionId: contact.trialSessionId, recordingId: recording.id, userClipId: uc.id,
    token: newToken(), childName, momentSeconds: input.momentSeconds, createdBy,
  }).returning();
  await queueUserClipExport(uc).catch((err) => logger.warn({ err, clipId: uc.id }, "Trial clip export did not start"));
  return { clipId: row.id };
}

export type SendTrialResult = { queued: number; reason?: "whatsapp_off" | "automation_off" | "opted_out" | "already_sent" | "not_found" };

/** Send the clip to the number that asked, and set the follow-up date. */
export async function sendTrialClip(academyId: number, clipId: number, createdBy: number, now = new Date()): Promise<SendTrialResult> {
  const [row] = await db.select({ clip: academyTrialClipsTable, contact: academyContactsTable, session: academySessionsTable })
    .from(academyTrialClipsTable)
    .innerJoin(academyContactsTable, eq(academyContactsTable.id, academyTrialClipsTable.contactId))
    .leftJoin(academySessionsTable, eq(academySessionsTable.id, academyTrialClipsTable.sessionId))
    .where(and(eq(academyTrialClipsTable.id, clipId), eq(academyTrialClipsTable.academyId, academyId)));
  if (!row) return { queued: 0, reason: "not_found" };
  if (row.clip.status === "sent") return { queued: 0, reason: "already_sent" };
  const settings = await getWhatsappSettings(academyId);
  if (!senderSessionFor(settings)) return { queued: 0, reason: "whatsapp_off" };
  const automations = effectiveAutomations(settings.automations, settings.locale);
  if (!automations.trial_clip.enabled) return { queued: 0, reason: "automation_off" };
  const [optOuts, blocked] = await Promise.all([optedOutPhones(academyId), blockedPhones(academyId)]);
  if (optOuts.has(row.contact.phone) || blocked.has(row.contact.phone)) return { queued: 0, reason: "opted_out" };
  const [academy] = await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, academyId));
  const locale = settings.locale;
  const queued = await enqueueMessages([{
    academyId,
    kind: "trial_clip",
    phone: row.contact.phone,
    recipientName: row.contact.name,
    recipientRole: "lead",
    createdBy,
    dedupeKey: `a${academyId}:trialclip${row.clip.id}`,
    body: renderTemplate(automations.trial_clip.template, {
      academy: academy?.name ?? "",
      name: row.contact.name ?? "",
      player: row.clip.childName ?? (locale === "ar" ? "ابنكم" : "your child"),
      day: row.session ? formatDay(row.session.startsAt, locale) : "",
      date: row.session ? formatDate(row.session.startsAt, locale) : "",
      link: `${publicBaseUrl()}/kc/${row.clip.token}`,
    }),
  }]);
  const days = automations.trial_follow_up.timing ?? 2;
  await db.update(academyTrialClipsTable).set({
    status: "sent", sentAt: now, followUpStatus: "pending", followUpAt: new Date(now.getTime() + days * DAY), updatedAt: now,
  }).where(eq(academyTrialClipsTable.id, row.clip.id));
  return { queued };
}

/**
 * Due follow-ups (WhatsApp tick): one message each, unless People says the
 * family joined or was lost, or the owner turned the follow-up off.
 */
export async function sweepTrialFollowUps(now = new Date()): Promise<{ sent: number; skipped: number }> {
  const due = await db.select({ clip: academyTrialClipsTable, contact: academyContactsTable })
    .from(academyTrialClipsTable)
    .innerJoin(academyContactsTable, eq(academyContactsTable.id, academyTrialClipsTable.contactId))
    .where(and(eq(academyTrialClipsTable.followUpStatus, "pending"), lte(academyTrialClipsTable.followUpAt, now), gte(academyTrialClipsTable.followUpAt, new Date(now.getTime() - 14 * DAY))))
    .limit(200);
  let sent = 0, skipped = 0;
  for (const { clip, contact } of due) {
    const done = contact.stage === "joined" || contact.stage === "lost" || contact.kind === "parent" || contact.kind === "player";
    const settings = await getWhatsappSettings(clip.academyId);
    const automations = effectiveAutomations(settings.automations, settings.locale);
    if (!senderSessionFor(settings)) continue; // try again when WhatsApp is back
    const [optOuts, blocked] = await Promise.all([optedOutPhones(clip.academyId), blockedPhones(clip.academyId)]);
    if (done || !automations.trial_follow_up.enabled || optOuts.has(contact.phone) || blocked.has(contact.phone)) {
      await db.update(academyTrialClipsTable).set({ followUpStatus: "skipped", updatedAt: now }).where(eq(academyTrialClipsTable.id, clip.id));
      skipped += 1;
      continue;
    }
    const [academy] = await db.select({ name: academiesTable.name, joinCode: academiesTable.joinCode }).from(academiesTable).where(eq(academiesTable.id, clip.academyId));
    await enqueueMessages([{
      academyId: clip.academyId,
      kind: "trial_follow_up",
      phone: contact.phone,
      recipientName: contact.name,
      recipientRole: "lead",
      dedupeKey: `a${clip.academyId}:trialfu${clip.id}`,
      body: renderTemplate(automations.trial_follow_up.template, {
        academy: academy?.name ?? "",
        name: contact.name ?? "",
        player: clip.childName ?? (settings.locale === "ar" ? "ابنكم" : "your child"),
        link: academy?.joinCode ? `${publicBaseUrl()}/join/${academy.joinCode}` : "",
      }),
    }]);
    await db.update(academyTrialClipsTable).set({ followUpStatus: "sent", updatedAt: now }).where(eq(academyTrialClipsTable.id, clip.id));
    sent += 1;
  }
  return { sent, skipped };
}
