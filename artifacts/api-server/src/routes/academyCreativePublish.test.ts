import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academiesTable,
  academyAdMediaTable,
  academyCreativeProjectsTable,
  academyMembersTable,
  academyPlayersTable,
  academySocialAccountsTable,
  academySocialPostsTable,
  academySquadsTable,
  academyWhatsappMessagesTable,
  academyWhatsappSettingsTable,
  db,
  fieldsTable,
  usersTable,
} from "@workspace/db";

process.env.META_ACCESS_TOKEN = "test-token";
process.env.META_AD_ACCOUNT_ID = "123456";
process.env.META_APP_SECRET = "test-app-secret";
process.env.PUBLIC_BASE_URL = "https://replay.test";

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

const stamp = Date.now();
const PAGE = `7${stamp}`;
const IG = `17${stamp}`;
const graphCalls: Array<{ path: string; params: Record<string, string> }> = [];
let seq = 0;

// No call leaves the machine: Meta is answered here, WhatsApp is only queued (never dispatched).
vi.mock("../lib/meta/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/graph")>();
  return {
    ...actual,
    graphGet: vi.fn(async (p: string) => {
      if (p.startsWith("ig-container-")) return { status_code: "FINISHED" };
      if (p.startsWith("ig-published-")) return { permalink: `https://instagram.com/p/${p}` };
      if (p.startsWith("fb-post-")) return { permalink_url: `https://facebook.com/${p}` };
      return {};
    }),
    graphPost: vi.fn(async (p: string, params: Record<string, string> = {}) => {
      graphCalls.push({ path: p, params });
      seq += 1;
      if (p === `${IG}/media`) return { id: `ig-container-${seq}` };
      if (p === `${IG}/media_publish`) return { id: `ig-published-${seq}` };
      if (p === `${PAGE}/photos`) return { id: `photo-${seq}`, post_id: `fb-post-${seq}` };
      return { success: true };
    }),
  };
});
vi.mock("../lib/whatsapp/waha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/waha")>();
  return { ...actual, sendText: vi.fn(async () => { throw new Error("must not send in tests"); }) };
});

import { encryptToken } from "../lib/meta/crypto";
import { ammanLocalToDate, dateToAmmanLocal } from "../lib/creative/publish";
import publishRouter from "./academyCreativePublish";

// A 1×1 PNG: the "rendered" output, read from disk like a local render.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "creative-publish-test-"));
const outputFile = path.join(tmp, "out.png");
fs.writeFileSync(outputFile, PNG);

let app: Express;
let ownerId: number;
let coachId: number;
let otherOwnerId: number;
let fieldId: number;
let academyId: number;
let otherAcademyId: number;
let squadId: number;
let otherSquadId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = (id = academyId) => `/api/academy/console/academies/${id}/creative`;
const scene = (format: "post" | "story" = "post") => ({ v: 1, format, background: "@paper", layers: [], locale: "ar" });

async function project(patch: Partial<typeof academyCreativeProjectsTable.$inferInsert> = {}) {
  const format = patch.format ?? "post";
  const [row] = await db.insert(academyCreativeProjectsTable).values({
    academyId, kind: "image", format, title: "Full time", scene: scene(format as "post" | "story"),
    renderStatus: "done", outputPath: outputFile, outputMime: "image/png", renderedAt: new Date("2026-11-02T09:00:00Z"),
    ...patch,
  }).returning();
  return row;
}

async function reload(id: number) {
  const [row] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, id));
  return row;
}

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", publishRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `cp-owner-${stamp}@test.local` },
    { name: `Coach ${stamp}`, email: `cp-coach-${stamp}@test.local` },
    { name: `Other ${stamp}`, email: `cp-other-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, otherOwnerId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `CP field ${stamp}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const academies = await db.insert(academiesTable).values([
    { name: `Galaxy Academy ${stamp}`, fieldId },
    { name: `Other Academy ${stamp}`, fieldId },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: otherOwnerId, role: "owner" },
  ]);
  await db.insert(academySocialAccountsTable).values({
    academyId, tokenEnc: encryptToken("sys-token"), pageId: PAGE, pageName: "Galaxy Academy", pageTokenEnc: encryptToken("page-token"),
    igUserId: IG, igUsername: "galaxy.academy", subscribed: true, status: "connected", connectedAt: new Date(),
  });
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U12" }).returning({ id: academySquadsTable.id });
  squadId = squad.id;
  const [other] = await db.insert(academySquadsTable).values({ academyId: otherAcademyId, name: "U14" }).returning({ id: academySquadsTable.id });
  otherSquadId = other.id;
  await db.insert(academyPlayersTable).values([
    { academyId, squadId, name: "Ali", guardianPhone: "0790000101" },
    { academyId, squadId, name: "Omar", guardianPhone: "0790000102" },
  ]);
});

