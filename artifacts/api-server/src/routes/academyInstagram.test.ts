import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable, academyCreativeProjectsTable, academyIgItemsTable, academyMembersTable, academyPlayersTable, academySocialAccountsTable,
  academySocialPostsTable, db, fieldsTable, usersTable,
} from "@workspace/db";
import { buildTemplateScene } from "@workspace/api-zod";

process.env.META_APP_SECRET = process.env.META_APP_SECRET || "test-meta-secret";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }),
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));
// No ffmpeg or Bunny here: a render finishes at once, the media library gets a row id.
vi.mock("../lib/creative/renderJobs", async () => {
  const { academyCreativeProjectsTable: t, db: d } = await import("@workspace/db");
  const { eq: e } = await import("drizzle-orm");
  const done = async (_a: unknown, row: { id: number; kind: string }) => {
    const [r] = await d.update(t).set({ renderStatus: "done", outputPath: `/tmp/a-${row.id}.png`, outputMime: "image/png", renderedAt: new Date() }).where(e(t.id, row.id)).returning();
    return r;
  };
  return { queueVideoRender: vi.fn(done), renderStillNow: vi.fn(done), isRendering: () => false, sweepInterruptedRenders: async () => undefined };
});
vi.mock("../lib/creative/publishMedia", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/creative/publishMedia")>();
  let n = 7000;
  return { ...actual, ensureCreativeMedia: vi.fn(async (row: { kind: string }) => ({ media: { id: (n += 1), kind: row.kind === "video" ? "video" : "image" }, created: true })) };
});

import instagramRouter from "./academyInstagram";
import { encryptToken } from "../lib/meta/crypto";
import { ammanLocal } from "../lib/venues/core";
import { planAcademySlots, resetAcademyIgTick, runAcademyIgTick } from "../lib/creative/academyIgAutopilot";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let academyId: number;
let noConsentPlayer: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (p = "") => `/api/academy/console/academies/${academyId}/instagram${p}`;
const tick = async (now = new Date()) => { resetAcademyIgTick(); await runAcademyIgTick(now, { force: true }); };
const items = async () => db.select().from(academyIgItemsTable).where(eq(academyIgItemsTable.academyId, academyId));

async function draft(opts: { hoursAgo: number; key?: string; origin?: "auto" | "manual"; data?: Record<string, unknown> }) {
  const key = opts.key ?? "fulltime";
  const at = new Date(Date.now() - opts.hoursAgo * 3_600_000);
  const [p] = await db.insert(academyCreativeProjectsTable).values({
    academyId, kind: "image", format: "post", title: `${key} ${opts.hoursAgo}h`, templateKey: key, style: "broadcast",
    origin: opts.origin ?? "auto", originKey: opts.origin === "manual" ? null : `test:${tag}:${opts.hoursAgo}:${key}:${Math.random().toString(36).slice(2)}`,
    scene: buildTemplateScene(key, "broadcast", "post", "en"), data: opts.data ?? {}, createdAt: at, updatedAt: at, createdBy: ownerId,
  }).returning();
  return p;
}

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", instagramRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `aig-owner-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `aig-coach-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `AIG field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const [academy] = await db.insert(academiesTable).values({ name: `Iris Academy ${tag}`, fieldId: field.id }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([{ academyId, userId: ownerId, role: "owner" }, { academyId, userId: coachId, role: "coach" }]);
  await db.insert(academySocialAccountsTable).values({
    academyId, tokenEnc: encryptToken("sys"), pageId: `p${tag}`, pageName: "Iris", pageTokenEnc: encryptToken("page"),
    igUserId: `ig${tag}`, igUsername: "iris.academy", subscribed: true, status: "connected", connectedAt: new Date(),
  });
  const [kid] = await db.insert(academyPlayersTable).values({ academyId, name: "Kareem", jerseyNumber: 9, guardianPhone: "0790000999" }).returning({ id: academyPlayersTable.id });
  noConsentPlayer = kid.id;
});

