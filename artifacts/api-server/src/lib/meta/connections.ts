import { eq } from "drizzle-orm";
import { academyMetaConnectionsTable, db, type AcademyMetaConnection } from "@workspace/db";
import { logger } from "../logger";
import { metaConfig } from "./config";
import { decryptToken, encryptToken } from "./crypto";
import { graphGet, graphPost, MetaGraphError } from "./graph";

/**
 * An academy's link to Meta, either of two ways:
 *   replay: the academy shares its Facebook Page with Replay's business (Business Settings →
 *           Partners); Replay's system user is assigned to it and runs ads from Replay's account.
 *   own:    the owner signs in with Facebook Login for Business; Meta gives us a business
 *           integration system user token for his business, kept encrypted.
 */

export async function getConnection(academyId: number): Promise<AcademyMetaConnection | null> {
  const [row] = await db.select().from(academyMetaConnectionsTable).where(eq(academyMetaConnectionsTable.academyId, academyId));
  return row ?? null;
}

async function saveConnection(academyId: number, patch: Partial<AcademyMetaConnection>) {
  const now = new Date();
  await db.insert(academyMetaConnectionsTable).values({ academyId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: academyMetaConnectionsTable.academyId, set: { ...patch, updatedAt: now } });
  return (await getConnection(academyId))!;
}

/** The token that acts for this academy: its own one in "own" mode, Replay's otherwise. */
export function connectionToken(connection: AcademyMetaConnection | null): string | undefined {
  if (connection?.mode === "own" && connection.tokenEnc) return decryptToken(connection.tokenEnc);
  return undefined; // graph.ts falls back to META_ACCESS_TOKEN
}

/** The token to read a lead from this Page with. */
export async function tokenForPage(pageId: string | null): Promise<string | undefined> {
  if (!pageId) return undefined;
  const [row] = await db.select().from(academyMetaConnectionsTable).where(eq(academyMetaConnectionsTable.pageId, pageId));
  return row ? connectionToken(row) : undefined;
}

/** "https://facebook.com/galaxy.academy", "profile.php?id=123", "@galaxy" or "123" → a Page reference. */
export function parsePageRef(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d{5,25}$/.test(raw)) return raw;
  const idParam = raw.match(/[?&]id=(\d{5,25})/);
  if (idParam) return idParam[1];
  const url = raw.match(/(?:facebook\.com|fb\.com|fb\.me)\/(?:pg\/)?([A-Za-z0-9.\-_]+)/i);
  const slug = url ? url[1] : raw.replace(/^@/, "");
  if (!/^[A-Za-z0-9.\-_]{3,100}$/.test(slug) || ["profile.php", "pages", "people"].includes(slug.toLowerCase())) return null;
  return slug;
}

type PageInfo = { id: string; name: string; access_token?: string; whatsapp_number?: string };

let systemUserId: string | null = null;
async function replaySystemUserId(): Promise<string> {
  if (!systemUserId) systemUserId = (await graphGet<{ id: string }>("me", { fields: "id" })).id;
  return systemUserId;
}

/** Subscribe our app to the Page's lead forms, with a Page token. */
async function subscribeLeads(page: PageInfo): Promise<boolean> {
  if (!page.access_token) return false;
  try {
    await graphPost(`${page.id}/subscribed_apps`, { subscribed_fields: "leadgen" }, { token: page.access_token });
    return true;
  } catch (error) {
    logger.warn({ pageId: page.id, error: (error as Error).message }, "Subscribing a Page to leads failed");
    return false;
  }
}

export type ShareCheck =
  | { status: "connected"; pageId: string; pageName: string; whatsappNumber: string | null; leadsSubscribed: boolean }
  | { status: "not_shared"; pageId: string | null; pageName: string | null; businessId: string }
  | { status: "invalid" };

/**
 * Option 1: after the owner shared his Page with Replay's business, find it, assign it to
 * Replay's system user if needed, subscribe its leads and save the connection.
 */
export async function checkSharedPage(academyId: number, input: string): Promise<ShareCheck> {
  const ref = parsePageRef(input);
  if (!ref) return { status: "invalid" };
  const config = metaConfig();
  let page: PageInfo | null = null;
  let publicPage: { id: string; name: string } | null = null;
  try {
    page = await graphGet<PageInfo>(ref, { fields: "id,name,access_token,whatsapp_number" });
  } catch {
    page = null;
  }
  if (page && !page.access_token) {
    publicPage = { id: page.id, name: page.name };
    page = null;
  }
  if (!page) {
    // Shared with Replay's business but not yet with the system user: assign it.
    const pageId = publicPage?.id ?? (/^\d+$/.test(ref) ? ref : null);
    if (pageId) {
      try {
        const clientPages = await graphGet<{ data: Array<{ id: string; name: string }> }>(`${config.businessId}/client_pages`, { fields: "id,name", limit: "200" });
        if (clientPages.data.some((p) => p.id === pageId)) {
          const user = await replaySystemUserId();
          for (const tasks of [["ADVERTISE", "ANALYZE", "MODERATE", "MESSAGING"], ["ADVERTISE", "ANALYZE"]]) {
            try {
              await graphPost(`${pageId}/assigned_users`, { user, tasks: JSON.stringify(tasks), business: config.businessId });
              break;
            } catch (error) {
              logger.warn({ pageId, tasks, error: (error as Error).message }, "Assigning a shared Page failed");
            }
          }
          page = await graphGet<PageInfo>(pageId, { fields: "id,name,access_token,whatsapp_number" }).catch(() => null);
          if (page && !page.access_token) page = null;
        }
      } catch (error) {
        logger.warn({ error: (error as Error).message }, "Listing client Pages failed");
      }
    }
  }
  if (!page) {
    await saveConnection(academyId, { mode: "replay", pageId: publicPage?.id ?? null, pageName: publicPage?.name ?? null, status: "pending", error: "not_shared" });
    return { status: "not_shared", pageId: publicPage?.id ?? null, pageName: publicPage?.name ?? null, businessId: config.businessId };
  }
  const leadsSubscribed = await subscribeLeads(page);
  await saveConnection(academyId, {
    mode: "replay",
    pageId: page.id,
    pageName: page.name,
    whatsappNumber: page.whatsapp_number ?? null,
    adAccountId: null,
    adAccountName: null,
    clientBusinessId: null,
    tokenEnc: null,
    currency: null,
    leadsSubscribed,
    status: "connected",
    error: null,
    connectedAt: new Date(),
  });
  return { status: "connected", pageId: page.id, pageName: page.name, whatsappNumber: page.whatsapp_number ?? null, leadsSubscribed };
}

