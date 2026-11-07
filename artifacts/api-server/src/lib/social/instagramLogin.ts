import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { academyMembersTable, academySocialAccountsTable, db } from "@workspace/db";
import { metaConfig } from "../meta/config";
import { encryptToken } from "../meta/crypto";
import { graphGetWithStatus, MetaGraphError } from "../meta/graph";
import { logger } from "../logger";
import { getSocialAccount, saveSocialAccount } from "./account";

const STATE_KEY = "__replayInstagramLogin";
export const INSTAGRAM_ASSETS_PENDING = "instagram_assets_pending";
const STATE_TTL_MS = 10 * 60_000;

async function assertNoFacebookPage(academyId: number): Promise<void> {
  const existing = await getSocialAccount(academyId);
  if (existing?.pageId) {
    throw new MetaGraphError("A Facebook Page is already connected to this academy. Continue using its existing Facebook connection.", 409);
  }
}

export type InstagramAsset = { id: string; username: string | null; profilePictureUrl: string | null };
type InstagramLoginState = { v: 1; academyId: number; userId: number; issuedAt: number; expiresAt: number; nonce: string };
type InstagramAssetLookup = "assigned_instagram_accounts" | "owned_instagram_accounts" | "instagram_accounts" | "client_instagram_accounts";
type InstagramAssetLookupResult = {
  accounts: InstagramAsset[];
  lookup: InstagramAssetLookup | null;
  errorRef: string | null;
};

type RawInstagramAsset = {
  id?: unknown;
  username?: unknown;
  profile_picture_url?: unknown;
};

function stateSecret(): string {
  const secret = metaConfig().appSecret;
  if (!secret) throw new MetaGraphError("Meta is not set up on the server (META_APP_SECRET)", 503);
  return secret;
}

function encodeState(payload: InstagramLoginState): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `replay-instagram-login-v1.${body}`;
  return `${body}.${createHmac("sha256", stateSecret()).update(signed).digest("base64url")}`;
}

function decodeStatePayload(state: string): InstagramLoginState | null {
  const [body] = state.split(".");
  if (!body) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<InstagramLoginState>;
    if (payload.v !== 1 || !Number.isSafeInteger(payload.academyId) || !Number.isSafeInteger(payload.userId)
      || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
      || typeof payload.nonce !== "string") return null;
    return payload as InstagramLoginState;
  } catch {
    return null;
  }
}

/** Untrusted academy hint for routing the callback; signature and identity are verified separately. */
export function instagramLoginAcademyHint(state: string): number | null {
  const payload = decodeStatePayload(state);
  return payload?.academyId ?? null;
}

export function instagramCallbackUrl(): string {
  return "https://replayjo.com/connect/instagram/callback";
}

export async function createInstagramLoginUrl(academyId: number, userId: number): Promise<string> {
  await assertNoFacebookPage(academyId);
  const config = metaConfig();
  const issuedAt = Date.now();
  const state = encodeState({
    v: 1, academyId, userId, issuedAt, expiresAt: issuedAt + STATE_TTL_MS,
    nonce: randomBytes(24).toString("base64url"),
  });
  const digest = createHash("sha256").update(state).digest("hex");
  await db.insert(academySocialAccountsTable).values({
    academyId,
    status: "pending",
    insights: { [STATE_KEY]: { digest, expiresAt: issuedAt + STATE_TTL_MS } },
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: academySocialAccountsTable.academyId,
    set: {
      insights: sql`coalesce(${academySocialAccountsTable.insights}, '{}'::jsonb) || ${JSON.stringify({
        [STATE_KEY]: { digest, expiresAt: issuedAt + STATE_TTL_MS },
      })}::jsonb`,
      updatedAt: new Date(),
    },
  });

  const url = new URL("https://www.facebook.com/dialog/oauth");
  url.search = new URLSearchParams({
    client_id: config.appId,
    config_id: config.instagramLoginConfigId,
    redirect_uri: instagramCallbackUrl(),
    response_type: "code",
    display: "popup",
    prompt: "login",
    state,
  }).toString();
  return url.toString();
}

