import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import {
  academyCreativeProjectsTable,
  academyPlayersTable,
  academySocialPostsTable,
  academySquadsTable,
  academyWhatsappBroadcastsTable,
  db,
  type AcademyCreativeProject,
} from "@workspace/db";
import type { CreativeStatus } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { metaAdsConfigured } from "../lib/meta/config";
import { getConnection } from "../lib/meta/connections";
import { MetaGraphError } from "../lib/meta/graph";
import { walletBalanceFils } from "../lib/meta/wallet";
import { getSocialAccount, publicMediaUrl } from "../lib/social/account";
import { publishPost, type Format, type Target } from "../lib/social/posts";
import { formatPhoneForDisplay } from "../lib/whatsapp/phone";
import { blockedPhones, enqueueMessages, getWhatsappSettings, optedOutPhones, senderSessionFor } from "../lib/whatsapp/queue";
import { joinNames, mergeByPhone, resolveAudience } from "../lib/whatsapp/recipients";
import { renderTemplate } from "../lib/whatsapp/templates";
import { publicBaseUrl } from "../lib/whatsapp/waha";
import { CREATIVE_BASE, creativeOwner, loadCreativeProject, projectIdParam, publicProject } from "../lib/creative/projects";
import {
  academyHashtag,
  addDownload,
  allowedPlacements,
  alreadyPosted,
  checkPlacement,
  deriveProjectStatus,
  nextScheduledAt,
  parseScheduledAt,
  readTargets,
  targetState,
  withoutPost,
  type LinkedPost,
  type PublishTarget,
} from "../lib/creative/publish";
import { ensureCreativeMedia, PublishMediaError, renderIsDone } from "../lib/creative/publishMedia";
import { mediaView } from "./academyAdMedia";
import { logProjectFeature, projectPlayers, removeFeatures } from "../lib/featured/store";

/**
 * Creative hub → Publish (owner only). Hands a rendered project to the
 * channels the academy already has: Instagram/Facebook through
 * academy_social_posts (its worker publishes scheduled posts), WhatsApp through
 * the broadcast queue, Ads through the media library. Nothing goes out
 * unless the console calls one of the POSTs below, which it does only from a
 * confirm step showing where it goes.
 */
const router: IRouter = Router();
const base = CREATIVE_BASE;

const adsMediaPrefix = (academyId: number) => `/api/academy/console/academies/${academyId}/ads/media`;

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof PublishMediaError) {
    res.status(error.status).json({ error: error.message, code: error.status === 409 ? "not_rendered" : "media" });
    return;
  }
  if (error instanceof MetaGraphError) {
    res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({ error: error.message });
    return;
  }
  logger.error({ error: (error as Error)?.message }, what);
  res.status(500).json({ error: what });
}

function notRendered(res: Response, row: AcademyCreativeProject): boolean {
  if (renderIsDone(row)) return false;
  const busy = row.renderStatus === "queued" || row.renderStatus === "rendering";
  res.status(409).json({
    error: busy
      ? "It's still rendering. Wait for it to finish."
      : row.renderStatus === "done" && row.outputPath
        ? "This render is out of date. Render it again before publishing."
        : "Render it first, then publish.",
    code: busy ? "rendering" : "not_rendered",
  });
  return true;
}

// ─── Linked posts and status sync ───────────────────────────────────────────

