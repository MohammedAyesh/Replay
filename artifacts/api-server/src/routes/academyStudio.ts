import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { loadImage, type Image } from "@napi-rs/canvas";
import {
  academyMatchLineupsTable,
  academyMatchPlayerStatsTable,
  academyMembersTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  brandingProfilesTable,
  db,
  userClipsTable,
  usersTable,
  type Academy,
} from "@workspace/db";
import { displayPhone, instagramHandle, requireAcademyOwner, type AcademyOwnerAccess } from "../lib/academyOwner";
import { fetchExportObject, forwardExportContentLength, probeExportObject } from "../lib/backupExport";
import { getBunnyProxiedThumbnailUrl, isBunnyConfigured } from "../lib/bunny";
import { loadLocalImage, replayMarkPath } from "../lib/clipBranding/assets";
import { lookFor } from "../lib/clipBranding/plan";
import { decodeDataUrl } from "../lib/clipBranding/profileStore";
import type { BrandLook } from "../lib/clipBranding/types";
import { CLIP_PLAYBACK_RANGE_MAX_BYTES, planExportRange, sendBoundedExport } from "../lib/exportPlayback";
import { logger } from "../lib/logger";
import { renderStudioPng, type StudioContent, type StudioLocale } from "../lib/studio/posts";
import { academyClipStatus } from "../lib/userClipExportState";

/**
 * Academy console → Studio (owner only).
 *
 *   Clips: every clip the academy's members made from its footage, with a
 *   branded download and a hand-off to the academy's ad media.
 *   Posts & stories: PNGs in the academy's look, rendered here so they use the
 *   same fonts, crest and Arabic shaping as the clip branding.
 *
 * Players' names appear only when the academy's own branding profile allows
 * them; most of these players are children. The render endpoint enforces it,
 * whatever the browser sends.
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/studio";
const owner = (req: Request, res: Response) => requireAcademyOwner(req, res, "Studio");

/** About 6 MB of image per upload. */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const TZ = "Asia/Amman";

// ── Shared look and data ─────────────────────────────────────────────────────

/** Whether the academy's own profile allows names. Never inherited from a field or Replay. */
export async function namesAllowed(academyId: number): Promise<boolean> {
  try {
    const [row] = await db.select({ show: brandingProfilesTable.showPlayerNames }).from(brandingProfilesTable)
      .where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyId)));
    return row?.show === true;
  } catch {
    return false;
  }
}

export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first.slice(0, 30) : null;
}

function contactFor(academy: Academy, look: BrandLook, locale: StudioLocale): string | null {
  const whatsapp = displayPhone(academy.whatsappPhone);
  if (whatsapp) return `${locale === "ar" ? "واتساب" : "WhatsApp"} ${whatsapp}`;
  const phone = look.bookingPhone ?? academy.contactPhone;
  return phone ? `${locale === "ar" ? "اتصل" : "Call"} ${phone}` : null;
}

export async function studioLook(access: AcademyOwnerAccess, temps: string[]): Promise<BrandLook> {
  const { academy } = access;
  const look = await lookFor({ academyId: access.academyId, fieldId: academy.fieldId }, temps);
  const fallback: BrandLook = {
    nameEn: academy.name, nameAr: null, taglineAr: null, primaryColor: "#2FD8C4", accentColor: null,
    bookingPhone: null, instagram: null, crest: null, isAcademy: true,
  };
  const out = { ...(look ?? fallback) };
  out.nameAr ??= academy.nameAr ?? null;
  out.bookingPhone ??= displayPhone(academy.whatsappPhone) ?? academy.contactPhone ?? null;
  out.instagram ??= instagramHandle(academy.instagramUrl);
  return out;
}

const parts = (date: Date, locale: StudioLocale, opts: Intl.DateTimeFormatOptions) => {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { timeZone: TZ, ...opts }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
};

