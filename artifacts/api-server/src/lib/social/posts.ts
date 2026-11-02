import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  academyAdMediaTable,
  academySocialAccountsTable,
  academySocialPostsTable,
  db,
  type AcademySocialAccount,
  type AcademySocialPost,
} from "@workspace/db";
import { logger } from "../logger";
import { graphGet, graphPost, MetaGraphError } from "../meta/graph";
import { publicBaseUrl } from "../whatsapp/waha";
import { getSocialAccount, pageToken, publicMediaUrl } from "./account";
import { recordComment } from "./inbox";

/**
 * Publishing to Instagram and the Facebook Page, and engagement numbers for every post
 * on both (made in Replay or not). Media come from the academy's media library
 * (academy_ad_media) through signed public links Meta downloads from.
 */

export type PostMedia = { mediaId: number; type: "image" | "video" };
export type Target = "instagram" | "facebook";
export type Format = "image" | "carousel" | "video" | "reel" | "story";

type Insights = Record<string, number | null>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mediaUrl(m: PostMedia): string {
  return publicMediaUrl(publicBaseUrl(), m.mediaId, m.type);
}

// ─── Instagram ──────────────────────────────────────────────────────────────

async function waitForContainer(id: string, token: string, timeoutMs = 5 * 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await graphGet<{ status_code?: string; status?: string }>(id, { fields: "status_code,status" }, { token });
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new MetaGraphError(`Instagram couldn't process the media (${s.status ?? s.status_code})`, 502);
    if (Date.now() > until) throw new MetaGraphError("Instagram took too long to process the video", 504);
    await sleep(4000);
  }
}

