import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyAdRequestsTable,
  academyMembersTable,
  academyMetaConnectionsTable,
  db,
  fieldsTable,
  metaAdCampaignsTable,
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
const SHARED_PAGE = `5${tag}`;
const OWN_PAGE = `6${tag}`;
let failCreative = false;
const posts: Array<{ path: string; params: Record<string, string>; token?: string }> = [];
const deletes: string[] = [];

vi.mock("../lib/meta/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/graph")>();
  let n = 0;
  return {
    ...actual,
    graphGet: vi.fn(async (path: string, _params: Record<string, string>, opts: { token?: string } = {}) => {
      if (path === "act_111") return { currency: "USD", name: "Qudra LLC" };
      if (path === "me" && !opts.token) return { id: "su-1" };
      if (path === `${SHARED_PAGE}`) return { id: SHARED_PAGE, name: "Galaxy Academy", access_token: "page-token", whatsapp_number: "962790000000" };
      if (path === "galaxy.academy") return { id: SHARED_PAGE, name: "Galaxy Academy", access_token: "page-token" };
      if (path === "notshared") return { id: "777", name: "Someone Else" };
      if (path === "999/client_pages") return { data: [] };
      if (path === "me" && opts.token === "own-token") return { id: "bisu", client_business_id: "cb-1" };
      if (path === "me/adaccounts") return { data: [{ id: "act_222", name: "Owner Ads", currency: "JOD", account_status: 1 }] };
      if (path === "me/accounts") return { data: [{ id: OWN_PAGE, name: "Owner Page", access_token: "own-page-token" }] };
      if (path === OWN_PAGE) return { access_token: "own-page-token" };
      throw new actual.MetaGraphError(`unexpected GET ${path}`, 404);
    }),
    graphPost: vi.fn(async (path: string, params: Record<string, string>, opts: { token?: string } = {}) => {
      posts.push({ path, params, token: opts.token });
      if (path.endsWith("/subscribed_apps")) return { success: true };
      if (path.endsWith("/adimages")) return { images: { bytes: { hash: "imghash" } } };
      if (path.endsWith("/leadgen_forms")) return { id: "form1" };
      if (path.endsWith("/adcreatives") && failCreative) throw new actual.MetaGraphError("Invalid creative", 400);
      n += 1;
      if (path.endsWith("/campaigns")) return { id: `c${tag}${n}` };
      if (path.endsWith("/adsets")) return { id: `as${n}` };
      if (path.endsWith("/adcreatives")) return { id: `cr${n}` };
      if (path.endsWith("/ads")) return { id: `ad${tag}${n}` };
      return { success: true };
    }),
    graphDelete: vi.fn(async (path: string) => {
      deletes.push(path);
    }),
  };
});

import adsRouter from "./academyAds";
import { decryptToken, encryptToken } from "../lib/meta/crypto";
import { parsePageRef } from "../lib/meta/connections";
import { creativeSpec, targetingFor } from "../lib/meta/launch";

let app: Express;
let adminId: number;
let ownerId: number;
let coachId: number;
let fieldId: number;
let academyId: number;
let ownAcademyId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = (id: number) => `/api/academy/console/academies/${id}/ads`;
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const ad = (patch: Record<string, unknown> = {}) => ({
  goal: "whatsapp", name: "Summer camp", dailyBudget: 7.5, radiusKm: 12, ageMin: 25, ageMax: 50,
  headline: "Summer camp U10", primaryText: "سجّل ابنك بالمعسكر الصيفي", locale: "ar", imageData: IMAGE, ...patch,
});

beforeAll(async () => {
  app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", adsRouter);
  const users = await db.insert(usersTable).values([
    { name: `Admin ${tag}`, email: `admin-ads-${tag}@test.local`, isAdmin: true },
    { name: `Owner ${tag}`, email: `owner-ads-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-ads-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [adminId, ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Ads field ${tag}`, cameraId: "camera1", latitude: 31.95, longitude: 35.91 }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const academies = await db.insert(academiesTable).values([{ name: `Galaxy ${tag}`, fieldId }, { name: `Own ${tag}`, fieldId }]).returning({ id: academiesTable.id });
  [academyId, ownAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: ownAcademyId, userId: ownerId, role: "owner" },
  ]);
});

beforeEach(() => {
  posts.length = 0;
  deletes.length = 0;
  failCreative = false;
});