/** "SAT 24 OCT" / "السبت 24 تشرين الأول", in Amman time. */
export function ammanDayLabel(date: Date, locale: StudioLocale, withMonth = true): string {
  const p = parts(date, locale, { weekday: locale === "ar" ? "long" : "short", day: "numeric", month: locale === "ar" ? "long" : "short" });
  const label = [p.weekday, p.day, withMonth ? p.month : null].filter(Boolean).join(" ");
  return locale === "ar" ? label : label.toUpperCase();
}

/** "17:00", in Amman time. */
export function ammanTime(date: Date): string {
  const p = parts(date, "en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.hour}:${p.minute}`;
}

function rangeLabel(from: Date, to: Date, locale: StudioLocale): string {
  const a = parts(from, locale, { day: "numeric", month: locale === "ar" ? "long" : "short" });
  const b = parts(to, locale, { day: "numeric", month: locale === "ar" ? "long" : "short" });
  const up = (s: string) => (locale === "ar" ? s : s.toUpperCase());
  return a.month === b.month ? up(`${a.day} – ${b.day} ${b.month}`) : up(`${a.day} ${a.month} – ${b.day} ${b.month}`);
}

async function matchesFor(academyId: number, showNames: boolean) {
  const sessions = await db
    .select({
      id: academySessionsTable.id,
      startsAt: academySessionsTable.startsAt,
      opponent: academySessionsTable.opponent,
      ownScore: academySessionsTable.ownScore,
      opponentScore: academySessionsTable.opponentScore,
      squad: academySquadsTable.name,
    })
    .from(academySessionsTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
    .where(and(eq(academySessionsTable.academyId, academyId), eq(academySessionsTable.type, "match")))
    .orderBy(desc(academySessionsTable.startsAt))
    .limit(30);
  const ids = sessions.map((s) => s.id);
  const [stats, lineups] = ids.length
    ? await Promise.all([
      db.select({
        sessionId: academyMatchPlayerStatsTable.sessionId,
        playerId: academyMatchPlayerStatsTable.playerId,
        stats: academyMatchPlayerStatsTable.stats,
        jersey: academyPlayersTable.jerseyNumber,
        name: academyPlayersTable.name,
      }).from(academyMatchPlayerStatsTable)
        .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyMatchPlayerStatsTable.playerId))
        .where(and(eq(academyMatchPlayerStatsTable.academyId, academyId), inArray(academyMatchPlayerStatsTable.sessionId, ids))),
      db.select({ sessionId: academyMatchLineupsTable.sessionId, playerId: academyMatchLineupsTable.playerId, shirt: academyMatchLineupsTable.shirtNumber })
        .from(academyMatchLineupsTable).where(inArray(academyMatchLineupsTable.sessionId, ids)),
    ])
    : [[], []];
  const shirt = new Map(lineups.map((l) => [`${l.sessionId}:${l.playerId}`, l.shirt]));
  return sessions.map((s) => {
    const scorers = stats
      .filter((r) => r.sessionId === s.id)
      .map((r) => ({
        number: shirt.get(`${s.id}:${r.playerId}`) ?? r.jersey ?? null,
        name: showNames ? firstName(r.name) : null,
        goals: Math.max(0, Math.round(Number((r.stats as { goals?: unknown } | null)?.goals ?? 0)) || 0),
      }))
      .filter((r) => r.goals > 0)
      .sort((a, b) => b.goals - a.goals || (a.number ?? 999) - (b.number ?? 999));
    return {
      sessionId: s.id,
      startsAt: s.startsAt.toISOString(),
      squad: s.squad ?? null,
      opponent: s.opponent ?? null,
      ownScore: s.ownScore,
      opponentScore: s.opponentScore,
      dateLabel: { en: ammanDayLabel(s.startsAt, "en"), ar: ammanDayLabel(s.startsAt, "ar") },
      scorers,
    };
  });
}