export type OwnAssets = {
  adAccounts: Array<{ id: string; name: string; currency: string; status: number }>;
  pages: Array<{ id: string; name: string; whatsappNumber: string | null }>;
};

async function ownAssets(token: string): Promise<OwnAssets & { pageTokens: Map<string, PageInfo> }> {
  const [accounts, pages] = await Promise.all([
    graphGet<{ data: Array<{ id: string; name: string; currency: string; account_status: number }> }>("me/adaccounts", { fields: "id,name,currency,account_status", limit: "100" }, { token }),
    graphGet<{ data: PageInfo[] }>("me/accounts", { fields: "id,name,access_token,whatsapp_number", limit: "100" }, { token }),
  ]);
  return {
    adAccounts: accounts.data.map((a) => ({ id: a.id, name: a.name, currency: a.currency, status: a.account_status })),
    pages: pages.data.map((p) => ({ id: p.id, name: p.name, whatsappNumber: p.whatsapp_number ?? null })),
    pageTokens: new Map(pages.data.map((p) => [p.id, p])),
  };
}

/**
 * Option 2: the code from Facebook Login for Business → a business integration system user
 * token for the owner's business. Saved encrypted; returns what he shared so he can pick.
 */
export async function connectOwnBusiness(academyId: number, code: string): Promise<OwnAssets> {
  const config = metaConfig();
  if (!config.appSecret) throw new MetaGraphError("Meta is not set up on the server (META_APP_SECRET)", 503);
  const exchange = await fetch(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token?${new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    code,
  })}`, { signal: AbortSignal.timeout(20_000) });
  const body = (await exchange.json().catch(() => null)) as { access_token?: string; error?: { message?: string } } | null;
  if (!exchange.ok || !body?.access_token) throw new MetaGraphError(body?.error?.message ?? "Meta refused the sign-in", exchange.status || 400);
  const token = body.access_token;
  const me = await graphGet<{ id: string; client_business_id?: string }>("me", { fields: "id,client_business_id" }, { token }).catch(() => ({ id: "", client_business_id: undefined }));
  const assets = await ownAssets(token);
  await saveConnection(academyId, {
    mode: "own",
    tokenEnc: encryptToken(token),
    clientBusinessId: me.client_business_id ?? null,
    status: "pending",
    error: null,
  });
  // One of each: pick them straight away.
  if (assets.adAccounts.length === 1 && assets.pages.length === 1) {
    await selectOwnAssets(academyId, assets.adAccounts[0].id, assets.pages[0].id);
  }
  return { adAccounts: assets.adAccounts, pages: assets.pages };
}

export async function listOwnAssets(academyId: number): Promise<OwnAssets | null> {
  const connection = await getConnection(academyId);
  if (connection?.mode !== "own" || !connection.tokenEnc) return null;
  const { adAccounts, pages } = await ownAssets(decryptToken(connection.tokenEnc));
  return { adAccounts, pages };
}

export async function selectOwnAssets(academyId: number, adAccountId: string, pageId: string): Promise<AcademyMetaConnection> {
  const connection = await getConnection(academyId);
  if (connection?.mode !== "own" || !connection.tokenEnc) throw new MetaGraphError("Connect Facebook first", 409);
  const token = decryptToken(connection.tokenEnc);
  const assets = await ownAssets(token);
  const account = assets.adAccounts.find((a) => a.id === adAccountId);
  const page = assets.pageTokens.get(pageId);
  if (!account || !page) throw new MetaGraphError("That ad account or Page wasn't shared with Replay", 404);
  const leadsSubscribed = await subscribeLeads(page);
  return saveConnection(academyId, {
    adAccountId: account.id,
    adAccountName: account.name,
    currency: account.currency,
    pageId: page.id,
    pageName: page.name,
    whatsappNumber: page.whatsapp_number ?? null,
    leadsSubscribed,
    status: "connected",
    error: null,
    connectedAt: new Date(),
  });
}

export async function disconnect(academyId: number): Promise<void> {
  await db.delete(academyMetaConnectionsTable).where(eq(academyMetaConnectionsTable.academyId, academyId));
}

/** A Page token for posting lead forms on the academy's Page. */
export async function pageToken(connection: AcademyMetaConnection): Promise<string> {
  if (!connection.pageId) throw new MetaGraphError("No Facebook Page connected", 409);
  const page = await graphGet<{ access_token?: string }>(connection.pageId, { fields: "access_token" }, { token: connectionToken(connection) });
  if (!page.access_token) throw new MetaGraphError("Replay can't act for this Page any more. Share it again.", 403);
  return page.access_token;
}
