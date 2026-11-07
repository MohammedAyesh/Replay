import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { academyCreativeProjectsTable, academyIgAutopilotTable, academyIgItemsTable, db, type AcademyCreativeProject, type AcademyIgItem } from "@workspace/db";
import { requireAcademyOwner } from "../lib/academyOwner";
import { getSocialAccount, refreshSocialAccountHealth } from "../lib/social/account";
import { ammanLocal, fromAmmanLocal } from "../lib/venues/core";
import {
  ACADEMY_IG_BACKFILL_DAYS,
  academyIgSettings,
  addItem,
  normaliseTimes,
  placementOf,
  planAcademy,
  publishAcademyItem,
  startRender,
} from "../lib/creative/academyIgAutopilot";

/**
 * Academy console → Social → Instagram autopilot (owner only). The academy's own Creative hub
 * designs on an Instagram calendar: lib/creative/academyIgAutopilot.ts.
 *
 *   GET  …/instagram                    switches, calendar, suggestions
 *   GET  …/instagram/today              today's posts and the next suggestions (Overview)
 *   PUT  …/instagram/settings           { enabled?, publishMode?, times? }
 *   POST …/instagram/suggestions        { projectId } a design onto the calendar
 *   POST …/instagram/items/:id/action   approve | unapprove | skip | restore | now
 *   PUT  …/instagram/items/:id/slot     { slotLocal } move it (pins it there)
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/instagram";
const owner = (req: Parameters<typeof requireAcademyOwner>[0], res: Parameters<typeof requireAcademyOwner>[1]) => requireAcademyOwner(req, res, "the Instagram autopilot");

function itemView(i: AcademyIgItem, p: AcademyCreativeProject | null) {
  return {
    id: i.id,
    projectId: i.projectId,
    placement: i.placement,
    status: i.status,
    pinned: i.pinned,
    slotAt: i.slotAt?.toISOString() ?? null,
    slotLocal: i.slotAt ? ammanLocal(i.slotAt) : null,
    error: i.error,
    igPermalink: i.igPermalink,
    publishedAt: i.publishedAt?.toISOString() ?? null,
    project: p ? projectView(p) : null,
  };
}
/**
 * Who or what a design is about, for the calendar line: the player (his name when the design
 * carries it, which it only does when the academy shows names, else his shirt number) and the
 * opponent.
 */
export function projectAbout(data: unknown): string | null {
  const d = (data && typeof data === "object" ? data : {}) as { player?: { name?: unknown; number?: unknown }; match?: { opponent?: unknown } };
  const who = typeof d.player?.name === "string" && d.player.name.trim() ? d.player.name.trim()
    : typeof d.player?.number === "number" || (typeof d.player?.number === "string" && d.player.number) ? `#${d.player!.number}` : null;
  const vs = typeof d.match?.opponent === "string" && d.match.opponent.trim() ? `vs ${d.match.opponent.trim()}` : null;
  return [who, vs].filter(Boolean).join(" · ") || null;
}

