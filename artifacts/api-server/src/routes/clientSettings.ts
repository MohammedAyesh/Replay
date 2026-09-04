import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { getAllSettings } from "../lib/settings";

const router: IRouter = Router();

/**
 * The settings the client needs, resolved for whoever is asking.
 *
 * A deliberately small allow-list rather than the whole registry. Most settings
 * describe how the server behaves and are nobody's business on the client;
 * shipping them all would leak the shape of the pricing model and every
 * operational threshold to anyone with a browser.
 */
const CLIENT_VISIBLE = [
  "playback.maxWidth",
  "downloads.limit",
  "downloads.windowDays",
  "downloads.enabled",
  "share.enabled",
  "clip.maxDurationSeconds",
] as const;

router.get("/client-settings", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  let academyId: number | null = null;
  if (userId) {
    const [user] = await db.select({ academyId: usersTable.academyId }).from(usersTable).where(eq(usersTable.id, userId));
    academyId = user?.academyId ?? null;
  }

  const rawFieldId = typeof req.query.fieldId === "string" ? Number.parseInt(req.query.fieldId, 10) : Number.NaN;
  const fieldId = Number.isInteger(rawFieldId) && rawFieldId > 0 ? rawFieldId : null;

  const all = await getAllSettings({ userId: userId ?? null, academyId, fieldId });
  const settings: Record<string, number | boolean | string> = {};
  for (const key of CLIENT_VISIBLE) settings[key] = all[key]!;

  // Per-user by construction, so it must never be cached by a shared proxy.
  res.setHeader("Cache-Control", "no-store");
  res.json({ settings });
});

export default router;
