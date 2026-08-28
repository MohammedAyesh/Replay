import { getAuth, createClerkClient } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type { Request } from "express";
import { logger } from "./logger";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export type UserResolutionReason =
  | "resolved_clerk"
  | "resolved_guest"
  | "no_credentials"
  | "clerk_session_unresolved"
  | "guest_session_invalid"
  | "local_user_provisioning_failed"
  | "local_user_disabled"
  | "guest_account_not_allowed";

export type UserResolutionDiagnostics = {
  clerkCredentialPresent: boolean;
  clerkSessionCookiePresent: boolean;
  authorizationHeaderPresent: boolean;
  guestCookiePresent: boolean;
  clerkUserIdPresent: boolean;
  localRowStatus: "not_checked" | "found" | "created" | "not_found";
  resolvedLocalUserId: number | null;
  disabledRowRejected: boolean;
  guestRowRejected: boolean;
  splitAccount: boolean;
  emailMatchLocalUserId: number | null;
};

export type UserResolution = {
  user: typeof usersTable.$inferSelect | null;
  reason: UserResolutionReason;
  diagnostics: UserResolutionDiagnostics;
};

const resolutionByRequest = new WeakMap<Request, UserResolution>();

function isSyntheticEmail(email: string): boolean {
  return email.startsWith("clerk_") || email.startsWith("guest_") || email.endsWith("@soccerwatch.local");
}

function getCookieNames(req: Request): Set<string> {
  return new Set(
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("=")[0])
      .filter(Boolean),
  );
}

function getRequestDiagnostics(req: Request): UserResolutionDiagnostics {
  const cookieNames = getCookieNames(req);
  const clerkSessionCookiePresent = [
    "__session",
    "__client_uat",
    "__clerk_db_jwt",
    "__clerk_handshake",
  ].some((name) => cookieNames.has(name));
  const authorizationHeaderPresent = typeof req.headers.authorization === "string"
    && req.headers.authorization.trim() !== "";

  return {
    clerkCredentialPresent: clerkSessionCookiePresent || authorizationHeaderPresent,
    clerkSessionCookiePresent,
    authorizationHeaderPresent,
    guestCookiePresent: cookieNames.has("guestId"),
    clerkUserIdPresent: false,
    localRowStatus: "not_checked",
    resolvedLocalUserId: null,
    disabledRowRejected: false,
    guestRowRejected: false,
    splitAccount: false,
    emailMatchLocalUserId: null,
  };
}

function extractClerkEmail(clerkUser: Awaited<ReturnType<typeof clerkClient.users.getUser>> | null): string | null {
  if (!clerkUser) return null;
  const emails = clerkUser.emailAddresses ?? [];
  const primary = emails.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress;
  const verified = emails.find((e) => e.verification?.status === "verified")?.emailAddress;
  const anyEmail = emails[0]?.emailAddress;
  return primary ?? verified ?? anyEmail ?? null;
}

type LocalUserProvisionResult = {
  id: number | null;
  localRowStatus: "found" | "created" | "not_found";
  splitAccount: boolean;
  emailMatchLocalUserId: number | null;
};

