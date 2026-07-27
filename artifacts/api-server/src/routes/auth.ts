import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, academiesTable } from "@workspace/db";
import { GetMeResponse, LoginAsGuestResponse } from "@workspace/api-zod";
import { getLocalUserRecord } from "../lib/clerkUserBridge";
import { GUEST_COOKIE_OPTIONS } from "../lib/cookies";

const router: IRouter = Router();

router.get("/auth/me", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  let liveAccess = false;
  if (user.academyId) {
    const [academy] = await db
      .select({ liveAccess: academiesTable.liveAccess })
      .from(academiesTable)
      .where(eq(academiesTable.id, user.academyId));
    liveAccess = academy?.liveAccess ?? false;
  }

  res.setHeader("Cache-Control", "no-store");
  res.json(GetMeResponse.parse({
    id: user.id,
    name: user.name,
    email: user.email,
    isGuest: user.isGuest,
    isAdmin: user.isAdmin,
    phone: user.phone ?? null,
    position: user.position ?? null,
    age: user.age ?? null,
    gender: user.gender ?? null,
    profileComplete: user.profileComplete,
    preferredLocale: user.preferredLocale ?? null,
    academyId: user.academyId ?? null,
    liveAccess,
  }));
});

router.post("/auth/guest", async (req, res): Promise<void> => {
  const [guest] = await db
    .insert(usersTable)
    .values({ name: "Guest", email: `guest_${Date.now()}@soccerwatch.local`, isGuest: true, profileComplete: true })
    .returning();

  res.cookie("guestId", String(guest.id), GUEST_COOKIE_OPTIONS);
  res.json(LoginAsGuestResponse.parse({
    user: {
      id: guest.id,
      name: guest.name,
      email: guest.email,
      isGuest: guest.isGuest,
      phone: null,
      position: null,
      age: null,
      gender: null,
      profileComplete: true,
    },
  }));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  // clearCookie only matches if path/sameSite/secure match how it was set —
  // otherwise the browser keeps the original cookie and logout silently fails.
  const { maxAge: _maxAge, ...clearOptions } = GUEST_COOKIE_OPTIONS;
  res.clearCookie("guestId", clearOptions);
  res.json({ ok: true });
});

// One-time secure admin bootstrap: requires a shared secret token set in
// environment variables. Call this once from your browser console or curl
// after signing in, then delete the secret so the route is disabled.
router.post("/auth/admin-setup", async (req, res): Promise<void> => {
  const expectedToken = process.env.ADMIN_SETUP_SECRET;
  if (!expectedToken) {
    res.status(403).json({ error: "Admin setup is disabled (no token configured)" });
    return;
  }
  const { token } = req.body as { token?: string };
  if (token !== expectedToken) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }

  const user = await getLocalUserRecord(req);
  if (!user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  // Guest accounts are anonymous and disposable — never grant admin to one.
  // The bootstrap must be run while signed in with a real (Clerk) account.
  if (user.isGuest || !user.clerkId) {
    res.status(403).json({ error: "Sign in with a real account before running admin setup" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ isAdmin: true })
    .where(eq(usersTable.id, user.id))
    .returning();

  if (!updated) {
    res.status(500).json({ error: "Failed to update user" });
    return;
  }

  res.json({ ok: true, isAdmin: updated.isAdmin });
});

export default router;