export async function verifyAndConsumeInstagramLoginState(state: string, academyId: number, userId: number): Promise<void> {
  const [body, signature, extra] = state.split(".");
  if (!body || !signature || extra) throw new MetaGraphError("Instagram sign-in state is invalid or expired. Start again.", 400);
  const expected = createHmac("sha256", stateSecret()).update(`replay-instagram-login-v1.${body}`).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    throw new MetaGraphError("Instagram sign-in state is invalid or expired. Start again.", 400);
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new MetaGraphError("Instagram sign-in state is invalid or expired. Start again.", 400);
  }
  const payload = decodeStatePayload(state);
  const now = Date.now();
  if (!payload || payload.academyId !== academyId || payload.userId !== userId
    || payload.expiresAt < now || payload.issuedAt > now + 30_000 || payload.expiresAt - payload.issuedAt !== STATE_TTL_MS) {
    throw new MetaGraphError("Instagram sign-in state is invalid or expired. Start again.", 400);
  }
  const digest = createHash("sha256").update(state).digest("hex");
  const consumed = await db.update(academySocialAccountsTable).set({
    insights: sql`coalesce(${academySocialAccountsTable.insights}, '{}'::jsonb) - ${STATE_KEY}`,
    updatedAt: new Date(),
  }).where(and(
    eq(academySocialAccountsTable.academyId, academyId),
    sql`(${academySocialAccountsTable.insights} -> ${STATE_KEY} ->> 'digest') = ${digest}`,
    sql`coalesce((${academySocialAccountsTable.insights} -> ${STATE_KEY} ->> 'expiresAt')::bigint, 0) >= ${now}`,
  )).returning({ academyId: academySocialAccountsTable.academyId });
  if (!consumed.length) throw new MetaGraphError("Instagram sign-in state was already used or expired. Start again.", 400);
}

function metaLookupFailure(error: unknown): {
  httpStatus: number | null;
  metaErrorCode: number | null;
  metaErrorSubcode: number | null;
  metaErrorMessage: string | null;
  reasonCode: string;
} {
  if (error instanceof MetaGraphError) {
    return {
      httpStatus: error.status,
      metaErrorCode: error.code ?? null,
      metaErrorSubcode: error.subcode ?? null,
      metaErrorMessage: error.message,
      reasonCode: String(error.code ?? error.status),
    };
  }
  const code = (error as { code?: unknown } | null)?.code;
  const reasonCode = typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : "network";
  return {
    httpStatus: null,
    metaErrorCode: null,
    metaErrorSubcode: null,
    metaErrorMessage: null,
    reasonCode,
  };
}