export async function weekRows(academyId: number, now = new Date()) {
  const until = new Date(now.getTime() + 7 * 86_400_000);
  const rows = await db
    .select({
      startsAt: academySessionsTable.startsAt,
      type: academySessionsTable.type,
      location: academySessionsTable.location,
      opponent: academySessionsTable.opponent,
      squad: academySquadsTable.name,
    })
    .from(academySessionsTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
    .where(and(eq(academySessionsTable.academyId, academyId), gte(academySessionsTable.startsAt, now), lt(academySessionsTable.startsAt, until)))
    .orderBy(asc(academySessionsTable.startsAt))
    .limit(40);
  const build = (locale: StudioLocale) => rows.map((r) => ({
    day: ammanDayLabel(r.startsAt, locale, false),
    time: ammanTime(r.startsAt),
    squad: r.squad ?? null,
    place: r.type === "match" && r.opponent ? `${locale === "ar" ? "ضد" : "vs"} ${r.opponent}` : r.location || null,
  }));
  return {
    rangeLabel: { en: rangeLabel(now, new Date(until.getTime() - 86_400_000), "en"), ar: rangeLabel(now, new Date(until.getTime() - 86_400_000), "ar") },
    rows: { en: build("en"), ar: build("ar") },
  };
}

router.get(base, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const temps: string[] = [];
  try {
    const showNames = await namesAllowed(access.academyId);
    const look = await studioLook(access, temps);
    const [matches, players, squads, week] = await Promise.all([
      matchesFor(access.academyId, showNames),
      db.select({
        id: academyPlayersTable.id,
        number: academyPlayersTable.jerseyNumber,
        name: academyPlayersTable.name,
        squad: academySquadsTable.name,
        ageGroup: academySquadsTable.ageGroup,
      }).from(academyPlayersTable)
        .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
        .where(and(eq(academyPlayersTable.academyId, access.academyId), eq(academyPlayersTable.isActive, true)))
        .orderBy(asc(academyPlayersTable.jerseyNumber), asc(academyPlayersTable.id)),
      db.select({ name: academySquadsTable.name, ageGroup: academySquadsTable.ageGroup }).from(academySquadsTable)
        .where(eq(academySquadsTable.academyId, access.academyId)).orderBy(asc(academySquadsTable.name)),
      weekRows(access.academyId),
    ]);
    res.json({
      brand: {
        nameEn: look.nameEn,
        nameAr: look.nameAr,
        primaryColor: look.primaryColor,
        accentColor: look.accentColor,
        showPlayerNames: showNames,
        contact: { en: contactFor(access.academy, look, "en"), ar: contactFor(access.academy, look, "ar") },
      },
      matches,
      players: players.map((p) => ({
        id: p.id,
        number: p.number ?? null,
        // A first name only, and only when the academy allows names.
        firstName: showNames ? firstName(p.name) : null,
        squad: p.squad ?? null,
        ageGroup: p.ageGroup ?? null,
      })),
      squads: squads.map((s) => ({ name: s.name, ageGroup: s.ageGroup ?? null })),
      week,
    });
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
});

// ── Render ──────────────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullish().transform((v) => (v ? v : null));
const imageData = z.string().max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 200).nullish();
const shirt = z.number().int().min(0).max(99);

const Common = {
  format: z.enum(["post", "square", "story"]),
  locale: z.enum(["en", "ar"]),
  backgroundData: imageData,
  /** The console's live preview: half size, same layout. */
  preview: z.boolean().optional(),
};