beforeEach(() => {
  graphCalls.length = 0;
});

afterAll(async () => {
  for (const id of [academyId, otherAcademyId]) if (id) await db.delete(academiesTable).where(eq(academiesTable.id, id));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [ownerId, coachId, otherOwnerId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validation", () => {
  it("is owner-only and scoped to the academy", async () => {
    const p = await project();
    await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(coachId)).send({ targets: ["instagram"] }).expect(403);
    // Another academy's owner, through his own academy's path: not found.
    await request(app).post(`${base(otherAcademyId)}/projects/${p.id}/publish`).set(auth(otherOwnerId)).send({ targets: ["instagram"] }).expect(404);
    await request(app).post(`${base(otherAcademyId)}/projects/${p.id}/whatsapp`).set(auth(otherOwnerId))
      .send({ audience: { roles: ["parents"] }, message: "Hi" }).expect(404);
    await request(app).post(`${base(otherAcademyId)}/projects/${p.id}/to-ads`).set(auth(otherOwnerId)).expect(404);
    expect(graphCalls).toHaveLength(0);
  });

  it("needs a finished render: 409", async () => {
    const none = await project({ renderStatus: "none", outputPath: null, renderedAt: null });
    const busy = await project({ renderStatus: "rendering", outputPath: null, renderedAt: null });
    const a = await request(app).post(`${base()}/projects/${none.id}/publish`).set(auth(ownerId)).send({ targets: ["instagram"] }).expect(409);
    expect(a.body.code).toBe("not_rendered");
    const b = await request(app).post(`${base()}/projects/${busy.id}/publish`).set(auth(ownerId)).send({ targets: ["instagram"] }).expect(409);
    expect(b.body.code).toBe("rendering");
    await request(app).post(`${base()}/projects/${none.id}/whatsapp`).set(auth(ownerId)).send({ audience: { roles: ["parents"] }, message: "Hi" }).expect(409);
    await request(app).post(`${base()}/projects/${none.id}/to-ads`).set(auth(ownerId)).expect(409);
    const posts = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.academyId, academyId));
    expect(posts).toHaveLength(0);
  });

  it("refuses a past time and Facebook stories", async () => {
    const p = await project();
    const past = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId))
      .send({ targets: ["instagram"], scheduledAt: "2020-01-01T10:00" }).expect(400);
    expect(past.body.code).toBe("schedule_past");
    const story = await project({ format: "story" });
    const fb = await request(app).post(`${base()}/projects/${story.id}/publish`).set(auth(ownerId)).send({ targets: ["instagram", "facebook"] }).expect(400);
    expect(fb.body.code).toBe("story_facebook");
    const wrong = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId)).send({ targets: ["instagram"], placement: "story" }).expect(400);
    expect(wrong.body.allowed).toEqual(["feed"]);
  });
});

