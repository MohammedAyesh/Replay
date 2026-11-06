import type { AcademySocialAccount } from "@workspace/db";
import { logger } from "../logger";
import { graphDelete, graphGet, MetaGraphError } from "../meta/graph";
import { markSocialReconnect, pageToken } from "../social/account";
import { IG_DAILY_LIMIT } from "./igCalendar";

/**
 * The Instagram calls the autopilot makes on top of lib/social/posts.ts: the account check,
 * the publishing limit, deleting a post on request, and a post's numbers.
 */

export type IgAccountCheck =
  | { ok: true; username: string | null; limit: { used: number; total: number } | null; limitError: string | null }
  | { ok: false; code: "not_connected" | "no_instagram" | "not_business" | "error" | "reconnect" | "instagram_assets_pending"; error: string };

const NOT_BUSINESS = "This Instagram account can't publish through Replay. It has to be an Instagram Business or Creator account. Check Instagram's account type, then connect again in Instagram & Facebook.";
const PERMISSION_ERROR = "Replay doesn't have permission for this Instagram account yet. Connect again and allow every permission.";

/** Meta's count of API posts in the last 24 hours (content_publishing_limit). */
export async function publishingLimit(igUserId: string, token: string): Promise<{ used: number; total: number }> {
  const res = await graphGet<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }> }>(
    `${igUserId}/content_publishing_limit`, { fields: "config,quota_usage" }, { token },
  );
  const row = res.data?.[0];
  const total = typeof row?.config?.quota_total === "number" && row.config.quota_total > 0 ? row.config.quota_total : IG_DAILY_LIMIT;
  return { used: typeof row?.quota_usage === "number" ? row.quota_usage : 0, total };
}

/**
 * Can this field publish? A Page with no linked Instagram, or one whose Instagram isn't a
 * Business account (content_publishing_limit refuses it), gets a clear error.
 */
export async function checkInstagram(account: AcademySocialAccount | null): Promise<IgAccountCheck> {
  if (account?.error === "instagram_assets_pending") {
    return { ok: false, code: "instagram_assets_pending", error: "Choose your Instagram account in Social to finish connecting." };
  }
  if (account?.status === "error") {
    return { ok: false, code: "reconnect", error: account.error ?? "Reconnect Instagram." };
  }
  if (!account || account.status !== "connected") {
    return { ok: false, code: "not_connected", error: "Connect Instagram first in Social." };
  }
  if (!account.igUserId) {
    return { ok: false, code: "no_instagram", error: account.pageId
      ? "No Instagram account is linked to your Facebook Page. Link one in Meta Business Suite, then connect again."
      : "Connect an Instagram professional account in Social first." };
  }
  let token: string;
  try {
    token = pageToken(account);
  } catch (error) {
    return { ok: false, code: "not_connected", error: (error as Error).message };
  }
  try {
    const limit = await publishingLimit(account.igUserId, token);
    return { ok: true, username: account.igUsername ?? null, limit, limitError: null };
  } catch (error) {
    const e = error as MetaGraphError;
    // 10 / 200: permission; 100 with "account type"/"business": a personal or creator account.
    const msg = (e.message ?? "").toLowerCase();
    if (e.code === 10 || e.code === 200) {
      await markSocialReconnect(account.academyId, error).catch(() => false);
      return { ok: false, code: "reconnect", error: PERMISSION_ERROR };
    }
    if (e.code === 190 || e.status === 401 || e.status === 403) {
      await markSocialReconnect(account.academyId, error).catch(() => false);
      return { ok: false, code: "reconnect", error: account.error ?? "Reconnect Instagram. Meta authorization expired or changed. Connect again and allow every permission." };
    }
    if (e.code === 100 && /(account type|must be (an? )?(instagram )?(business|professional)|not a (business|professional)|professional account required)/.test(msg)) {
      return { ok: false, code: "not_business", error: NOT_BUSINESS };
    }
    logger.info({ igUserId: account.igUserId, error: e.message }, "Instagram publishing limit could not be read");
    return { ok: true, username: account.igUsername ?? null, limit: null, limitError: e.message ?? "Meta didn't answer" };
  }
}

/** Delete a published post. Meta can delete feed posts and Reels; it can't delete Stories. */
export async function deleteInstagramMedia(account: AcademySocialAccount, igMediaId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await graphDelete(igMediaId, { token: pageToken(account) });
    return { ok: true };
  } catch (error) {
    await markSocialReconnect(account.academyId, error).catch(() => false);
    return { ok: false, error: (error as Error).message || "Meta refused the delete" };
  }
}

/** A post's numbers while Instagram still gives them (a Story's only for 24 hours). */
export async function mediaInsights(igMediaId: string, placement: "story" | "reel", token: string): Promise<Record<string, number | null>> {
  const metrics = placement === "story" ? ["views", "reach", "replies", "shares", "navigation"] : ["views", "reach", "likes", "comments", "shares", "saved"];
  const out: Record<string, number | null> = {};
  const isReconnectError = (error: unknown) => {
    const e = error as { code?: number; status?: number };
    return e?.code === 190 || e?.code === 10 || e?.code === 200 || e?.status === 401 || e?.status === 403;
  };
  const read = async (list: string[]) => {
    const res = await graphGet<{ data?: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(
      `${igMediaId}/insights`, { metric: list.join(",") }, { token },
    );
    for (const m of res.data ?? []) out[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? null;
  };
  try {
    await read(metrics);
  } catch (error) {
    if (isReconnectError(error)) throw error;
    // One metric Meta doesn't give for this post fails the whole call: ask one by one.
    for (const m of metrics) {
      try {
        await read([m]);
      } catch (metricError) {
        if (isReconnectError(metricError)) throw metricError;
        out[m] = null;
      }
    }
  }
  // "plays" is what the report calls a video's views.
  if (out.views !== undefined) out.plays = out.views;
  return out;
}