export const RenderBody = z.discriminatedUnion("template", [
  z.object({
    ...Common,
    template: z.literal("match"),
    ownName: optText(40),
    opponent: text(40).min(1),
    ownScore: z.number().int().min(0).max(99),
    opponentScore: z.number().int().min(0).max(99),
    squad: optText(40),
    dateLabel: optText(40),
    scorers: z.array(z.object({ number: shirt.nullable(), name: optText(30), goals: z.number().int().min(1).max(20) })).max(12).default([]),
  }),
  z.object({
    ...Common,
    template: z.literal("player"),
    number: shirt.nullish(),
    firstName: optText(30),
    squad: optText(40),
    ageGroup: optText(20),
    line: optText(80),
    photoData: imageData,
  }),
  z.object({
    ...Common,
    template: z.literal("training"),
    rangeLabel: optText(40),
    rows: z.array(z.object({ day: text(30).min(1), time: text(20).min(1), squad: optText(40), place: optText(40) })).max(14),
  }),
  z.object({
    ...Common,
    template: z.literal("registration"),
    kind: z.enum(["registration", "trial"]),
    headline: text(80).min(1),
    ageGroups: optText(40),
    startDate: optText(40),
    priceJod: z.number().min(0).max(10_000).nullish(),
  }),
  z.object({
    ...Common,
    template: z.literal("announcement"),
    title: text(80).min(1),
    body: optText(400),
  }),
]);
export type RenderBodyInput = z.infer<typeof RenderBody>;

type ImageResult = { image: Image | null } | { error: string; status: number };

async function uploadedImage(data: string | null | undefined): Promise<ImageResult> {
  if (!data) return { image: null };
  const decoded = decodeDataUrl(data);
  if (!decoded) return { error: "Use a JPEG, PNG or WebP photo.", status: 400 };
  if (decoded.buffer.length > MAX_UPLOAD_BYTES) return { error: "That photo is over 6 MB. Pick a smaller one.", status: 413 };
  try {
    return { image: await loadImage(decoded.buffer) };
  } catch {
    return { error: "That photo couldn't be read.", status: 400 };
  }
}

router.post(`${base}/render`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const parsed = RenderBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: `Check ${issue?.path.join(".") || "the form"}: ${issue?.message ?? "invalid"}` });
    return;
  }
  const body = parsed.data;
  const locale = body.locale;
  const showNames = await namesAllowed(access.academyId);
  const temps: string[] = [];
  try {
    const background = await uploadedImage(body.backgroundData);
    if ("error" in background) { res.status(background.status).json({ error: background.error }); return; }
    let photo: Image | null = null;
    if (body.template === "player") {
      const p = await uploadedImage(body.photoData);
      if ("error" in p) { res.status(p.status).json({ error: p.error }); return; }
      photo = p.image;
    }
    const look = await studioLook(access, temps);
    let content: StudioContent;
    switch (body.template) {
      case "match":
        content = {
          template: "match",
          ownName: body.ownName ?? (locale === "ar" ? look.nameAr || look.nameEn : look.nameEn),
          opponent: body.opponent,
          ownScore: body.ownScore,
          opponentScore: body.opponentScore,
          squad: body.squad,
          dateLabel: body.dateLabel,
          // Shirt numbers always; a first name only when the academy allows names.
          scorers: body.scorers.map((s) => ({ number: s.number, name: showNames ? firstName(s.name) : null, goals: s.goals })),
        };
        break;
      case "player": {
        const name = showNames ? firstName(body.firstName) : null;
        if (body.number == null && !name) {
          res.status(400).json({ error: showNames ? "Add the player's shirt number or first name." : "Add the player's shirt number. Names are off for your academy." });
          return;
        }
        content = { template: "player", number: body.number ?? null, name, squad: body.squad, ageGroup: body.ageGroup, line: body.line };
        break;
      }
      case "training":
        content = { template: "training", rangeLabel: body.rangeLabel, rows: body.rows.map((r) => ({ ...r })) };
        break;
      case "registration":
        content = {
          template: "registration",
          kind: body.kind,
          headline: body.headline,
          ageGroups: body.ageGroups,
          startDate: body.startDate,
          priceJod: body.priceJod ?? null,
          contact: contactFor(access.academy, look, locale),
        };
        break;
      default:
        content = { template: "announcement", title: body.title, body: body.body };
    }
    const png = renderStudioPng({
      look,
      format: body.format,
      locale,
      content,
      background: background.image,
      photo,
      mark: await loadLocalImage(replayMarkPath()),
      scale: body.preview ? 0.5 : 1,
    });
    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(png);
  } catch (err) {
    logger.error({ err, academyId: access.academyId, template: body.template }, "Studio render failed");
    res.status(500).json({ error: "Couldn't draw that. Try again." });
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
});