describe("Instagram and Facebook", () => {
  it("story format goes out as an Instagram story", async () => {
    const p = await project({ format: "story" });
    const res = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId))
      .send({ targets: ["instagram"], caption: "ignored for stories" }).expect(201);
    expect(res.body.post.status).toBe("published");
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, res.body.post.id));
    expect(post).toMatchObject({ format: "story", caption: "", targets: ["instagram"], source: "replay" });
    const container = graphCalls.find((c) => c.path === `${IG}/media`)!;
    expect(container.params.media_type).toBe("STORIES");
    expect(container.params.image_url).toMatch(/^https:\/\/replay\.test\/api\/social\/media\/\d+\/[0-9a-f]+\.jpg$/);
  });

  it("posts now, records every target and the media copy, and asks before posting the same render twice", async () => {
    const p = await project();
    const res = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId))
      .send({ targets: ["instagram", "facebook"], caption: "الفل تايم ⚽ #Galaxy" }).expect(201);
    expect(res.body.post.status).toBe("published");
    expect(res.body.project.status).toBe("published");
    expect(res.body.project.publishedAt).toBeTruthy();
    const row = await reload(p.id);
    const targets = row.publishTargets as Array<Record<string, unknown>>;
    expect(targets.map((t) => t.channel)).toEqual(["instagram", "facebook"]);
    expect(targets.every((t) => t.postId === res.body.post.id && t.ref === `post:${res.body.post.id}` && t.placement === "feed")).toBe(true);
    expect(targets[0].renderedAt).toBe("2026-11-02T09:00:00.000Z");
    const mediaId = targets[0].mediaId as number;
    const [media] = await db.select().from(academyAdMediaTable).where(eq(academyAdMediaTable.id, mediaId));
    expect(media).toMatchObject({ academyId, kind: "image", source: "studio_post", status: "ready", width: 1080, height: 1350 });
    expect(media.imageData).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(res.body.targets.map((t: { state: string }) => t.state)).toEqual(["published", "published"]);

    const again = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId)).send({ targets: ["instagram"] }).expect(409);
    expect(again.body).toMatchObject({ code: "already_posted", channels: ["instagram"] });
    const forced = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId)).send({ targets: ["instagram"], again: true }).expect(201);
    const after = (await reload(p.id)).publishTargets as Array<Record<string, unknown>>;
    expect(after).toHaveLength(3);
    // Same render → same library copy, not a second one.
    expect(after[2]).toMatchObject({ postId: forced.body.post.id, mediaId });
    const copies = await db.select().from(academyAdMediaTable).where(and(eq(academyAdMediaTable.academyId, academyId), eq(academyAdMediaTable.name, "Full time")));
    expect(copies.filter((m) => m.id === mediaId)).toHaveLength(1);
  });

  it("schedules in Amman time, hands off to the social worker and syncs back", async () => {
    const p = await project();
    const local = dateToAmmanLocal(new Date(Date.now() + 26 * 3600_000));
    const res = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId))
      .send({ targets: ["instagram", "facebook"], caption: "Saturday", scheduledAt: local }).expect(201);
    expect(graphCalls).toHaveLength(0);
    expect(res.body.post.status).toBe("scheduled");
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, res.body.post.id));
    expect(post.scheduledFor!.toISOString()).toBe(ammanLocalToDate(local)!.toISOString());
    // Jordan is UTC+3: the wall-clock hour the owner picked is 3 hours ahead of the stored UTC hour.
    expect((post.scheduledFor!.getUTCHours() + 3) % 24).toBe(Number(local.slice(11, 13)));
    expect(res.body.project.status).toBe("scheduled");
    expect(res.body.project.scheduledAt).toBe(post.scheduledFor!.toISOString());

    // The worker posts it to Instagram; Facebook fails.
    await db.update(academySocialPostsTable).set({ status: "partial", igMediaId: `ig-${stamp}`, igPermalink: "https://instagram.com/p/x", error: "Facebook: nope", publishedAt: new Date() })
      .where(eq(academySocialPostsTable.id, post.id));
    const history = await request(app).get(`${base()}/publish/history`).set(auth(ownerId)).expect(200);
    const item = history.body.items.find((i: { project: { id: number } }) => i.project.id === p.id);
    expect(item.project.status).toBe("published");
    expect(item.project.scene).toBeUndefined();
    expect(item.targets.map((t: { channel: string; state: string }) => `${t.channel}:${t.state}`)).toEqual(["instagram:published", "facebook:failed"]);
    expect(item.targets[0].permalink).toBe("https://instagram.com/p/x");
    expect(item.thumbUrl).toMatch(/\/ads\/media\/\d+\/thumb$/);
    expect((await reload(p.id)).status).toBe("published");
  });

  it("cancelling a waiting post sets the project back to ready", async () => {
    const p = await project();
    const local = dateToAmmanLocal(new Date(Date.now() + 3 * 86_400_000));
    const res = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId)).send({ targets: ["facebook"], scheduledAt: local }).expect(201);
    await request(app).delete(`${base()}/projects/${p.id}/publish/999999`).set(auth(ownerId)).expect(404);
    const cancelled = await request(app).delete(`${base()}/projects/${p.id}/publish/${res.body.post.id}`).set(auth(ownerId)).expect(200);
    expect(cancelled.body.project.status).toBe("ready");
    expect(cancelled.body.project.scheduledAt).toBeNull();
    expect(cancelled.body.targets).toEqual([]);
    const gone = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, res.body.post.id));
    expect(gone).toHaveLength(0);
  });

  it("a scheduled post that fails sends the project back to ready", async () => {
    const p = await project();
    const res = await request(app).post(`${base()}/projects/${p.id}/publish`).set(auth(ownerId))
      .send({ targets: ["instagram"], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201);
    await db.update(academySocialPostsTable).set({ status: "failed", error: "Instagram: media rejected" }).where(eq(academySocialPostsTable.id, res.body.post.id));
    const one = await request(app).get(`${base()}/projects/${p.id}/publish`).set(auth(ownerId)).expect(200);
    expect(one.body.project.status).toBe("ready");
    expect(one.body.targets[0]).toMatchObject({ state: "failed", error: "Instagram: media rejected" });
  });
});

