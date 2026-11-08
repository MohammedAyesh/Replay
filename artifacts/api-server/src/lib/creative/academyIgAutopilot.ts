import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, notLike, or, sql } from "drizzle-orm";
import {
  academiesTable,
  academyCreativeProjectsTable,
  academyIgAutopilotTable,
  academyIgItemsTable,
  academySocialPostsTable,
  db,
  type AcademyCreativeProject,
  type AcademyIgItem,
} from "@workspace/db";
import { logger } from "../logger";
import { ammanLocal, fromAmmanLocal, wallMinutes, wallString } from "../venues/core";
import { nowWall } from "../venues/igCalendar";
import { ownerAccess } from "../venues/igAutopilot";
import { getSocialAccount } from "../social/account";
import { logProjectFeature, projectPlayers } from "../featured/store";
import { academyHashtag } from "./publish";
import { ensureCreativeMedia, renderIsDone } from "./publishMedia";
import { CREATIVE_RENDER_VERSION_PATH } from "./renderStore";
import { AUTOPILOT_CAMERA_4K_PROBE_MS, queueVideoRender, renderStillNow } from "./renderJobs";

/**
 * Academies' Instagram autopilot. What it posts are the academy's own Creative hub designs:
 * the drafts Replay prepares after every match and week ("For you": full time, goals, player of
 * the match, moment of the week, every child appears …) and anything the owner adds.
 *
 * Each tick, for academies that switched it on with Instagram connected:
 *   1. sync     For-you drafts of the last ACADEMY_IG_BACKFILL_DAYS onto the calendar;
 *   2. plan     each waiting design into the next free time of its kind (feed post, Reel or
 *               Story): this week's matches first, then earlier days' to fill what's left;
 *   3. render   six hours ahead;
 *   4. publish  at its time, approved by the owner (or on its own in automatic mode), through
 *               academy_social_posts like any post.
 * A child without public-post consent never goes out: checked when planned and again at posting.
 */

export const ACADEMY_IG_BACKFILL_DAYS = 12;
const FRESH_HOURS = 72;
const LEAD_MINUTES = 20;
const RENDER_AHEAD_MINUTES = 6 * 60;
const GRACE_MINUTES = 60;
const CALENDAR_DAYS = 14;

export type AcademyIgPlacement = "feed" | "reel" | "story";
export type AcademyIgTimes = Record<AcademyIgPlacement, string[]>;
export const DEFAULT_ACADEMY_IG_TIMES: AcademyIgTimes = { feed: ["18:00"], reel: ["20:30"], story: ["13:00"] };
const WAITING = ["planned", "approved"] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function normaliseTimes(value: unknown): AcademyIgTimes {
  const v = (value ?? {}) as Partial<Record<AcademyIgPlacement, unknown>>;
  const list = (x: unknown, d: string[]) => (Array.isArray(x) ? [...new Set(x.filter((t): t is string => typeof t === "string" && TIME_RE.test(t)))].sort().slice(0, 4) : d);
  return { feed: list(v.feed, DEFAULT_ACADEMY_IG_TIMES.feed), reel: list(v.reel, DEFAULT_ACADEMY_IG_TIMES.reel), story: list(v.story, DEFAULT_ACADEMY_IG_TIMES.story) };
}

export type AcademyIgSettings = { enabled: boolean; publishMode: "approve" | "auto"; times: AcademyIgTimes };

export async function academyIgSettings(academyId: number): Promise<AcademyIgSettings> {
  const [row] = await db.select().from(academyIgAutopilotTable).where(eq(academyIgAutopilotTable.academyId, academyId));
  return { enabled: row?.enabled ?? false, publishMode: row?.publishMode === "auto" ? "auto" : "approve", times: normaliseTimes(row?.times) };
}

/** Where a design goes: a video is a Reel, a 9:16 still a Story, the rest a feed post. */
export function placementOf(p: Pick<AcademyCreativeProject, "kind" | "format">): AcademyIgPlacement {
  return p.kind === "video" ? "reel" : p.format === "story" ? "story" : "feed";
}