function projectView(p: AcademyCreativeProject) {
  return {
    id: p.id, title: p.title, kind: p.kind, format: p.format, templateKey: p.templateKey, origin: p.origin, renderStatus: p.renderStatus,
    about: projectAbout(p.data),
    outputUrl: p.outputPath ? `/api/academy/console/academies/${p.academyId}/creative/projects/${p.id}/output` : null,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Designs that could go on the calendar and aren't on it: the newest drafts first. There is always something unless nothing was ever made. */
async function suggestions(academyId: number, now: Date, limit: number) {
  const rows = await db.select().from(academyCreativeProjectsTable).where(and(
    eq(academyCreativeProjectsTable.academyId, academyId),
    inArray(academyCreativeProjectsTable.status, ["draft", "ready"]),
    gte(academyCreativeProjectsTable.updatedAt, new Date(now.getTime() - ACADEMY_IG_BACKFILL_DAYS * 86_400_000)),
    sql`not exists (select 1 from ${academyIgItemsTable} i where i.project_id = ${academyCreativeProjectsTable.id} and i.status <> 'skipped')`,
  )).orderBy(desc(academyCreativeProjectsTable.updatedAt)).limit(limit);
  return rows.map((p) => ({ ...projectView(p), placement: placementOf(p) }));
}

async function itemsWithProjects(where: ReturnType<typeof and>) {
  const rows = await db.select({ item: academyIgItemsTable, project: academyCreativeProjectsTable }).from(academyIgItemsTable)
    .leftJoin(academyCreativeProjectsTable, eq(academyCreativeProjectsTable.id, academyIgItemsTable.projectId))
    .where(where).orderBy(academyIgItemsTable.slotAt).limit(200);
  return rows.map((r) => itemView(r.item, r.project));
}

router.get(base, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const now = new Date();
  const s = await academyIgSettings(access.academyId);
  let account = await getSocialAccount(access.academyId);
  if (account?.status === "error") {
    account = await refreshSocialAccountHealth(account, "academy_instagram.overview");
  }
  const items = await itemsWithProjects(and(
    eq(academyIgItemsTable.academyId, access.academyId),
    or(isNull(academyIgItemsTable.slotAt), gte(academyIgItemsTable.slotAt, new Date(now.getTime() - 7 * 86_400_000)))!,
  ));
  res.json({
    settings: s,
    instagram: { connected: account?.status === "connected" && Boolean(account.igUserId), username: account?.igUsername ?? null },
    items,
    suggestions: await suggestions(access.academyId, now, 8),
  });
});

router.get(`${base}/today`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const now = new Date();
  const s = await academyIgSettings(access.academyId);
  let account = await getSocialAccount(access.academyId);
  if (account?.status === "error") {
    account = await refreshSocialAccountHealth(account, "academy_instagram.today");
  }
  const from = fromAmmanLocal(`${ammanLocal(now).slice(0, 10)} 00:00`) ?? now;
  const items = await itemsWithProjects(and(
    eq(academyIgItemsTable.academyId, access.academyId),
    gte(academyIgItemsTable.slotAt, from),
    lt(academyIgItemsTable.slotAt, new Date(from.getTime() + 86_400_000)),
  )!);
  res.json({
    enabled: s.enabled,
    publishMode: s.publishMode,
    connected: account?.status === "connected" && Boolean(account.igUserId),
    items: items.filter((i) => i.status !== "skipped"),
    suggestions: await suggestions(access.academyId, now, 3),
  });
});

const settingsBody = z.object({
  enabled: z.boolean().optional(),
  publishMode: z.enum(["approve", "auto"]).optional(),
  times: z.object({ feed: z.array(z.string()), reel: z.array(z.string()), story: z.array(z.string()) }).partial().optional(),
});

router.put(`${base}/settings`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const body = settingsBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid settings" }); return; }
  const current = await academyIgSettings(access.academyId);
  const next = {
    enabled: body.data.enabled ?? current.enabled,
    publishMode: body.data.publishMode ?? current.publishMode,
    times: body.data.times ? normaliseTimes({ ...current.times, ...body.data.times }) : current.times,
  };
  await db.insert(academyIgAutopilotTable).values({ academyId: access.academyId, ...next, updatedBy: access.user.id, updatedAt: new Date() })
    .onConflictDoUpdate({ target: academyIgAutopilotTable.academyId, set: { ...next, updatedBy: access.user.id, updatedAt: new Date() } });
  if (next.enabled) await planAcademy(access.academyId, next).catch(() => 0);
  res.json({ settings: next });
});

