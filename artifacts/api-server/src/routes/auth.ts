import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { GetMeResponse, LoginAsGuestResponse } from "@workspace/api-zod";
import { getLocalUserRecord } from "../lib/clerkUserBridge";

const router: IRouter = Router();

router.get("/auth/me", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
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
  }));
});

router.post("/auth/guest", async (req, res): Promise<void> => {
  const [guest] = await db
    .insert(usersTable)
    .values({ name: "Guest", email: `guest_${Date.now()}@soccerwatch.local`, isGuest: true, profileComplete: true })
    .returning();

  res.cookie("guestId", String(guest.id), { httpOnly: true, sameSite: "lax" });
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
  res.clearCookie("guestId");
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
