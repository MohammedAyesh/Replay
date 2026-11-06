import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { academySocialAccountsTable, db } from "@workspace/db";
import { metaConfig } from "../meta/config";
import { encryptToken } from "../meta/crypto";
import { graphGet, MetaGraphError } from "../meta/graph";
import { accountByInstagram, getSocialAccount, saveSocialAccount } from "./account";

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

async function assignedInstagramAssets(token: string): Promise<InstagramAsset[]> {
  // Meta requires this business integration edge; do not substitute Page accounts or /me.
  await graphGet<{ client_business_id?: string }>("me", { fields: "client_business_id" }, { token });
  const result = await graphGet<{ data?: Array<{ id: string; username?: string; profile_picture_url?: string }> }>(
    "me/assigned_instagram_accounts",
    { fields: "id,username,profile_picture_url", limit: "100" },
    { token },
  );
  return (result.data ?? []).filter((a) => /^\d{5,30}$/.test(a.id)).map((a) => ({
    id: a.id,
    username: a.username ?? null,
    profilePictureUrl: a.profile_picture_url ?? null,
  }));
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

async function saveInstagramOnly(academyId: number, userId: number, token: string, asset: InstagramAsset) {
  await assertNoFacebookPage(academyId);
  const other = await accountByInstagram(asset.id);
  if (other && other.academyId !== academyId) {
    throw new MetaGraphError("That Instagram account is already connected to another academy on Replay.", 409);
  }
  return saveSocialAccount(academyId, {
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
    connectedAt: new Date(),
    connectedBy: userId,
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
  const accounts = await assignedInstagramAssets(token);
  if (accounts.length === 0) throw new MetaGraphError("Pick your Instagram account when Meta asks, then try again.", 400);
  if (accounts.length === 1) {
    const account = await saveInstagramOnly(input.academyId, input.userId, token, accounts[0]);
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
  return assignedInstagramAssets((await import("../meta/crypto")).decryptToken(account.tokenEnc));
}

export async function selectInstagramAsset(academyId: number, userId: number, instagramId: string) {
  if (!/^\d{5,30}$/.test(instagramId)) throw new MetaGraphError("Pick your Instagram account.", 400);
  const account = await getSocialAccount(academyId);
  if (!account?.tokenEnc || account.status !== "pending" || account.error !== INSTAGRAM_ASSETS_PENDING) {
    throw new MetaGraphError("Start the Instagram connection again.", 409);
  }
  const token = (await import("../meta/crypto")).decryptToken(account.tokenEnc);
  const asset = (await assignedInstagramAssets(token)).find((a) => a.id === instagramId);
  if (!asset) throw new MetaGraphError("That Instagram account wasn't selected in Meta. Connect again and choose it.", 404);
  return saveInstagramOnly(academyId, userId, token, asset);
}
