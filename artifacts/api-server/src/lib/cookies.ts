import crypto from "crypto";
import type { CookieOptions } from "express";
import { logger } from "./logger";

/**
 * Secret used to sign cookies (currently the guest identity cookie).
 *
 * Set COOKIE_SECRET in the environment so signatures survive restarts and are
 * valid across instances. Without it we fall back to a random per-process
 * secret: that is still safe — nobody can forge a signature — but every
 * restart invalidates outstanding guest cookies, so guests get logged out.
 * We deliberately fail closed (random) rather than open (unsigned).
 */
function resolveCookieSecret(): string {
  const fromEnv = process.env.COOKIE_SECRET?.trim();
  if (fromEnv) return fromEnv;

  logger.warn(
    "COOKIE_SECRET is not set — falling back to a random per-process secret. " +
      "Guest sessions will not survive a restart or span multiple instances. " +
      "Set COOKIE_SECRET to a long random string in production.",
  );
  return crypto.randomBytes(32).toString("hex");
}

export const COOKIE_SECRET: string = resolveCookieSecret();

/**
 * Options for the guest identity cookie.
 *
 * signed:   the value is a bare row id, so it must be tamper-proof.
 * httpOnly: not readable from page JavaScript.
 * sameSite: "lax" keeps it off cross-site subrequests (CSRF surface).
 * secure:   HTTPS-only in production; off in dev so localhost still works.
 */
export const GUEST_COOKIE_OPTIONS: CookieOptions = {
  signed: true,
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
};