// ── Clips ───────────────────────────────────────────────────────────────────

/** A clip of this academy, made by one of its members, not deleted. */
async function academyClip(academyId: number, rawId: unknown) {
  const clipId = Number(Array.isArray(rawId) ? rawId[0] : rawId);
  if (!Number.isSafeInteger(clipId) || clipId < 1) return null;
  const [row] = await db.select({ clip: userClipsTable }).from(userClipsTable)
    .innerJoin(academyMembersTable, and(
      eq(academyMembersTable.academyId, academyId),
      eq(academyMembersTable.userId, userClipsTable.userId),
    ))
    .where(and(eq(userClipsTable.id, clipId), eq(userClipsTable.academyId, academyId)))
    .limit(1);
  if (!row || row.clip.hiddenReason === "deleted") return null;
  return row.clip;
}

const clipStatus = academyClipStatus;

/** GET …/studio/clips — the academy's clips by its members, newest first. */
router.get(`${base}/clips`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const rows = await db
    .select({ clip: userClipsTable, creatorName: usersTable.name, role: academyMembersTable.role })
    .from(userClipsTable)
    .innerJoin(academyMembersTable, and(
      eq(academyMembersTable.academyId, access.academyId),
      eq(academyMembersTable.userId, userClipsTable.userId),
    ))
    .innerJoin(usersTable, eq(usersTable.id, userClipsTable.userId))
    .where(and(eq(userClipsTable.academyId, access.academyId), isNotNull(userClipsTable.videoId)))
    .orderBy(desc(userClipsTable.createdAt), desc(userClipsTable.id))
    .limit(200);
  const seen = new Set<number>();
  const clips = [];
  for (const { clip, creatorName, role } of rows) {
    // A member with two roles appears twice in the join.
    if (seen.has(clip.id) || clip.hiddenReason === "deleted") continue;
    seen.add(clip.id);
    const isLive = clip.videoId.startsWith("live:");
    const thumbTime = clip.thumbnailTime != null ? Number(clip.thumbnailTime) : Number(clip.startTime);
    clips.push({
      id: clip.id,
      title: clip.title,
      aspectRatio: clip.aspectRatio === "9:16" ? "9:16" : "16:9",
      status: clipStatus(clip),
      createdAt: clip.createdAt.toISOString(),
      durationSeconds: Math.max(0, Math.round(Number(clip.endTime) - Number(clip.startTime))),
      thumbnailUrl: !isLive && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(clip.videoId, thumbTime) : null,
      creator: { id: clip.userId, name: creatorName, role, isYou: clip.userId === access.user.id },
    });
  }
  res.json({ clips });
});

/** POST …/studio/clips/:clipId/export — make sure the branded MP4 exists (the creator's own export pipeline). */
router.post(`${base}/clips/:clipId/export`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const clip = await academyClip(access.academyId, req.params.clipId);
  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
  if (clip.videoId.startsWith("live:")) { res.status(400).json({ error: "This live clip is still being saved. Try again in a few minutes." }); return; }
  if (clip.exportStatus === "expired") { res.status(410).json({ status: "expired", error: "This clip is no longer available." }); return; }
  if (clip.exportStatus === "done" && clip.exportedUrl) { res.json({ status: "done" }); return; }
  // Dynamic: userClips is a large route module with background sweeps.
  const { queueUserClipExport } = await import("./userClips");
  const status = await queueUserClipExport(clip);
  res.json({ status: status === "done" ? "done" : status === "error" ? "error" : "pending" });
});