describe("WhatsApp", () => {
  it("needs WhatsApp on, checks squads belong, queues text + the media link", async () => {
    const p = await project();
    const off = await request(app).post(`${base()}/projects/${p.id}/whatsapp`).set(auth(ownerId))
      .send({ audience: { roles: ["parents"], squadIds: [squadId] }, message: "Hi" }).expect(409);
    expect(off.body.code).toBe("whatsapp_off");
    await db.insert(academyWhatsappSettingsTable).values({ academyId, sender: "replay" });
    await request(app).post(`${base()}/projects/${p.id}/whatsapp`).set(auth(ownerId))
      .send({ audience: { roles: ["parents"], squadIds: [otherSquadId] }, message: "Hi" }).expect(404);
    const preview = await request(app).post(`${base()}/publish/whatsapp/preview`).set(auth(ownerId))
      .send({ audience: { roles: ["parents"], squadIds: [squadId] } }).expect(200);
    expect(preview.body).toMatchObject({ count: 2, squads: ["U12"] });

    const res = await request(app).post(`${base()}/projects/${p.id}/whatsapp`).set(auth(ownerId))
      .send({ audience: { roles: ["parents"], squadIds: [squadId] }, message: "شوفوا {player} 👏" }).expect(201);
    expect(res.body.queued).toBe(2);
    expect(res.body.project.status).toBe("published");
    const queued = await db.select().from(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.broadcastId, res.body.broadcastId));
    expect(queued).toHaveLength(2);
    for (const m of queued) {
      expect(m.status).toBe("queued");
      expect(m.body).toMatch(/^شوفوا (Ali|Omar) 👏\n\nhttps:\/\/replay\.test\/api\/social\/media\/\d+\/[0-9a-f]+\.jpg$/);
    }
    const targets = (await reload(p.id)).publishTargets as Array<Record<string, unknown>>;
    expect(targets).toEqual([expect.objectContaining({ channel: "whatsapp", ref: `broadcast:${res.body.broadcastId}`, recipients: 2 })]);

    const twice = await request(app).post(`${base()}/projects/${p.id}/whatsapp`).set(auth(ownerId))
      .send({ audience: { roles: ["parents"], squadIds: [squadId] }, message: "again" }).expect(409);
    expect(twice.body.code).toBe("already_sent");
  });
});

describe("ads and channels", () => {
  it("adds the render to ad media once", async () => {
    const p = await project({ title: "For ads" });
    const first = await request(app).post(`${base()}/projects/${p.id}/to-ads`).set(auth(ownerId)).expect(201);
    expect(first.body.media).toMatchObject({ kind: "image", source: "studio_post", status: "ready" });
    expect(first.body.media.thumbUrl).toBe(`/api/academy/console/academies/${academyId}/ads/media/${first.body.media.id}/thumb`);
    const second = await request(app).post(`${base()}/projects/${p.id}/to-ads`).set(auth(ownerId)).expect(200);
    expect(second.body.media.id).toBe(first.body.media.id);
    const targets = (await reload(p.id)).publishTargets as Array<Record<string, unknown>>;
    expect(targets).toEqual([expect.objectContaining({ channel: "ad", mediaId: first.body.media.id, ref: `media:${first.body.media.id}` })]);
    expect((await reload(p.id)).status).toBe("draft");
  });

  it("records a download once per render", async () => {
    const p = await project();
    await request(app).post(`${base()}/projects/${p.id}/downloaded`).set(auth(ownerId)).expect(204);
    await request(app).post(`${base()}/projects/${p.id}/downloaded`).set(auth(ownerId)).expect(204);
    expect((await reload(p.id)).publishTargets).toEqual([expect.objectContaining({ channel: "download", renderedAt: "2026-11-02T09:00:00.000Z" })]);
  });

  it("lists what is connected", async () => {
    const res = await request(app).get(`${base()}/publish/channels`).set(auth(ownerId)).expect(200);
    expect(res.body.social).toMatchObject({ status: "connected", instagram: { username: "galaxy.academy" }, facebook: { pageName: "Galaxy Academy" } });
    expect(res.body.whatsapp.squads).toEqual([{ id: squadId, name: "U12", players: 2 }]);
    expect(res.body.ads).toMatchObject({ available: true, mode: "replay", walletFils: 0 });
    expect(res.body.hashtag).toBe(`#GalaxyAcademy${stamp}`);
    await request(app).get(`${base()}/publish/channels`).set(auth(coachId)).expect(403);
    const other = await request(app).get(`${base(otherAcademyId)}/publish/channels`).set(auth(otherOwnerId)).expect(200);
    expect(other.body.social.status).toBe("none");
  });
});
