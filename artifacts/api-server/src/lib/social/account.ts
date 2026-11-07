import { createHash, createHmac } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { academySocialAccountsTable, db, type AcademySocialAccount } from "@workspace/db";
import { logger } from "../logger";
import { metaConfig } from "../meta/config";
import { decryptToken, encryptToken } from "../meta/crypto";
import { graphGet, graphPost, MetaGraphError } from "../meta/graph";

/**
 * An academy's Facebook Page and Instagram professional account, connected with
 * Facebook Login for Business or Instagram API with Unified Login.
 */

export function socialLoginConfigId(): string {
  return process.env.META_SOCIAL_LOGIN_CONFIG_ID?.trim() || "1112456661520835";
}

/** Page fields our app is subscribed to: DMs, replies sent from Meta's apps, buttons, comments, lead forms. */
export const PAGE_FIELDS = ["messages", "message_echoes", "messaging_postbacks", "feed", "leadgen"];

export async function getSocialAccount(academyId: number): Promise<AcademySocialAccount | null> {
  const [row] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, academyId));
  return row ?? null;
}

export async function accountByPage(pageId: string): Promise<AcademySocialAccount | null> {
  const [row] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.pageId, pageId));
  return row ?? null;
}

export async function accountByInstagram(igUserId: string): Promise<AcademySocialAccount | null> {
  const [row] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.igUserId, igUserId));
  return row ?? null;
}

export async function saveSocialAccount(academyId: number, patch: Partial<AcademySocialAccount>): Promise<AcademySocialAccount> {
  const now = new Date();
  await db.insert(academySocialAccountsTable).values({ academyId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: academySocialAccountsTable.academyId, set: { ...patch, updatedAt: now } });
  return (await getSocialAccount(academyId))!;
}

export function pageToken(account: AcademySocialAccount): string {
  const encrypted = account.pageTokenEnc ?? (!account.pageId ? account.tokenEnc : null);
  if (!encrypted) throw new MetaGraphError(account.pageId ? "Connect your Facebook Page first" : "Connect Instagram first", 409);
  return decryptToken(encrypted);
}

type PageRow = {
  id: string;
  name: string;
  access_token?: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
};

export type PageChoice = { id: string; name: string; instagram: { id: string; username: string | null } | null };

async function pagesFor(token: string): Promise<PageRow[]> {
  const res = await graphGet<{ data: PageRow[] }>("me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username,profile_picture_url}",
    limit: "100",
  }, { token });
  return res.data ?? [];
}

const choice = (p: PageRow): PageChoice => ({
  id: p.id,
  name: p.name,
  instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? null } : null,
});

/** Code from Login for Business → a business system user token; lists the Pages it was given. */
export async function connectWithCode(academyId: number, code: string, userId: number): Promise<{ account: AcademySocialAccount; pages: PageChoice[] }> {
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
  const pages = await pagesFor(token);
  let account = await saveSocialAccount(academyId, { tokenEnc: encryptToken(token), status: "pending", error: null, connectedBy: userId });
  if (pages.length === 1) account = await selectPage(academyId, pages[0].id);
  return { account, pages: pages.map(choice) };
}

export async function listPages(academyId: number): Promise<PageChoice[]> {
  const account = await getSocialAccount(academyId);
  if (!account?.tokenEnc) throw new MetaGraphError("Connect Facebook first", 409);
  return (await pagesFor(decryptToken(account.tokenEnc))).map(choice);
}

/** Subscribe our app to the Page's events. Lead forms need extra permissions, so retry without them. */
export async function subscribePage(pageId: string, token: string): Promise<boolean> {
  for (const fields of [PAGE_FIELDS, PAGE_FIELDS.filter((f) => f !== "leadgen")]) {
    try {
      await graphPost(`${pageId}/subscribed_apps`, { subscribed_fields: fields.join(",") }, { token });
      return true;
    } catch (error) {
      logger.warn({ pageId, fields, error: (error as Error).message }, "Subscribing a Page to the app failed");
    }
  }
  return false;
}

