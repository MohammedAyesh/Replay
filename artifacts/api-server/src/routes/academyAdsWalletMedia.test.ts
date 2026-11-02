import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import {
  academiesTable,
  academyAdMediaTable,
  academyAdRequestsTable,
  academyAdWalletEntriesTable,
  academyMembersTable,
  academyMetaConnectionsTable,
  db,
  fieldsTable,
  metaAdCampaignsTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";

process.env.META_ACCESS_TOKEN = "replay-token";
process.env.META_AD_ACCOUNT_ID = "111";
process.env.META_APP_SECRET = "test-app-secret";
process.env.META_BUSINESS_ID = "999";

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

const tag = Date.now();
const PAGE = `7${tag}`;
const posts: Array<{ path: string; params: Record<string, string> }> = [];
const uploads: string[] = [];
const stored = new Map<string, string>();

vi.mock("../lib/meta/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/graph")>();
  let n = 0;
  return {
    ...actual,
    graphGet: vi.fn(async (p: string) => {
      if (p === "act_111") return { currency: "USD", name: "Qudra LLC" };
      if (p === PAGE) return { access_token: "page-token" };
      throw new actual.MetaGraphError(`unexpected GET ${p}`, 404);
    }),
    graphPost: vi.fn(async (p: string, params: Record<string, string>) => {
      posts.push({ path: p, params });
      if (p.endsWith("/adimages")) return { images: { bytes: { hash: `hash${posts.length}` } } };
      if (p.endsWith("/leadgen_forms")) return { id: "form9" };
      n += 1;
      if (p.endsWith("/campaigns")) return { id: `wc${tag}${n}` };
      if (p.endsWith("/adsets")) return { id: `was${n}` };
      if (p.endsWith("/adcreatives")) return { id: `wcr${n}` };
      if (p.endsWith("/ads")) return { id: `wad${tag}${n}` };
      return { success: true };
    }),
    graphDelete: vi.fn(async () => undefined),
    graphUploadVideo: vi.fn(async (act: string, file: string) => {
      uploads.push(`${act}:${fs.statSync(file).size}`);
      return `vid${uploads.length}`;
    }),
    waitForVideo: vi.fn(async () => "ready"),
  };
});

// Bunny Storage stands in as a temp folder.
vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    uploadFileToBunnyStoragePath: vi.fn(async (file: string, remote: string) => {
      const url = `https://storage.test/${remote}`;
      const copy = path.join(os.tmpdir(), `stored-${stored.size}-${path.basename(remote)}`);
      fs.copyFileSync(file, copy);
      stored.set(url, copy);
      return url;
    }),
  };
});
vi.mock("../lib/backupExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backupExport")>();
  return {
    ...actual,
    fetchExportObject: vi.fn(async (url: string) => {
      const file = stored.get(url);
      if (!file) return new Response("missing", { status: 404 });
      return new Response(fs.readFileSync(file), { status: 200, headers: { "content-type": "video/mp4" } });
    }),
  };
});

import adsRouter from "./academyAds";
import walletRouter from "./academyAdWallet";
import mediaRouter from "./academyAdMedia";
import templatesRouter from "./academyAdTemplates";
import { chargeFils, chargedNumbers, closeEndedAds, ledgerNumbers, metaBudgetFor, settleWallets, walletBalanceFils } from "../lib/meta/wallet";
import { creativeFor, leadFormSpec } from "../lib/meta/launch";

let app: Express;
let adminId: number;
let ownerId: number;
let coachId: number;
let academyId: number;
let fieldId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = `/api/academy/console/academies`;
let video: string;
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