async function postsFor(academyId: number, targets: PublishTarget[]): Promise<Map<number, LinkedPost>> {
  const ids = [...new Set(targets.map((t) => t.postId).filter((id): id is number => typeof id === "number"))];
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    id: academySocialPostsTable.id,
    status: academySocialPostsTable.status,
    error: academySocialPostsTable.error,
    igMediaId: academySocialPostsTable.igMediaId,
    igPermalink: academySocialPostsTable.igPermalink,
    fbPostId: academySocialPostsTable.fbPostId,
    fbPermalink: academySocialPostsTable.fbPermalink,
    scheduledFor: academySocialPostsTable.scheduledFor,
    publishedAt: academySocialPostsTable.publishedAt,
  }).from(academySocialPostsTable)
    .where(and(eq(academySocialPostsTable.academyId, academyId), inArray(academySocialPostsTable.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

function targetsView(targets: PublishTarget[], posts: Map<number, LinkedPost>) {
  return targets.map((t) => {
    const post = t.postId ? posts.get(t.postId) : undefined;
    const live = targetState(t, post);
    return { ...t, ...live, scheduledAt: post?.scheduledFor?.toISOString() ?? t.scheduledAt ?? null, publishedAt: post?.publishedAt?.toISOString() ?? null };
  });
}
export type PublishTargetView = ReturnType<typeof targetsView>[number];

/** Read where the project went, bring its status in line with the social posts, and save if that changed. */
async function synced(row: AcademyCreativeProject, posts?: Map<number, LinkedPost>) {
  const targets = readTargets(row.publishTargets);
  const linked = posts ?? await postsFor(row.academyId, targets);
  const derived = deriveProjectStatus(row.status as CreativeStatus, targets, linked);
  const handedOff = targets.some((t) => t.channel === "instagram" || t.channel === "facebook" || t.channel === "whatsapp");
  const scheduledAt = derived.status === "scheduled" ? nextScheduledAt(targets, linked) : handedOff ? null : row.scheduledAt;
  const publishedAt = handedOff ? derived.publishedAt : row.publishedAt;
  const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  let current = row;
  if (derived.status !== row.status || !same(scheduledAt, row.scheduledAt) || !same(publishedAt, row.publishedAt)) {
    const [updated] = await db.update(academyCreativeProjectsTable)
      .set({ status: derived.status, scheduledAt, publishedAt, updatedAt: new Date() })
      .where(eq(academyCreativeProjectsTable.id, row.id)).returning();
    current = updated ?? row;
  }
  return { row: current, targets: targetsView(targets, linked), posts: linked };
}

/** Append targets atomically (two taps on two channels must not lose each other's entry). */
async function appendTargets(row: AcademyCreativeProject, add: PublishTarget[]): Promise<AcademyCreativeProject> {
  const [updated] = await db.update(academyCreativeProjectsTable)
    .set({
      publishTargets: sql`coalesce(${academyCreativeProjectsTable.publishTargets}, '[]'::jsonb) || ${JSON.stringify(add)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(academyCreativeProjectsTable.id, row.id)).returning();
  return updated;
}

function projectSummary(row: AcademyCreativeProject) {
  const { scene: _scene, data: _data, ...rest } = publicProject(row);
  return rest;
}

function thumbFor(row: AcademyCreativeProject, targets: PublishTarget[]): string | null {
  const withMedia = [...targets].reverse().find((t) => t.mediaId);
  if (withMedia?.mediaId) return `${adsMediaPrefix(row.academyId)}/${withMedia.mediaId}/thumb`;
  const p = publicProject(row);
  return p.outputUrl && (row.outputMime?.startsWith("image/") ?? row.kind === "image") ? p.outputUrl : null;
}

// ─── Channels ───────────────────────────────────────────────────────────────

router.get(`${base}/publish/channels`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    const [account, settings, connection, walletFils, squads, counts] = await Promise.all([
      getSocialAccount(access.academyId),
      getWhatsappSettings(access.academyId),
      getConnection(access.academyId).catch(() => null),
      walletBalanceFils(access.academyId).catch(() => 0),
      db.select({ id: academySquadsTable.id, name: academySquadsTable.name }).from(academySquadsTable)
        .where(eq(academySquadsTable.academyId, access.academyId)).orderBy(academySquadsTable.name),
      db.select({ squadId: academyPlayersTable.squadId, n: sql<number>`count(*)::int` }).from(academyPlayersTable)
        .where(and(eq(academyPlayersTable.academyId, access.academyId), eq(academyPlayersTable.isActive, true)))
        .groupBy(academyPlayersTable.squadId),
    ]);
    const perSquad = new Map(counts.map((c) => [c.squadId, c.n]));
    const connected = account?.status === "connected";
    const ownAds = connection?.mode === "own" && connection.status === "connected";
    res.json({
      social: {
        status: account?.status ?? "none",
        instagram: connected && account?.igUserId ? { username: account.igUsername } : null,
        facebook: connected && account?.pageId ? { pageName: account.pageName } : null,
        error: account?.error ?? null,
      },
      whatsapp: {
        sender: settings.sender,
        available: Boolean(senderSessionFor(settings)),
        phone: settings.sender === "own" && settings.connectedPhone ? formatPhoneForDisplay(settings.connectedPhone) : null,
        roles: ["parents", "players", "coaches"],
        squads: squads.map((s) => ({ id: s.id, name: s.name, players: perSquad.get(s.id) ?? 0 })),
        players: counts.reduce((sum, c) => sum + c.n, 0),
      },
      ads: {
        available: ownAds || metaAdsConfigured(),
        mode: ownAds ? "own" : "replay",
        walletFils,
      },
      hashtag: academyHashtag(access.academy.name),
    });
  } catch (error) {
    fail(res, error, "Reading the publish channels failed");
  }
});

// ─── Instagram / Facebook ───────────────────────────────────────────────────

const PublishBody = z.object({
  targets: z.array(z.enum(["instagram", "facebook"])).min(1).max(2),
  caption: z.string().max(2200).default(""),
  placement: z.enum(["feed", "reel", "story"]).nullish(),
  /** ISO with an offset, or "YYYY-MM-DDTHH:mm" in Amman time. Empty = now. */
  scheduledAt: z.string().max(40).nullish(),
  /** Post again a render that already went to one of these targets. */
  again: z.boolean().optional(),
});

router.post(`${base}/projects/:projectId/publish`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  const body = PublishBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid", code: "invalid" }); return; }
  if (notRendered(res, row)) return;
  const placement = checkPlacement(row, body.data.targets, body.data.placement ?? null);
  if (!placement.ok) { res.status(400).json({ error: placement.error, code: placement.code, allowed: allowedPlacements(row) }); return; }
  const schedule = parseScheduledAt(body.data.scheduledAt);
  if (!schedule.ok) { res.status(400).json({ error: schedule.error, code: schedule.code }); return; }
  try {
    const account = await getSocialAccount(access.academyId);
    if (!account || account.status !== "connected") {
      res.status(409).json({ error: "Connect Instagram and Facebook first (Academy console → Social).", code: "social_not_connected" });
      return;
    }
    if (placement.targets.includes("instagram") && !account.igUserId) {
      res.status(409).json({ error: "No Instagram account is linked to your Facebook Page.", code: "no_instagram" });
      return;
    }
    if (placement.targets.includes("facebook") && !account.pageId) {
      res.status(409).json({ error: "No Facebook Page is connected.", code: "no_facebook" });
      return;
    }
    // Children's rules: a child without public-post consent never goes on a public page.
    const shown = await projectPlayers(row);
    if (shown.withoutConsent.length) {
      res.status(409).json({
        error: "A player in this design has no public-post consent from his family. Take him out, or record the consent in Players.",
        code: "no_public_consent",
        players: shown.withoutConsent,
      });
      return;
    }
    const before = readTargets(row.publishTargets);
    const repeat = alreadyPosted(before, await postsFor(access.academyId, before), placement.targets, row.renderedAt);
    if (repeat.length > 0 && !body.data.again) {
      res.status(409).json({ error: `This version already went to ${repeat.join(" and ")}. Post it again?`, code: "already_posted", channels: repeat });
      return;
    }

    const { media } = await ensureCreativeMedia(row, access.user.id);
    const type = media.kind === "video" ? "video" : "image";
    if (placement.format === "reel" && type !== "video") {
      res.status(400).json({ error: "Reels need a video", code: "placement" });
      return;
    }
    // A video takes minutes on Meta's side: the minute worker posts it, as it does scheduled posts.
    const when = schedule.at ?? (type === "video" ? new Date() : null);
    const [post] = await db.insert(academySocialPostsTable).values({
      academyId: access.academyId,
      source: "replay",
      targets: placement.targets as Target[],
      format: placement.format as Format,
      caption: placement.placement === "story" ? "" : body.data.caption,
      media: [{ mediaId: media.id, type }],
      status: when ? "scheduled" : "draft",
      scheduledFor: when,
      createdBy: access.user.id,
    }).returning();
    const now = new Date().toISOString();
    const updated = await appendTargets(row, placement.targets.map((channel) => ({
      channel,
      ref: `post:${post.id}`,
      at: now,
      postId: post.id,
      mediaId: media.id,
      renderedAt: row.renderedAt?.toISOString() ?? null,
      placement: placement.placement,
      scheduledAt: schedule.at?.toISOString() ?? null,
    })));
    const result = when ? post : await publishPost(post.id);
    // Every child in it appeared (publicly) when it goes out.
    await logProjectFeature(row, "public", when ?? new Date()).catch((err) => logger.warn({ err, projectId: row.id }, "Feature log failed"));
    const view = await synced(updated);
    res.status(201).json({
      project: publicProject(view.row),
      targets: view.targets,
      post: { id: result.id, status: result.status, error: result.error, igPermalink: result.igPermalink, fbPermalink: result.fbPermalink, scheduledFor: result.scheduledFor },
    });
  } catch (error) {
    fail(res, error, "Publishing to Instagram and Facebook failed");
  }
});

/** Take back a post that hasn't gone out yet (or failed). */
router.delete(`${base}/projects/:projectId/publish/:postId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  const postId = projectIdParam(req.params.postId);
  const targets = readTargets(row.publishTargets);
  if (!postId || !targets.some((t) => t.postId === postId)) { res.status(404).json({ error: "Not found" }); return; }
  try {
    const deleted = await db.delete(academySocialPostsTable).where(and(
      eq(academySocialPostsTable.id, postId),
      eq(academySocialPostsTable.academyId, access.academyId),
      inArray(academySocialPostsTable.status, ["draft", "scheduled", "failed"]),
    )).returning({ id: academySocialPostsTable.id });
    const [still] = await db.select({ id: academySocialPostsTable.id }).from(academySocialPostsTable).where(eq(academySocialPostsTable.id, postId));
    if (deleted.length === 0 && still) {
      res.status(409).json({ error: "It's already going out or out. Delete it in Instagram or Facebook.", code: "already_out" });
      return;
    }
    const remaining = withoutPost(targets, postId);
    // Taken back before it went out: it no longer counts as a public appearance.
    if (!remaining.some((t) => t.channel === "instagram" || t.channel === "facebook")) {
      await removeFeatures(access.academyId, "post", String(row.id)).catch(() => {});
    }
    const handedOff = remaining.some((t) => t.channel === "instagram" || t.channel === "facebook" || t.channel === "whatsapp");
    const [updated] = await db.update(academyCreativeProjectsTable)
      .set({
        publishTargets: remaining,
        // Nothing else is waiting or out: it is a rendered design again.
        ...(handedOff ? {} : { status: row.status === "scheduled" || row.status === "published" ? "ready" : row.status, scheduledAt: null, publishedAt: null }),
        updatedAt: new Date(),
      })
      .where(eq(academyCreativeProjectsTable.id, row.id)).returning();
    const view = await synced(updated);
    res.json({ project: publicProject(view.row), targets: view.targets });
  } catch (error) {
    fail(res, error, "Cancelling the post failed");
  }
});

// ─── WhatsApp ───────────────────────────────────────────────────────────────

const AudienceBody = z.object({
  roles: z.array(z.enum(["parents", "players", "coaches"])).min(1).max(3),
  /** null = every squad. */
  squadIds: z.array(z.number().int().positive()).max(100).nullable().default(null),
});
type Audience = z.infer<typeof AudienceBody>;

async function squadsBelong(academyId: number, audience: Audience): Promise<{ ok: boolean; names: string[] }> {
  if (!audience.squadIds) return { ok: true, names: [] };
  if (audience.squadIds.length === 0) return { ok: false, names: [] };
  const rows = await db.select({ id: academySquadsTable.id, name: academySquadsTable.name }).from(academySquadsTable)
    .where(and(eq(academySquadsTable.academyId, academyId), inArray(academySquadsTable.id, audience.squadIds)));
  return { ok: rows.length === new Set(audience.squadIds).size, names: rows.map((r) => r.name) };
}

/** Who the message reaches: one per phone, without opted-out or blocked numbers. */
async function reach(academyId: number, audience: Audience) {
  const resolved = await resolveAudience(academyId, { roles: audience.roles, squadIds: audience.squadIds, playerIds: null });
  const [optOuts, blocked] = await Promise.all([optedOutPhones(academyId), blockedPhones(academyId)]);
  const merged = mergeByPhone(resolved.recipients);
  const reachable = merged.filter((r) => !optOuts.has(r.phone) && !blocked.has(r.phone));
  return { reachable, skipped: merged.length - reachable.length, missing: resolved.missing.length };
}

const audienceKey = (a: Audience) => `${[...a.roles].sort().join(",")}|${a.squadIds ? [...a.squadIds].sort((x, y) => x - y).join(",") : "all"}`;

router.post(`${base}/publish/whatsapp/preview`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const body = AudienceBody.safeParse(req.body?.audience ?? req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick who it goes to", code: "invalid" }); return; }
  try {
    const squads = await squadsBelong(access.academyId, body.data);
    if (!squads.ok) { res.status(404).json({ error: "Squad not found in this academy" }); return; }
    const r = await reach(access.academyId, body.data);
    res.json({ count: r.reachable.length, skipped: r.skipped, missing: r.missing, squads: squads.names });
  } catch (error) {
    fail(res, error, "Counting the WhatsApp audience failed");
  }
});

const WhatsappBody = z.object({
  audience: AudienceBody,
  message: z.string().trim().min(1).max(3500),
  again: z.boolean().optional(),
});

router.post(`${base}/projects/:projectId/whatsapp`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  const body = WhatsappBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid", code: "invalid" }); return; }
  if (notRendered(res, row)) return;
  try {
    const settings = await getWhatsappSettings(access.academyId);
    if (!senderSessionFor(settings)) {
      res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number.", code: "whatsapp_off" });
      return;
    }
    const squads = await squadsBelong(access.academyId, body.data.audience);
    if (!squads.ok) { res.status(404).json({ error: "Squad not found in this academy" }); return; }
    const key = audienceKey(body.data.audience);
    const renderKey = row.renderedAt?.toISOString() ?? null;
    if (!body.data.again && readTargets(row.publishTargets).some((t) => t.channel === "whatsapp" && t.audience === key && (t.renderedAt ?? null) === renderKey)) {
      res.status(409).json({ error: "This version was already sent to the same people. Send it again?", code: "already_sent" });
      return;
    }
    const { reachable } = await reach(access.academyId, body.data.audience);
    if (reachable.length === 0) {
      res.status(400).json({ error: "Nobody in this audience has a WhatsApp number on file", code: "no_recipients" });
      return;
    }
    const { media } = await ensureCreativeMedia(row, access.user.id);
    // WhatsApp sends text through the academy's number; the picture or video goes as its signed link.
    const link = publicMediaUrl(publicBaseUrl(), media.id, media.kind === "video" ? "video" : "image");
    const scheduledFor = new Date();
    const [broadcast] = await db.insert(academyWhatsappBroadcastsTable).values({
      academyId: access.academyId,
      body: `${body.data.message}\n\n${link}`,
      audience: { ...body.data.audience, creativeProjectId: row.id },
      recipientCount: reachable.length,
      createdBy: access.user.id,
      scheduledFor,
    }).returning({ id: academyWhatsappBroadcastsTable.id });
    const queued = await enqueueMessages(reachable.map((r) => ({
      academyId: access.academyId,
      kind: "broadcast",
      broadcastId: broadcast.id,
      phone: r.phone,
      recipientName: r.name,
      recipientRole: r.role,
      playerId: r.playerIds.length === 1 ? r.playerIds[0] : null,
      createdBy: access.user.id,
      scheduledFor,
      dedupeKey: `a${access.academyId}:b${broadcast.id}:${r.phone}`,
      body: `${renderTemplate(body.data.message, {
        academy: access.academy.name,
        name: r.name ?? "",
        player: joinNames(r.playerNames, settings.locale),
        squad: r.squadNames.join(settings.locale === "ar" ? "، " : ", "),
      })}\n\n${link}`,
    })));
    await logProjectFeature(row, "private", scheduledFor).catch((err) => logger.warn({ err, projectId: row.id }, "Feature log failed"));
    const updated = await appendTargets(row, [{
      channel: "whatsapp",
      ref: `broadcast:${broadcast.id}`,
      at: scheduledFor.toISOString(),
      broadcastId: broadcast.id,
      recipients: queued,
      audience: key,
      mediaId: media.id,
      renderedAt: renderKey,
    }]);
    const view = await synced(updated);
    res.status(201).json({ project: publicProject(view.row), targets: view.targets, broadcastId: broadcast.id, queued });
  } catch (error) {
    fail(res, error, "Sending on WhatsApp failed");
  }
});

// ─── Ads ────────────────────────────────────────────────────────────────────

router.post(`${base}/projects/:projectId/to-ads`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  if (notRendered(res, row)) return;
  try {
    const { media, created } = await ensureCreativeMedia(row, access.user.id, { forAds: true });
    const renderKey = row.renderedAt?.toISOString() ?? null;
    const targets = readTargets(row.publishTargets);
    const recorded = targets.some((t) => t.channel === "ad" && t.mediaId === media.id);
    const updated = recorded ? row : await appendTargets(row, [{
      channel: "ad", ref: `media:${media.id}`, at: new Date().toISOString(), mediaId: media.id, renderedAt: renderKey,
    }]);
    const view = await synced(updated);
    res.status(created ? 201 : 200).json({ media: mediaView(media, adsMediaPrefix(access.academyId)), project: publicProject(view.row), targets: view.targets });
  } catch (error) {
    fail(res, error, "Adding it to your ad media failed");
  }
});

// ─── Download (bookkeeping only; the file is project.outputUrl?download=1) ──

router.post(`${base}/projects/:projectId/downloaded`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  if (notRendered(res, row)) return;
  const targets = readTargets(row.publishTargets);
  const next = addDownload(targets, row.renderedAt);
  if (next !== targets) {
    await db.update(academyCreativeProjectsTable).set({ publishTargets: next })
      .where(eq(academyCreativeProjectsTable.id, row.id));
  }
  res.status(204).end();
});

// ─── One project's targets, and the history ─────────────────────────────────

router.get(`${base}/projects/:projectId/publish`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  try {
    const view = await synced(row);
    res.json({ project: publicProject(view.row), targets: view.targets });
  } catch (error) {
    fail(res, error, "Reading where it went failed");
  }
});

router.get(`${base}/publish/history`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    const rows = await db.select().from(academyCreativeProjectsTable).where(and(
      eq(academyCreativeProjectsTable.academyId, access.academyId),
      sql`(${academyCreativeProjectsTable.status} in ('published', 'scheduled')
        or jsonb_array_length(coalesce(${academyCreativeProjectsTable.publishTargets}, '[]'::jsonb)) > 0)`,
    )).orderBy(desc(sql`coalesce(${academyCreativeProjectsTable.publishedAt}, ${academyCreativeProjectsTable.scheduledAt}, ${academyCreativeProjectsTable.updatedAt})`))
      .limit(100);
    const all = await postsFor(access.academyId, rows.flatMap((r) => readTargets(r.publishTargets)));
    const items = [];
    for (const r of rows) {
      const view = await synced(r, all);
      items.push({ project: projectSummary(view.row), targets: view.targets, thumbUrl: thumbFor(view.row, readTargets(view.row.publishTargets)) });
    }
    res.json({ items });
  } catch (error) {
    fail(res, error, "Reading the publish history failed");
  }
});

export default router;