export async function selectPage(academyId: number, pageId: string): Promise<AcademySocialAccount> {
  const account = await getSocialAccount(academyId);
  if (!account?.tokenEnc) throw new MetaGraphError("Connect Facebook first", 409);
  const page = (await pagesFor(decryptToken(account.tokenEnc))).find((p) => p.id === pageId);
  if (!page?.access_token) throw new MetaGraphError("That Page wasn't shared with Replay. Connect again and tick it.", 404);
  const other = await accountByPage(page.id);
  if (other && other.academyId !== academyId) throw new MetaGraphError("That Page is already connected to another academy on Replay.", 409);
  const ig = page.instagram_business_account ?? null;
  const subscribed = await subscribePage(page.id, page.access_token);
  return saveSocialAccount(academyId, {
    pageId: page.id,
    pageName: page.name,
    pageTokenEnc: encryptToken(page.access_token),
    igUserId: ig?.id ?? null,
    igUsername: ig?.username ?? null,
    igPicture: ig?.profile_picture_url ?? null,
    subscribed,
    status: "connected",
    error: subscribed ? null : "Replay couldn't subscribe to this Page's messages. Connect again and allow every permission.",
    connectedAt: new Date(),
  });
}

export async function disconnectSocial(academyId: number): Promise<void> {
  // The Page stays subscribed (the ads lead forms may use it); Replay just forgets the tokens.
  await db.delete(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, academyId));
}

const RECONNECT_MESSAGE = "Reconnect Instagram. Meta authorization expired or the Instagram permissions changed. Connect again and allow every permission.";
const PERMISSION_RECONNECT_MESSAGE = "Reconnect Instagram. Replay doesn't have permission for this Instagram account yet. Connect again and allow every permission.";

type MetaFailure = {
  status: number | null;
  code: number | null;
  subcode: number | null;
  type: string | null;
  message: string | null;
  fbtrace_id: string | null;
};

type SocialHealthResult =
  | { kind: "healthy" }
  | { kind: "auth_error"; failure: MetaFailure }
  | { kind: "missing_permissions"; missingPermissions: string[] }
  | { kind: "inconclusive"; endpoint: string; failure?: MetaFailure };

type HealthCheckCacheEntry = {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<SocialHealthResult>;
};

const HEALTH_CHECK_CACHE_MS = 3 * 60_000;
const socialHealthCache = new Map<number, HealthCheckCacheEntry>();

function failureDetails(error: unknown): MetaFailure {
  const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const text = typeof e.message === "string" ? e.message : null;
  const safeMessage = text?.replace(/(access_token|appsecret_proof)=([^&\s]+)/gi, "$1=[REDACTED]") ?? null;
  return {
    status: typeof e.status === "number" ? e.status : null,
    code: typeof e.code === "number" ? e.code : null,
    subcode: typeof e.subcode === "number" ? e.subcode : null,
    type: typeof e.type === "string" ? e.type : null,
    message: safeMessage,
    fbtrace_id: typeof e.fbtraceId === "string" ? e.fbtraceId
      : typeof e.fbtrace_id === "string" ? e.fbtrace_id : null,
  };
}

function healthFingerprint(account: AcademySocialAccount): string {
  return createHash("sha256").update([
    account.tokenEnc ?? "",
    account.pageTokenEnc ?? "",
    account.pageId ?? "",
    account.igUserId ?? "",
  ].join("\0")).digest("hex");
}

function healthAuthFailure(error: unknown): boolean {
  // Meta's code 190 covers expired, revoked, password-changed, and app-removed tokens.
  return failureDetails(error).code === 190;
}