afterAll(async () => {
  await db.delete(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.academyId, academyId));
  await db.delete(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.academyId, ownAcademyId));
  for (const id of [academyId, ownAcademyId]) if (id) await db.delete(academiesTable).where(eq(academiesTable.id, id));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [adminId, ownerId, coachId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("pure parts", () => {
  it("reads a Page from a link, an id or a handle", () => {
    expect(parsePageRef("https://www.facebook.com/galaxy.academy/")).toBe("galaxy.academy");
    expect(parsePageRef("https://facebook.com/profile.php?id=61596376490692")).toBe("61596376490692");
    expect(parsePageRef("61596376490692")).toBe("61596376490692");
    expect(parsePageRef("@galaxy.academy")).toBe("galaxy.academy");
    expect(parsePageRef("https://facebook.com/profile.php")).toBeNull();
    expect(parsePageRef("")).toBeNull();
  });

  it("encrypts tokens so only the app secret reads them", () => {
    const stored = encryptToken("secret-token", "s1");
    expect(stored).not.toContain("secret-token");
    expect(decryptToken(stored, "s1")).toBe("secret-token");
    expect(() => decryptToken(stored, "s2")).toThrow();
  });

  it("targets a radius around the pitch and keeps ages in Meta's range", () => {
    expect(targetingFor({ latitude: 31.9, longitude: 35.9, radiusKm: 200, ageMin: 13, ageMax: 70 })).toMatchObject({
      geo_locations: { custom_locations: [{ latitude: 31.9, longitude: 35.9, radius: 80, distance_unit: "kilometer" }] },
      age_min: 18,
      age_max: 65,
    });
    expect(creativeSpec({ goal: "whatsapp", headline: "H", primaryText: "T" }, "p1", "hash", null).link_data.call_to_action.type).toBe("WHATSAPP_MESSAGE");
    expect(creativeSpec({ goal: "lead_form", headline: "H", primaryText: "T" }, "p1", "hash", "f1").link_data.call_to_action).toEqual({ type: "SIGN_UP", value: { lead_gen_form_id: "f1" } });
  });
});

describe("connecting Meta", () => {
  it("only lets the owner see or change the connection", async () => {
    await request(app).get(`${base(academyId)}/connection`).set(auth(coachId)).expect(403);
    const res = await request(app).get(`${base(academyId)}/connection`).set(auth(ownerId)).expect(200);
    expect(res.body).toMatchObject({ connection: null, replay: { available: true, businessId: "999" } });
  });

  it("says when a Page isn't shared yet, and connects one that is", async () => {
    const missing = await request(app).post(`${base(academyId)}/connection/share`).set(auth(ownerId)).send({ page: "https://facebook.com/notshared" }).expect(200);
    expect(missing.body).toMatchObject({ status: "not_shared", businessId: "999", pageName: "Someone Else" });
    const ok = await request(app).post(`${base(academyId)}/connection/share`).set(auth(ownerId)).send({ page: "https://facebook.com/galaxy.academy" }).expect(200);
    expect(ok.body).toMatchObject({ status: "connected", pageId: SHARED_PAGE, pageName: "Galaxy Academy", leadsSubscribed: true });
    expect(posts.find((p) => p.path === `${SHARED_PAGE}/subscribed_apps`)?.token).toBe("page-token");
  });

  it("connects an owner's own business from the Login for Business code, token kept encrypted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "own-token" }), { status: 200 }));
    const res = await request(app).post(`${base(ownAcademyId)}/connection/own`).set(auth(ownerId)).send({ code: "abc" }).expect(200);
    fetchSpy.mockRestore();
    expect(res.body.assets.adAccounts[0]).toMatchObject({ id: "act_222", currency: "JOD" });
    // One account and one Page: picked straight away.
    expect(res.body.connection).toMatchObject({ mode: "own", status: "connected", adAccountId: "act_222", pageId: OWN_PAGE, currency: "JOD" });
    const [row] = await db.select().from(academyMetaConnectionsTable).where(eq(academyMetaConnectionsTable.academyId, ownAcademyId));
    expect(row.tokenEnc).toBeTruthy();
    expect(row.tokenEnc).not.toContain("own-token");
    expect(decryptToken(row.tokenEnc!)).toBe("own-token");
  });
});

