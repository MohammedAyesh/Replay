import { desc, eq, isNull, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { academiesTable, academyContactsTable, db, metaAdCampaignsTable, metaAdLeadsTable } from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "../lib/academyAccess";
import { logger } from "../lib/logger";
import { metaAdsConfigured, metaConfig, metaSignatureValid, metaWebhookVerifyToken } from "../lib/meta/config";
import { graphGet, graphPost, MetaGraphError } from "../lib/meta/graph";
import { fileUnassignedLeads, handleLeadgen } from "../lib/meta/leads";
import { lastMetaSync, syncMetaAds, type CampaignNumbers } from "../lib/meta/sync";
import { formatPhoneForDisplay } from "../lib/whatsapp/phone";

/**
 * Meta ads that Replay runs for academies from its own ad account:
 *   - the lead webhook (instant forms) Meta calls,
 *   - admin: connection, sync, which academy each campaign is for, Pages subscribed to leads,
 *   - academy owners: their campaigns' spend and what became of the people they brought.
 */
const router: IRouter = Router();

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function missingTables(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code === "42P01" || /does not exist/i.test(`${(error as Error)?.message ?? ""} ${cause?.message ?? ""}`);
}

function sendError(res: Response, error: unknown, what: string) {
  if (missingTables(error)) {
    res.status(500).json({ error: "The Meta ads tables are missing from this database. Run the schema push and publish with the database review." });
    return;
  }
  if (error instanceof MetaGraphError) {
    res.status(502).json({ error: `Meta: ${error.message}` });
    return;
  }
  logger.error({ error: (error as Error)?.message }, what);
  res.status(500).json({ error: (error as Error)?.message?.slice(0, 300) ?? "Failed" });
}

// ─── Webhook (Meta → us) ─────────────────────────────────────────────────────

/** Meta's subscription check: echo the challenge when the verify token matches. */
router.get("/meta/webhook", (req, res): void => {
  const expected = metaWebhookVerifyToken();
  if (req.query["hub.mode"] === "subscribe" && expected && req.query["hub.verify_token"] === expected) {
    res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    return;
  }
  res.status(403).send("Forbidden");
});

/** Raw body (see app.ts) so the signature is checked over the exact bytes. */
router.post("/meta/webhook", async (req, res): Promise<void> => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  if (!metaSignatureValid(raw, req.headers["x-hub-signature-256"] as string | undefined, metaConfig().appSecret)) {
    res.status(401).json({ error: "Bad signature" });
    return;
  }
  let body: { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, string | number> }> }> };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Bad JSON" });
    return;
  }
  const changes = (body.entry ?? []).flatMap((entry) => entry.changes ?? []).filter((c) => c.field === "leadgen" && c.value);
  try {
    for (const change of changes) await handleLeadgen(change.value!);
    res.status(200).json({ ok: true, leads: changes.length });
  } catch (error) {
    // A non-2xx makes Meta retry, which is what we want if the lead could not be fetched.
    logger.error({ error: (error as Error)?.message }, "Meta lead webhook failed");
    res.status(500).json({ error: "Could not record the lead" });
  }
});

// ─── Admin ───────────────────────────────────────────────────────────────────

async function requireAdmin(req: Request, res: Response): Promise<AcademyConsoleUser | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return user;
}

function publicBaseUrl(req: Request): string {
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "replayjo.com";
  return `https://${host.split(",")[0].trim()}`;
}