const dateOfWall = (m: number) => fromAmmanLocal(wallString(m));
const wallOf = (d: Date | null | undefined) => (d ? wallMinutes(ammanLocal(d)) : null);

// ── Planning (pure) ──────────────────────────────────────────────────────────

export type AcademyPlanItem = { id: number; placement: AcademyIgPlacement; slotAt: number | null; pinned: boolean; status: string; readyAt: number };

/** The day's times of each kind for `days` days from today (wall minutes). */
export function academySlots(times: AcademyIgTimes, today: string, days: number): Array<{ at: number; placement: AcademyIgPlacement }> {
  const out: Array<{ at: number; placement: AcademyIgPlacement }> = [];
  const start = wallMinutes(`${today} 00:00`);
  for (let d = 0; d < days; d += 1) {
    const date = wallString(start + d * 1440).slice(0, 10);
    for (const placement of ["feed", "reel", "story"] as const) for (const t of times[placement]) out.push({ at: wallMinutes(`${date} ${t}`), placement });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * One design per time. Pinned and in-flight items keep theirs. Waiting designs go to the next
 * free time of their kind after they're ready: this week's (made in the last FRESH_HOURS) in the
 * order they were made, then earlier days' newest first, to fill what's left.
 */
export function planAcademySlots(input: { now: number; slots: Array<{ at: number; placement: AcademyIgPlacement }>; items: AcademyPlanItem[] }): Map<number, number | null> {
  const used = new Set<string>();
  const key = (p: AcademyIgPlacement, at: number) => `${p}:${at}`;
  const free: AcademyPlanItem[] = [];
  for (const i of input.items) {
    if ((i.status === "planned" || i.status === "approved") && !i.pinned) free.push(i);
    else if (i.slotAt !== null) used.add(key(i.placement, i.slotAt));
  }
  const fresh = (i: AcademyPlanItem) => i.readyAt >= input.now - FRESH_HOURS * 60;
  const order = [...free].sort((a, b) => Number(fresh(b)) - Number(fresh(a)) || (fresh(a) ? a.readyAt - b.readyAt : b.readyAt - a.readyAt) || a.id - b.id);
  const future = input.slots.filter((s) => s.at >= input.now + LEAD_MINUTES);
  const out = new Map<number, number | null>();
  for (const item of order) {
    const slot = future.find((s) => s.placement === item.placement && !used.has(key(s.placement, s.at)));
    if (slot) { used.add(key(slot.placement, slot.at)); out.set(item.id, slot.at); } else out.set(item.id, null);
  }
  return out;
}

// ── 1. Sync ──────────────────────────────────────────────────────────────────

/** For-you drafts of the last days onto the calendar (once each; a skipped one stays skipped). */
export async function syncAcademyItems(academyId: number, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - ACADEMY_IG_BACKFILL_DAYS * 86_400_000);
  const drafts = await db.select().from(academyCreativeProjectsTable).where(and(
    eq(academyCreativeProjectsTable.academyId, academyId),
    eq(academyCreativeProjectsTable.origin, "auto"),
    inArray(academyCreativeProjectsTable.status, ["draft", "ready"]),
    gte(academyCreativeProjectsTable.createdAt, since),
    sql`not exists (select 1 from ${academyIgItemsTable} i where i.project_id = ${academyCreativeProjectsTable.id})`,
  )).orderBy(desc(academyCreativeProjectsTable.createdAt)).limit(30);
  let made = 0;
  for (const p of drafts) made += await addItem(p, false, now) ? 1 : 0;
  return made;
}

/** A design onto the calendar: waiting for a time (or the owner's OK), or skipped with why. */
export async function addItem(p: AcademyCreativeProject, pinnedAt: Date | false, now = new Date()): Promise<AcademyIgItem | null> {
  const shown = await projectPlayers(p).catch(() => null);
  const blocked = shown && shown.withoutConsent.length > 0;
  const [row] = await db.insert(academyIgItemsTable).values({
    academyId: p.academyId,
    projectId: p.id,
    placement: placementOf(p),
    status: blocked ? "skipped" : "planned",
    error: blocked ? "A player in it has no public-post consent from his family" : null,
    pinned: Boolean(pinnedAt),
    slotAt: pinnedAt || null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  return row ?? null;
}

// ── 2. Plan ──────────────────────────────────────────────────────────────────

export async function planAcademy(academyId: number, s: AcademyIgSettings, now = new Date()): Promise<number> {
  const nowM = nowWall(now);
  // Too old: its footage is about to go. A time that passed without an OK: back to waiting.
  await db.update(academyIgItemsTable).set({ status: "skipped", error: "Too old to post", updatedAt: now }).where(and(
    eq(academyIgItemsTable.academyId, academyId),
    inArray(academyIgItemsTable.status, [...WAITING]),
    sql`${academyIgItemsTable.createdAt} < ${new Date(now.getTime() - ACADEMY_IG_BACKFILL_DAYS * 86_400_000)}`,
  ));
  await db.update(academyIgItemsTable).set({ pinned: false, updatedAt: now }).where(and(
    eq(academyIgItemsTable.academyId, academyId),
    eq(academyIgItemsTable.status, "planned"),
    eq(academyIgItemsTable.pinned, true),
    sql`${academyIgItemsTable.slotAt} < ${new Date(now.getTime() - GRACE_MINUTES * 60_000)}`,
  ));
  const items = await db.select().from(academyIgItemsTable).where(and(
    eq(academyIgItemsTable.academyId, academyId),
    notInArray(academyIgItemsTable.status, ["skipped", "published", "failed"]),
  ));
  const graceFrom = now.getTime() - GRACE_MINUTES * 60_000;
  // A time that has just come round for a post that may go out is held for publishing.
  const due = (i: AcademyIgItem) => Boolean(i.slotAt) && i.slotAt!.getTime() <= now.getTime() && i.slotAt!.getTime() >= graceFrom
    && (i.status === "approved" || (s.publishMode === "auto" && i.status === "planned"));
  const plan = planAcademySlots({
    now: nowM,
    slots: academySlots(s.times, ammanLocal(now).slice(0, 10), CALENDAR_DAYS),
    items: items.map((i) => ({ id: i.id, placement: i.placement as AcademyIgPlacement, slotAt: wallOf(i.slotAt), pinned: i.pinned || due(i), status: i.status, readyAt: wallOf(i.createdAt) ?? nowM })),
  });
  let changed = 0;
  for (const i of items) {
    if (!plan.has(i.id)) continue;
    const next = plan.get(i.id)!;
    const at = next === null ? null : dateOfWall(next);
    if ((at?.getTime() ?? null) === (i.slotAt?.getTime() ?? null)) continue;
    await db.update(academyIgItemsTable).set({ slotAt: at, updatedAt: now }).where(eq(academyIgItemsTable.id, i.id));
    changed += 1;
  }
  return changed;
}

// ── 3. Render ahead ──────────────────────────────────────────────────────────

async function projectOf(item: AcademyIgItem): Promise<AcademyCreativeProject | null> {
  const [p] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, item.projectId));
  return p ?? null;
}

/** Start a design's render (an image renders at once, a video is queued). */
export async function startRender(academyId: number, project: AcademyCreativeProject): Promise<void> {
  if (renderIsDone(project) || project.renderStatus === "queued" || project.renderStatus === "rendering") return;
  const access = await ownerAccess(academyId);
  if (!access) return;
  if (project.kind === "video") {
    await queueVideoRender(access, project, { sourceWaitMs: AUTOPILOT_CAMERA_4K_PROBE_MS });
  } else {
    await renderStillNow(access, project, { sourceWaitMs: AUTOPILOT_CAMERA_4K_PROBE_MS });
  }
}

async function renderAhead(academyId: number, now: Date): Promise<number> {
  const soon = new Date(now.getTime() + RENDER_AHEAD_MINUTES * 60_000);
  const rows = await db.select({ item: academyIgItemsTable, project: academyCreativeProjectsTable }).from(academyIgItemsTable)
    .innerJoin(academyCreativeProjectsTable, eq(academyCreativeProjectsTable.id, academyIgItemsTable.projectId))
    .where(and(
      eq(academyIgItemsTable.academyId, academyId),
      inArray(academyIgItemsTable.status, [...WAITING]),
      isNotNull(academyIgItemsTable.slotAt),
      lte(academyIgItemsTable.slotAt, soon),
      or(
        inArray(academyCreativeProjectsTable.renderStatus, ["none", "failed"]),
        and(
          eq(academyCreativeProjectsTable.renderStatus, "done"),
          or(
            isNull(academyCreativeProjectsTable.outputPath),
            notLike(academyCreativeProjectsTable.outputPath, `%/${CREATIVE_RENDER_VERSION_PATH}/%`),
          ),
        ),
      ),
    )).orderBy(asc(academyIgItemsTable.slotAt)).limit(2);
  const pending = rows.filter(({ project }) => !renderIsDone(project));
  if (!pending.length) return 0;
  const access = await ownerAccess(academyId);
  if (!access) return 0;
  for (const { item, project } of pending) {
    // A render that already failed is tried once more, at most every half hour.
    if (project.renderStatus === "failed" && project.updatedAt.getTime() > now.getTime() - 30 * 60_000) continue;
    try {
      if (project.kind === "video") {
        await queueVideoRender(access, project, { sourceWaitMs: AUTOPILOT_CAMERA_4K_PROBE_MS });
      } else {
        await renderStillNow(access, project, { sourceWaitMs: AUTOPILOT_CAMERA_4K_PROBE_MS });
      }
    } catch (error) {
      await db.update(academyIgItemsTable).set({ error: (error as Error).message.slice(0, 300), updatedAt: now }).where(eq(academyIgItemsTable.id, item.id));
    }
  }
  return pending.length;
}

// ── 4. Publish ───────────────────────────────────────────────────────────────

function captionFor(project: AcademyCreativeProject, academyName: string): string {
  const tag = academyHashtag(academyName);
  return [project.title, tag].filter(Boolean).join("\n\n").slice(0, 2200);
}

export async function publishAcademyItem(item: AcademyIgItem, now = new Date()): Promise<AcademyIgItem> {
  const set = async (patch: Partial<typeof academyIgItemsTable.$inferInsert>) => {
    const [row] = await db.update(academyIgItemsTable).set({ ...patch, updatedAt: now }).where(eq(academyIgItemsTable.id, item.id)).returning();
    return row;
  };
  const project = await projectOf(item);
  if (!project) return set({ status: "skipped", error: "The design is gone" });
  const shown = await projectPlayers(project);
  if (shown.withoutConsent.length) return set({ status: "skipped", error: "A player in it has no public-post consent from his family" });
  if (project.renderStatus === "failed") return set({ error: project.renderError ?? "The render failed" });
  // Still rendering: it goes out on a later tick, within its time's grace.
  if (!renderIsDone(project)) return set({ error: null });
  const account = await getSocialAccount(item.academyId);
  if (!account || account.status !== "connected" || !account.igUserId) return set({ error: "Instagram isn't connected (Social)" });
  const owner = await ownerAccess(item.academyId);
  const { media } = await ensureCreativeMedia(project, owner?.user.id ?? 0);
  const [academy] = await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, item.academyId));
  const [post] = await db.insert(academySocialPostsTable).values({
    academyId: item.academyId,
    source: "replay",
    targets: ["instagram"],
    format: item.placement === "reel" ? "reel" : item.placement === "story" ? "story" : "image",
    caption: item.placement === "story" ? "" : captionFor(project, academy?.name ?? ""),
    media: [{ mediaId: media.id, type: media.kind === "video" ? "video" : "image" }],
    status: "scheduled",
    scheduledFor: now,
    createdBy: owner?.user.id ?? null,
  }).returning();
  // Every child in it appeared publicly.
  await logProjectFeature(project, "public", now).catch((err) => logger.warn({ err, projectId: project.id }, "Feature log failed"));
  return set({ status: "publishing", postId: post.id, error: null });
}

