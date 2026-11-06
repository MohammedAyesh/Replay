import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
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

/** Meta auth/permission failures must stop scheduled retries until the owner reconnects. */
export async function markSocialReconnect(academyId: number, error: unknown): Promise<boolean> {
  const e = error as { code?: number; status?: number; message?: string };
  if (!(e?.code === 190 || e?.code === 10 || e?.code === 200 || e?.status === 401 || e?.status === 403)) return false;
  const [updated] = await db.update(academySocialAccountsTable)
    .set({
      status: "error",
      error: e.code === 10 || e.code === 200 ? PERMISSION_RECONNECT_MESSAGE : RECONNECT_MESSAGE,
      updatedAt: new Date(),
    })
    .where(eq(academySocialAccountsTable.academyId, academyId))
    .returning({ academyId: academySocialAccountsTable.academyId });
  return Boolean(updated);
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