router.get("/admin/meta-ads", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const config = metaConfig();
    let account: { name: string | null; currency: string | null; status: number | null } | null = null;
    let accountError: string | null = null;
    if (metaAdsConfigured(config)) {
      try {
        const a = await graphGet<{ name?: string; currency?: string; account_status?: number }>(config.adAccountId!, { fields: "name,currency,account_status" });
        account = { name: a.name ?? null, currency: a.currency ?? null, status: a.account_status ?? null };
      } catch (error) {
        accountError = (error as Error).message;
      }
    }
    const [campaigns, leadCounts, academies, lastSync] = await Promise.all([
      db.select().from(metaAdCampaignsTable).orderBy(desc(metaAdCampaignsTable.startedAt)),
      db.select({ campaignId: metaAdLeadsTable.campaignId, total: sql<number>`count(*)::int`, unassigned: sql<number>`count(*) filter (where ${metaAdLeadsTable.academyId} is null)::int` })
        .from(metaAdLeadsTable).groupBy(metaAdLeadsTable.campaignId),
      db.select({ id: academiesTable.id, name: academiesTable.name }).from(academiesTable).orderBy(academiesTable.name),
      lastMetaSync(),
    ]);
    const counts = new Map(leadCounts.map((c) => [c.campaignId, c]));
    res.json({
      connected: {
        token: Boolean(config.token),
        adAccount: config.adAccountId,
        appSecret: Boolean(config.appSecret),
        graphVersion: config.graphVersion,
      },
      account,
      accountError,
      webhook: { url: `${publicBaseUrl(req)}/api/meta/webhook`, verifyToken: metaWebhookVerifyToken(config) },
      lastSyncedAt: lastSync,
      academies,
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        startedAt: c.startedAt,
        academyId: c.academyId,
        insights: c.insights as CampaignNumbers | null,
        insights30d: c.insights30d as CampaignNumbers | null,
        leads: counts.get(c.id)?.total ?? 0,
        unassignedLeads: counts.get(c.id)?.unassigned ?? 0,
      })),
      leadsWithoutCampaign: counts.get(null)?.total ?? 0,
    });
  } catch (error) {
    sendError(res, error, "Admin Meta ads overview failed");
  }
});

router.post("/admin/meta-ads/sync", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await syncMetaAds());
  } catch (error) {
    sendError(res, error, "Meta ads sync failed");
  }
});

const AssignBody = z.object({ academyId: z.number().int().positive().nullable() });

router.put("/admin/meta-ads/campaigns/:campaignId", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const body = AssignBody.safeParse(req.body ?? {});
  const campaignId = String(req.params.campaignId ?? "");
  if (!body.success || !/^\d+$/.test(campaignId)) {
    res.status(400).json({ error: "Expected { academyId: number | null }" });
    return;
  }
  try {
    const [updated] = await db.update(metaAdCampaignsTable)
      .set({ academyId: body.data.academyId, updatedAt: new Date() })
      .where(eq(metaAdCampaignsTable.id, campaignId))
      .returning({ id: metaAdCampaignsTable.id });
    if (!updated) {
      res.status(404).json({ error: "Campaign not found. Sync first." });
      return;
    }
    const filed = body.data.academyId ? await fileUnassignedLeads(campaignId, body.data.academyId) : 0;
    res.json({ ok: true, filed });
  } catch (error) {
    sendError(res, error, "Assigning a Meta campaign failed");
  }
});

/** Pages the token can see, and whether each sends its instant-form leads here. */
router.get("/admin/meta-ads/pages", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const pages = await graphGet<{ data: Array<{ id: string; name: string; access_token?: string }> }>("me/accounts", { fields: "id,name,access_token", limit: "100" });
    const out = await Promise.all(pages.data.map(async (page) => {
      let subscribed: boolean | null = null;
      if (page.access_token) {
        try {
          const apps = await graphGet<{ data: Array<{ subscribed_fields?: string[] }> }>(`${page.id}/subscribed_apps`, {}, { token: page.access_token });
          subscribed = apps.data.some((app) => app.subscribed_fields?.includes("leadgen"));
        } catch {
          subscribed = null;
        }
      }
      return { id: page.id, name: page.name, subscribed };
    }));
    res.json(out);
  } catch (error) {
    sendError(res, error, "Listing Meta Pages failed");
  }
});

router.post("/admin/meta-ads/pages/:pageId/subscribe", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const pageId = String(req.params.pageId ?? "");
  if (!/^\d+$/.test(pageId)) {
    res.status(400).json({ error: "Invalid page id" });
    return;
  }
  try {
    const page = await graphGet<{ access_token?: string }>(pageId, { fields: "access_token" });
    if (!page.access_token) {
      res.status(403).json({ error: "Replay's Meta user has no access to this Page. Ask the academy to give Replay's business access to it." });
      return;
    }
    await graphPost(`${pageId}/subscribed_apps`, { subscribed_fields: "leadgen" }, { token: page.access_token });
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, "Subscribing a Meta Page failed");
  }
});