/** GET …/studio/clips/:clipId/export-status */
router.get(`${base}/clips/:clipId/export-status`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const clip = await academyClip(access.academyId, req.params.clipId);
  if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
  const status = clipStatus(clip);
  res.json({ status: status === "ready" ? "done" : status === "failed" ? "error" : status === "expired" ? "expired" : "pending" });
});

/**
 * GET …/studio/clips/:clipId/download — the branded MP4 as an attachment.
 * Counted against the owner's own download allowance, as any download is.
 */
router.get(`${base}/clips/:clipId/download`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const clip = await academyClip(access.academyId, req.params.clipId);
  if (!clip || !clip.exportedUrl || clipStatus(clip) !== "ready") { res.status(404).json({ error: "Export not ready" }); return; }
  const { reserveDownload, readableFromUpstream } = await import("./userClips");
  const reservation = await reserveDownload(access.user.id, clip.id, new Date());
  if (reservation.outcome === "disabled") { res.status(403).json({ error: "Downloads are currently disabled" }); return; }
  if (reservation.outcome === "refused") { res.status(402).json({ error: "Download limit reached" }); return; }

  const abort = new AbortController();
  const stop = () => { if (!abort.signal.aborted) abort.abort(); };
  res.once("close", stop);
  try {
    let upstream: globalThis.Response | null = null;
    try {
      upstream = await fetchExportObject(clip.exportedUrl, { signal: abort.signal });
    } catch (err) {
      logger.error({ err, clipId: clip.id }, "Studio download: could not reach the export");
    }
    if (!upstream || !upstream.ok || !upstream.body) {
      await upstream?.body?.cancel().catch(() => {});
      if (!res.headersSent) res.status(503).json({ error: "The clip file isn't reachable right now. Try again in a minute." });
      return;
    }
    const safeName = clip.title.replace(/[^a-z0-9_\-]/gi, "_") || "clip";
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);
    forwardExportContentLength(res, upstream, false);
    await pipeline(readableFromUpstream(upstream.body as ReadableStream<Uint8Array>, () => {}) as Readable, res).catch((err: unknown) => {
      if (!abort.signal.aborted) logger.error({ err, clipId: clip.id }, "Studio download failed");
    });
  } finally {
    res.off("close", stop);
  }
});

/** GET …/studio/clips/:clipId/video — play the branded MP4 (bounded 206 ranges, like /user-clips/:id/playback). */
router.get(`${base}/clips/:clipId/video`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const clip = await academyClip(access.academyId, req.params.clipId);
  if (!clip || !clip.exportedUrl) { res.status(404).json({ error: "Export not available" }); return; }
  const probe = await probeExportObject(clip.exportedUrl);
  if (probe.state !== "exists") { res.status(probe.state === "missing" ? 404 : 503).json({ error: "Export not available" }); return; }
  const plan = planExportRange(req.header("range") ?? undefined, CLIP_PLAYBACK_RANGE_MAX_BYTES);
  const abort = new AbortController();
  const stop = () => { if (!res.writableEnded && !abort.signal.aborted) abort.abort(); };
  res.once("close", stop);
  try {
    const upstream = await fetchExportObject(probe.url, { range: plan.upstreamRange, signal: abort.signal }).catch(() => null);
    if (!upstream || (upstream.status !== 416 && (!upstream.ok || !upstream.body))) {
      await upstream?.body?.cancel().catch(() => {});
      if (!res.headersSent) res.status(502).json({ error: "Playback unavailable" });
      return;
    }
    const outcome = await sendBoundedExport(res, upstream, plan, {
      "Content-Type": upstream.headers.get("content-type") ?? "video/mp4",
      "Cache-Control": "private, no-store",
    });
    if (outcome === "unusable" && !res.headersSent) {
      await upstream.body?.cancel().catch(() => {});
      res.status(502).json({ error: "Playback unavailable" });
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Playback failed" });
    else logger.debug({ err }, "Studio playback ended early");
  } finally {
    res.off("close", stop);
  }
});

export default router;