function normalizeInstagramAssets(raw: unknown): { accounts: InstagramAsset[]; count: number } {
  const rows = Array.isArray(raw) ? raw as RawInstagramAsset[] : [];
  const seen = new Set<string>();
  const accounts: InstagramAsset[] = [];
  for (const row of rows) {
    if (typeof row?.id !== "string" || !/^\d{5,30}$/.test(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    accounts.push({
      id: row.id,
      username: typeof row.username === "string" ? row.username : null,
      profilePictureUrl: typeof row.profile_picture_url === "string" ? row.profile_picture_url : null,
    });
  }
  return { accounts, count: rows.length };
}

function logInstagramAssetLookup(input: {
  lookup: string;
  clientBusinessId: string | null;
  httpStatus: number | null;
  metaErrorCode?: number | null;
  metaErrorSubcode?: number | null;
  metaErrorMessage?: string | null;
  accountsReturned: number;
  validAccounts: number;
}): void {
  logger.info({
    lookup: input.lookup,
    httpStatus: input.httpStatus,
    metaErrorCode: input.metaErrorCode ?? null,
    metaErrorSubcode: input.metaErrorSubcode ?? null,
    metaErrorMessage: input.metaErrorMessage ?? null,
    accountsReturned: input.accountsReturned,
    validAccounts: input.validAccounts,
    clientBusinessId: input.clientBusinessId,
  }, "Instagram account lookup");
}

async function lookupInstagramAssets(
  lookup: InstagramAssetLookup,
  path: string,
  token: string,
  clientBusinessId: string | null,
): Promise<{ accounts: InstagramAsset[]; errorRef: string | null }> {
  try {
    const response = await graphGetWithStatus<{ data?: unknown }>(
      path,
      { fields: "id,username,profile_picture_url", limit: "100" },
      { token },
    );
    const normalized = normalizeInstagramAssets(response.data.data);
    logInstagramAssetLookup({
      lookup,
      clientBusinessId,
      httpStatus: response.status,
      accountsReturned: normalized.count,
      validAccounts: normalized.accounts.length,
    });
    return { accounts: normalized.accounts, errorRef: null };
  } catch (error) {
    const failure = metaLookupFailure(error);
    logInstagramAssetLookup({
      lookup,
      clientBusinessId,
      httpStatus: failure.httpStatus,
      metaErrorCode: failure.metaErrorCode,
      metaErrorSubcode: failure.metaErrorSubcode,
      metaErrorMessage: failure.metaErrorMessage,
      accountsReturned: 0,
      validAccounts: 0,
    });
    return { accounts: [], errorRef: failure.reasonCode };
  }
}

async function assignedInstagramAssets(token: string): Promise<InstagramAssetLookupResult> {
  let clientBusinessId: string | null = null;
  let firstErrorRef: string | null = null;

  try {
    const response = await graphGetWithStatus<{ client_business_id?: unknown }>(
      "me",
      { fields: "client_business_id" },
      { token },
    );
    clientBusinessId = typeof response.data.client_business_id === "string"
      ? response.data.client_business_id.trim() || null
      : null;
    logInstagramAssetLookup({
      lookup: "client_business_id",
      clientBusinessId,
      httpStatus: response.status,
      accountsReturned: 0,
      validAccounts: 0,
    });
  } catch (error) {
    const failure = metaLookupFailure(error);
    firstErrorRef = failure.reasonCode;
    logInstagramAssetLookup({
      lookup: "client_business_id",
      clientBusinessId,
      httpStatus: failure.httpStatus,
      metaErrorCode: failure.metaErrorCode,
      metaErrorSubcode: failure.metaErrorSubcode,
      metaErrorMessage: failure.metaErrorMessage,
      accountsReturned: 0,
      validAccounts: 0,
    });
  }

  const primary = await lookupInstagramAssets("assigned_instagram_accounts", "me/assigned_instagram_accounts", token, clientBusinessId);
  if (primary.accounts.length) return { ...primary, lookup: "assigned_instagram_accounts" };
  firstErrorRef ??= primary.errorRef;

  if (clientBusinessId) {
    const businessId = encodeURIComponent(clientBusinessId);
    const fallbacks: Array<{ lookup: InstagramAssetLookup; path: string }> = [
      { lookup: "owned_instagram_accounts", path: `${businessId}/owned_instagram_accounts` },
      { lookup: "instagram_accounts", path: `${businessId}/instagram_accounts` },
      { lookup: "client_instagram_accounts", path: `${businessId}/client_instagram_accounts` },
    ];
    for (const fallback of fallbacks) {
      const result = await lookupInstagramAssets(fallback.lookup, fallback.path, token, clientBusinessId);
      if (result.accounts.length) return { ...result, lookup: fallback.lookup };
      firstErrorRef ??= result.errorRef;
    }
  }
  return { accounts: [], lookup: null, errorRef: firstErrorRef };
}

async function exchangeCode(code: string): Promise<string> {
  const config = metaConfig();
  if (!config.appSecret) throw new MetaGraphError("Meta is not set up on the server (META_APP_SECRET)", 503);
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: instagramCallbackUrl(),
    code,
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    error?: { message?: string; code?: number };
  } | null;
  if (!response.ok || !body?.access_token) {
    throw new MetaGraphError(body?.error?.message ?? "Meta refused the Instagram sign-in", response.status || 400, body?.error?.code);
  }
  return body.access_token;
}

async function saveInstagramOnly(
  academyId: number,
  userId: number,
  token: string,
  asset: InstagramAsset,
  lookup: InstagramAssetLookup,
) {
  await assertNoFacebookPage(academyId);
  const now = new Date();
  const patch = {
    tokenEnc: encryptToken(token),
    pageId: null,
    pageName: null,
    pageTokenEnc: null,
    igUserId: asset.id,
    igUsername: asset.username,
    igPicture: asset.profilePictureUrl,
    subscribed: false,
    insights: null,
    insightsAt: null,
    postsSyncedAt: null,
    status: "connected",
    error: null,
    connectedAt: now,
    connectedBy: userId,
  } as const;
  return db.transaction(async (tx) => {
    const [target] = await tx.select({ pageId: academySocialAccountsTable.pageId })
      .from(academySocialAccountsTable)
      .where(eq(academySocialAccountsTable.academyId, academyId))
      .limit(1);
    if (target?.pageId) {
      throw new MetaGraphError("A Facebook Page is already connected to this academy. Continue using its existing Facebook connection.", 409);
    }

    const [other] = await tx.select().from(academySocialAccountsTable)
      .where(eq(academySocialAccountsTable.igUserId, asset.id))
      .limit(1)
      .for("update");
    if (other && other.academyId !== academyId) {
      const [sourceOwner] = await tx.select({ userId: academyMembersTable.userId })
        .from(academyMembersTable)
        .where(and(
          eq(academyMembersTable.academyId, other.academyId),
          eq(academyMembersTable.userId, userId),
          eq(academyMembersTable.role, "owner"),
        ))
        .limit(1);
      if (!sourceOwner) {
        logger.info({
          lookup,
          instagramId: asset.id,
          academyId,
          alreadyConnectedAcademyId: other.academyId,
          transferAllowed: false,
        }, "Instagram account transfer denied because the user does not own the current academy");
        throw new MetaGraphError("Only an owner of the academy currently connected to this Instagram account can transfer it.", 403);
      }

      if (other.pageId) {
        await tx.update(academySocialAccountsTable).set({
          igUserId: null,
          igUsername: null,
          igPicture: null,
          updatedAt: now,
        }).where(and(
          eq(academySocialAccountsTable.academyId, other.academyId),
          eq(academySocialAccountsTable.igUserId, asset.id),
        ));
      } else {
        await tx.delete(academySocialAccountsTable).where(and(
          eq(academySocialAccountsTable.academyId, other.academyId),
          eq(academySocialAccountsTable.igUserId, asset.id),
        ));
      }
      logger.info({
        lookup,
        instagramId: asset.id,
        fromAcademyId: other.academyId,
        toAcademyId: academyId,
        retainedFacebookPage: Boolean(other.pageId),
      }, "Instagram account transferred between academies");
    }

    await tx.insert(academySocialAccountsTable).values({ academyId, ...patch, updatedAt: now })
      .onConflictDoUpdate({
        target: academySocialAccountsTable.academyId,
        set: { ...patch, updatedAt: now },
      });
    const [saved] = await tx.select().from(academySocialAccountsTable)
      .where(eq(academySocialAccountsTable.academyId, academyId))
      .limit(1);
    if (!saved) throw new MetaGraphError("Instagram connection could not be saved.", 500);
    return saved;
  });
}

export async function finishInstagramLogin(input: {
  academyId: number;
  userId: number;
  state: string;
  code?: string;
  oauthError?: string;
  errorDescription?: string;
}): Promise<{ status: "connected" | "pending"; igUsername?: string | null; accounts?: InstagramAsset[]; academyId: number }> {
  await verifyAndConsumeInstagramLoginState(input.state, input.academyId, input.userId);
  if (input.oauthError) {
    throw new MetaGraphError(input.errorDescription?.slice(0, 300) || "Instagram sign-in was cancelled.", 400);
  }
  await assertNoFacebookPage(input.academyId);
  const code = input.code?.trim() ?? "";
  if (!code || code.length > 4096) throw new MetaGraphError("Meta didn't return a sign-in code. Start again.", 400);
  const token = await exchangeCode(code);
  const result = await assignedInstagramAssets(token);
  const accounts = result.accounts;
  if (accounts.length === 0) {
    const ref = result.errorRef ? `lookup_error_${result.errorRef}` : "no_ig_assets";
    throw new MetaGraphError(`Pick your Instagram account when Meta asks, then try again. (Ref: ${ref})`, 400);
  }
  if (accounts.length === 1) {
    const account = await saveInstagramOnly(input.academyId, input.userId, token, accounts[0], result.lookup!);
    return { status: "connected", igUsername: account.igUsername, academyId: input.academyId };
  }
  await saveSocialAccount(input.academyId, {
    tokenEnc: encryptToken(token),
    pageId: null,
    pageName: null,
    pageTokenEnc: null,
    igUserId: null,
    igUsername: null,
    igPicture: null,
    subscribed: false,
    insights: null,
    insightsAt: null,
    postsSyncedAt: null,
    status: "pending",
    error: INSTAGRAM_ASSETS_PENDING,
    connectedAt: null,
    connectedBy: input.userId,
  });
  return { status: "pending", accounts, academyId: input.academyId };
}

export async function listPendingInstagramAssets(academyId: number): Promise<InstagramAsset[]> {
  const account = await getSocialAccount(academyId);
  if (!account?.tokenEnc || account.status !== "pending" || account.error !== INSTAGRAM_ASSETS_PENDING) return [];
  return (await assignedInstagramAssets((await import("../meta/crypto")).decryptToken(account.tokenEnc))).accounts;
}

export async function selectInstagramAsset(academyId: number, userId: number, instagramId: string) {
  if (!/^\d{5,30}$/.test(instagramId)) throw new MetaGraphError("Pick your Instagram account.", 400);
  const account = await getSocialAccount(academyId);
  if (!account?.tokenEnc || account.status !== "pending" || account.error !== INSTAGRAM_ASSETS_PENDING) {
    throw new MetaGraphError("Start the Instagram connection again.", 409);
  }
  const token = (await import("../meta/crypto")).decryptToken(account.tokenEnc);
  const result = await assignedInstagramAssets(token);
  const asset = result.accounts.find((a) => a.id === instagramId);
  if (!asset) throw new MetaGraphError("That Instagram account wasn't selected in Meta. Connect again and choose it.", 404);
  return saveInstagramOnly(academyId, userId, token, asset, result.lookup!);
}
