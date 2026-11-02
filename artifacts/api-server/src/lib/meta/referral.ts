/**
 * Click-to-WhatsApp ads: when someone taps the ad, WhatsApp attaches the ad's
 * referral (ad id, headline, click id "ctwa_clid") to their first message only.
 * WAHA passes the engine's raw message through as `_data`, whose shape differs
 * by engine (GOWS: protobuf ContextInfo.ExternalAdReply in PascalCase or
 * camelCase; WEBJS: ctwaContext), so look for it by field names, anywhere.
 */
export type AdReferral = {
  adId: string | null;
  ctwaClid: string | null;
  headline: string | null;
  body: string | null;
  sourceUrl: string | null;
};

const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function fromObject(obj: Record<string, unknown>): AdReferral | null {
  const fields = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) fields.set(key(k), v);
  const ctwaClid = str(fields.get("ctwaclid"));
  const sourceType = str(fields.get("sourcetype"))?.toLowerCase() ?? null;
  const sourceId = str(fields.get("sourceid"));
  // A link preview also uses ExternalAdReply; only a click id or an explicit "ad" source is an ad.
  if (ctwaClid === null && sourceType !== "ad") return null;
  return {
    adId: sourceType === null || sourceType === "ad" ? sourceId : null,
    ctwaClid,
    headline: str(fields.get("title")) ?? str(fields.get("headline")),
    body: str(fields.get("body")) ?? str(fields.get("description")),
    sourceUrl: str(fields.get("sourceurl")),
  };
}

export function findAdReferral(payload: unknown, depth = 0): AdReferral | null {
  if (!payload || typeof payload !== "object" || depth > 12) return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findAdReferral(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const here = fromObject(obj);
  if (here) return here;
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = findAdReferral(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
