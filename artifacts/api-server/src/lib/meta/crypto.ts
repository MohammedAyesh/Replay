import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { metaConfig, tokenKey } from "./config";

/** AES-256-GCM, "v1.<iv>.<tag>.<ciphertext>" in base64url. */
export function encryptToken(plain: string, appSecret = metaConfig().appSecret): string {
  if (!appSecret) throw new Error("META_APP_SECRET is not set");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(appSecret), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptToken(stored: string, appSecret = metaConfig().appSecret): string {
  if (!appSecret) throw new Error("META_APP_SECRET is not set");
  const [v, iv, tag, body] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable stored token");
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(appSecret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