async function inspectSocialAccount(account: AcademySocialAccount): Promise<SocialHealthResult> {
  let resourceToken: string;
  let permissionsToken: string;
  try {
    resourceToken = pageToken(account);
    permissionsToken = account.tokenEnc ? decryptToken(account.tokenEnc) : resourceToken;
  } catch (error) {
    return { kind: "inconclusive", endpoint: "stored_token", failure: failureDetails(error) };
  }

  const permissionsRequest = graphGet<{ data?: Array<{ permission?: string; status?: string }> }>(
    "me/permissions", {}, { token: permissionsToken },
  );
  const pageRequest = account.pageId
    ? graphGet<{ id?: string; name?: string }>(account.pageId, { fields: "id,name" }, { token: resourceToken })
    : Promise.resolve(null);
  const instagramRequest = account.igUserId
    ? graphGet<{ id?: string; username?: string }>(account.igUserId, { fields: "id,username" }, { token: resourceToken })
    : Promise.resolve(null);

  const [permissionsResult, pageResult, instagramResult] = await Promise.allSettled([
    permissionsRequest,
    pageRequest,
    instagramRequest,
  ]);
  const rejected = [permissionsResult, pageResult, instagramResult]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const authError = rejected.find((result) => healthAuthFailure(result.reason));
  if (authError) return { kind: "auth_error", failure: failureDetails(authError.reason) };

  if (permissionsResult.status === "rejected") {
    return { kind: "inconclusive", endpoint: "me/permissions", failure: failureDetails(permissionsResult.reason) };
  }
  if (!Array.isArray(permissionsResult.value.data)) {
    return { kind: "inconclusive", endpoint: "me/permissions" };
  }

  const requiredPermissions = [
    ...(account.pageId ? ["pages_show_list", "pages_read_engagement"] : []),
    ...(account.igUserId ? ["instagram_basic", "instagram_content_publish"] : []),
  ];
  if (!requiredPermissions.length) return { kind: "inconclusive", endpoint: "account_identity" };
  const granted = new Set(permissionsResult.value.data
    .filter((permission) => permission.status === "granted")
    .map((permission) => permission.permission)
    .filter((permission): permission is string => Boolean(permission)));
  const missingPermissions = requiredPermissions.filter((permission) => !granted.has(permission));
  if (missingPermissions.length) return { kind: "missing_permissions", missingPermissions };

  if (account.pageId) {
    if (pageResult.status === "rejected") {
      return { kind: "inconclusive", endpoint: "page_identity", failure: failureDetails(pageResult.reason) };
    }
    if (!pageResult.value || pageResult.value.id !== account.pageId || typeof pageResult.value.name !== "string") {
      return { kind: "inconclusive", endpoint: "page_identity" };
    }
  }
  if (account.igUserId) {
    if (instagramResult.status === "rejected") {
      return { kind: "inconclusive", endpoint: "instagram_identity", failure: failureDetails(instagramResult.reason) };
    }
    if (!instagramResult.value || instagramResult.value.id !== account.igUserId) {
      return { kind: "inconclusive", endpoint: "instagram_identity" };
    }
  }
  return { kind: "healthy" };
}

async function socialAccountHealth(account: AcademySocialAccount): Promise<SocialHealthResult> {
  const fingerprint = healthFingerprint(account);
  const cached = socialHealthCache.get(account.academyId);
  if (cached?.fingerprint === fingerprint && cached.expiresAt > Date.now()) return cached.promise;

  const entry: HealthCheckCacheEntry = {
    fingerprint,
    expiresAt: Date.now() + HEALTH_CHECK_CACHE_MS,
    promise: Promise.resolve({ kind: "inconclusive", endpoint: "health_check" }),
  };
  entry.promise = inspectSocialAccount(account).catch((error) => ({
    kind: "inconclusive" as const,
    endpoint: "health_check",
    failure: failureDetails(error),
  }));
  socialHealthCache.set(account.academyId, entry);
  return entry.promise;
}

function cacheSocialHealth(account: AcademySocialAccount, result: SocialHealthResult): void {
  socialHealthCache.set(account.academyId, {
    fingerprint: healthFingerprint(account),
    expiresAt: Date.now() + HEALTH_CHECK_CACHE_MS,
    promise: Promise.resolve(result),
  });
}

function logReconnectRequired(
  account: AcademySocialAccount,
  trigger: string,
  reason: string,
  triggerFailure: MetaFailure,
  healthResult?: SocialHealthResult,
): void {
  logger.warn({
    academyId: account.academyId,
    trigger,
    reason,
    meta: triggerFailure,
    healthCheck: healthResult && healthResult.kind !== "healthy" ? healthResult : undefined,
  }, "Social account marked for reconnect");
}

