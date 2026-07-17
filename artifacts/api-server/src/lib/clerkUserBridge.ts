import { getAuth, createClerkClient } from "@clerk/express";
import { eq } from "drizzle-orm";
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

  return created?.id ?? null;
}

function getGuestUserId(req: Request): number | null {
  const raw = req.cookies?.guestId;
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}

export async function getLocalUserId(req: Request): Promise<number | null> {
  const auth = getAuth(req);
  if (auth?.userId) {
    return getOrCreateLocalUserByClerkId(auth.userId);
  }
  return getGuestUserId(req);
}

export async function getLocalUserRecord(req: Request) {
  const auth = getAuth(req);

  if (auth?.userId) {
    const localId = await getOrCreateLocalUserByClerkId(auth.userId);
    if (!localId) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, localId));
    return user ?? null;
  }

  const guestId = getGuestUserId(req);
  if (guestId) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, guestId));
    return user ?? null;
  }

  return null;
}