async function getOrCreateLocalUserByClerkId(clerkId: string): Promise<LocalUserProvisionResult> {
  // Fetch Clerk user first — we need it whether the user is new or existing.
  let clerkUser: Awaited<ReturnType<typeof clerkClient.users.getUser>> | null = null;
  try {
    clerkUser = await clerkClient.users.getUser(clerkId);
  } catch {
    // If Clerk is unreachable, fall back to synthetic values below.
  }

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));

  if (existing) {
    // Sync name and email from Clerk if the local record is stale.
    const freshEmail = extractClerkEmail(clerkUser);
    const firstName = clerkUser?.firstName?.trim() ?? "";
    const lastName = clerkUser?.lastName?.trim() ?? "";
    const freshName = [firstName, lastName].filter(Boolean).join(" ") || undefined;

    const needsNameUpdate = freshName && freshName !== existing.name;
    const needsEmailUpdate = freshEmail && (isSyntheticEmail(existing.email) || freshEmail !== existing.email);

    if (needsNameUpdate || needsEmailUpdate) {
      try {
        await db
          .update(usersTable)
          .set({
            ...(needsNameUpdate ? { name: freshName } : {}),
            ...(needsEmailUpdate ? { email: freshEmail } : {}),
          })
          .where(eq(usersTable.id, existing.id));
      } catch (err) {
        // users.email is unique: if the fresh address already belongs to another
        // row, keeping the stale one is strictly better than failing the request.
        logger.warn({ err, userId: existing.id }, "Could not sync user profile from Clerk");
      }
    }

    return {
      id: existing.id,
      localRowStatus: "found",
      splitAccount: false,
      emailMatchLocalUserId: null,
    };
  }

  const firstName = clerkUser?.firstName?.trim() ?? "";
  const lastName = clerkUser?.lastName?.trim() ?? "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || "Player";
  const email = extractClerkEmail(clerkUser) ?? `clerk_${clerkId}@soccerwatch.local`;
  let emailMatchLocalUserId: number | null = null;
  if (!isSyntheticEmail(email)) {
    const [emailMatch] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email));
    emailMatchLocalUserId = emailMatch?.id ?? null;
  }

  const [created] = await db
    .insert(usersTable)
    .values({
      clerkId,
      name,
      email,
      isGuest: false,
      profileComplete: false,
    })
    .onConflictDoNothing()
    .returning({ id: usersTable.id });

  if (created) {
    return {
      id: created.id,
      localRowStatus: "created",
      splitAccount: false,
      emailMatchLocalUserId,
    };
  }

  // onConflictDoNothing returns no row on conflict, and returning null here
  // makes every route treat a legitimately signed-in Clerk user as anonymous —
  // silently and permanently. Two things can conflict:
  //
  //  - users.clerk_id, when two requests from a brand-new Clerk user race. The
  //    row already exists, so re-select it.
  const [byClerkId] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));
  if (byClerkId) {
    return {
      id: byClerkId.id,
      localRowStatus: "found",
      splitAccount: false,
      emailMatchLocalUserId,
    };
  }

  //  - users.email, when the address is already attached to a different local
  //    row. Do NOT adopt that row: Clerk emails are not necessarily verified
  //    (extractClerkEmail falls back to any address on the account), every
  //    pre-Clerk row has a null clerk_id, and some of those are admins — so
  //    "claim the row whose email matches" is an account-takeover primitive.
  //    Give this Clerk id its own row under a synthetic address instead. The
  //    person gets in; an operator can merge the accounts deliberately.
  logger.warn(
    { clerkId, emailMatchLocalUserId },
    "Clerk sign-in email already belongs to another local user — creating a separate row",
  );
  const [fallback] = await db
    .insert(usersTable)
    .values({
      clerkId,
      name,
      email: `clerk_${clerkId}@soccerwatch.local`,
      isGuest: false,
      profileComplete: false,
    })
    .onConflictDoNothing()
    .returning({ id: usersTable.id });
  if (fallback) {
    return {
      id: fallback.id,
      localRowStatus: "created",
      splitAccount: true,
      emailMatchLocalUserId,
    };
  }

  const [retry] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));
  return {
    id: retry?.id ?? null,
    localRowStatus: retry ? "found" : "not_found",
    splitAccount: Boolean(retry),
    emailMatchLocalUserId,
  };
}

/**
 * Reads the guest id from the *signed* cookie jar only.
 *
 * The guest cookie is a bare row id, so if it were trusted unsigned any client
 * could set `guestId=<n>` and be treated as user n — including an admin. Only
 * `req.signedCookies` is consulted here: values there have been verified by
 * cookie-parser against COOKIE_SECRET, so a client cannot mint one. An
 * unsigned `guestId` (a stale cookie from before this change, or a forgery) is
 * ignored, which logs that client out rather than trusting it.
 */
function getGuestUserId(req: Request): number | null {
  const raw = req.signedCookies?.guestId;
  if (typeof raw !== "string" || raw === "") return null;
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Loads the user a guest cookie points at, but only if that row really is a
 * guest. Defence in depth: even if a signature were somehow obtained for
 * another id, the guest path can never resolve to a Clerk-backed or admin
 * account, so it cannot be used to escalate privileges.
 */
async function getGuestUserRecord(req: Request) {
  const guestId = getGuestUserId(req);
  if (!guestId) return null;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, guestId), eq(usersTable.isGuest, true)));

  return user ?? null;
}

