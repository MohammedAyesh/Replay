import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  academiesTable,
  academyContactsTable,
  academyMembersTable,
  db,
  fieldsTable,
  metaAdCampaignsTable,
  metaAdLeadsTable,
  metaAdsTable,
  usersTable,
} from "@workspace/db";

process.env.META_ACCESS_TOKEN = "test-token";
process.env.META_AD_ACCOUNT_ID = "123456";
process.env.META_APP_SECRET = "test-app-secret";
process.env.CONTABO_CONTROL_KEY = "test-control-key";
process.env.CONTABO_CONTROL_URL = "http://127.0.0.1:9";

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

const tag = `meta_${Date.now()}`;
const campaignA = `9${Date.now()}1`;
const campaignB = `9${Date.now()}2`;
const adA = `8${Date.now()}1`;
const adB = `8${Date.now()}2`;

// Meta's Graph API, faked: the account, its campaigns/ads/insights, and single leads.
vi.mock("../lib/meta/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/graph")>();
  return {
    ...actual,
    graphGet: vi.fn(async (path: string) => {
      if (path === "act_123456") return { name: "Replay ads", currency: "JOD", account_status: 1 };
      if (path.startsWith("lead-")) {
        return {
          id: path,
          created_time: "2026-11-01T10:00:00+0000",
          ad_id: adA,
          campaign_id: campaignA,
          form_id: "555",
          field_data: [
            { name: "full_name", values: ["Abu Kareem"] },
            { name: "phone_number", values: ["0791234567"] },
            { name: "child's_age", values: ["9"] },
          ],
        };
      }
      if (path === adB) return { id: adB, name: "Ad B", effective_status: "ACTIVE", campaign: { id: campaignB, name: "Campaign B" } };
      throw new actual.MetaGraphError(`unexpected ${path}`, 404);
    }),
    graphAll: vi.fn(async (path: string, params: Record<string, string>) => {
      if (path.endsWith("/campaigns")) return [{ id: campaignA, name: "Campaign A", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", start_time: "2026-10-20T00:00:00+0300" }];
      if (path.endsWith("/ads")) return [{ id: adA, name: "Ad A", campaign_id: campaignA, effective_status: "ACTIVE" }];
      if (path.endsWith("/insights")) {
        const lifetime = params.date_preset === "maximum";
        return [{
          campaign_id: campaignA,
          spend: lifetime ? "40.50" : "20.00",
          impressions: "10000",
          reach: "6000",
          clicks: "300",
          actions: [{ action_type: "lead", value: "4" }, { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "6" }],
        }];
      }
      return [];
    }),
  };
});

import metaRouter from "./metaAds";
import { handleWahaWebhook } from "../lib/whatsapp/queue";
import { findAdReferral } from "../lib/meta/referral";
import { readLeadFields } from "../lib/meta/leads";
import { metaWebhookVerifyToken } from "../lib/meta/config";
import { funnelOf } from "./metaAds";

let app: Express;
let adminId: number;
let ownerId: number;
let coachId: number;
let fieldId: number;
let academyId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  return { raw, signature: `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}` };
}

