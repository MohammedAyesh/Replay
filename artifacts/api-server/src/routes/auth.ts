import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { LoginBody, GetMeResponse, LoginResponse, LoginAsGuestResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function getUserId(req: import("express").Request): number | null {
  const raw = req.cookies?.userId;
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, parsed.data.email));

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  res.cookie("userId", String(user.id), { httpOnly: true, sameSite: "lax" });
  res.json(LoginResponse.parse({ user: { id: user.id, name: user.name, email: user.email, isGuest: user.isGuest } }));
});

router.post("/auth/guest", async (req, res): Promise<void> => {
  const [guest] = await db
    .insert(usersTable)
    .values({ name: "Guest", email: `guest_${Date.now()}@soccerwatch.local`, isGuest: true })
    .returning();

  res.cookie("userId", String(guest.id), { httpOnly: true, sameSite: "lax" });
  res.json(LoginAsGuestResponse.parse({ user: { id: guest.id, name: guest.name, email: guest.email, isGuest: guest.isGuest } }));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  res.clearCookie("userId");
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  res.json(GetMeResponse.parse({ id: user.id, name: user.name, email: user.email, isGuest: user.isGuest }));
});

export { getUserId };
export default router;