function logResolutionFailure(req: Request, resolution: UserResolution): void {
  logger.warn(
    {
      path: req.originalUrl?.split("?")[0] ?? req.url?.split("?")[0],
      method: req.method,
      reason: resolution.reason,
      diagnostics: resolution.diagnostics,
    },
    "Local user resolution rejected",
  );
}

function saveResolution(req: Request, resolution: UserResolution): UserResolution {
  resolutionByRequest.set(req, resolution);
  if (!resolution.user) logResolutionFailure(req, resolution);
  return resolution;
}

export function getUserResolution(req: Request): UserResolution | null {
  return resolutionByRequest.get(req) ?? null;
}

export function unauthenticatedResponse(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  req: Request,
  error = "Unauthenticated",
): void {
  const resolution = getUserResolution(req);
  res.status(401).json({
    error,
    reason: resolution?.reason ?? "no_credentials",
  });
}

export async function resolveLocalUser(req: Request): Promise<UserResolution> {
  const auth = getAuth(req);
  const diagnostics = getRequestDiagnostics(req);
  diagnostics.clerkUserIdPresent = Boolean(auth?.userId);

  if (auth?.userId) {
    const provision = await getOrCreateLocalUserByClerkId(auth.userId);
    diagnostics.localRowStatus = provision.localRowStatus;
    diagnostics.resolvedLocalUserId = provision.id;
    diagnostics.splitAccount = provision.splitAccount;
    diagnostics.emailMatchLocalUserId = provision.emailMatchLocalUserId;

    if (!provision.id) {
      return saveResolution(req, {
        user: null,
        reason: "local_user_provisioning_failed",
        diagnostics,
      });
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, provision.id));
    if (!user) {
      diagnostics.localRowStatus = "not_found";
      return saveResolution(req, {
        user: null,
        reason: "local_user_provisioning_failed",
        diagnostics,
      });
    }

    if (user.isDisabled) {
      diagnostics.disabledRowRejected = true;
      return saveResolution(req, {
        user: null,
        reason: "local_user_disabled",
        diagnostics,
      });
    }

    const resolution: UserResolution = {
      user,
      reason: "resolved_clerk",
      diagnostics,
    };
    if (provision.splitAccount) {
      logger.warn(
        {
          resolvedLocalUserId: user.id,
          emailMatchLocalUserId: provision.emailMatchLocalUserId,
          splitAccount: true,
        },
        "Clerk user resolved to a synthetic local account beside an existing email row",
      );
    }
    return saveResolution(req, resolution);
  }

  const guest = await getGuestUserRecord(req);
  if (guest) {
    diagnostics.localRowStatus = "found";
    diagnostics.resolvedLocalUserId = guest.id;
    return saveResolution(req, {
      user: guest,
      reason: "resolved_guest",
      diagnostics,
    });
  }

  return saveResolution(req, {
    user: null,
    reason: diagnostics.clerkCredentialPresent
      ? "clerk_session_unresolved"
      : diagnostics.guestCookiePresent
        ? "guest_session_invalid"
        : "no_credentials",
    diagnostics,
  });
}

export async function getLocalUserId(req: Request): Promise<number | null> {
  const resolution = await resolveLocalUser(req);
  return resolution.user?.id ?? null;
}

export async function getLocalUserRecord(req: Request) {
  const resolution = await resolveLocalUser(req);
  return resolution.user;
}

export async function getLocalAccountUserId(req: Request): Promise<number | null> {
  const resolution = await resolveLocalUser(req);
  if (!resolution.user) return null;
  if (!resolution.user.isGuest) return resolution.user.id;

  const rejected: UserResolution = {
    ...resolution,
    user: null,
    reason: "guest_account_not_allowed",
    diagnostics: {
      ...resolution.diagnostics,
      guestRowRejected: true,
    },
  };
  saveResolution(req, rejected);
  return null;
}