beforeAll(async () => {
  app = express();
  app.use("/api/meta/webhook", express.raw({ type: "*/*" }));
  app.use(express.json());
  app.use("/api", metaRouter);
  const users = await db.insert(usersTable).values([
    { name: `Admin ${tag}`, email: `admin-${tag}@test.local`, isAdmin: true },
    { name: `Owner ${tag}`, email: `owner-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [adminId, ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Meta field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `Meta Academy ${tag}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.delete(metaAdLeadsTable).where(inArray(metaAdLeadsTable.campaignId, [campaignA, campaignB]));
  await db.delete(metaAdCampaignsTable).where(inArray(metaAdCampaignsTable.id, [campaignA, campaignB]));
  if (academyId) await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [adminId, ownerId, coachId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("pure parts", () => {
  it("finds a click-to-WhatsApp referral in each engine's shape and ignores link previews", () => {
    // GOWS: protobuf ContextInfo serialised with Go field names.
    expect(findAdReferral({ _data: { Message: { ExtendedTextMessage: { ContextInfo: { ExternalAdReply: { Title: "Join U10", SourceType: "ad", SourceID: "777", SourceURL: "https://fb.me/x", CtwaClid: "clid-1" } } } } } }))
      .toEqual({ adId: "777", ctwaClid: "clid-1", headline: "Join U10", body: null, sourceUrl: "https://fb.me/x" });
    // camelCase protobuf JSON.
    expect(findAdReferral({ _data: { message: { extendedTextMessage: { contextInfo: { externalAdReply: { sourceType: "ad", sourceId: "778", ctwaClid: "clid-2" } } } } } })?.adId).toBe("778");
    // Cloud API style.
    expect(findAdReferral({ referral: { source_type: "ad", source_id: "779", ctwa_clid: "clid-3", headline: "H" } })).toMatchObject({ adId: "779", ctwaClid: "clid-3", headline: "H" });
    // A shared link's rich preview also uses ExternalAdReply: not an ad.
    expect(findAdReferral({ _data: { contextInfo: { externalAdReply: { title: "A link", sourceUrl: "https://example.com" } } } })).toBeNull();
    // A referral from an organic post isn't an ad either.
    expect(findAdReferral({ referral: { source_type: "post", source_id: "1" } })).toBeNull();
    expect(findAdReferral({ body: "hi" })).toBeNull();
  });

  it("reads name, phone and email from an instant form", () => {
    expect(readLeadFields([
      { name: "first_name", values: ["Sami"] }, { name: "last_name", values: ["Haddad"] },
      { name: "PHONE_NUMBER", values: ["+962791112233"] }, { name: "email", values: ["s@x.jo"] },
    ])).toMatchObject({ name: "Sami Haddad", phone: "+962791112233", email: "s@x.jo" });
  });

  it("counts a funnel where joined implies trial implies contacted", () => {
    expect(funnelOf([
      { stage: "new", kind: "lead" }, { stage: "contacted", kind: "lead" }, { stage: "trial", kind: "lead" },
      { stage: "joined", kind: "lead" }, { stage: null, kind: "parent" }, { stage: "lost", kind: "lead" },
    ])).toEqual({ leads: 6, contacted: 5, trial: 3, joined: 2, lost: 1 });
  });
});

describe("Meta webhook", () => {
  it("answers Meta's verification only with the right token", async () => {
    const token = metaWebhookVerifyToken()!;
    await request(app).get("/api/meta/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "42" }).expect(403);
    const ok = await request(app).get("/api/meta/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "42" }).expect(200);
    expect(ok.text).toBe("42");
  });

  it("refuses unsigned bodies", async () => {
    await request(app).post("/api/meta/webhook").set("content-type", "application/json").send(JSON.stringify({ entry: [] })).expect(401);
  });

  it("holds a lead until its campaign has an academy, then files it into People", async () => {
    // Sync first so the campaign exists, unassigned.
    await request(app).post("/api/admin/meta-ads/sync").set(auth(ownerId)).expect(403);
    const sync = await request(app).post("/api/admin/meta-ads/sync").set(auth(adminId)).expect(200);
    expect(sync.body).toMatchObject({ campaigns: 1, ads: 1, currency: "JOD" });

    const { raw, signature } = signed({ object: "page", entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: `lead-${tag}`, page_id: "1", form_id: "555" } }] }] });
    await request(app).post("/api/meta/webhook").set("content-type", "application/json").set("x-hub-signature-256", signature).send(raw).expect(200);
    // A retry of the same lead is not a second lead.
    await request(app).post("/api/meta/webhook").set("content-type", "application/json").set("x-hub-signature-256", signature).send(raw).expect(200);
    const held = await db.select().from(metaAdLeadsTable).where(eq(metaAdLeadsTable.campaignId, campaignA));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ academyId: null, phone: "962791234567", name: "Abu Kareem", source: "lead_form" });

    const overview = await request(app).get("/api/admin/meta-ads").set(auth(adminId)).expect(200);
    const row = overview.body.campaigns.find((c: { id: string }) => c.id === campaignA);
    expect(row).toMatchObject({ leads: 1, unassignedLeads: 1, insights: { spend: 40.5, leads: 4, conversations: 6, currency: "JOD" } });

    const assigned = await request(app).put(`/api/admin/meta-ads/campaigns/${campaignA}`).set(auth(adminId)).send({ academyId }).expect(200);
    expect(assigned.body.filed).toBe(1);
    const [contact] = await db.select().from(academyContactsTable).where(eq(academyContactsTable.academyId, academyId));
    expect(contact).toMatchObject({ phone: "962791234567", name: "Abu Kareem", kind: "lead", stage: "new", source: "meta_ad" });
    expect(contact.tags).toContain("Meta ad");
  });

  it("files a click-to-WhatsApp chat on Replay's number into the ad's academy", async () => {
    // Ad B is not synced yet: the chat's ad id is looked up at Meta, and its campaign gets an academy.
    await handleWahaWebhook({
      event: "message.any",
      session: "replay",
      payload: {
        id: `false_962795550000@c.us_A${tag}`,
        from: "962795550000@c.us",
        fromMe: false,
        body: "Hi, I saw your ad",
        _data: { pushName: "Um Yazan", Message: { ExtendedTextMessage: { ContextInfo: { ExternalAdReply: { SourceType: "ad", SourceID: adB, CtwaClid: `clid-${tag}`, Title: "Summer camp" } } } } },
      },
    });
    const [held] = await db.select().from(metaAdLeadsTable).where(eq(metaAdLeadsTable.campaignId, campaignB));
    expect(held).toMatchObject({ source: "whatsapp", academyId: null, ctwaClid: `clid-${tag}`, headline: "Summer camp", name: "Um Yazan" });
    expect(await db.select().from(metaAdsTable).where(eq(metaAdsTable.id, adB))).toHaveLength(1);

    await request(app).put(`/api/admin/meta-ads/campaigns/${campaignB}`).set(auth(adminId)).send({ academyId }).expect(200);

    // The next person from that ad lands in the academy straight away, with their message.
    await handleWahaWebhook({
      event: "message.any",
      session: "replay",
      payload: {
        id: `false_962795550001@c.us_B${tag}`,
        from: "962795550001@c.us",
        fromMe: false,
        body: "Price?",
        _data: { pushName: "Abu Omar", Message: { ExtendedTextMessage: { ContextInfo: { ExternalAdReply: { SourceType: "ad", SourceID: adB, CtwaClid: `clid2-${tag}` } } } } },
      },
    });
    const contacts = await db.select().from(academyContactsTable).where(eq(academyContactsTable.academyId, academyId));
    expect(contacts.map((c) => c.phone).sort()).toEqual(["962791234567", "962795550000", "962795550001"]);
    expect(contacts.find((c) => c.phone === "962795550001")).toMatchObject({ kind: "lead", stage: "new", name: "Abu Omar" });
  });

  it("shows the owner their campaigns with spend and what became of the leads; coaches can't", async () => {
    await db.update(academyContactsTable).set({ stage: "joined" }).where(eq(academyContactsTable.phone, "962791234567"));
    await request(app).get(`/api/academy/console/academies/${academyId}/ads`).set(auth(coachId)).expect(403);
    const res = await request(app).get(`/api/academy/console/academies/${academyId}/ads`).set(auth(ownerId)).expect(200);
    const a = res.body.campaigns.find((c: { id: string }) => c.id === campaignA);
    expect(a).toMatchObject({ insights: { spend: 40.5 }, funnel: { leads: 1, joined: 1, trial: 1, contacted: 1 } });
    const b = res.body.campaigns.find((c: { id: string }) => c.id === campaignB);
    expect(b.funnel.leads).toBe(2);
    expect(res.body.leads[0]).toHaveProperty("phoneDisplay");
  });
});