router.post(`${base}/suggestions`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const body = z.object({ projectId: z.number().int().positive() }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid design" }); return; }
  const [p] = await db.select().from(academyCreativeProjectsTable)
    .where(and(eq(academyCreativeProjectsTable.id, body.data.projectId), eq(academyCreativeProjectsTable.academyId, access.academyId)));
  if (!p) { res.status(404).json({ error: "Not found" }); return; }
  const [existing] = await db.select().from(academyIgItemsTable).where(eq(academyIgItemsTable.projectId, p.id));
  let item = existing ?? await addItem(p, false);
  if (existing?.status === "skipped") {
    [item] = await db.update(academyIgItemsTable).set({ status: "planned", error: null, slotAt: null, pinned: false, updatedAt: new Date() }).where(eq(academyIgItemsTable.id, existing.id)).returning();
  } else if (existing) {
    res.status(409).json({ error: "It's on the calendar already", code: "exists" }); return;
  }
  if (!item) { res.status(409).json({ error: "It's on the calendar already", code: "exists" }); return; }
  if (item.status === "skipped") { res.status(409).json({ error: item.error ?? "It can't be posted", code: "blocked" }); return; }
  await planAcademy(access.academyId, await academyIgSettings(access.academyId)).catch(() => 0);
  const [fresh] = await db.select().from(academyIgItemsTable).where(eq(academyIgItemsTable.id, item.id));
  res.status(201).json({ item: itemView(fresh, p) });
});

async function ownItem(academyId: number, id: number) {
  const [row] = await db.select().from(academyIgItemsTable).where(and(eq(academyIgItemsTable.id, id), eq(academyIgItemsTable.academyId, academyId)));
  return row ?? null;
}

router.post(`${base}/items/:itemId/action`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const body = z.object({ action: z.enum(["approve", "unapprove", "skip", "restore", "now"]) }).safeParse(req.body ?? {});
  const item = await ownItem(access.academyId, Number(req.params.itemId));
  if (!body.success || !item) { res.status(body.success ? 404 : 400).json({ error: body.success ? "Not found" : "Invalid action" }); return; }
  const now = new Date();
  const waiting = item.status === "planned" || item.status === "approved";
  const set = async (patch: Partial<typeof academyIgItemsTable.$inferInsert>) =>
    (await db.update(academyIgItemsTable).set({ ...patch, updatedAt: now }).where(eq(academyIgItemsTable.id, item.id)).returning())[0];
  let row: AcademyIgItem = item;
  switch (body.data.action) {
    case "approve": if (!waiting) break; row = await set({ status: "approved" }); break;
    case "unapprove": if (item.status !== "approved") break; row = await set({ status: "planned" }); break;
    case "skip": if (!waiting && item.status !== "failed") break; row = await set({ status: "skipped", error: "Skipped by you", pinned: false }); break;
    case "restore":
      if (item.status !== "skipped" && item.status !== "failed") break;
      row = await set({ status: "planned", error: null, slotAt: null, pinned: false });
      await planAcademy(access.academyId, await academyIgSettings(access.academyId), now).catch(() => 0);
      break;
    case "now": {
      if (!waiting) break;
      // Approved for now: it goes out as soon as its render is done (the tick picks it up).
      row = await set({ status: "approved", slotAt: now, pinned: true, error: null });
      const [p] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, item.projectId));
      if (p) await startRender(access.academyId, p).catch(() => undefined);
      row = await publishAcademyItem(row, now).catch(() => row);
      break;
    }
  }
  const [p] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, row.projectId));
  res.json({ item: itemView((await ownItem(access.academyId, item.id)) ?? row, p ?? null) });
});

router.put(`${base}/items/:itemId/slot`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const body = z.object({ slotLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/) }).safeParse(req.body ?? {});
  const item = await ownItem(access.academyId, Number(req.params.itemId));
  if (!body.success || !item) { res.status(body.success ? 404 : 400).json({ error: body.success ? "Not found" : "Invalid time" }); return; }
  const at = fromAmmanLocal(body.data.slotLocal);
  if (!at || at.getTime() < Date.now() + 15 * 60_000) { res.status(409).json({ error: "Pick a time at least 15 minutes from now", code: "too_soon" }); return; }
  if (item.status !== "planned" && item.status !== "approved") { res.status(409).json({ error: "It can't be moved now", code: "not_waiting" }); return; }
  const [row] = await db.update(academyIgItemsTable).set({ slotAt: at, pinned: true, updatedAt: new Date() }).where(eq(academyIgItemsTable.id, item.id)).returning();
  res.json({ item: itemView(row, null) });
});

export default router;
