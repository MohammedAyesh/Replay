import { randomUUID } from "node:crypto";
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
  issues: OwnAssetIssue[];
};

export type OwnAssetIssue = {
  step: "ad_accounts" | "pages";
  reason: "not_shared" | "unavailable";
  referenceCode?: string;
};

type OwnConnectionStep = "token_exchange" | "identity" | "permissions" | "ad_accounts" | "pages";

export class OwnBusinessConnectError extends Error {
  constructor(readonly status: number, readonly referenceCode: string) {
    super("Facebook refused the connection");
  }
}

type StepResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

function shortReferenceCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function logOwnConnectionStepFailure(step: OwnConnectionStep, referenceCode: string, error: unknown): void {
  if (error instanceof MetaGraphError) {
    logger.error({
      referenceCode,
      step,
      metaError: {
        code: error.code ?? null,
        error_subcode: error.subcode ?? null,
        type: error.type ?? null,
        message: error.message,
        fbtrace_id: error.fbtraceId ?? null,
      },
    }, "Connecting an academy's own Meta business failed");
    return;
  }
  logger.error({
    referenceCode,
    step,
    failureKind: error instanceof Error ? error.name : "UnknownError",
  }, "Connecting an academy's own Meta business failed");
}

async function captureOwnConnectionStep<T>(
  step: OwnConnectionStep,
  referenceCode: string,
  run: () => Promise<T>,
): Promise<StepResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    logOwnConnectionStepFailure(step, referenceCode, error);
    return { ok: false, error };
  }
}

function permissionError(error: unknown): boolean {
  return error instanceof MetaGraphError && (error.code === 10 || error.code === 200);
}

async function ownAssets(token: string, referenceCode = shortReferenceCode()): Promise<OwnAssets & {
  pageTokens: Map<string, PageInfo>;
  adAccountCount: number | null;
  pageCount: number | null;
}> {
  const [accountsResult, pagesResult] = await Promise.all([
    captureOwnConnectionStep("ad_accounts", referenceCode, () =>
      graphGet<{ data?: Array<{ id: string; name: string; currency: string; account_status: number }> }>(
        "me/adaccounts", { fields: "id,name,currency,account_status", limit: "100" }, { token },
      )),
    captureOwnConnectionStep("pages", referenceCode, () =>
      graphGet<{ data?: PageInfo[] }>(
        "me/accounts", { fields: "id,name,access_token,whatsapp_number", limit: "100" }, { token },
      )),
  ]);

  const accountRows = accountsResult.ok && Array.isArray(accountsResult.value.data) ? accountsResult.value.data : [];
  const pageRows = pagesResult.ok && Array.isArray(pagesResult.value.data) ? pagesResult.value.data : [];
  const issues: OwnAssetIssue[] = [];

  if (!accountsResult.ok) {
    issues.push({
      step: "ad_accounts",
      reason: permissionError(accountsResult.error) ? "not_shared" : "unavailable",
      referenceCode,
    });
  } else if (accountRows.length === 0) {
    issues.push({ step: "ad_accounts", reason: "not_shared" });
  }

  if (!pagesResult.ok) {
    issues.push({
      step: "pages",
      reason: permissionError(pagesResult.error) ? "not_shared" : "unavailable",
      referenceCode,
    });
  } else if (pageRows.length === 0) {
    issues.push({ step: "pages", reason: "not_shared" });
  }

  return {
    adAccounts: accountRows.map((a) => ({ id: a.id, name: a.name, currency: a.currency, status: a.account_status })),
    pages: pageRows.map((p) => ({ id: p.id, name: p.name, whatsappNumber: p.whatsapp_number ?? null })),
    issues,
    pageTokens: new Map(pageRows.map((p) => [p.id, p])),
    adAccountCount: accountsResult.ok ? accountRows.length : null,
    pageCount: pagesResult.ok ? pageRows.length : null,
  };
}

async function grantedPermissions(token: string, referenceCode: string): Promise<string[] | null> {
  const result = await captureOwnConnectionStep("permissions", referenceCode, () =>
    graphGet<{ data?: Array<{ permission?: string; status?: string }> }>("me/permissions", {}, { token }));
  if (!result.ok || !Array.isArray(result.value.data)) return null;
  return result.value.data
    .filter((item) => item.status === "granted" && typeof item.permission === "string")
    .map((item) => item.permission!)
    .sort();
}