async function publishDue(academyId: number, s: AcademyIgSettings, now: Date): Promise<number> {
  const due = await db.select().from(academyIgItemsTable).where(and(
    eq(academyIgItemsTable.academyId, academyId),
    inArray(academyIgItemsTable.status, s.publishMode === "auto" ? [...WAITING] : ["approved"]),
    isNotNull(academyIgItemsTable.slotAt),
    lte(academyIgItemsTable.slotAt, now),
    gte(academyIgItemsTable.slotAt, new Date(now.getTime() - GRACE_MINUTES * 60_000)),
  )).orderBy(asc(academyIgItemsTable.slotAt)).limit(3);
  for (const item of due) {
    await publishAcademyItem(item, now).catch(async (error) => {
      logger.warn({ itemId: item.id, error: (error as Error).message }, "Academy Instagram: handing a design to publishing failed");
      await db.update(academyIgItemsTable).set({ error: (error as Error).message.slice(0, 300), updatedAt: now }).where(eq(academyIgItemsTable.id, item.id));
    });
  }
  return due.length;
}

async function followPublishing(academyId: number, now: Date): Promise<number> {
  const rows = await db.select({ item: academyIgItemsTable, post: academySocialPostsTable }).from(academyIgItemsTable)
    .innerJoin(academySocialPostsTable, eq(academySocialPostsTable.id, academyIgItemsTable.postId))
    .where(and(eq(academyIgItemsTable.academyId, academyId), eq(academyIgItemsTable.status, "publishing")));
  let n = 0;
  for (const { item, post } of rows) {
    if (post.status === "published" || (post.status === "partial" && post.igMediaId)) {
      await db.update(academyIgItemsTable).set({ status: "published", igPermalink: post.igPermalink, publishedAt: post.publishedAt ?? now, error: null, updatedAt: now }).where(eq(academyIgItemsTable.id, item.id));
      n += 1;
    } else if (post.status === "failed") {
      await db.update(academyIgItemsTable).set({ status: "failed", error: post.error ?? "Instagram refused it", updatedAt: now }).where(eq(academyIgItemsTable.id, item.id));
      n += 1;
    }
  }
  return n;
}

