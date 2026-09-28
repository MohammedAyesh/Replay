import { getAuth } from "@clerk/express";
import { parsePublishableKey, publishableKeyFromHost } from "@clerk/shared/keys";
import type { NextFunction, Request, Response } from "express";
import { getClerkProxyHost } from "../middlewares/clerkProxyMiddleware";
import { logger } from "./logger";

type DiagnosticLogger = Pick<typeof logger, "info" | "warn" | "error">;
type ClerkRequest = Request & { log?: DiagnosticLogger; res?: Response };
type ClerkKeyIdentity = {
  prefix: string | null;
  mode: "test" | "live" | null;
  frontendApiDomain: string | null;
};
type ClerkAuthOutcome = Record<string, unknown>;

const authMeOutcomes = new WeakMap<Request, ClerkAuthOutcome>();
const diagnosticsEnabled = process.env.CLERK_AUTH_DIAGNOSTICS !== "0";
const clerkAuthHeaderNames = [
  "x-clerk-auth-status",
  "x-clerk-auth-reason",
  "x-clerk-auth-message",
] as const;

function safeText(value: unknown, limit = 300): string | null {
  if (typeof value !== "string" || !value) return null;
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:pk|sk)_(?:test|live)_[A-Za-z0-9_+/=-]+\$?/gi, "[redacted-clerk-key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .slice(0, limit);
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return safeText(raw);
}

function sanitizeUrl(value: string | undefined, keepPath: boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return safeText(keepPath ? `${url.origin}${url.pathname}` : url.origin, 512);
  } catch {
    return safeText(value.split(/[?#]/, 1)[0], 512);
  }
}

function requestPath(req: Request): string {
  return safeText((req.originalUrl || req.url || "").split("?", 1)[0], 512) ?? "/";
}

export function isAuthMeRequest(req: Request): boolean {
  const path = requestPath(req).replace(/\/+$/, "");
  return path === "/auth/me" || path.endsWith("/api/auth/me");
}

export function decodeClerkKeyIdentity(key: string | undefined): ClerkKeyIdentity {
  if (!key) return { prefix: null, mode: null, frontendApiDomain: null };

  const prefixMatch = /^(pk|sk)_(test|live)_/.exec(key);
  if (!prefixMatch) return { prefix: null, mode: null, frontendApiDomain: null };

  let frontendApiDomain: string | null = null;
  if (prefixMatch[1] === "pk") {
    try {
      const parsed = parsePublishableKey(key);
      const domain = parsed?.frontendApi;
      if (domain && /^[a-z0-9.-]+$/i.test(domain)) frontendApiDomain = domain;
    } catch {
      // Invalid or unsupported key encoding is reported as an unknown domain.
    }
  }

  return {
    prefix: `${prefixMatch[1]}_${prefixMatch[2]}_`,
    mode: prefixMatch[2] as "test" | "live",
    frontendApiDomain,
  };
}

export function clerkKeyPairMatches(
  publishable: ClerkKeyIdentity,
  secret: ClerkKeyIdentity,
): boolean | null {
  if (!publishable.mode || !secret.mode) {
    return null;
  }
  return publishable.mode === secret.mode;
}

type CookieEntry = { name: string; value: string };

function parseCookies(req: Request): CookieEntry[] {
  return (req.headers.cookie ?? "")
    .split(";")
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return null;
      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
      };
    })
    .filter((entry): entry is CookieEntry => Boolean(entry?.name));
}

function isRelevantClerkCookie(name: string): boolean {
  return name === "__session"
    || name.startsWith("__session_")
    || name === "__client_uat"
    || name.startsWith("__client_uat_")
    || name === "__clerk_db_jwt"
    || name === "__clerk_handshake";
}

function getSessionToken(cookies: CookieEntry[]): string | null {
  const direct = cookies.find(({ name }) => name === "__session")?.value;
  if (direct) return direct;

  const chunks = cookies
    .map(({ name, value }) => {
      const match = /^__session_(\d+)$/.exec(name);
      return match ? { index: Number(match[1]), value } : null;
    })
    .filter((chunk): chunk is { index: number; value: string } => chunk !== null)
    .sort((a, b) => a.index - b.index);

  if (!chunks.length || chunks.some((chunk, index) => chunk.index !== index)) return null;
  return chunks.map(({ value }) => value).join("") || null;
}

type SessionClaimsDiagnostic = {
  tokenPresent: boolean;
  decodeStatus: "decoded" | "not_present" | "malformed";
  decodedWithoutVerification: true;
  iss: string | null;
  azp: string | null;
  sidPrefix: string | null;
  iat: number | null;
  exp: number | null;
  secondsUntilExpiry: number | null;
  serverNowUtc: string;
};