beforeAll(async () => {
  app = express();
  app.use(express.json({ limit: "20mb" }));
  for (const r of [adsRouter, walletRouter, mediaRouter, templatesRouter]) app.use("/api", r);
  const users = await db.insert(usersTable).values([
    { name: `Admin ${tag}`, email: `admin-w-${tag}@test.local`, isAdmin: true },
    { name: `Owner ${tag}`, email: `owner-w-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-w-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [adminId, ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `W field ${tag}`, cameraId: "camera1", latitude: 31.95, longitude: 35.91 }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `Wallet ${tag}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
  await db.insert(academyMetaConnectionsTable).values({ academyId, mode: "replay", pageId: PAGE, pageName: "W", status: "connected", leadsSubscribed: true });
  video = path.join(os.tmpdir(), `ad-test-${tag}.mp4`);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=10", "-t", "2", "-pix_fmt", "yuv420p", "-y", video]);
});

afterAll(() => {
  fs.rmSync(video, { force: true });
  for (const f of stored.values()) fs.rmSync(f, { force: true });
});

describe("the ad rate", () => {
  it("charges Meta's dollars in JOD with Replay's margin, and budgets so a day costs at most the owner's figure", () => {
    expect(chargeFils(1000, "USD")).toBe(7586); // $10 → 7.586 JOD
    expect(chargeFils(1000, "JOD")).toBe(10700);
    const budget = metaBudgetFor(5000, "USD");
    expect(budget).toBe(659);
    expect(chargeFils(budget, "USD")).toBeLessThanOrEqual(5000);
    expect(chargedNumbers({ spend: 10, impressions: 5, reach: 4, clicks: 1, conversations: 2, leads: 0, currency: "USD" }))
      .toMatchObject({ spend: 7.59, currency: "JOD", conversations: 2 });
    // Owner numbers come from the ledger: a variant with 25% of Meta's spend shows 25% of the charge.
    const n = { spend: 2.5, impressions: 0, reach: 0, clicks: 0, conversations: 0, leads: 0, currency: "USD" };
    expect(ledgerNumbers(n, 7586, 10)).toMatchObject({ spend: 1.9, currency: "JOD" });
    expect(ledgerNumbers(n, undefined, 10)).toMatchObject({ spend: null, currency: "JOD" });
  });
});

describe("the wallet", () => {
  it("lets the owner ask for a CliQ top-up that only counts once an admin confirms it", async () => {
    await request(app).get(`${base}/${academyId}/ads/wallet`).set(auth(coachId)).expect(403);
    await request(app).post(`${base}/${academyId}/ads/wallet/topups`).set(auth(ownerId)).send({ amount: 5 }).expect(400);
    const topup = await request(app).post(`${base}/${academyId}/ads/wallet/topups`).set(auth(ownerId)).send({ amount: 25 }).expect(201);
    expect(topup.body).toMatchObject({ status: "pending", amount: 25, reference: expect.stringMatching(new RegExp(`^AD${academyId}-\\d{4}$`)) });
    const before = await request(app).get(`${base}/${academyId}/ads/wallet`).set(auth(ownerId)).expect(200);
    expect(before.body).toMatchObject({ balance: 0, currency: "JOD", pending: [expect.objectContaining({ amount: 25 })] });
    expect(JSON.stringify(before.body)).not.toMatch(/margin|0\.07/);

    await request(app).post(`/api/admin/meta-ads/wallets/topups/${topup.body.id}/confirm`).set(auth(ownerId)).send({}).expect(403);
    const confirmed = await request(app).post(`/api/admin/meta-ads/wallets/topups/${topup.body.id}/confirm`).set(auth(adminId)).send({ amount: 30 }).expect(200);
    expect(confirmed.body.balance).toBe(30);
    await request(app).post(`/api/admin/meta-ads/wallets/topups/${topup.body.id}/confirm`).set(auth(adminId)).send({}).expect(404);
  });

  it("charges new spend once, and pauses the academy's ads when the wallet runs low", async () => {
    const [req] = await db.insert(academyAdRequestsTable).values({
      academyId, mode: "replay", goal: "whatsapp", name: "Running", status: "active", dailyBudget: 659, budgetFils: 5000,
      currency: "USD", headline: "H", primaryText: "T", metaCampaignId: `run${tag}`,
    }).returning();
    await db.insert(metaAdCampaignsTable).values({ id: `run${tag}`, academyId, name: "Running", status: "ACTIVE", insights: { spend: 10, impressions: 0, reach: 0, clicks: 0, conversations: 0, leads: 0, currency: "USD" } });
    const paused: number[] = [];
    const pause = async (r: { id: number }) => { paused.push(r.id); await db.update(academyAdRequestsTable).set({ status: "paused", pausedReason: "funds" }).where(eq(academyAdRequestsTable.id, r.id)); return true; };

    await settleWallets(pause);
    expect(await walletBalanceFils(academyId)).toBe(30000 - 7586);
    await settleWallets(pause); // nothing new
    expect(await walletBalanceFils(academyId)).toBe(30000 - 7586);
    expect(paused).toEqual([]);

    // $40 lifetime: another $30 charged, leaving less than a quarter of a day.
    await db.update(metaAdCampaignsTable).set({ insights: { spend: 40, impressions: 0, reach: 0, clicks: 0, conversations: 0, leads: 0, currency: "USD" } }).where(eq(metaAdCampaignsTable.id, `run${tag}`));
    await settleWallets(pause);
    expect(await walletBalanceFils(academyId)).toBe(30000 - chargeFils(4000, "USD"));
    expect(paused).toEqual([req.id]);
    const [row] = await db.select().from(academyAdRequestsTable).where(eq(academyAdRequestsTable.id, req.id));
    expect(row.pausedReason).toBe("funds");

    const spend = await db.select().from(academyAdWalletEntriesTable).where(eq(academyAdWalletEntriesTable.campaignId, `run${tag}`));
    expect(spend.map((s) => s.metaSpendCents)).toEqual([1000, 3000]);

    // The owner sees the day's charge per ad, and the admin sees what Replay earned.
    const wallet = await request(app).get(`${base}/${academyId}/ads/wallet`).set(auth(ownerId)).expect(200);
    expect(wallet.body.history.find((h: { kind: string }) => h.kind === "spend")).toMatchObject({ amount: -chargeFils(4000, "USD") / 1000, campaignName: "Running" });
    const admin = await request(app).get("/api/admin/meta-ads/wallets").set(auth(adminId)).expect(200);
    const mine = admin.body.wallets.find((w: { academyId: number }) => w.academyId === academyId);
    expect(mine).toMatchObject({ metaCost: 28.36, charged: 30.345, earned: expect.closeTo(1.985, 2) });

    // A top-up switches it back on (Replay's token pauses/resumes on Meta).
    await db.update(academyAdRequestsTable).set({ status: "paused" }).where(eq(academyAdRequestsTable.id, req.id));
    const credit = await request(app).post(`/api/admin/meta-ads/wallets/${academyId}/adjust`).set(auth(adminId)).send({ amount: 20, note: "cash" }).expect(201);
    expect(credit.body.resumed).toEqual([req.id]);
    const [after] = await db.select().from(academyAdRequestsTable).where(eq(academyAdRequestsTable.id, req.id));
    expect(after).toMatchObject({ status: "active", pausedReason: null });
    await db.update(academyAdRequestsTable).set({ status: "paused" }).where(eq(academyAdRequestsTable.id, req.id));
  });
});

describe("wallet edge cases", () => {
  it("never charges an ad from before the wallet, and stops counting ads past their end date", async () => {
    const [legacy] = await db.insert(academyAdRequestsTable).values({
      academyId, mode: "replay", goal: "whatsapp", name: "Old", status: "active", dailyBudget: 750, budgetFils: null,
      currency: "USD", headline: "H", primaryText: "T", metaCampaignId: `old${tag}`,
    }).returning();
    await db.insert(metaAdCampaignsTable).values({ id: `old${tag}`, academyId, name: "Old", status: "ACTIVE", insights: { spend: 200, impressions: 0, reach: 0, clicks: 0, conversations: 0, leads: 0, currency: "USD" } });
    const before = await walletBalanceFils(academyId);
    const paused: number[] = [];
    await settleWallets(async (r) => { paused.push(r.id); return true; });
    expect(await walletBalanceFils(academyId)).toBe(before);
    expect(paused).not.toContain(legacy.id);

    const [ended] = await db.insert(academyAdRequestsTable).values({
      academyId, mode: "replay", goal: "whatsapp", name: "Done", status: "active", dailyBudget: 659, budgetFils: 5000,
      currency: "USD", headline: "H", primaryText: "T", endAt: new Date(Date.now() - 3600_000),
    }).returning();
    expect(await closeEndedAds()).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(academyAdRequestsTable).where(eq(academyAdRequestsTable.id, ended.id));
    expect(row).toMatchObject({ status: "paused", pausedReason: "ended" });
    await request(app).post(`${base}/${academyId}/ads/requests/${ended.id}/resume`).set(auth(ownerId)).expect(409);
    await db.delete(academyAdRequestsTable).where(inArray(academyAdRequestsTable.id, [legacy.id, ended.id]));
  });

  it("counts the academy's other waiting ads when checking the wallet", async () => {
    const balance = await walletBalanceFils(academyId);
    // Each fits on its own (3 days), but not alongside a day of the other.
    const daily = Math.floor(balance / 3.5 / 1000);
    const make = async (name: string) => (await request(app).post(`${base}/${academyId}/ads/requests`).set(auth(ownerId)).send({
      goal: "whatsapp", name, dailyBudget: daily, radiusKm: 10, ageMin: 25, ageMax: 50, locale: "ar", variants: [{ headline: "H", primaryText: "T" }], imageData: JPEG,
    }).expect(201)).body.id as number;
    const first = await make("First");
    const second = await make("Second");
    await request(app).post(`${base}/${academyId}/ads/requests/${first}/submit`).set(auth(ownerId)).expect(200);
    const refused = await request(app).post(`${base}/${academyId}/ads/requests/${second}/submit`).set(auth(ownerId)).expect(402);
    expect(refused.body.need).toBe(daily * 3 + daily);
    await db.delete(academyAdRequestsTable).where(inArray(academyAdRequestsTable.id, [first, second]));
  });

  it("lets the owner keep a funds-paused ad off, so a top-up doesn't restart it", async () => {
    const [r] = await db.insert(academyAdRequestsTable).values({
      academyId, mode: "replay", goal: "whatsapp", name: "Keep off", status: "paused", pausedReason: "funds", dailyBudget: 659, budgetFils: 1000,
      currency: "USD", headline: "H", primaryText: "T", metaCampaignId: `keep${tag}`,
    }).returning();
    await db.insert(metaAdCampaignsTable).values({ id: `keep${tag}`, academyId, name: "Keep off", status: "PAUSED" });
    const kept = await request(app).post(`${base}/${academyId}/ads/requests/${r.id}/pause`).set(auth(ownerId)).expect(200);
    expect(kept.body.pausedReason).toBeNull();
    const credit = await request(app).post(`/api/admin/meta-ads/wallets/${academyId}/adjust`).set(auth(adminId)).send({ amount: 50, note: "credit" }).expect(201);
    expect(credit.body.resumed).not.toContain(r.id);
    await db.delete(academyAdRequestsTable).where(eq(academyAdRequestsTable.id, r.id));
  });
});

describe("ad media", () => {
  let imageId: number;
  let videoId: number;

  it("takes a photo or a video from the phone, with a still for the video", async () => {
    await request(app).post(`${base}/${academyId}/ads/media`).set(auth(coachId)).attach("file", Buffer.from(JPEG.split(",")[1], "base64"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(403);
    const image = await request(app).post(`${base}/${academyId}/ads/media`).set(auth(ownerId))
      .attach("file", Buffer.from(JPEG.split(",")[1], "base64"), { filename: "pitch.jpg", contentType: "image/jpeg" }).expect(201);
    expect(image.body).toMatchObject({ kind: "image", name: "pitch.jpg", thumbUrl: expect.stringContaining(`/media/${image.body.id}/thumb`) });
    imageId = image.body.id;
    const thumb = await request(app).get(`${base}/${academyId}/ads/media/${imageId}/thumb`).set(auth(ownerId)).expect(200);
    expect(thumb.headers["content-type"]).toBe("image/jpeg");

    const clip = await request(app).post(`${base}/${academyId}/ads/media`).set(auth(ownerId))
      .attach("file", video, { filename: "goal.mp4", contentType: "video/mp4" }).expect(201);
    expect(clip.body).toMatchObject({ kind: "video", width: 320, height: 568, durationSec: 2, fileUrl: expect.stringContaining("/file") });
    videoId = clip.body.id;
    const [row] = await db.select().from(academyAdMediaTable).where(eq(academyAdMediaTable.id, videoId));
    expect(row.imageData).toMatch(/^data:image\/jpeg;base64,/);
    const file = await request(app).get(`${base}/${academyId}/ads/media/${videoId}/file`).set(auth(ownerId))
      .buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); })
      .expect(200);
    expect(file.headers["content-type"]).toBe("video/mp4");
    expect((file.body as Buffer).length).toBe(fs.statSync(video).size);
    await request(app).get(`${base}/${academyId}/ads/media/${videoId}/file`).set(auth(coachId)).expect(403);

    await request(app).post(`${base}/${academyId}/ads/media`).set(auth(ownerId))
      .attach("file", Buffer.from("not a video"), { filename: "x.mp4", contentType: "video/mp4" }).expect(400);
  });

  it("adds a Studio post, and a rendered academy clip but not another academy's", async () => {
    const post = await request(app).post(`${base}/${academyId}/ads/media/from-image`).set(auth(ownerId)).send({ dataUrl: JPEG, name: "Result" }).expect(201);
    expect(post.body).toMatchObject({ kind: "image", source: "studio_post" });

    const [mine] = await db.insert(userClipsTable).values({ userId: ownerId, title: "Goal", videoId: "v1", startTime: "0", endTime: "2", academyId, exportStatus: "done", exportedUrl: "https://storage.test/exports/1.mp4" }).returning();
    stored.set("https://storage.test/exports/1.mp4", video);
    const [notExported] = await db.insert(userClipsTable).values({ userId: ownerId, title: "Raw", videoId: "v1", startTime: "0", endTime: "2", academyId }).returning();
    const [elsewhere] = await db.insert(userClipsTable).values({ userId: ownerId, title: "Other", videoId: "v1", startTime: "0", endTime: "2", exportStatus: "done", exportedUrl: "https://storage.test/exports/1.mp4" }).returning();
    await request(app).post(`${base}/${academyId}/ads/media/from-clip`).set(auth(ownerId)).send({ userClipId: elsewhere.id }).expect(404);
    const wait = await request(app).post(`${base}/${academyId}/ads/media/from-clip`).set(auth(ownerId)).send({ userClipId: notExported.id }).expect(409);
    expect(wait.body.code).toBe("not_exported");
    const added = await request(app).post(`${base}/${academyId}/ads/media/from-clip`).set(auth(ownerId)).send({ userClipId: mine.id }).expect(201);
    expect(added.body).toMatchObject({ kind: "video", source: "studio_clip", userClipId: mine.id });
    // Asking again returns the same media.
    const again = await request(app).post(`${base}/${academyId}/ads/media/from-clip`).set(auth(ownerId)).send({ userClipId: mine.id }).expect(200);
    expect(again.body.id).toBe(added.body.id);
  });

  it("launches a carousel with a video card and two text versions as two ads, with the form's questions", async () => {
    posts.length = 0;
    const body = {
      goal: "lead_form", name: "Camp", dailyBudget: 5, radiusKm: 10, ageMin: 25, ageMax: 50, locale: "ar",
      variants: [{ headline: "Camp A", primaryText: "Text A" }, { headline: "Camp B", primaryText: "Text B" }],
      cards: [{ mediaId: imageId, headline: "The pitch" }, { mediaId: videoId, headline: "A goal" }],
      questions: [{ label: "Child's age", options: ["5–7", "8–10"] }, { label: "Anything else?" }],
    };
    await request(app).post(`${base}/${academyId}/ads/requests`).set(auth(ownerId)).send({ ...body, cards: [{ mediaId: 999999 }] }).expect(400);
    const created = await request(app).post(`${base}/${academyId}/ads/requests`).set(auth(ownerId)).send(body).expect(201);
    expect(created.body).toMatchObject({ variants: body.variants, questions: body.questions, cards: body.cards, dailyBudget: 5, currency: "JOD" });
    await request(app).post(`${base}/${academyId}/ads/requests/${created.body.id}/submit`).set(auth(ownerId)).expect(200);
    const approved = await request(app).post(`/api/admin/meta-ads/requests/${created.body.id}/approve`).set(auth(adminId)).expect(200);
    expect(approved.body.status).toBe("active");
    expect(approved.body.metaAds).toHaveLength(2);

    const creatives = posts.filter((p) => p.path === "act_111/adcreatives").map((p) => JSON.parse(p.params.object_story_spec));
    expect(creatives).toHaveLength(2);
    expect(creatives[0].link_data.child_attachments).toHaveLength(2);
    expect(creatives[0].link_data.child_attachments[1]).toMatchObject({ name: "A goal", video_id: expect.stringMatching(/^vid/) });
    expect(creatives[1].link_data.message).toBe("Text B");
    expect(posts.filter((p) => p.path === "act_111/ads").map((p) => p.params.name)).toEqual(["Camp · A", "Camp · B"]);
    const form = posts.find((p) => p.path.endsWith("/leadgen_forms"))!;
    expect(JSON.parse(form.params.questions)).toEqual([
      { type: "FULL_NAME" }, { type: "PHONE" },
      { type: "CUSTOM", key: "q1", label: "Child's age", options: [{ value: "5–7", key: "q1_1" }, { value: "8–10", key: "q1_2" }] },
      { type: "CUSTOM", key: "q2", label: "Anything else?" },
    ]);
    expect(uploads[0]).toMatch(/^act_111:/);
  });

  it("builds a single video ad with the still as its thumbnail", () => {
    const spec = creativeFor("whatsapp", "p1", { headline: "H", primaryText: "T" }, [{ imageHash: "h", videoId: "v" }], null);
    expect(spec).toMatchObject({ video_data: { video_id: "v", image_hash: "h", title: "H", message: "T", call_to_action: { type: "WHATSAPP_MESSAGE" } } });
    const legacy = leadFormSpec({ name: "N", locale: "en", extraQuestion: "Age?", headline: "H", questions: null }, "A");
    expect(JSON.parse(legacy.questions)[2]).toEqual({ type: "CUSTOM", key: "extra", label: "Age?" });
  });
});

describe("templates", () => {
  it("gives owners Replay's starter campaigns, and lets admins edit the list", async () => {
    await request(app).get(`${base}/${academyId}/ads/templates`).set(auth(coachId)).expect(403);
    const list = await request(app).get(`${base}/${academyId}/ads/templates`).set(auth(ownerId)).expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(5);
    const camp = list.body.find((t: { key: string }) => t.key === "summer_camp");
    expect(camp).toMatchObject({ goal: "lead_form", dailyBudget: 6, questions: expect.arrayContaining([expect.objectContaining({ options: expect.any(Array) })]) });
    expect(camp.variants.some((v: { locale: string }) => v.locale === "ar")).toBe(true);

    await request(app).post("/api/admin/meta-ads/templates").set(auth(ownerId)).send({}).expect(403);
    const made = await request(app).post("/api/admin/meta-ads/templates").set(auth(adminId)).send({
      title: "Ramadan nights", goal: "whatsapp", variants: [{ locale: "ar", headline: "ليالي رمضان", primaryText: "تدريب بعد الإفطار في {academy}" }],
      dailyBudget: 3, days: 20, ageMin: 25, ageMax: 50, radiusKm: 8,
    }).expect(201);
    await request(app).put(`/api/admin/meta-ads/templates/${made.body.id}`).set(auth(adminId)).send({ ...made.body, title: "Ramadan", isActive: false }).expect(200);
    const after = await request(app).get(`${base}/${academyId}/ads/templates`).set(auth(ownerId)).expect(200);
    expect(after.body.some((t: { id: number }) => t.id === made.body.id)).toBe(false);
    await request(app).delete(`/api/admin/meta-ads/templates/${made.body.id}`).set(auth(adminId)).expect(204);
  });
});
