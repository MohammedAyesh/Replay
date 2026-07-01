import { getAuth, createClerkClient } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type { Request } from "express";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function isSocialLoginUser(clerkId: string): Promise<boolean> {
  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    return (clerkUser.externalAccounts?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function getOrCreateLocalUserByClerkId(clerkId: string): Promise<number | null> {
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));

  if (existing) return existing.id;

  // Social login users (Google, Apple, etc.) start with profileComplete=false
  // so they are guided through onboarding to fill in their soccer profile.
  // Email-signup users skip onboarding since they already completed Clerk's flow.
  const isSocial = await isSocialLoginUser(clerkId);

  const [created] = await db
    .insert(usersTable)
    .values({
      clerkId,
      name: "Player",
      email: `clerk_${clerkId}@soccerwatch.local`,
      isGuest: false,
      profileComplete: !isSocial,
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