export function decodeSessionClaims(
  token: string | null,
  nowMs = Date.now(),
): SessionClaimsDiagnostic {
  const serverNowUtc = new Date(nowMs).toISOString();
  const empty: SessionClaimsDiagnostic = {
    tokenPresent: Boolean(token),
    decodeStatus: token ? "malformed" : "not_present",
    decodedWithoutVerification: true,
    iss: null,
    azp: null,
    sidPrefix: null,
    iat: null,
    exp: null,
    secondsUntilExpiry: null,
    serverNowUtc,
  };
  if (!token) return empty;

  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return empty;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const iat = typeof claims.iat === "number" && Number.isFinite(claims.iat) ? claims.iat : null;
    const exp = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null;
    const sid = typeof claims.sid === "string" ? claims.sid : null;
    return {
      tokenPresent: true,
      decodeStatus: "decoded",
      decodedWithoutVerification: true,
      iss: safeText(claims.iss, 512),
      azp: safeText(claims.azp, 512),
      sidPrefix: sid ? safeText(sid.slice(0, 8), 16) : null,
      iat,
      exp,
      secondsUntilExpiry: exp === null ? null : exp - Math.floor(nowMs / 1000),
      serverNowUtc,
    };
  } catch {
    return empty;
  }
}

function headerPair(req: Request, res: Response | undefined, name: string) {
  const requestValue = firstHeaderValue(req.headers[name] as string | string[] | undefined);
  const responseValue = safeText(res?.getHeader(name)?.toString(), 300);
  return { request: requestValue, response: responseValue };
}

function getAuthVerdict(req: Request) {
  try {
    return { userIdPresent: Boolean(getAuth(req)?.userId), readError: null };
  } catch (error) {
    return {
      userIdPresent: false,
      readError: error instanceof Error ? safeText(error.name, 80) : "UnknownError",
    };
  }
}

function getRequestAuthContext(req: Request, res?: Response) {
  const forwarded = req.headers["x-forwarded-host"];
  const forwardedRaw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const xForwardedHostLeftmost = forwardedRaw?.split(",")[0]?.trim() || null;
  const hostHeader = req.headers.host ?? null;
  const proxyHost = getClerkProxyHost(req) ?? null;
  let serverPublishableKey: string | undefined;
  try {
    serverPublishableKey = publishableKeyFromHost(proxyHost ?? "", process.env.CLERK_PUBLISHABLE_KEY);
  } catch {
    serverPublishableKey = undefined;
  }

  const publishableIdentity = decodeClerkKeyIdentity(serverPublishableKey);
  const secretIdentity = decodeClerkKeyIdentity(process.env.CLERK_SECRET_KEY);
  const cookies = parseCookies(req);
  const clerkCookieNames = [...new Set(cookies.map(({ name }) => name).filter(isRelevantClerkCookie))].sort();
  const sessionClaims = decodeSessionClaims(getSessionToken(cookies));
  const requestWithResponse = req as ClerkRequest;
  const response = res ?? requestWithResponse.res;
  const hostForEnvironment = safeText(proxyHost ?? hostHeader ?? "unknown", 255) ?? "unknown";
  const origin = firstHeaderValue(req.headers.origin);
  const referer = firstHeaderValue(req.headers.referer);

  return {
    environment: process.env.NODE_ENV === "production" ? "published" : "dev_preview",
    nodeEnv: process.env.NODE_ENV ?? null,
    host: safeText(hostHeader, 255),
    xForwardedHostLeftmost: safeText(xForwardedHostLeftmost, 255),
    origin: sanitizeUrl(origin ?? undefined, false),
    referer: sanitizeUrl(referer ?? undefined, true),
    clerkProxyHost: safeText(proxyHost, 255),
    environmentHost: hostForEnvironment,
    clerkKeys: {
      serverPublishablePrefix: publishableIdentity.prefix,
      serverPublishableFrontendApiDomain: publishableIdentity.frontendApiDomain,
      secretPrefix: secretIdentity.prefix,
      secretMode: secretIdentity.mode,
      pairingMatches: clerkKeyPairMatches(publishableIdentity, secretIdentity),
    },
    clerkCookieNames,
    sessionClaims,
    clerkVerdict: {
      ...getAuthVerdict(req),
      authStatus: headerPair(req, response, "x-clerk-auth-status"),
      authReason: headerPair(req, response, "x-clerk-auth-reason"),
      authMessage: headerPair(req, response, "x-clerk-auth-message"),
    },
    authorizationHeaderPresent: Boolean(
      typeof req.headers.authorization === "string" && req.headers.authorization.trim(),
    ),
  };
}