async function saveOwnSelection(
  academyId: number,
  account: OwnAssets["adAccounts"][number],
  page: PageInfo,
): Promise<AcademyMetaConnection> {
  const leadsSubscribed = await subscribeLeads(page);
  return saveConnection(academyId, {
    mode: "own",
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

/**
 * Option 2: the code from Facebook Login for Business → a business integration system user
 * token for the owner's business. Saved encrypted; returns what he shared so he can pick.
 */
export async function connectOwnBusiness(academyId: number, code: string): Promise<OwnAssets> {
  const referenceCode = shortReferenceCode();
  const config = metaConfig();
  if (!config.appSecret) {
    const error = new MetaGraphError("Meta app secret is not configured", 503);
    logOwnConnectionStepFailure("token_exchange", referenceCode, error);
    throw new OwnBusinessConnectError(503, referenceCode);
  }
  let exchange: Response;
  try {
    exchange = await fetch(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token?${new URLSearchParams({
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
    })}`, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    logOwnConnectionStepFailure("token_exchange", referenceCode, error);
    throw new OwnBusinessConnectError(502, referenceCode);
  }
  const body = (await exchange.json().catch(() => null)) as {
    access_token?: string;
    error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string };
  } | null;
  if (!exchange.ok || !body?.access_token) {
    const error = new MetaGraphError(
      body?.error?.message ?? "Meta refused the sign-in",
      exchange.status || 400,
      body?.error?.code,
      body?.error?.error_subcode,
      body?.error?.type,
      body?.error?.fbtrace_id,
    );
    logOwnConnectionStepFailure("token_exchange", referenceCode, error);
    throw new OwnBusinessConnectError(exchange.status >= 400 && exchange.status < 500 ? exchange.status : 502, referenceCode);
  }
  const token = body.access_token;
  const [meResult, permissions, assets] = await Promise.all([
    captureOwnConnectionStep("identity", referenceCode, () =>
      graphGet<{ id?: string; client_business_id?: string }>("me", { fields: "id,client_business_id" }, { token })),
    grantedPermissions(token, referenceCode),
    ownAssets(token, referenceCode),
  ]);
  const me = meResult.ok ? meResult.value : null;
  logger.info({
    referenceCode,
    grantedPermissions: permissions,
    permissionsAvailable: permissions !== null,
    adAccountCount: assets.adAccountCount,
    pageCount: assets.pageCount,
  }, "Meta own-business sign-in assets checked");

  await saveConnection(academyId, {
    mode: "own",
    tokenEnc: encryptToken(token),
    clientBusinessId: me?.client_business_id ?? null,
    adAccountId: null,
    adAccountName: null,
    currency: null,
    pageId: null,
    pageName: null,
    whatsappNumber: null,
    leadsSubscribed: false,
    status: "pending",
    error: null,
    connectedAt: null,
  });
  if (assets.issues.length === 0 && assets.adAccounts.length === 1 && assets.pages.length === 1) {
    const page = assets.pageTokens.get(assets.pages[0].id);
    if (page) await saveOwnSelection(academyId, assets.adAccounts[0], page);
  }
  return { adAccounts: assets.adAccounts, pages: assets.pages, issues: assets.issues };
}

export async function listOwnAssets(academyId: number): Promise<OwnAssets | null> {
  const connection = await getConnection(academyId);
  if (connection?.mode !== "own" || !connection.tokenEnc) return null;
  const { adAccounts, pages, issues } = await ownAssets(decryptToken(connection.tokenEnc));
  return { adAccounts, pages, issues };
}

export async function selectOwnAssets(academyId: number, adAccountId: string, pageId: string): Promise<AcademyMetaConnection> {
  const connection = await getConnection(academyId);
  if (connection?.mode !== "own" || !connection.tokenEnc) throw new MetaGraphError("Connect Facebook first", 409);
  const token = decryptToken(connection.tokenEnc);
  const assets = await ownAssets(token);
  const account = assets.adAccounts.find((a) => a.id === adAccountId);
  const page = assets.pageTokens.get(pageId);
  if (!account || !page) throw new MetaGraphError("That ad account or Page wasn't shared with Replay", 404);
  return saveOwnSelection(academyId, account, page);
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
