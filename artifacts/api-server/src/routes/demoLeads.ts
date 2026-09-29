import { Router, type IRouter, type Request } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, demoLeadsTable, usersTable } from "@workspace/db";

import { getLocalUserId } from "../lib/clerkUserBridge";
import { demoLeadsReady, resetDemoLeadsReady } from "../lib/demoLeads";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Call-me-back requests from the public demo. See lib/demoLeads.ts for why
 * every route checks that the table exists first.
 */
export function resetDemoLeadsState(): void {
  resetDemoLeadsReady();
  recent.clear();
}

// Five requests per address per ten minutes is plenty for a person and
// useless for a script.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();

function allow(req: Request): boolean {
  // Behind the host's proxy req.ip is the proxy; the first forwarded address
  // is the visitor. Spoofable, which only matters to a limiter this soft.
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  const key = forwarded || req.ip || "unknown";
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    recent.set(key, hits);
    return false;
  }
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) {
    for (const [k, v] of recent) if (!v.some((at) => now - at < WINDOW_MS)) recent.delete(k);
  }
  return true;
}

const LeadInput = z.object({
  name: z.string().trim().min(1).max(80),
  place: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^[0-9+ ()-]{7,20}$/),
  persona: z.enum(["pitch", "academy"]),
  locale: z.enum(["ar", "en"]).catch("ar"),
  /** Honeypot: people never fill a field they cannot see. */
  website: z.string().max(0).optional(),
});

router.post("/demo/leads", async (req, res): Promise<void> => {
  const parsed = LeadInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Please check the name, place and phone number." });
    return;
  }
  if (!allow(req)) {
    res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
    return;
  }
  if (!(await demoLeadsReady())) {
    res.status(503).json({ error: "Not available yet" });
    return;
  }
  try {
    const { name, place, phone, persona, locale } = parsed.data;
    const [row] = await db.insert(demoLeadsTable).values({ name, place, phone, persona, locale }).returning({ id: demoLeadsTable.id });
    logger.info({ leadId: row?.id, persona }, "demo lead received");
    res.status(201).json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, "demo lead insert failed");
    res.status(500).json({ error: "Could not save the request" });
  }
});

async function requireAdmin(req: Request): Promise<boolean> {
  const userId = await getLocalUserId(req);
  if (!userId) return false;
  const [user] = await db.select({ isAdmin: usersTable.isAdmin }).from(usersTable).where(eq(usersTable.id, userId));
  return Boolean(user?.isAdmin);
}

router.get("/admin/demo-leads", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (!(await demoLeadsReady())) {
    res.json({ ready: false, leads: [] });
    return;
  }
  const leads = await db.select().from(demoLeadsTable).orderBy(desc(demoLeadsTable.createdAt)).limit(500);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ready: true, leads: leads.map((lead) => ({ ...lead, createdAt: lead.createdAt.toISOString() })) });
});

router.patch("/admin/demo-leads/:id", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number.parseInt(String(req.params.id), 10);
  const handled = (req.body ?? {}).handled;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof handled !== "boolean") {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  if (!(await demoLeadsReady())) {
    res.status(503).json({ error: "Not available yet" });
    return;
  }
  const [row] = await db.update(demoLeadsTable).set({ handled }).where(eq(demoLeadsTable.id, id)).returning({ id: demoLeadsTable.id });
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