function emitClerkAuthDiagnostic(
  req: Request,
  res: Response | undefined,
  outcome: ClerkAuthOutcome,
  level: "info" | "warn" | "error",
): void {
  if (!diagnosticsEnabled) return;
  const context = getRequestAuthContext(req, res);
  const fields = {
    event: "clerk_auth_diagnostic",
    method: req.method,
    path: requestPath(req),
    ...context,
    outcome,
  };
  const requestLogger = (req as ClerkRequest).log ?? logger;
  const message = "Clerk auth diagnostic";
  if (level === "error") requestLogger.error(fields, message);
  else if (level === "warn") requestLogger.warn(fields, message);
  else requestLogger.info(fields, message);
}

export function recordClerkAuthOutcome(req: Request, outcome: ClerkAuthOutcome): void {
  authMeOutcomes.set(req, outcome);
}

export function observeClerkAuthMeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!diagnosticsEnabled || !isAuthMeRequest(req)) {
    next();
    return;
  }

  let emitted = false;
  const emit = (responseClosed: boolean) => {
    if (emitted) return;
    emitted = true;
    const recorded = authMeOutcomes.get(req);
    const statusCode = res.statusCode;
    const fallback: ClerkAuthOutcome = statusCode === 401
      ? { type: "unauthenticated", reason: "clerk_or_local_user_rejected" }
      : statusCode >= 500
        ? { type: "server_error", error: { name: "UnclassifiedServerError", code: null } }
        : { type: "http_response" };
    const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
    emitClerkAuthDiagnostic(req, res, {
      ...(recorded ?? fallback),
      statusCode,
      responseClosed,
    }, level);
  };

  res.once("finish", () => emit(false));
  res.once("close", () => {
    if (!res.writableFinished) emit(true);
  });
  next();
}

export function logRejectedLocalUserResolution(
  req: Request,
  reason: string,
  diagnostics: Record<string, unknown>,
): void {
  if (isAuthMeRequest(req)) return;
  emitClerkAuthDiagnostic(
    req,
    (req as ClerkRequest).res,
    { type: "local_user_resolution_rejected", reason, diagnostics },
    "warn",
  );
}

function findErrorCause(error: unknown): Record<string, unknown> | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string" && /^[A-Z0-9]{5}$/.test(record.code)) return record;
    current = record.cause;
  }
  return null;
}

function safeDatabaseMessage(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.message === "string") {
      const message = record.message;
      if (/^column "[a-zA-Z_][a-zA-Z0-9_]*" of relation "[a-zA-Z_][a-zA-Z0-9_]*" does not exist$/.test(message)) return message;
      if (/^relation "[a-zA-Z_][a-zA-Z0-9_]*" does not exist$/.test(message)) return message;
      if (/^duplicate key value violates unique constraint "[a-zA-Z0-9_]+"$/.test(message)) return message;
    }
    current = record.cause;
  }
  return null;
}

export function summarizeAuthError(error: unknown): Record<string, unknown> {
  const name = typeof error === "object" && error !== null && "name" in error
    ? safeText(String((error as { name: unknown }).name), 80)
    : "UnknownError";
  const pgError = findErrorCause(error);
  const code = pgError && typeof pgError.code === "string" ? pgError.code : null;
  return {
    name: name ?? "UnknownError",
    code,
    message: safeDatabaseMessage(error) ?? (code ? `postgres_${code}` : "unclassified_error"),
  };
}

export function recordAuthMeError(req: Request, error: unknown): void {
  recordClerkAuthOutcome(req, {
    type: "server_error",
    error: summarizeAuthError(error),
  });
}

function sanitizedProxyPath(req: Request): string {
  return requestPath(req).replace(/(\/v1\/client\/sessions\/)sess_[^/]+/i, "$1:sessionId");
}

export function logClerkProxyRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!diagnosticsEnabled || process.env.NODE_ENV !== "production") {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  let emitted = false;
  const emit = (responseClosed: boolean) => {
    if (emitted) return;
    emitted = true;
    const fields = {
      event: "clerk_proxy_request",
      environment: "published",
      host: safeText(req.headers.host, 255),
      xForwardedHostLeftmost: safeText(
        (Array.isArray(req.headers["x-forwarded-host"])
          ? req.headers["x-forwarded-host"]?.[0]
          : req.headers["x-forwarded-host"])?.split(",")[0]?.trim(),
        255,
      ),
      method: req.method,
      path: sanitizedProxyPath(req),
      upstreamStatus: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      responseClosed,
    };
    const requestLogger = (req as ClerkRequest).log ?? logger;
    requestLogger.info(fields, "Clerk proxy request completed");
  };

  res.once("finish", () => emit(false));
  res.once("close", () => {
    if (!res.writableFinished) emit(true);
  });
  next();
}