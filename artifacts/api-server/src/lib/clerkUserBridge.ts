import { getAuth, createClerkClient } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type { Request } from "express";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function isSyntheticEmail(email: string): boolean {
  return email.startsWith("clerk_") || email.startsWith("guest_") || email.endsWith("@soccerwatch.local");
}

function extractClerkEmail(clerkUser: Awaited<ReturnType<typeof clerkClient.users.getUser>> | null): string | null {
  if (!clerkUser) return null;
  const emails = clerkUser.emailAddresses ?? [];
  const primary = emails.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress;
  const verified = emails.find((e) => e.verification?.status === "verified")?.emailAddress;
  const anyEmail = emails[0]?.emailAddress;
  return primary ?? verified ?? anyEmail ?? null;
}

async function getOrCreateLocalUserByClerkId(clerkId: string): Promise<number | null> {
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
      await db
        .update(usersTable)
        .set({
          ...(needsNameUpdate ? { name: freshName } : {}),
          ...(needsEmailUpdate ? { email: freshEmail } : {}),
        })
        .where(eq(usersTable.id, existing.id));
    }

    return existing.id;
  }

  const firstName = clerkUser?.firstName?.trim() ?? "";
  const lastName = clerkUser?.lastName?.trim() ?? "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || "Player";
  const email = extractClerkEmail(clerkUser) ?? `clerk_${clerkId}@soccerwatch.local`;

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

  if (created) return created.id;

  // onConflictDoNothing returns no row on conflict, and returning null here
  // makes every route treat a legitimately signed-in Clerk user as anonymous —
  // silently and permanently. Two things conflict:
  //
  //  - users.clerk_id, when two requests from a brand-new Clerk user race. The
  //    row now exists, so re-select it.
  //  - users.email, when the address is already attached to a different local
  //    row (an admin edited it, or the person previously signed up another way).
  //    Claim that row for this Clerk id rather than locking the person out; it
  //    is the same human, and the email is the only identity we can match on.
  const [byClerkId] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));
  if (byClerkId) return byClerkId.id;

  const [byEmail] = await db
    .select({ id: usersTable.id, clerkId: usersTable.clerkId })
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (byEmail && !byEmail.clerkId) {
    await db.update(usersTable).set({ clerkId }).where(eq(usersTable.id, byEmail.id));
    return byEmail.id;
  }

  return null;
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

export async function getLocalUserId(req: Request): Promise<number | null> {
  const user = await getLocalUserRecord(req);
  return user?.id ?? null;
}

export async function getLocalUserRecord(req: Request) {
  const auth = getAuth(req);

  let user: typeof usersTable.$inferSelect | null = null;

  if (auth?.userId) {
    const localId = await getOrCreateLocalUserByClerkId(auth.userId);
    if (!localId) return null;
    const [found] = await db.select().from(usersTable).where(eq(usersTable.id, localId));
    user = found ?? null;
  } else {
    user = await getGuestUserRecord(req);
  }

  // A disabled account must not authenticate anywhere. Enforced centrally so
  // every caller of getLocalUserId/getLocalUserRecord inherits it.
  if (!user || user.isDisabled) return null;

  return user;
}
