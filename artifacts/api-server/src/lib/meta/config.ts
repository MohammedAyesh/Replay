import { createHmac } from "node:crypto";

/**
 * Replay's Meta (Facebook/Instagram) ads connection. Three secrets in the app's
 * environment; the webhook verify token is derived from the app secret so there
 * is nothing else to keep in step.
 *   META_ACCESS_TOKEN   system-user token (never expires) with ads_read, leads_retrieval,
 *                       pages_show_list, pages_read_engagement, pages_manage_metadata, pages_manage_ads
 *   META_AD_ACCOUNT_ID  the ad account the academies' campaigns run in (act_… or digits)
 *   META_APP_SECRET     the Meta app's secret: signs webhooks and appsecret_proof
 */
export type MetaConfig = {
  token: string | null;
  adAccountId: string | null;
  appSecret: string | null;
  graphVersion: string;
  /** Not secret: Replay's Meta app, its business portfolio, and the Login for Business configuration. */
  appId: string;
  businessId: string;
  loginConfigId: string | null;
  instagramLoginConfigId: string;
};

export function metaConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig {
  const account = env.META_AD_ACCOUNT_ID?.trim() || null;
  return {
    token: env.META_ACCESS_TOKEN?.trim() || null,
    adAccountId: account ? (account.startsWith("act_") ? account : `act_${account.replace(/\D/g, "")}`) : null,
    appSecret: env.META_APP_SECRET?.trim() || null,
    graphVersion: env.META_GRAPH_VERSION?.trim() || "v26.0",
    appId: env.META_APP_ID?.trim() || "1401484938413305",
    businessId: env.META_BUSINESS_ID?.trim() || "3918266301637396",
    loginConfigId: env.META_LOGIN_CONFIG_ID?.trim() || "1127305789840487",
    instagramLoginConfigId: env.META_IG_LOGIN_CONFIG_ID?.trim() || "1126113460026170",
  };
}

export function metaAdsConfigured(config = metaConfig()): boolean {
  return Boolean(config.token && config.adAccountId);
}

/** What Meta's webhook setup page asks for as the "Verify token". */
export function metaWebhookVerifyToken(config = metaConfig()): string | null {
  if (process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()) return process.env.META_WEBHOOK_VERIFY_TOKEN.trim();
  if (!config.appSecret) return null;
  return createHmac("sha256", config.appSecret).update("replay-meta-webhook-v1").digest("hex").slice(0, 32);
}

/** Meta signs webhook bodies as "sha256=<hex hmac of the raw body with the app secret>". */
export function metaSignatureValid(raw: Buffer, header: string | undefined, appSecret: string | null): boolean {
  if (!appSecret || !header) return false;
  const [scheme, value] = header.trim().split("=", 2);
  if (scheme !== "sha256" || !value) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  if (expected.length !== value.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ value.toLowerCase().charCodeAt(i);
  return diff === 0;
}

/** Per-academy Meta tokens are stored encrypted with a key derived from the app secret. */
export function tokenKey(appSecret: string): Buffer {
  return createHmac("sha256", appSecret).update("replay-meta-token-v1").digest();
}
