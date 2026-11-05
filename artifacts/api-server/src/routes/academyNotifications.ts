import { Router, type IRouter } from "express";
import { z } from "zod";
import { consoleAccess } from "./academyMatches";
import { deleteSubscription, hasSubscription, saveSubscription, vapidKeys } from "../lib/push/webPush";

/**
 * Notifications on this device for new chat messages (lib/push/webPush.ts):
 *
 *   GET    …/notifications?endpoint=…      { publicKey, on }: the key to subscribe with, and whether this device is on
 *   POST   …/notifications { subscription } turn this device on (for every academy or field this person sees chats in)
 *   DELETE …/notifications { endpoint }     turn it off
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/notifications";

const endpoint = z.string().url().max(1000).refine((u) => u.startsWith("https://"), "https only");
const Subscribe = z.object({
  subscription: z.object({
    endpoint,
    keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
  }),
});

router.get(base, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const at = endpoint.safeParse(req.query.endpoint);
  res.setHeader("Cache-Control", "no-store");
  res.json({ publicKey: (await vapidKeys()).publicKey, on: at.success ? await hasSubscription(access.user.id, at.data) : false });
});

router.post(base, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const body = Subscribe.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "This browser didn't give a subscription" }); return; }
  const s = body.data.subscription;
  await saveSubscription(access.user.id, { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }, String(req.headers["user-agent"] ?? "").slice(0, 300) || null);
  res.status(201).json({ on: true });
});

router.delete(base, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const body = z.object({ endpoint }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Which device?" }); return; }
  await deleteSubscription(access.user.id, body.data.endpoint);
  res.json({ on: false });
});

export default router;
