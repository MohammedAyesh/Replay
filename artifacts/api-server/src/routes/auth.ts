import { Router, type IRouter } from "express";
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
  res.json(GetMeResponse.parse({ id: user.id, name: user.name, email: user.email, isGuest: user.isGuest }));
});

router.post("/auth/guest", async (req, res): Promise<void> => {
  const [guest] = await db
    .insert(usersTable)
    .values({ name: "Guest", email: `guest_${Date.now()}@soccerwatch.local`, isGuest: true })
    .returning();

  res.cookie("guestId", String(guest.id), { httpOnly: true, sameSite: "lax" });
  res.json(LoginAsGuestResponse.parse({ user: { id: guest.id, name: guest.name, email: guest.email, isGuest: guest.isGuest } }));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  res.clearCookie("guestId");
  res.json({ ok: true });
});

export default router;