async function markAccountBroken(
  account: AcademySocialAccount,
  trigger: string,
  reason: "token_auth_failure" | "missing_core_permissions",
  triggerFailure: MetaFailure,
  healthResult?: SocialHealthResult,
): Promise<boolean> {
  const current = await getSocialAccount(account.academyId);
  if (!current || healthFingerprint(current) !== healthFingerprint(account)) return false;
  const message = reason === "missing_core_permissions" ? PERMISSION_RECONNECT_MESSAGE : RECONNECT_MESSAGE;
  const [updated] = await db.update(academySocialAccountsTable)
    .set({ status: "error", error: message, updatedAt: new Date() })
    .where(eq(academySocialAccountsTable.academyId, current.academyId))
    .returning({ academyId: academySocialAccountsTable.academyId });
  if (!updated) return false;
  if (current.status !== "error" || current.error !== message) {
    logReconnectRequired(current, trigger, reason, triggerFailure, healthResult);
  }
  return true;
}

/**
 * Recheck a previously flagged account when an owner opens a social surface or an hourly
 * sync runs. A healthy token clears only the stale reconnect status; tokens are not changed.
 */
export async function refreshSocialAccountHealth(
  account: AcademySocialAccount | null,
  trigger: string,
): Promise<AcademySocialAccount | null> {
  if (!account || account.status !== "error") return account;
  const result = await socialAccountHealth(account);
  if (result.kind === "healthy") {
    const [restored] = await db.update(academySocialAccountsTable)
      .set({ status: "connected", error: null, updatedAt: new Date() })
      .where(and(
        eq(academySocialAccountsTable.academyId, account.academyId),
        eq(academySocialAccountsTable.status, "error"),
        account.tokenEnc === null
          ? isNull(academySocialAccountsTable.tokenEnc)
          : eq(academySocialAccountsTable.tokenEnc, account.tokenEnc),
        account.pageTokenEnc === null
          ? isNull(academySocialAccountsTable.pageTokenEnc)
          : eq(academySocialAccountsTable.pageTokenEnc, account.pageTokenEnc),
        account.pageId === null
          ? isNull(academySocialAccountsTable.pageId)
          : eq(academySocialAccountsTable.pageId, account.pageId),
        account.igUserId === null
          ? isNull(academySocialAccountsTable.igUserId)
          : eq(academySocialAccountsTable.igUserId, account.igUserId),
      ))
      .returning({ academyId: academySocialAccountsTable.academyId });
    if (restored) logger.info({ academyId: account.academyId, trigger }, "Healthy social account restored");
  } else if (result.kind !== "inconclusive") {
    logger.info({ academyId: account.academyId, trigger, healthCheck: result }, "Flagged social account health check failed");
  }
  return getSocialAccount(account.academyId);
}

/** Only a confirmed token rejection or missing core permission can flag the account. */
export async function markSocialReconnect(
  academyId: number,
  error: unknown,
  trigger: string,
  options: { optionalRead?: boolean } = {},
): Promise<boolean> {
  const account = await getSocialAccount(academyId);
  if (!account) return false;
  const triggerFailure = failureDetails(error);

  if (triggerFailure.code === 190) {
    const result: SocialHealthResult = { kind: "auth_error", failure: triggerFailure };
    cacheSocialHealth(account, result);
    return markAccountBroken(account, trigger, "token_auth_failure", triggerFailure, result);
  }

  // Optional metrics, profile and comment reads do not initiate permission-based disconnects.
  if (options.optionalRead) return false;

  const result = await socialAccountHealth(account);
  if (result.kind === "auth_error") {
    return markAccountBroken(account, trigger, "token_auth_failure", triggerFailure, result);
  }
  if (result.kind === "missing_permissions") {
    return markAccountBroken(account, trigger, "missing_core_permissions", triggerFailure, result);
  }
  return false;
}

// ─── Public media links Meta can fetch when publishing ──────────────────────

function mediaSecret(): string {
  return metaConfig().appSecret ?? process.env.SESSION_SECRET ?? "replay-dev-media";
}

export function mediaSignature(mediaId: number): string {
  return createHmac("sha256", mediaSecret()).update(`social-media:${mediaId}`).digest("hex").slice(0, 24);
}

export function publicMediaUrl(base: string, mediaId: number, kind: "image" | "video"): string {
  return `${base}/api/social/media/${mediaId}/${mediaSignature(mediaId)}.${kind === "video" ? "mp4" : "jpg"}`;
}
