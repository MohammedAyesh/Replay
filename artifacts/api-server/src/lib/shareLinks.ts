import crypto from "crypto";

const SHARE_TOKEN_PREFIX = "clip-share:";

function shareSecret(): string {
  return process.env.CLIP_SHARE_URL_SECRET
    || process.env.SESSION_SECRET
    || process.env.CLIP_EXPORT_URL_SECRET
    || process.env.BUNNY_STORAGE_API_KEY
    || "";
}

export function createClipShareToken(clipId: number): string {
  return crypto
    .createHmac("sha256", shareSecret())
    .update(`${SHARE_TOKEN_PREFIX}${clipId}`)
    .digest("hex");
}

export function isValidClipShareToken(clipId: number, suppliedToken: string): boolean {
  const expected = Buffer.from(createClipShareToken(clipId), "utf8");
  const supplied = Buffer.from(suppliedToken, "utf8");
  if (expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(expected, supplied);
}

export function clipSharePath(clipId: number, token = createClipShareToken(clipId)): string {
  return `/share/clips/${clipId}/${token}`;
}

export function publicOrigin(req: { protocol: string; headers: Record<string, string | string[] | undefined> }): string {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const protocol = typeof forwardedProto === "string"
    ? forwardedProto.split(",")[0].trim()
    : req.protocol;
  const host = typeof forwardedHost === "string"
    ? forwardedHost.split(",")[0].trim()
    : typeof req.headers.host === "string"
      ? req.headers.host
      : "";
  const configuredOrigin = process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, "");
  return configuredOrigin || `${protocol}://${host}`;
}

export function absoluteClipShareUrl(
  req: { protocol: string; headers: Record<string, string | string[] | undefined> },
  clipId: number,
): string {
  return `${publicOrigin(req)}${clipSharePath(clipId)}`;
}