async function publishInstagram(account: AcademySocialAccount, post: { format: Format; caption: string; media: PostMedia[] }): Promise<{ id: string; permalink: string | null }> {
  if (!account.igUserId) throw new MetaGraphError("No Instagram account is linked to this Page", 409);
  const token = pageToken(account);
  const ig = account.igUserId;
  const item = async (m: PostMedia, extra: Record<string, string>) => {
    const params: Record<string, string> = { ...extra };
    if (m.type === "video") params.video_url = mediaUrl(m);
    else params.image_url = mediaUrl(m);
    const res = await graphPost<{ id: string }>(`${ig}/media`, params, { token });
    if (m.type === "video") await waitForContainer(res.id, token);
    return res.id;
  };
  let creation: string;
  if (post.format === "carousel") {
    const children: string[] = [];
    for (const m of post.media.slice(0, 10)) children.push(await item(m, { is_carousel_item: "true", ...(m.type === "video" ? { media_type: "VIDEO" } : {}) }));
    creation = (await graphPost<{ id: string }>(`${ig}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: post.caption }, { token })).id;
    await waitForContainer(creation, token);
  } else if (post.format === "story") {
    creation = await item(post.media[0], { media_type: "STORIES" });
  } else if (post.format === "reel" || post.media[0].type === "video") {
    creation = await item(post.media[0], { media_type: "REELS", caption: post.caption, share_to_feed: "true" });
  } else {
    creation = await item(post.media[0], { caption: post.caption });
  }
  const published = await graphPost<{ id: string }>(`${ig}/media_publish`, { creation_id: creation }, { token });
  const info = await graphGet<{ permalink?: string }>(published.id, { fields: "permalink" }, { token }).catch(() => ({ permalink: undefined }));
  return { id: published.id, permalink: info.permalink ?? null };
}

// ─── Facebook Page ──────────────────────────────────────────────────────────

async function publishFacebook(account: AcademySocialAccount, post: { format: Format; caption: string; media: PostMedia[] }): Promise<{ id: string; permalink: string | null }> {
  if (!account.pageId) throw new MetaGraphError("No Facebook Page connected", 409);
  if (post.format === "story") throw new MetaGraphError("Stories go to Instagram only", 400);
  const token = pageToken(account);
  const page = account.pageId;
  let id: string;
  const first = post.media[0];
  if (first?.type === "video") {
    id = (await graphPost<{ id: string }>(`${page}/videos`, { file_url: mediaUrl(first), description: post.caption }, { token })).id;
  } else if (post.media.length > 1) {
    const photos: string[] = [];
    for (const m of post.media.filter((x) => x.type === "image").slice(0, 10)) {
      photos.push((await graphPost<{ id: string }>(`${page}/photos`, { url: mediaUrl(m), published: "false" }, { token })).id);
    }
    const params: Record<string, string> = { message: post.caption };
    photos.forEach((p, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: p }); });
    id = (await graphPost<{ id: string }>(`${page}/feed`, params, { token })).id;
  } else if (first) {
    const res = await graphPost<{ id: string; post_id?: string }>(`${page}/photos`, { url: mediaUrl(first), caption: post.caption }, { token });
    id = res.post_id ?? res.id;
  } else {
    id = (await graphPost<{ id: string }>(`${page}/feed`, { message: post.caption }, { token })).id;
  }
  const info = await graphGet<{ permalink_url?: string }>(id, { fields: "permalink_url" }, { token }).catch(() => ({ permalink_url: undefined }));
  return { id, permalink: info.permalink_url ?? null };
}

/** Publish one post to each of its targets. Partial success is kept and reported. */
export async function publishPost(postId: number): Promise<AcademySocialPost> {
  const claimed = await db.update(academySocialPostsTable).set({ status: "publishing", error: null, updatedAt: new Date() })
    .where(and(eq(academySocialPostsTable.id, postId), inArray(academySocialPostsTable.status, ["draft", "scheduled", "failed", "partial"])))
    .returning();
  const post = claimed[0];
  if (!post) {
    const [row] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, postId));
    if (!row) throw new MetaGraphError("Post not found", 404);
    return row;
  }
  const account = await getSocialAccount(post.academyId);
  const targets = (post.targets as Target[]) ?? [];
  const media = (post.media as PostMedia[]) ?? [];
  const patch: Partial<AcademySocialPost> = {};
  const errors: string[] = [];
  if (!account || account.status !== "connected") errors.push("Instagram and Facebook aren't connected");
  else {
    if (targets.includes("instagram") && !post.igMediaId) {
      try {
        const r = await publishInstagram(account, { format: post.format as Format, caption: post.caption, media });
        patch.igMediaId = r.id;
        patch.igPermalink = r.permalink;
      } catch (e) {
        errors.push(`Instagram: ${(e as Error).message}`);
      }
    }
    if (targets.includes("facebook") && !post.fbPostId && post.format !== "story") {
      try {
        const r = await publishFacebook(account, { format: post.format as Format, caption: post.caption, media });
        patch.fbPostId = r.id;
        patch.fbPermalink = r.permalink;
      } catch (e) {
        errors.push(`Facebook: ${(e as Error).message}`);
      }
    }
  }
  const done = targets.filter((t) => (t === "instagram" ? patch.igMediaId ?? post.igMediaId : t === "facebook" && post.format !== "story" ? patch.fbPostId ?? post.fbPostId : true));
  const status = errors.length === 0 ? "published" : done.length > 0 && (patch.igMediaId || patch.fbPostId || post.igMediaId || post.fbPostId) ? "partial" : "failed";
  const [row] = await db.update(academySocialPostsTable).set({
    ...patch,
    status,
    error: errors.length ? errors.join(" · ").slice(0, 1000) : null,
    publishedAt: status === "failed" ? post.publishedAt : post.publishedAt ?? new Date(),
    updatedAt: new Date(),
  }).where(eq(academySocialPostsTable.id, post.id)).returning();
  return row;
}

/** Scheduled posts whose time has come (run from the minute tick). */
export async function publishDuePosts(now = new Date()): Promise<number> {
  // A publish that died half-way (a restart) is reported, never retried blindly: it may have posted.
  await db.update(academySocialPostsTable).set({ status: "failed", error: "Publishing was interrupted. Check Instagram and Facebook before trying again.", updatedAt: now })
    .where(and(eq(academySocialPostsTable.status, "publishing"), lte(academySocialPostsTable.updatedAt, new Date(now.getTime() - 15 * 60_000))));
  const due = await db.select({ id: academySocialPostsTable.id }).from(academySocialPostsTable)
    .where(and(eq(academySocialPostsTable.status, "scheduled"), lte(academySocialPostsTable.scheduledFor, now)))
    .limit(5);
  for (const p of due) {
    try {
      await publishPost(p.id);
    } catch (error) {
      logger.warn({ postId: p.id, error: (error as Error).message }, "Publishing a scheduled post failed");
    }
  }
  return due.length;
}

/** Check a media item exists in the academy's library and is ready. */
export async function libraryMedia(academyId: number, ids: number[]): Promise<PostMedia[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: academyAdMediaTable.id, kind: academyAdMediaTable.kind, status: academyAdMediaTable.status })
    .from(academyAdMediaTable).where(and(eq(academyAdMediaTable.academyId, academyId), inArray(academyAdMediaTable.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r || r.status !== "ready") throw new MetaGraphError("A photo or video isn't in your media library (or is still processing)", 400);
    return { mediaId: id, type: r.kind === "video" ? "video" : "image" } as PostMedia;
  });
}

// ─── Engagement ─────────────────────────────────────────────────────────────

type IgMedia = {
  id: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string;
  thumbnail_url?: string; media_url?: string; timestamp?: string; like_count?: number; comments_count?: number;
  comments?: { data?: Array<{ id: string; text?: string; username?: string; timestamp?: string; from?: { id?: string; username?: string } }> };
};

async function igMediaInsights(id: string, product: string | undefined, token: string): Promise<Insights> {
  const metrics = product === "STORY" ? ["views", "reach", "replies", "shares", "total_interactions"]
    : ["views", "reach", "saved", "shares", "total_interactions"];
  const out: Insights = {};
  try {
    const res = await graphGet<{ data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(`${id}/insights`, { metric: metrics.join(",") }, { token });
    for (const m of res.data ?? []) out[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? null;
  } catch (error) {
    logger.info({ id, error: (error as Error).message }, "Instagram media insights failed");
  }
  return out;
}

async function syncInstagram(account: AcademySocialAccount, token: string): Promise<number> {
  if (!account.igUserId) return 0;
  const res = await graphGet<{ data: IgMedia[] }>(`${account.igUserId}/media`, {
    fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count,comments.limit(20){id,text,username,timestamp,from}",
    limit: "25",
  }, { token });
  let n = 0;
  for (const m of res.data ?? []) {
    const insights: Insights = { likes: m.like_count ?? null, comments: m.comments_count ?? null, ...(await igMediaInsights(m.id, m.media_product_type, token)) };
    const thumb = m.thumbnail_url ?? (m.media_type === "VIDEO" ? null : m.media_url ?? null);
    const format: Format = m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_product_type === "REELS" ? "reel" : m.media_type === "VIDEO" ? "video" : "image";
    await db.insert(academySocialPostsTable).values({
      academyId: account.academyId, source: "synced", targets: ["instagram"], format, caption: m.caption ?? "",
      status: "published", publishedAt: m.timestamp ? new Date(m.timestamp) : new Date(), igMediaId: m.id, igPermalink: m.permalink ?? null,
      thumbnail: thumb, insights: { instagram: insights }, insightsAt: new Date(),
    }).onConflictDoUpdate({
      target: academySocialPostsTable.igMediaId,
      targetWhere: isNotNull(academySocialPostsTable.igMediaId),
      set: {
        insights: sql`jsonb_set(coalesce(${academySocialPostsTable.insights}, '{}'::jsonb), '{instagram}', ${JSON.stringify(insights)}::jsonb)`,
        insightsAt: new Date(),
        igPermalink: m.permalink ?? null,
        thumbnail: sql`coalesce(${academySocialPostsTable.thumbnail}, ${thumb})`,
        updatedAt: new Date(),
      },
    });
    for (const c of m.comments?.data ?? []) {
      await recordComment(account, "instagram", {
        commentId: c.id, postId: m.id, fromId: c.from?.id ?? null, fromName: c.username ? `@${c.username}` : c.from?.username ? `@${c.from.username}` : null,
        body: c.text ?? "", createdAt: c.timestamp ? new Date(c.timestamp) : undefined,
      });
    }
    n += 1;
  }
  return n;
}

type FbPost = {
  id: string; message?: string; permalink_url?: string; created_time?: string; full_picture?: string;
  shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number }; data?: Array<{ id: string; message?: string; created_time?: string; from?: { id?: string; name?: string } }> };
};

async function fbPostInsights(id: string, token: string): Promise<Insights> {
  const out: Insights = {};
  for (const metric of ["post_impressions_unique", "post_clicks"]) {
    try {
      const res = await graphGet<{ data: Array<{ name: string; values?: Array<{ value: number }> }> }>(`${id}/insights`, { metric }, { token });
      const v = res.data?.[0]?.values?.[0]?.value;
      out[metric === "post_impressions_unique" ? "reach" : "clicks"] = typeof v === "number" ? v : null;
    } catch {
      // Not every post type or Page size has these.
    }
  }
  return out;
}

async function syncFacebook(account: AcademySocialAccount, token: string): Promise<number> {
  if (!account.pageId) return 0;
  const res = await graphGet<{ data: FbPost[] }>(`${account.pageId}/published_posts`, {
    fields: "id,message,permalink_url,created_time,full_picture,shares,reactions.summary(true).limit(0),comments.summary(true).limit(20){id,message,created_time,from}",
    limit: "25",
  }, { token });
  let n = 0;
  for (const p of res.data ?? []) {
    const insights: Insights = {
      reactions: p.reactions?.summary?.total_count ?? null,
      comments: p.comments?.summary?.total_count ?? null,
      shares: p.shares?.count ?? 0,
      ...(await fbPostInsights(p.id, token)),
    };
    await db.insert(academySocialPostsTable).values({
      academyId: account.academyId, source: "synced", targets: ["facebook"], format: "image", caption: p.message ?? "",
      status: "published", publishedAt: p.created_time ? new Date(p.created_time) : new Date(), fbPostId: p.id, fbPermalink: p.permalink_url ?? null,
      thumbnail: p.full_picture ?? null, insights: { facebook: insights }, insightsAt: new Date(),
    }).onConflictDoUpdate({
      target: academySocialPostsTable.fbPostId,
      targetWhere: isNotNull(academySocialPostsTable.fbPostId),
      set: {
        insights: sql`jsonb_set(coalesce(${academySocialPostsTable.insights}, '{}'::jsonb), '{facebook}', ${JSON.stringify(insights)}::jsonb)`,
        insightsAt: new Date(),
        fbPermalink: p.permalink_url ?? null,
        thumbnail: sql`coalesce(${academySocialPostsTable.thumbnail}, ${p.full_picture ?? null})`,
        updatedAt: new Date(),
      },
    });
    for (const c of p.comments?.data ?? []) {
      await recordComment(account, "facebook", {
        commentId: c.id, postId: p.id, fromId: c.from?.id ?? null, fromName: c.from?.name ?? null,
        body: c.message ?? "", createdAt: c.created_time ? new Date(c.created_time) : undefined,
      });
    }
    n += 1;
  }
  return n;
}

async function accountInsights(account: AcademySocialAccount, token: string) {
  const out: Record<string, Insights> = {};
  if (account.igUserId) {
    const ig: Insights = {};
    try {
      const p = await graphGet<{ followers_count?: number; media_count?: number }>(account.igUserId, { fields: "followers_count,media_count" }, { token });
      ig.followers = p.followers_count ?? null;
      ig.posts = p.media_count ?? null;
    } catch (error) {
      logger.info({ error: (error as Error).message }, "Instagram profile numbers failed");
    }
    const until = Math.floor(Date.now() / 1000);
    const since = until - 28 * 86400;
    for (const metric of ["reach", "views", "accounts_engaged", "total_interactions", "profile_views"]) {
      try {
        const res = await graphGet<{ data: Array<{ total_value?: { value: number } }> }>(`${account.igUserId}/insights`, {
          metric, period: "day", metric_type: "total_value", since: String(since), until: String(until),
        }, { token });
        ig[metric] = res.data?.[0]?.total_value?.value ?? null;
      } catch {
        ig[metric] = null;
      }
    }
    out.instagram = ig;
  }
  if (account.pageId) {
    try {
      const p = await graphGet<{ followers_count?: number; fan_count?: number }>(account.pageId, { fields: "followers_count,fan_count" }, { token });
      out.facebook = { followers: p.followers_count ?? p.fan_count ?? null };
    } catch (error) {
      logger.info({ error: (error as Error).message }, "Page numbers failed");
    }
  }
  return out;
}

/** Posts, their numbers and the account's numbers for one academy. */
export async function syncSocial(academyId: number): Promise<{ instagram: number; facebook: number }> {
  const account = await getSocialAccount(academyId);
  if (!account || account.status !== "connected") throw new MetaGraphError("Instagram and Facebook aren't connected", 409);
  const token = pageToken(account);
  const instagram = await syncInstagram(account, token).catch((e) => { logger.warn({ academyId, error: (e as Error).message }, "Instagram sync failed"); return 0; });
  const facebook = await syncFacebook(account, token).catch((e) => { logger.warn({ academyId, error: (e as Error).message }, "Facebook sync failed"); return 0; });
  const insights = await accountInsights(account, token);
  await db.update(academySocialAccountsTable).set({ insights, insightsAt: new Date(), postsSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(academySocialAccountsTable.academyId, academyId));
  return { instagram, facebook };
}

let lastRun = 0;
/** Hourly from the minute tick: refresh every connected academy, and publish what's due (every minute). */
export async function maybeRunSocial(everyMs = 60 * 60 * 1000): Promise<{ published: number; synced: number } | "skipped"> {
  const published = await publishDuePosts().catch(() => 0);
  if (Date.now() - lastRun < everyMs) return published ? { published, synced: 0 } : "skipped";
  lastRun = Date.now();
  const accounts = await db.select({ academyId: academySocialAccountsTable.academyId }).from(academySocialAccountsTable)
    .where(eq(academySocialAccountsTable.status, "connected"));
  let synced = 0;
  for (const a of accounts) {
    try {
      await syncSocial(a.academyId);
      synced += 1;
    } catch (error) {
      logger.warn({ academyId: a.academyId, error: (error as Error).message }, "Social sync failed");
    }
  }
  return { published, synced };
}