/** Leads, newest first; ?unassigned=1 for those still waiting for their campaign's academy. */
router.get("/admin/meta-ads/leads", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const rows = await db.select({
      id: metaAdLeadsTable.id,
      source: metaAdLeadsTable.source,
      academyId: metaAdLeadsTable.academyId,
      campaignId: metaAdLeadsTable.campaignId,
      campaignName: metaAdCampaignsTable.name,
      phone: metaAdLeadsTable.phone,
      name: metaAdLeadsTable.name,
      headline: metaAdLeadsTable.headline,
      createdAt: metaAdLeadsTable.createdAt,
    })
      .from(metaAdLeadsTable)
      .leftJoin(metaAdCampaignsTable, eq(metaAdCampaignsTable.id, metaAdLeadsTable.campaignId))
      .where(req.query.unassigned ? isNull(metaAdLeadsTable.academyId) : undefined)
      .orderBy(desc(metaAdLeadsTable.createdAt))
      .limit(200);
    res.json(rows.map((r) => ({ ...r, phoneDisplay: r.phone ? formatPhoneForDisplay(r.phone) : null })));
  } catch (error) {
    sendError(res, error, "Listing Meta leads failed");
  }
});

// ─── Academy owner: their ads ────────────────────────────────────────────────

export type FunnelCounts = { leads: number; contacted: number; trial: number; joined: number; lost: number };

/** Where each lead is now, from its contact in People. Joined = stage joined, or now a parent/player. */
export function funnelOf(rows: Array<{ stage: string | null; kind: string | null }>): FunnelCounts {
  const out: FunnelCounts = { leads: rows.length, contacted: 0, trial: 0, joined: 0, lost: 0 };
  for (const r of rows) {
    const joined = r.stage === "joined" || r.kind === "parent" || r.kind === "player";
    if (joined) out.joined += 1;
    else if (r.stage === "trial") out.trial += 1;
    else if (r.stage === "contacted") out.contacted += 1;
    else if (r.stage === "lost") out.lost += 1;
  }
  // Someone at trial was contacted; someone who joined had both.
  out.trial += out.joined;
  out.contacted += out.trial + out.lost;
  return out;
}

router.get("/academy/console/academies/:academyId/ads", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const academyId = intParam(req.params.academyId);
  if (!academyId) {
    res.status(400).json({ error: "Invalid academy id" });
    return;
  }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return;
  }
  try {
    const [campaigns, leads] = await Promise.all([
      db.select().from(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.academyId, academyId)).orderBy(desc(metaAdCampaignsTable.startedAt)),
      db.select({
        id: metaAdLeadsTable.id,
        source: metaAdLeadsTable.source,
        campaignId: metaAdLeadsTable.campaignId,
        phone: metaAdLeadsTable.phone,
        name: metaAdLeadsTable.name,
        headline: metaAdLeadsTable.headline,
        answers: metaAdLeadsTable.answers,
        createdAt: metaAdLeadsTable.createdAt,
        contactId: metaAdLeadsTable.contactId,
        contactName: academyContactsTable.name,
        stage: academyContactsTable.stage,
        kind: academyContactsTable.kind,
      })
        .from(metaAdLeadsTable)
        .leftJoin(academyContactsTable, eq(academyContactsTable.id, metaAdLeadsTable.contactId))
        .where(eq(metaAdLeadsTable.academyId, academyId))
        .orderBy(desc(metaAdLeadsTable.createdAt))
        .limit(1000),
    ]);
    const byCampaign = (id: string | null) => leads.filter((l) => l.campaignId === id);
    const campaignIds = new Set(campaigns.map((c) => c.id));
    res.json({
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        startedAt: c.startedAt,
        insights: c.insights as CampaignNumbers | null,
        insights30d: c.insights30d as CampaignNumbers | null,
        funnel: funnelOf(byCampaign(c.id)),
      })),
      // Chats from an ad Replay doesn't run for this academy, or whose ad is unknown.
      otherLeads: funnelOf(leads.filter((l) => !l.campaignId || !campaignIds.has(l.campaignId))),
      lastSyncedAt: await lastMetaSync(),
      leads: leads.slice(0, 100).map((l) => ({
        id: l.id,
        source: l.source,
        campaignId: l.campaignId,
        campaignName: campaigns.find((c) => c.id === l.campaignId)?.name ?? null,
        name: l.contactName ?? l.name,
        phone: l.phone,
        phoneDisplay: l.phone ? formatPhoneForDisplay(l.phone) : null,
        headline: l.headline,
        message: typeof (l.answers as { message?: unknown } | null)?.message === "string" ? (l.answers as { message: string }).message : null,
        answers: l.source === "lead_form" ? (l.answers as Record<string, string> | null) : null,
        createdAt: l.createdAt,
        contactId: l.contactId,
        stage: l.stage,
        kind: l.kind,
      })),
    });
  } catch (error) {
    sendError(res, error, "Academy ads overview failed");
  }
});

export default router;