describe("building ads", () => {
  it("keeps a Replay-account ad waiting for Replay's approval, then launches it paused-first", async () => {
    const created = await request(app).post(`${base(academyId)}/requests`).set(auth(ownerId)).send(ad()).expect(201);
    expect(created.body).toMatchObject({ mode: "replay", status: "draft", currency: "USD", dailyBudget: 7.5, latitude: expect.closeTo(31.95, 2) });
    const id = created.body.id;
    const submitted = await request(app).post(`${base(academyId)}/requests/${id}/submit`).set(auth(ownerId)).expect(200);
    expect(submitted.body.status).toBe("pending_approval");
    expect(posts.some((p) => p.path.endsWith("/campaigns"))).toBe(false);

    await request(app).post(`/api/admin/meta-ads/requests/${id}/approve`).set(auth(ownerId)).expect(403);
    const approved = await request(app).post(`/api/admin/meta-ads/requests/${id}/approve`).set(auth(adminId)).expect(200);
    expect(approved.body).toMatchObject({ status: "active" });
    const paths = posts.map((p) => p.path);
    expect(paths.slice(0, 5)).toEqual(["act_111/adimages", "act_111/campaigns", "act_111/adsets", "act_111/adcreatives", "act_111/ads"]);
    const adset = posts.find((p) => p.path === "act_111/adsets")!.params;
    expect(adset).toMatchObject({ daily_budget: "750", destination_type: "WHATSAPP", optimization_goal: "CONVERSATIONS", status: "PAUSED" });
    // Everything was created paused and switched on last, ad first.
    expect(posts.slice(-3).every((p) => p.params.status === "ACTIVE")).toBe(true);
    const [campaign] = await db.select().from(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.id, approved.body.metaCampaignId));
    expect(campaign.academyId).toBe(academyId);

    const paused = await request(app).post(`${base(academyId)}/requests/${id}/pause`).set(auth(ownerId)).expect(200);
    expect(paused.body.status).toBe("paused");
  });

  it("deletes what it made when Meta refuses part-way, and lets the owner fix and resubmit", async () => {
    const created = await request(app).post(`${base(academyId)}/requests`).set(auth(ownerId)).send(ad({ name: "Bad", goal: "lead_form", extraQuestion: "Child's age?" })).expect(201);
    await request(app).post(`${base(academyId)}/requests/${created.body.id}/submit`).set(auth(ownerId)).expect(200);
    failCreative = true;
    const res = await request(app).post(`/api/admin/meta-ads/requests/${created.body.id}/approve`).set(auth(adminId)).expect(200);
    expect(res.body).toMatchObject({ status: "failed", error: "Invalid creative", metaCampaignId: null });
    expect(deletes).toHaveLength(1);
    expect(posts.find((p) => p.path.endsWith("/leadgen_forms"))?.token).toBe("page-token");
    await request(app).put(`${base(academyId)}/requests/${created.body.id}`).set(auth(ownerId)).send(ad({ name: "Fixed" })).expect(200);
  });

  it("launches an own-account ad straight away in his account, with his token and currency", async () => {
    const created = await request(app).post(`${base(ownAcademyId)}/requests`).set(auth(ownerId)).send(ad({ dailyBudget: 5 })).expect(201);
    expect(created.body).toMatchObject({ mode: "own", currency: "JOD" });
    const res = await request(app).post(`${base(ownAcademyId)}/requests/${created.body.id}/submit`).set(auth(ownerId)).expect(200);
    expect(res.body.status).toBe("active");
    const campaign = posts.find((p) => p.path === "act_222/campaigns")!;
    expect(campaign.token).toBe("own-token");
    expect(posts.find((p) => p.path === "act_222/adsets")!.params.daily_budget).toBe("500");
    const [row] = await db.select().from(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.academyId, ownAcademyId));
    expect(row.adAccountId).toBe("act_222");
  });

  it("refuses submitting without a connected Page or an image", async () => {
    const other = await db.insert(academiesTable).values({ name: `None ${tag}`, fieldId }).returning({ id: academiesTable.id });
    await db.insert(academyMembersTable).values({ academyId: other[0].id, userId: ownerId, role: "owner" });
    const draft = await request(app).post(`${base(other[0].id)}/requests`).set(auth(ownerId)).send(ad({ imageData: null })).expect(201);
    await request(app).post(`${base(other[0].id)}/requests/${draft.body.id}/submit`).set(auth(ownerId)).expect(400);
    await request(app).put(`${base(other[0].id)}/requests/${draft.body.id}`).set(auth(ownerId)).send(ad()).expect(200);
    await request(app).post(`${base(other[0].id)}/requests/${draft.body.id}/submit`).set(auth(ownerId)).expect(409);
    await db.delete(academyAdRequestsTable).where(eq(academyAdRequestsTable.academyId, other[0].id));
    await db.delete(academiesTable).where(eq(academiesTable.id, other[0].id));
  });
});