describe("Academy Instagram autopilot", () => {
  it("is off until the owner turns it on; a coach can't", async () => {
    const got = await request(app).get(url()).set(auth(ownerId)).expect(200);
    expect(got.body.settings).toMatchObject({ enabled: false, publishMode: "approve", times: { feed: ["18:00"], reel: ["20:30"], story: ["13:00"] } });
    expect(got.body.instagram).toEqual({ connected: true, username: "iris.academy" });
    await request(app).get(url()).set(auth(coachId)).expect(403);
    const put = await request(app).put(url("/settings")).set(auth(ownerId)).send({ enabled: true, times: { feed: ["09:30", "19:00", "bad"] } }).expect(200);
    expect(put.body.settings).toMatchObject({ enabled: true, times: { feed: ["09:30", "19:00"], reel: ["20:30"] } });
  });

  it("puts this week's drafts and earlier days' on the calendar, fresh first; too old and no-consent ones stay off", async () => {
    const fresh = await draft({ hoursAgo: 2 });
    const older = await draft({ hoursAgo: 24 * 6 });
    const tooOld = await draft({ hoursAgo: 24 * 13 });
    const child = await draft({ hoursAgo: 3, key: "potm", data: { player: { playerId: noConsentPlayer } } });
    await tick();
    const all = await items();
    const of = (id: number) => all.find((i) => i.projectId === id);
    expect(of(tooOld.id)).toBeUndefined();
    expect(of(child.id)).toMatchObject({ status: "skipped", error: expect.stringContaining("consent") });
    expect(of(fresh.id)).toMatchObject({ status: "planned", placement: "feed" });
    expect(of(older.id)).toMatchObject({ status: "planned", placement: "feed" });
    expect(of(fresh.id)!.slotAt!.getTime()).toBeLessThan(of(older.id)!.slotAt!.getTime());
    expect(["09:30", "19:00"]).toContain(ammanLocal(of(fresh.id)!.slotAt!).slice(11));
  });

  it("always has suggestions: designs not on the calendar, which the owner adds", async () => {
    const mine = await draft({ hoursAgo: 1, origin: "manual" });
    const got = await request(app).get(url()).set(auth(ownerId)).expect(200);
    expect(got.body.suggestions.map((s: { id: number }) => s.id)).toContain(mine.id);
    const added = await request(app).post(url("/suggestions")).set(auth(ownerId)).send({ projectId: mine.id }).expect(201);
    expect(added.body.item).toMatchObject({ projectId: mine.id, status: "planned", slotLocal: expect.any(String) });
    await request(app).post(url("/suggestions")).set(auth(ownerId)).send({ projectId: mine.id }).expect(409);
    const again = await request(app).get(url()).set(auth(ownerId)).expect(200);
    expect(again.body.suggestions.map((s: { id: number }) => s.id)).not.toContain(mine.id);
    const today = await request(app).get(url("/today")).set(auth(ownerId)).expect(200);
    expect(today.body).toMatchObject({ enabled: true, connected: true, publishMode: "approve" });
  });

  it("posts an approved design at its time, renders it first, and follows the post", async () => {
    const p = await draft({ hoursAgo: 1, key: "fulltime" });
    await tick();
    const item = (await items()).find((i) => i.projectId === p.id)!;
    await request(app).post(url(`/items/${item.id}/action`)).set(auth(ownerId)).send({ action: "approve" }).expect(200);
    // Its time comes round.
    await db.update(academyIgItemsTable).set({ slotAt: new Date(Date.now() - 60_000), pinned: true }).where(eq(academyIgItemsTable.id, item.id));
    await tick();
    await tick();
    const [after] = await db.select().from(academyIgItemsTable).where(eq(academyIgItemsTable.id, item.id));
    expect(after.status).toBe("publishing");
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, after.postId!));
    expect(post).toMatchObject({ targets: ["instagram"], format: "image", status: "scheduled" });
    expect(post.caption).toContain("#IrisAcademy");
    await db.update(academySocialPostsTable).set({ status: "published", igPermalink: "https://instagram.com/p/x", publishedAt: new Date() }).where(eq(academySocialPostsTable.id, post.id));
    await tick();
    const [done] = await db.select().from(academyIgItemsTable).where(eq(academyIgItemsTable.id, item.id));
    expect(done).toMatchObject({ status: "published", igPermalink: "https://instagram.com/p/x" });
  });

  it("lets the owner skip, bring back and move a design", async () => {
    const p = await draft({ hoursAgo: 1, key: "fulltime" });
    await tick();
    const item = (await items()).find((i) => i.projectId === p.id)!;
    expect((await request(app).post(url(`/items/${item.id}/action`)).set(auth(ownerId)).send({ action: "skip" }).expect(200)).body.item.status).toBe("skipped");
    expect((await request(app).post(url(`/items/${item.id}/action`)).set(auth(ownerId)).send({ action: "restore" }).expect(200)).body.item.status).toBe("planned");
    const tomorrow = ammanLocal(new Date(Date.now() + 86_400_000)).slice(0, 10);
    const moved = await request(app).put(url(`/items/${item.id}/slot`)).set(auth(ownerId)).send({ slotLocal: `${tomorrow} 12:15` }).expect(200);
    expect(moved.body.item).toMatchObject({ slotLocal: `${tomorrow} 12:15`, pinned: true });
    await request(app).put(url(`/items/${item.id}/slot`)).set(auth(ownerId)).send({ slotLocal: "2020-01-01 10:00" }).expect(409);
  });
});

describe("Academy calendar planner", () => {
  it("gives each time one design of its kind, this week's first, then earlier days' newest first", () => {
    const now = 1000 * 1440;
    const slots = [{ at: now + 60, placement: "feed" as const }, { at: now + 120, placement: "reel" as const }, { at: now + 1500, placement: "feed" as const }, { at: now + 3000, placement: "feed" as const }];
    const plan = planAcademySlots({ now, slots, items: [
      { id: 1, placement: "feed", slotAt: null, pinned: false, status: "planned", readyAt: now - 8 * 1440 },
      { id: 2, placement: "feed", slotAt: null, pinned: false, status: "planned", readyAt: now - 5 * 1440 },
      { id: 3, placement: "feed", slotAt: null, pinned: false, status: "planned", readyAt: now - 60 },
      { id: 4, placement: "reel", slotAt: null, pinned: false, status: "approved", readyAt: now - 60 },
    ] });
    expect([plan.get(3), plan.get(2), plan.get(1), plan.get(4)]).toEqual([now + 60, now + 1500, now + 3000, now + 120]);
  });
});
