import { and, eq, sql } from "drizzle-orm";
import { academyMetaConnectionsTable, db, metaAdCampaignsTable, metaAdsTable } from "@workspace/db";
import { decryptToken } from "./crypto";
import { logger } from "../logger";
import { metaAdsConfigured, metaConfig } from "./config";
import { graphAll, graphGet } from "./graph";

export type CampaignNumbers = {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  /** Click-to-WhatsApp/Messenger chats started. */
  conversations: number;
  /** Instant-form leads. */
  leads: number;
  currency: string | null;
};

type InsightRow = {
  campaign_id?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
};

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function numbersFromInsight(row: InsightRow | undefined, currency: string | null): CampaignNumbers | null {
  if (!row) return null;
  const action = (type: string) => num(row.actions?.find((a) => a.action_type === type)?.value);
  const leads = action("lead") || action("onsite_conversion.lead_grouped") || action("leadgen_grouped");
  return {
    spend: num(row.spend),
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    conversations: action("onsite_conversion.messaging_conversation_started_7d"),
    leads,
    currency,
  };
}

export type SyncSummary = { campaigns: number; ads: number; account: string | null; currency: string | null };

/**
 * One ad account's campaigns, ads and numbers. Replay's account keeps each campaign's academy
 * (an admin picks it); an academy's own account files every campaign under that academy.
 */
async function syncAccount(act: string, token: string | undefined, academyId: number | null): Promise<SyncSummary> {
  const account = await graphGet<{ name?: string; currency?: string }>(act, { fields: "name,currency" }, { token });
  const currency = account.currency ?? null;
  const [campaigns, ads, lifetime, recent] = await Promise.all([
    graphAll<{ id: string; name: string; effective_status?: string; objective?: string; start_time?: string }>(
      `${act}/campaigns`, { fields: "id,name,effective_status,objective,start_time", limit: "200" }, 20, token,
    ),
    graphAll<{ id: string; name?: string; campaign_id: string; effective_status?: string }>(
      `${act}/ads`, { fields: "id,name,campaign_id,effective_status", limit: "500" }, 20, token,
    ),
    graphAll<InsightRow>(`${act}/insights`, { level: "campaign", date_preset: "maximum", fields: "campaign_id,spend,impressions,reach,clicks,actions", limit: "500" }, 20, token),
    graphAll<InsightRow>(`${act}/insights`, { level: "campaign", date_preset: "last_30d", fields: "campaign_id,spend,impressions,reach,clicks,actions", limit: "500" }, 20, token),
  ]);
  const now = new Date();
  for (const c of campaigns) {
    const values = {
      name: c.name,
      status: c.effective_status ?? null,
      objective: c.objective ?? null,
      startedAt: c.start_time ? new Date(c.start_time) : null,
      insights: numbersFromInsight(lifetime.find((r) => r.campaign_id === c.id), currency) as never,
      insights30d: numbersFromInsight(recent.find((r) => r.campaign_id === c.id), currency) as never,
      syncedAt: now,
      updatedAt: now,
      ...(academyId !== null ? { academyId, adAccountId: act } : {}),
    };
    await db.insert(metaAdCampaignsTable).values({ id: c.id, ...values })
      .onConflictDoUpdate({ target: metaAdCampaignsTable.id, set: values });
  }
  const knownCampaigns = new Set(campaigns.map((c) => c.id));
  for (const ad of ads) {
    if (!knownCampaigns.has(ad.campaign_id)) continue;
    const values = { campaignId: ad.campaign_id, name: ad.name ?? null, status: ad.effective_status ?? null, syncedAt: now };
    await db.insert(metaAdsTable).values({ id: ad.id, ...values }).onConflictDoUpdate({ target: metaAdsTable.id, set: values });
  }
  return { campaigns: campaigns.length, ads: ads.length, account: account.name ?? null, currency };
}

/** Replay's ad account, then every academy that connected its own. */
export async function syncMetaAds(): Promise<SyncSummary> {
  const config = metaConfig();
  if (!metaAdsConfigured(config)) throw new Error("Meta is not connected");
  const summary = await syncAccount(config.adAccountId!, undefined, null);
  const own = await db.select().from(academyMetaConnectionsTable).where(and(
    eq(academyMetaConnectionsTable.mode, "own"),
    eq(academyMetaConnectionsTable.status, "connected"),
  ));
  for (const connection of own) {
    if (!connection.adAccountId || !connection.tokenEnc) continue;
    try {
      await syncAccount(connection.adAccountId, decryptToken(connection.tokenEnc), connection.academyId);
    } catch (error) {
      logger.warn({ academyId: connection.academyId, error: (error as Error).message }, "Syncing an academy's own ad account failed");
      await db.update(academyMetaConnectionsTable).set({ error: (error as Error).message.slice(0, 300), updatedAt: new Date() })
        .where(eq(academyMetaConnectionsTable.academyId, connection.academyId));
    }
  }
  return summary;
}

export async function lastMetaSync(): Promise<Date | null> {
  const [row] = await db.select({ at: sql<Date | null>`max(${metaAdCampaignsTable.syncedAt})` }).from(metaAdCampaignsTable);
  return row?.at ? new Date(row.at) : null;
}

let lastAttempt = 0;

/** Called from vps1's every-minute tick: syncs at most once an hour. Never throws. */
export async function maybeSyncMetaAds(everyMs = 60 * 60 * 1000): Promise<SyncSummary | "skipped" | "not-configured" | "failed"> {
  if (!metaAdsConfigured()) return "not-configured";
  if (Date.now() - lastAttempt < everyMs) return "skipped";
  lastAttempt = Date.now();
  try {
    const last = await lastMetaSync();
    if (last && Date.now() - last.getTime() < everyMs) return "skipped";
    return await syncMetaAds();
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "Meta ads sync failed");
    return "failed";
  }
}

export async function campaignById(id: string) {
  const [row] = await db.select().from(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.id, id));
  return row ?? null;
}