// ── The tick ────────────────────────────────────────────────────────────────

let lastTick = 0;
let running = false;
export function resetAcademyIgTick() { lastTick = 0; running = false; }

/** Every academy (not a field: fields have their own autopilot) with the autopilot on. */
export async function runAcademyIgTick(now = new Date(), opts: { force?: boolean } = {}): Promise<{ academies: number } | "skipped"> {
  if (running || (!opts.force && Date.now() - lastTick < 50_000)) return "skipped";
  running = true;
  lastTick = Date.now();
  try {
    const rows = await db.select({ academyId: academyIgAutopilotTable.academyId }).from(academyIgAutopilotTable)
      .innerJoin(academiesTable, eq(academiesTable.id, academyIgAutopilotTable.academyId))
      .where(and(eq(academyIgAutopilotTable.enabled, true), ne(academiesTable.kind, "venue")));
    for (const { academyId } of rows) {
      try {
        const s = await academyIgSettings(academyId);
        await followPublishing(academyId, now);
        await syncAcademyItems(academyId, now);
        await planAcademy(academyId, s, now);
        await renderAhead(academyId, now);
        await publishDue(academyId, s, now);
      } catch (error) {
        logger.warn({ academyId, error: (error as Error).message }, "Academy Instagram autopilot failed for one academy");
      }
    }
    return { academies: rows.length };
  } finally {
    running = false;
  }
}
