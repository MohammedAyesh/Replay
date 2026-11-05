import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academyCreativeProjectsTable,
  academySocialAccountsTable,
  academySocialPostsTable,
  academyWhatsappSettingsTable,
  db,
  fieldsTable,
  footageRequestsTable,
  matchRoomsTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  userClipsTable,
  usersTable,
  venueAgentThreadsTable,
  venueBookingsTable,
  venueIgAwardsTable,
  venueIgConsentEventsTable,
  venueIgItemsTable,
  venueIgRemovalsTable,
  venuePitchesTable,
  venueSettingsTable,
} from "@workspace/db";

process.env.CONTABO_CONTROL_KEY = "test-control-key";
process.env.META_APP_SECRET = process.env.META_APP_SECRET || "test-meta-secret";
process.env.CONTABO_CONTROL_URL = "http://127.0.0.1:9";
delete process.env.ANTHROPIC_API_KEY;

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

vi.mock("../lib/whatsapp/waha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/waha")>();
  return {
    ...actual,
    wahaConfigured: vi.fn(() => true),
    getSession: vi.fn(async (name: string) => ({ name, status: "WORKING", me: { id: "962700000000@c.us", pushName: "Field" } })),
    checkNumber: vi.fn(async (_s: string, phone: string) => `${phone}@c.us`),
    sendText: vi.fn(async () => `wamid-${Math.random().toString(36).slice(2)}`),
    setTyping: vi.fn(async () => undefined),
    phoneForLid: vi.fn(async () => null),
  };
});

// Instagram itself: what Meta answers is set per test.
const graph = vi.hoisted(() => ({
  check: { ok: true, username: "galaxy.jo", limit: { used: 3, total: 100 }, limitError: null } as Record<string, unknown>,
  deleteOk: true,
  deleted: [] as string[],
}));
vi.mock("../lib/venues/igGraph", () => ({
  checkInstagram: vi.fn(async () => graph.check),
  deleteInstagramMedia: vi.fn(async (_a: unknown, id: string) => {
    graph.deleted.push(id);
    return graph.deleteOk ? { ok: true } : { ok: false, error: "(#10) Media Type Not Supported" };
  }),
  mediaInsights: vi.fn(async () => ({ views: 120, reach: 80, plays: 120 })),
  publishingLimit: vi.fn(async () => graph.check.limit),
}));
// Comments on a post, as Instagram's Graph API lists them (votes in the comments).
const comments = vi.hoisted(() => ({ byMedia: new Map<string, Array<{ id: string; text: string; from: { id: string; username: string } }>>() }));
vi.mock("../lib/meta/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/graph")>();
  return {
    ...actual,
    graphGet: vi.fn(async (path: string) => {
      const m = /^(.+)\/comments$/.exec(path);
      return m ? { data: comments.byMedia.get(m[1]) ?? [] } : {};
    }),
  };
});
// No ffmpeg, Bunny or ball data here: a render finishes at once, the media library gets a row id.
vi.mock("../lib/creative/renderJobs", async () => {
  const { academyCreativeProjectsTable: t, db: d } = await import("@workspace/db");
  const { eq: e } = await import("drizzle-orm");
  const done = async (_a: unknown, row: { id: number; kind: string }) => {
    const [r] = await d.update(t).set({ renderStatus: "done", outputPath: `/tmp/ig-${row.id}.${row.kind === "video" ? "mp4" : "png"}`, outputMime: row.kind === "video" ? "video/mp4" : "image/png", renderedAt: new Date() }).where(e(t.id, row.id)).returning();
    return r;
  };
  return { queueVideoRender: vi.fn(done), renderStillNow: vi.fn(done), isRendering: () => false, sweepInterruptedRenders: async () => undefined };
});
vi.mock("../lib/creative/publishMedia", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/creative/publishMedia")>();
  let n = 9000;
  return { ...actual, ensureCreativeMedia: vi.fn(async (row: { kind: string }) => ({ media: { id: (n += 1), kind: row.kind === "video" ? "video" : "image" }, created: true })) };
});
vi.mock("../lib/creative/framing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/creative/framing")>();
  return { ...actual, framingFor: vi.fn(async () => ({ framing: actual.centreFraming(), source: "centre", coverage: 0 })) };
});
vi.mock("../lib/creative/music", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/creative/music")>();
  return { ...actual, ensureReplayMusic: vi.fn(async () => undefined), replayLibrary: vi.fn(async () => []), templateMusicOverrides: vi.fn(async () => new Map()), sceneWithDefaultMusic: vi.fn(async (scene: unknown) => scene) };
});

import { academyAccessGate } from "./academyAccessGate";
import venueConsoleRouter from "./venueConsole";
import venuePublicRouter from "./venuePublic";
import venueAdminRouter from "./venueAdmin";
import venueInstagramRouter from "./venueInstagram";
import whatsappRouter from "./academyWhatsapp";
import { createHmac } from "node:crypto";
import * as waha from "../lib/whatsapp/waha";
import { encryptToken } from "../lib/meta/crypto";
import { addDays, ammanLocal, fromAmmanLocal } from "../lib/venues/core";
import { createVenue, loadVenue } from "../lib/venues/store";
import { ensureRenderedAll, resetIgTick, runIgAutopilotTick, scheduleFieldPosts, syncBookingItems } from "../lib/venues/igAutopilot";
import { leaderboardDesign, openSlotsDesign, resetWeekNumbers } from "../lib/venues/igFieldPosts";
import { resetCommentPulls } from "../lib/venues/igVotes";
import { weekCandidates } from "../lib/venues/igAwards";
import { weekStartOf } from "../lib/venues/igCalendar";

const tag = Date.now();
let app: Express;
let ownerId: number;
let captainId: number;
let strangerId: number;
let adminId: number;
let voterIds: number[] = [];
let fieldId: number;
let venueId: number;
let pitchId: number;
let slug = "";
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = () => `/api/academy/console/academies/${venueId}/venue`;
const ig = () => `${base()}/instagram`;
const tomorrow = addDays(ammanLocal(new Date()).slice(0, 10), 1);

const tick = async (now = new Date()) => { resetIgTick(); await runIgAutopilotTick(now, { force: true }); };
const items = async () => db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.academyId, venueId));
const itemFor = async (bookingId: number) => (await db.select().from(venueIgItemsTable).where(and(eq(venueIgItemsTable.academyId, venueId), eq(venueIgItemsTable.bookingId, bookingId))))[0];

/** A game played hoursAgo hours ago: its footage came back, a match room, optionally a player's saved clip and a tracking bundle. */
async function playedBooking(opts: { hoursAgo: number; consent?: "yes" | "no" | null; source?: string | null; under18?: boolean; clip?: boolean; bundle?: boolean; academyFootage?: boolean }) {
  const start = new Date(Date.now() - opts.hoursAgo * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  const startLocal = ammanLocal(start);
  const end = new Date(start.getTime() + 3_600_000);
  const endLocal = ammanLocal(end);
  const videoId = randomUUID();
  const [fr] = await db.insert(footageRequestsTable).values({
    fieldId, cameraId: "cam1", requestedBy: ownerId, startLocal, endLocal, requestedSeconds: 3600, status: "ready", videoId,
    readyAt: new Date(end.getTime() + 20 * 60_000), academyId: null,
  }).returning();
  const [rec] = await db.insert(recordingsTable).values({
    fieldId, court: "cam1", date: startLocal.slice(0, 10), timeSlot: startLocal.slice(11), duration: "60:00", videoUrl: `https://vz-test.b-cdn.net/${videoId}/playlist.m3u8`,
  }).returning();
  const code = `IG${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 10);
  const [room] = await db.insert(matchRoomsTable).values({ footageRequestId: fr.id, fieldId, code, captainToken: randomBytes(8).toString("hex"), captainUserId: captainId }).returning();
  const [booking] = await db.insert(venueBookingsTable).values({
    academyId: venueId, pitchId, startsAt: start, endsAt: end, startLocal, endLocal, status: "completed", reference: `GL-${randomBytes(3).toString("hex").toUpperCase()}`,
    footageRequestId: fr.id, igConsent: opts.consent ?? null, igConsentSource: opts.source ?? (opts.consent ? "captain_web" : null),
    igConsentAt: opts.consent ? new Date() : null, under18: Boolean(opts.under18), customerName: "Captain",
  }).returning();
  if (opts.academyFootage) {
    const [academy] = await db.select({ id: venueSettingsTable.academyId }).from(venueSettingsTable).where(eq(venueSettingsTable.academyId, venueId));
    await db.update(footageRequestsTable).set({ academyId: academy.id }).where(eq(footageRequestsTable.id, fr.id));
  }
  if (opts.clip !== false) {
    await db.insert(userClipsTable).values({ userId: captainId, videoId, title: "My goal", startTime: "600", endTime: "614", footageRequestId: fr.id, sourceRecordingId: rec.id, shareCount: 2 });
  }
  if (opts.bundle) {
    await db.insert(recordingTrackingBundlesTable).values({ recordingId: rec.id, manifest: { version: 1, duration: 3600, videoStartSeconds: 1.48, fps: 20, segments: [] } as never });
  }
  return { booking, fr, rec, room, code };
}

beforeAll(async () => {
  app = express();
  app.use("/api/whatsapp/webhook", express.raw({ type: "*/*" }));
  app.use(express.json());
  app.use("/api", academyAccessGate);
  for (const r of [venueConsoleRouter, venuePublicRouter, venueAdminRouter, venueInstagramRouter, whatsappRouter]) app.use("/api", r);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `ig-owner-${tag}@test.local` },
    { name: `Captain ${tag}`, email: `ig-captain-${tag}@test.local` },
    { name: `Stranger ${tag}`, email: `ig-stranger-${tag}@test.local` },
    { name: `Admin ${tag}`, email: `ig-admin-${tag}@test.local`, isAdmin: true },
    ...[1, 2, 3].map((i) => ({ name: `Voter ${i} ${tag}`, email: `ig-voter${i}-${tag}@test.local` })),
  ]).returning({ id: usersTable.id });
  [ownerId, captainId, strangerId, adminId] = users.map((u) => u.id);
  voterIds = users.slice(4).map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Galaxy IG ${tag}`, cameraId: null }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const venue = await createVenue({ name: `Galaxy IG ${tag}`, fieldIds: [fieldId], ownerUserId: ownerId });
  venueId = venue.id;
  slug = venue.settings.slug;
  [{ id: pitchId }] = await db.select({ id: venuePitchesTable.id }).from(venuePitchesTable).where(eq(venuePitchesTable.academyId, venueId));
  await db.update(venueSettingsTable).set({
    openingHours: Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "00:00", close: "24:00" }])),
    minNoticeMinutes: 0,
  }).where(eq(venueSettingsTable.academyId, venueId));
  await db.insert(academyWhatsappSettingsTable).values({ academyId: venueId, sender: "own", sessionStatus: "WORKING" }).onConflictDoNothing();
  await db.insert(academySocialAccountsTable).values({ academyId: venueId, status: "connected", pageId: `p${tag}`, igUserId: `ig${tag}`, igUsername: "galaxy.jo", pageTokenEnc: encryptToken("page-token") });
});

describe("1. Instagram consent", () => {
  it("is Off for a new field, and the owner can't turn the autopilot on until Replay sets consent", async () => {
    const got = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    expect(got.body.settings).toMatchObject({ consentMode: "off", autopilot: false, publishMode: "approve" });
    const refused = await request(app).put(`${ig()}/settings`).set(auth(ownerId)).send({ autopilot: true }).expect(409);
    expect(refused.body.code).toBe("consent_off");
    // Strangers and the owner can't reach the admin switch.
    await request(app).get(ig()).set(auth(strangerId)).expect(403);
    await request(app).put(`/api/admin/venues/${venueId}/instagram-consent`).set(auth(ownerId)).send({ mode: "ask" }).expect(403);
  });

  it("lets an admin set the mode, needs the owner's wording for owner mode, and logs every change", async () => {
    const noWording = await request(app).put(`/api/admin/venues/${venueId}/instagram-consent`).set(auth(adminId)).send({ mode: "owner" }).expect(400);
    expect(noWording.body.code).toBe("wording_required");
    const set = await request(app).put(`/api/admin/venues/${venueId}/instagram-consent`).set(auth(adminId))
      .send({ mode: "owner", wording: "Games at Galaxy are filmed and may be posted on our Instagram." }).expect(200);
    expect(set.body).toMatchObject({ mode: "owner", wording: "Games at Galaxy are filmed and may be posted on our Instagram." });
    expect(set.body.since).toBeTruthy();
    expect(set.body.history[0]).toMatchObject({ oldMode: "off", newMode: "owner", by: `ig-admin-${tag}@test.local` });
    const [settings] = await db.select().from(venueSettingsTable).where(eq(venueSettingsTable.academyId, venueId));
    expect(settings.igConsentBy).toBe(adminId);
    // The owner sees it and its history in the console, read-only.
    const got = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    expect(got.body.settings).toMatchObject({ consentMode: "owner", consentWording: expect.stringContaining("Galaxy") });
    expect(got.body.settings.consentHistory).toHaveLength(1);
  });

  it("owner mode: staff bookings count as consented unless the front desk marks one no, and under-18 is kept", async () => {
    const yes = await request(app).post(`${base()}/bookings`).set(auth(ownerId)).send({ pitchId, startLocal: `${tomorrow} 10:00`, minutes: 60, payWith: "none", notify: false }).expect(201);
    expect(yes.body.bookings[0]).toMatchObject({ igConsent: "yes", igConsentSource: "owner_default", under18: false });
    const no = await request(app).post(`${base()}/bookings`).set(auth(ownerId)).send({ pitchId, startLocal: `${tomorrow} 11:00`, minutes: 60, payWith: "none", notify: false, igConsent: false, under18: true }).expect(201);
    expect(no.body.bookings[0]).toMatchObject({ igConsent: "no", igConsentSource: "staff", under18: true });
    const flipped = await request(app).patch(`${base()}/bookings/${yes.body.bookings[0].id}`).set(auth(ownerId)).send({ igConsent: "no", under18: true }).expect(200);
    expect(flipped.body.booking).toMatchObject({ igConsent: "no", igConsentSource: "staff", under18: true });
  });

  it("ask mode: the booking site asks the captain and stores his answer", async () => {
    await request(app).put(`/api/admin/venues/${venueId}/instagram-consent`).set(auth(adminId)).send({ mode: "ask" }).expect(200);
    const site = await request(app).get(`/api/venue-site/${slug}`).expect(200);
    expect(site.body.instagram.mode).toBe("ask");
    expect(site.body.instagram.question.en).toBe(`Allow Galaxy IG ${tag} to post a highlight from our match on Instagram?`);
    const yes = await request(app).post(`/api/venue-site/${slug}/bookings`).send({ pitchId, startLocal: `${tomorrow} 13:00`, minutes: 60, name: "Yes Captain", phone: "0791230001", payWith: "field", igConsent: true }).expect(201);
    const no = await request(app).post(`/api/venue-site/${slug}/bookings`).send({ pitchId, startLocal: `${tomorrow} 14:00`, minutes: 60, name: "No Captain", phone: "0791230002", payWith: "field", igConsent: false, under18: true }).expect(201);
    const silent = await request(app).post(`/api/venue-site/${slug}/bookings`).send({ pitchId, startLocal: `${tomorrow} 15:00`, minutes: 60, name: "Old App", phone: "0791230003", payWith: "field" }).expect(201);
    const row = async (reference: string) => (await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.reference, reference)))[0];
    expect(await row(yes.body.reference)).toMatchObject({ igConsent: "yes", igConsentSource: "captain_web", under18: false });
    expect(await row(no.body.reference)).toMatchObject({ igConsent: "no", igConsentSource: "captain_web", under18: true });
    expect(await row(silent.body.reference)).toMatchObject({ igConsent: null, igConsentSource: null });
    const history = await request(app).get(`/api/admin/venues/${venueId}/instagram-consent`).set(auth(adminId)).expect(200);
    expect(history.body.history.map((h: { newMode: string }) => h.newMode)).toEqual(["ask", "owner"]);
  });

  it("ask mode: the WhatsApp menu agent asks the question before payment and stores the answer", async () => {
    const phone = "962791230010";
    await request(app).put(`${base()}/agent`).set(auth(ownerId)).send({ agentMode: "menu" }).expect(200);
    let seq = 0;
    const say = async (text: string) => {
      seq += 1;
      const body = JSON.stringify({ event: "message", session: `academy-${venueId}`, payload: { id: `false_${phone}@c.us_IG${tag}${seq}`, from: `${phone}@c.us`, to: "962700000000@c.us", fromMe: false, body: text, _data: { pushName: "Rami Ig" } } });
      await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", createHmac("sha512", waha.wahaWebhookSecret()).update(body).digest("hex")).send(body).expect(200);
    };
    const state = async () => (await db.select().from(venueAgentThreadsTable).where(and(eq(venueAgentThreadsTable.academyId, venueId), eq(venueAgentThreadsTable.phone, phone))))[0]?.state as { step?: string; draft?: { options?: string[] } };
    await say("hi");
    await say("1");
    const days = (await state()).draft!.options!;
    await say(String(days.indexOf(tomorrow) + 1));
    // One pitch: straight to lengths, then times.
    for (let i = 0; i < 3 && (await state()).step !== "consent"; i += 1) await say("1");
    expect((await state()).step).toBe("consent");
    await say("2"); // No
    if ((await state()).step === "pay") await say("1");
    const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venueId), eq(venueBookingsTable.customerPhone, phone)));
    expect(b).toMatchObject({ source: "whatsapp", igConsent: "no", igConsentSource: "captain_whatsapp" });
    await request(app).put(`${base()}/agent`).set(auth(ownerId)).send({ agentMode: "off" }).expect(200);
  });
});

describe("2. One clip per booking, on the calendar", () => {
  let game: Awaited<ReturnType<typeof playedBooking>>;
  let refused: Awaited<ReturnType<typeof playedBooking>>;
  let young: Awaited<ReturnType<typeof playedBooking>>;
  let unasked: Awaited<ReturnType<typeof playedBooking>>;

  it("turns on, then makes an item only for bookings that may be posted, with the consent it relied on", async () => {
    await request(app).put(`${ig()}/settings`).set(auth(ownerId)).send({ autopilot: true }).expect(200);
    game = await playedBooking({ hoursAgo: 3, consent: "yes" });
    refused = await playedBooking({ hoursAgo: 4, consent: "no" });
    young = await playedBooking({ hoursAgo: 5, consent: "yes", under18: true });
    unasked = await playedBooking({ hoursAgo: 6, consent: null });
    await tick();
    const item = await itemFor(game.booking.id);
    expect(item).toMatchObject({ kind: "booking_clip", source: "saved_clip", status: "planned", consentMode: "ask" });
    expect(item.consentRef).toMatchObject({ bookingId: game.booking.id, mode: "ask", consent: "yes", source: "captain_web" });
    expect(item.slotAt).toBeTruthy();
    for (const other of [refused, young, unasked]) expect(await itemFor(other.booking.id)).toBeUndefined();
    const got = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    const reasons = Object.fromEntries(got.body.notPosted.map((n: { bookingId: number; reason: string }) => [n.bookingId, n.reason]));
    expect(reasons[refused.booking.id]).toBe("They said no to Instagram");
    expect(reasons[young.booking.id]).toBe("Marked under 18");
    expect(reasons[unasked.booking.id]).toBe("The captain hasn't said yes");
    expect(got.body.account).toMatchObject({ ok: true, username: "galaxy.jo", limit: { used: 3, total: 100, left: 87 } });
  });

  it("never posts an academy's footage", async () => {
    const academyGame = await playedBooking({ hoursAgo: 2, consent: "yes", academyFootage: true });
    const venue = (await loadVenue(venueId))!;
    await syncBookingItems(venue);
    expect(await itemFor(academyGame.booking.id)).toBeUndefined();
  });

  it("waits for the owner's OK in approve-first mode, then renders a 9:16 story with the booking number and hands it over", async () => {
    let item = await itemFor(game.booking.id);
    // Its slot came and went without an OK: nothing goes out, it rolls on.
    await db.update(venueIgItemsTable).set({ slotAt: new Date(Date.now() - 60_000) }).where(eq(venueIgItemsTable.id, item.id));
    await tick();
    item = await itemFor(game.booking.id);
    expect(item.status).toBe("planned");
    expect(item.slotAt!.getTime()).toBeGreaterThan(Date.now());
    // Preview renders it.
    const preview = await request(app).post(`${ig()}/items/${item.id}/action`).set(auth(ownerId)).send({ action: "preview" }).expect(200);
    expect(preview.body.item.render).toMatchObject({ status: "done", kind: "video" });
    const [project] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, preview.body.item.projectId));
    expect(project).toMatchObject({ format: "story", templateKey: "field-booking-clip", style: "field", origin: "auto" });
    // The end card: "Booking" over the booking number, in the field's colour.
    expect((project.data as { custom: { endBig: string } }).custom.endBig).toBe(game.booking.reference);
    expect((project.data as { media: { type: string } }).media).toMatchObject({ type: "recording", recordingId: game.rec.id });
    const layers = (project.scene as { layers: Array<{ id: string; framing?: unknown; text?: string }> }).layers;
    expect(layers.find((l) => l.id === "video")?.framing).toBeTruthy();
    expect(layers.find((l) => l.id === "end-big")?.text).toBe("{{custom.endBig}}");
    // Approved and due: it becomes a scheduled Instagram story post.
    await request(app).post(`${ig()}/items/${item.id}/action`).set(auth(ownerId)).send({ action: "approve" }).expect(200);
    await db.update(venueIgItemsTable).set({ slotAt: new Date(Date.now() - 30_000) }).where(eq(venueIgItemsTable.id, item.id));
    await tick();
    item = await itemFor(game.booking.id);
    expect(item.status).toBe("publishing");
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, item.postId!));
    // A saved, shared clip is the day's best so far: it may have been promoted to a Reel slot.
    expect(post).toMatchObject({ format: item.placement, status: "scheduled", targets: ["instagram"] });
    expect(post.caption === "").toBe(item.placement === "story");
    // Instagram took it.
    await db.update(academySocialPostsTable).set({ status: "published", igMediaId: `igm-${tag}-1`, igPermalink: "https://instagram.com/stories/x", publishedAt: new Date() }).where(eq(academySocialPostsTable.id, post.id));
    await tick();
    item = await itemFor(game.booking.id);
    expect(item).toMatchObject({ status: "published", igMediaId: `igm-${tag}-1` });
    expect(item.insights).toMatchObject({ views: 120, reach: 80 });
  });

  it("checks consent again at posting time: a booking marked under 18 after approval is skipped", async () => {
    const late = await playedBooking({ hoursAgo: 7, consent: "yes" });
    await tick();
    const item = await itemFor(late.booking.id);
    await request(app).post(`${ig()}/items/${item.id}/action`).set(auth(ownerId)).send({ action: "approve" }).expect(200);
    await db.update(venueBookingsTable).set({ under18: true }).where(eq(venueBookingsTable.id, late.booking.id));
    await db.update(venueIgItemsTable).set({ slotAt: new Date(Date.now() - 30_000), pinned: true }).where(eq(venueIgItemsTable.id, item.id));
    await tick();
    expect(await itemFor(late.booking.id)).toMatchObject({ status: "skipped", error: "Marked under 18" });
  });

  it("paces under Instagram's 24-hour limit and says why it is waiting", async () => {
    const paced = await playedBooking({ hoursAgo: 8, consent: "yes" });
    await tick();
    const item = await itemFor(paced.booking.id);
    await request(app).post(`${ig()}/items/${item.id}/action`).set(auth(ownerId)).send({ action: "now" }).expect(200);
    graph.check = { ok: true, username: "galaxy.jo", limit: { used: 95, total: 100 }, limitError: null };
    await tick();
    expect(await itemFor(paced.booking.id)).toMatchObject({ status: "approved", error: "Waiting: 95 of 100 Instagram posts used in the last 24 hours" });
    graph.check = { ok: false, code: "not_business", error: "This Instagram account can't publish through Replay. It has to be an Instagram Business account…" };
    const got = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    expect(got.body.account).toMatchObject({ ok: false, code: "not_business" });
    graph.check = { ok: true, username: "galaxy.jo", limit: { used: 3, total: 100 }, limitError: null };
    await request(app).post(`${ig()}/items/${item.id}/action`).set(auth(ownerId)).send({ action: "skip" }).expect(200);
  });

  it("lets the owner drag (not into the night), swap and skip, and publishes on its own in auto mode", async () => {
    const a = await playedBooking({ hoursAgo: 9, consent: "yes" });
    const b = await playedBooking({ hoursAgo: 10, consent: "yes" });
    await tick();
    const [ia, ib] = [await itemFor(a.booking.id), await itemFor(b.booking.id)];
    const night = await request(app).put(`${ig()}/items/${ia.id}/slot`).set(auth(ownerId)).send({ slotLocal: `${tomorrow} 03:00` }).expect(400);
    expect(night.body.code).toBe("quiet");
    const moved = await request(app).put(`${ig()}/items/${ia.id}/slot`).set(auth(ownerId)).send({ slotLocal: `${tomorrow} 18:30`, placement: "reel" }).expect(200);
    expect(moved.body.item).toMatchObject({ slotLocal: `${tomorrow} 18:30`, pinned: true, placement: "reel" });
    const swapped = await request(app).post(`${ig()}/items/swap`).set(auth(ownerId)).send({ a: ia.id, b: ib.id }).expect(200);
    const byId = Object.fromEntries(swapped.body.items.map((i: { id: number; slotLocal: string; placement: string }) => [i.id, i]));
    expect(byId[ib.id]).toMatchObject({ slotLocal: `${tomorrow} 18:30`, placement: "reel" });
    expect(byId[ia.id].placement).toBe(ib.placement);
    // Auto mode: due and unapproved, it goes out anyway.
    await request(app).put(`${ig()}/settings`).set(auth(ownerId)).send({ publishMode: "auto" }).expect(200);
    await db.update(venueIgItemsTable).set({ slotAt: new Date(Date.now() - 30_000) }).where(eq(venueIgItemsTable.id, ib.id));
    await tick();
    const after = await itemFor(b.booking.id);
    expect(after.status).toBe("publishing");
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, after.postId!));
    expect(post.format).toBe("reel");
    expect(post.caption).toContain(`/v/${slug}`);
    await request(app).put(`${ig()}/settings`).set(auth(ownerId)).send({ publishMode: "approve" }).expect(200);
    await request(app).post(`${ig()}/items/${ia.id}/action`).set(auth(ownerId)).send({ action: "skip" }).expect(200);
    expect((await itemFor(a.booking.id)).status).toBe("skipped");
  });
});

describe("removal from the match page", () => {
  it("lets a player in the match take it down: a Reel is deleted, a Story is flagged for the owner, and both are logged", async () => {
    const reelGame = await playedBooking({ hoursAgo: 11, consent: "yes" });
    const storyGame = await playedBooking({ hoursAgo: 12, consent: "yes" });
    await tick();
    for (const [g, placement, media] of [[reelGame, "reel", `igm-${tag}-reel`], [storyGame, "story", `igm-${tag}-story`]] as const) {
      const it = await itemFor(g.booking.id);
      await db.update(venueIgItemsTable).set({ status: "published", placement, igMediaId: media, publishedAt: new Date() }).where(eq(venueIgItemsTable.id, it.id));
    }
    const seen = await request(app).get(`/api/m/${reelGame.code}/instagram`).set(auth(captainId)).expect(200);
    expect(seen.body).toMatchObject({ enabled: true, canRemove: true });
    expect(seen.body.posts[0]).toMatchObject({ placement: "reel", status: "published" });
    const outsider = await request(app).get(`/api/m/${reelGame.code}/instagram`).set(auth(strangerId)).expect(200);
    expect(outsider.body.canRemove).toBe(false);
    await request(app).post(`/api/m/${reelGame.code}/instagram/remove`).set(auth(strangerId)).expect(403);

    graph.deleteOk = true;
    const r1 = await request(app).post(`/api/m/${reelGame.code}/instagram/remove`).set(auth(captainId)).expect(200);
    expect(r1.body.outcomes[0]).toMatchObject({ outcome: "deleted" });
    expect(graph.deleted).toContain(`igm-${tag}-reel`);
    expect((await itemFor(reelGame.booking.id)).status).toBe("removed");

    graph.deleteOk = false;
    const r2 = await request(app).post(`/api/m/${storyGame.code}/instagram/remove`).set(auth(captainId)).expect(200);
    expect(r2.body.outcomes[0].outcome).toBe("flagged");
    expect(r2.body.outcomes[0].error).toMatch(/Stories/);
    expect((await itemFor(storyGame.booking.id)).status).toBe("removal_flagged");

    const log = await db.select().from(venueIgRemovalsTable).where(eq(venueIgRemovalsTable.academyId, venueId));
    expect(log.map((l) => [l.bookingId, l.outcome, l.requestedBy])).toEqual(expect.arrayContaining([[reelGame.booking.id, "deleted", captainId], [storyGame.booking.id, "flagged", captainId]]));
    const [b] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.id, reelGame.booking.id));
    expect(b).toMatchObject({ igConsent: "no", igConsentSource: "removal" });
    // The owner sees the flagged one, deletes it by hand and says so.
    const got = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    const flagged = got.body.flaggedRemovals.find((f: { bookingId: number }) => f.bookingId === storyGame.booking.id);
    expect(flagged).toBeTruthy();
    await request(app).post(`${ig()}/removals/${flagged.id}/resolved`).set(auth(ownerId)).expect(200);
    expect((await itemFor(storyGame.booking.id)).status).toBe("removed");
    // Nothing from that booking is made again.
    await tick();
    expect((await items()).filter((i) => i.bookingId === reelGame.booking.id)).toHaveLength(1);
  });
});

describe("3. Weekly awards", () => {
  let week: string;
  let saveGame: Awaited<ReturnType<typeof playedBooking>>;

  it("takes save nominations from players on the match page, and the owner's approval puts them on the list", async () => {
    saveGame = await playedBooking({ hoursAgo: 13, consent: "yes", bundle: true });
    const nominated = await request(app).post(`/api/m/${saveGame.code}/instagram/nominate-save`).set(auth(captainId)).send({ recordingId: saveGame.rec.id, atSeconds: 1200 }).expect(201);
    await request(app).post(`/api/m/${saveGame.code}/instagram/nominate-save`).set(auth(strangerId)).send({ recordingId: saveGame.rec.id, atSeconds: 1300 }).expect(403);
    await request(app).post(`/api/m/${saveGame.code}/instagram/nominate-save`).set(auth(captainId)).send({ recordingId: saveGame.rec.id, atSeconds: 99_999 }).expect(404);
    const pending = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    expect(pending.body.nominations.map((n: { id: number }) => n.id)).toContain(nominated.body.id);
    await request(app).post(`${ig()}/nominations/${nominated.body.id}`).set(auth(ownerId)).send({ status: "approved" }).expect(200);
    week = weekStartOf(Math.round(new Date(saveGame.booking.startsAt).getTime() / 60_000) + 180);
    const venue = (await loadVenue(venueId))!;
    const cands = await weekCandidates(venue, week);
    expect(cands.save.map((n) => n.source)).toEqual(["save"]);
    expect(cands.save[0]).toMatchObject({ recordingId: saveGame.rec.id, bookingId: saveGame.booking.id, atSeconds: 1200 });
    // There is no keeper-save detection: nothing else is a save, and no analysis means no goals or dribbles.
    expect(cands.goal).toEqual([]);
    expect(cands.dribble).toEqual([]);
  });

  it("votes in the app (counts hidden while open), and a thin vote goes to the owner, whose pick makes the winner Reel", async () => {
    const venue = (await loadVenue(venueId))!;
    const nominees = (await weekCandidates(venue, week)).save;
    const [award] = await db.insert(venueIgAwardsTable).values({
      academyId: venueId, weekStart: week, category: "save", status: "voting", nominees, votingEndsAt: new Date(Date.now() + 3_600_000),
    }).returning();
    await request(app).post(`/api/venue-awards/${slug}/${award.id}/vote`).send({ key: nominees[0].key }).expect(401);
    const voted = await request(app).post(`/api/venue-awards/${slug}/${award.id}/vote`).set(auth(voterIds[0])).send({ key: nominees[0].key }).expect(200);
    expect(voted.body.myVote).toBe(nominees[0].key);
    await request(app).post(`/api/venue-awards/${slug}/${award.id}/vote`).set(auth(voterIds[1])).send({ key: "nope" }).expect(404);
    const page = await request(app).get(`/api/venue-awards/${slug}`).set(auth(voterIds[0])).expect(200);
    const shown = page.body.awards.find((a: { id: number }) => a.id === award.id);
    expect(shown).toMatchObject({ status: "voting", totalVotes: null, myVote: nominees[0].key });
    expect(shown.nominees[0].votes).toBeNull();
    // Voting closes with 1 vote (5 needed): the owner picks.
    await db.update(venueIgAwardsTable).set({ votingEndsAt: new Date(Date.now() - 60_000) }).where(eq(venueIgAwardsTable.id, award.id));
    await tick();
    const [closed] = await db.select().from(venueIgAwardsTable).where(eq(venueIgAwardsTable.id, award.id));
    expect(closed.status).toBe("owner_pick");
    await request(app).post(`/api/venue-awards/${slug}/${award.id}/vote`).set(auth(voterIds[2])).send({ key: nominees[0].key }).expect(409);
    const picked = await request(app).post(`${ig()}/awards/${award.id}/winner`).set(auth(ownerId)).send({ key: nominees[0].key }).expect(200);
    expect(picked.body.award).toMatchObject({ status: "decided", decidedBy: "owner" });
    const [winner] = await db.select().from(venueIgItemsTable).where(and(eq(venueIgItemsTable.academyId, venueId), eq(venueIgItemsTable.originKey, `winner:${award.id}`)));
    expect(winner).toMatchObject({ kind: "award_winner", placement: "reel", pinned: true, bookingId: saveGame.booking.id });
    // Its design is the field pack's award video, in 9:16; the owner picked it, so no vote count.
    const preview = await request(app).post(`${ig()}/items/${winner.id}/action`).set(auth(ownerId)).send({ action: "preview" }).expect(200);
    const [project] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, preview.body.item.projectId));
    expect(project).toMatchObject({ templateKey: "field-award", format: "story", style: "field" });
    const custom = (project.data as { custom: Record<string, string> }).custom;
    expect(custom.title).toBe("تصدّي الأسبوع");
    expect(custom.stat).toBeUndefined();
  });
});

describe("5. Monthly report", () => {
  it("counts posts by type, reach and plays, bookings from the site and WhatsApp, and removals", async () => {
    const month = ammanLocal(new Date()).slice(0, 7);
    const report = await request(app).get(`${ig()}/report?month=${month}`).set(auth(ownerId)).expect(200);
    expect(report.body.month).toBe(month);
    expect(report.body.posts.total).toBeGreaterThanOrEqual(3);
    expect(report.body.posts.byType.story.posts + report.body.posts.byType.reel.posts).toBeGreaterThanOrEqual(3);
    expect(report.body.insightsAvailable).toBe(true);
    expect(report.body.bookings.website).toBeGreaterThanOrEqual(3);
    expect(report.body.bookings.whatsapp).toBeGreaterThanOrEqual(1);
    expect(report.body.removals).toMatchObject({ total: 2, deleted: 1, flagged: 1 });
    await request(app).get(`${ig()}/report?month=${month}`).set(auth(strangerId)).expect(403);
  });
});

describe("6. Field template pack: carousels, votes in the comments, weekly posts", () => {
  const nominee = async (game: Awaited<ReturnType<typeof playedBooking>>, n: number) => ({
    key: `${game.rec.id}:${n}`, recordingId: game.rec.id, bookingId: game.booking.id, atSeconds: 600 + n, fromMs: 591_000, toMs: 606_000, atMs: 601_000,
    source: "confirmed_goal" as const, label: `Game ${n}`, labelAr: `ماتش ${n}`,
  });

  it("posts award nominees as a 4:5 carousel (cover + one slide each), counts one comment vote per account, and the winner video shows no count", async () => {
    const [g1, g2] = [await playedBooking({ hoursAgo: 30, consent: "yes" }), await playedBooking({ hoursAgo: 31, consent: "yes" })];
    const nominees = [await nominee(g1, 1), await nominee(g2, 2)];
    const [award] = await db.insert(venueIgAwardsTable).values({
      academyId: venueId, weekStart: weekStartOf(Math.round(Date.now() / 60_000) + 180), category: "goal", status: "voting", nominees, votingEndsAt: new Date(Date.now() + 3_600_000),
    }).returning();
    const [item] = await db.insert(venueIgItemsTable).values({
      academyId: venueId, originKey: `nominees:${award.id}`, kind: "award_nominees", placement: "carousel", awardId: award.id, recordingId: g1.rec.id,
      source: "award", slotAt: new Date(Date.now() - 30_000), pinned: true, status: "approved",
    }).returning();
    await tick();
    const [out] = await db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.id, item.id));
    expect(out.status).toBe("publishing");
    const projects = (await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.academyId, venueId)))
      .filter((p) => p.originKey === `ig:item:${item.id}` || p.originKey?.startsWith(`ig:item:${item.id}:`))
      .sort((a, b) => (a.originKey ?? "").localeCompare(b.originKey ?? ""));
    expect(projects.map((p) => [p.templateKey, p.format, p.kind])).toEqual([
      ["field-nominees-cover", "post", "image"], ["field-nominee-slide", "post", "video"], ["field-nominee-slide", "post", "video"],
    ]);
    expect((projects[0].data as { custom: Record<string, string> }).custom).toMatchObject({ title: "جول الأسبوع", n1: "ماتش 1", n2: "ماتش 2" });
    expect((projects[2].data as { custom: Record<string, string> }).custom).toMatchObject({ n: "2", cta: "علّق 2 إذا عجبتك" });
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, out.postId!));
    expect(post.format).toBe("carousel");
    expect(post.media).toHaveLength(3);
    expect(post.caption).toContain("(1–2)");
    // Out on Instagram; people vote in the comments (and one in the app).
    const media = `igm-${tag}-carousel`;
    await db.update(academySocialPostsTable).set({ status: "published", igMediaId: media, publishedAt: new Date() }).where(eq(academySocialPostsTable.id, post.id));
    await tick();
    comments.byMedia.set(media, [
      { id: `c1-${tag}`, text: "2", from: { id: "fan1", username: "fan1" } },
      { id: `c2-${tag}`, text: "٢ 🔥", from: { id: "fan2", username: "fan2" } },
      { id: `c3-${tag}`, text: "1", from: { id: "fan3", username: "fan3" } },
      { id: `c4-${tag}`, text: "رقم 2", from: { id: "fan3", username: "fan3" } },
      { id: `c5-${tag}`, text: "1 or 2?", from: { id: "fan4", username: "fan4" } },
      { id: `c6-${tag}`, text: "2", from: { id: `ig${tag}`, username: "galaxy.jo" } },
    ]);
    await request(app).post(`/api/venue-awards/${slug}/${award.id}/vote`).set(auth(voterIds[0])).send({ key: nominees[0].key }).expect(200);
    await db.update(venueSettingsTable).set({ igSlots: { minVotes: 3 } }).where(eq(venueSettingsTable.academyId, venueId));
    await db.update(venueIgAwardsTable).set({ votingEndsAt: new Date(Date.now() - 60_000) }).where(eq(venueIgAwardsTable.id, award.id));
    resetCommentPulls();
    await tick();
    const [closed] = await db.select().from(venueIgAwardsTable).where(eq(venueIgAwardsTable.id, award.id));
    // fan1, fan2, fan3 (latest: 2) → 3 for #2; the app's vote and nothing else for #1; the field's own and a two-choice comment don't count.
    expect(closed).toMatchObject({ status: "decided", decidedBy: "votes", winnerKey: nominees[1].key });
    const [winner] = await db.select().from(venueIgItemsTable).where(and(eq(venueIgItemsTable.academyId, venueId), eq(venueIgItemsTable.originKey, `winner:${award.id}`)));
    const preview = await request(app).post(`${ig()}/items/${winner.id}/action`).set(auth(ownerId)).send({ action: "preview" }).expect(200);
    const [project] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, preview.body.item.projectId));
    // No vote count on the design (Mohammed, 2026-11-04).
    expect((project.data as { custom: Record<string, string> }).custom).toMatchObject({ kicker: "فايز هالأسبوع", title: "جول الأسبوع" });
    expect((project.data as { custom: Record<string, string> }).custom.stat).toBeUndefined();
    await db.update(venueSettingsTable).set({ igSlots: {} }).where(eq(venueSettingsTable.academyId, venueId));
  });

  it("counts which-is-nicer votes, A or B, on the console", async () => {
    const [g1, g2] = [await playedBooking({ hoursAgo: 32, consent: "yes" }), await playedBooking({ hoursAgo: 33, consent: "yes" })];
    const media = `igm-${tag}-versus`;
    const [item] = await db.insert(venueIgItemsTable).values({
      academyId: venueId, originKey: `versus:test-${tag}`, kind: "versus", placement: "reel", source: "field", status: "published", publishedAt: new Date(),
      igMediaId: media, slotAt: new Date(Date.now() - 3_600_000),
      moment: { choices: [{ key: "a", bookingId: g1.booking.id }, { key: "b", bookingId: g2.booking.id }] },
    }).returning();
    comments.byMedia.set(media, [
      { id: `v1-${tag}`, text: "A", from: { id: "fan1", username: "fan1" } },
      { id: `v2-${tag}`, text: "ب", from: { id: "fan2", username: "fan2" } },
      { id: `v3-${tag}`, text: "b 🔥", from: { id: "fan3", username: "fan3" } },
      { id: `v4-${tag}`, text: "what a goal", from: { id: "fan4", username: "fan4" } },
    ]);
    resetCommentPulls();
    await tick();
    const got = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    expect(got.body.items.find((i: { id: number }) => i.id === item.id)?.votes).toEqual({ a: 1, b: 2 });
  });

  it("schedules the weekly thank-you a few hours ahead, counts last week's games, and leaves out what the owner switched off", async () => {
    const venue = (await loadVenue(venueId))!;
    // The Sunday after this week's games, 16:00: the thank-you (21:00) is within the render-ahead window.
    const thisWeek = weekStartOf(Math.round(Date.now() / 60_000) + 180);
    const sunday = fromAmmanLocal(`${addDays(thisWeek, 7)} 16:00`)!;
    await db.update(venueSettingsTable).set({ igSlots: { off: ["top5"] } }).where(eq(venueSettingsTable.academyId, venueId));
    await scheduleFieldPosts((await loadVenue(venueId))!, sunday);
    const made = (await items()).filter((i) => i.originKey === `thanks:${thisWeek}` || i.originKey === `top5:${thisWeek}`);
    expect(made.map((i) => [i.kind, i.placement, i.pinned, ammanLocal(i.slotAt!)])).toEqual([["thanks", "reel", true, `${addDays(thisWeek, 7)} 21:00`]]);
    // The design waits while the week is counted, then shows every filmed game (no analysis here: no goals, no km).
    resetWeekNumbers();
    let projects = await ensureRenderedAll(venue, made[0]);
    for (let i = 0; i < 50 && !projects; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const [fresh] = await db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.id, made[0].id));
      expect(fresh.status).toBe("planned");
      projects = await ensureRenderedAll(venue, fresh);
    }
    expect(projects).toHaveLength(1);
    const custom = (projects![0].data as { custom: Record<string, string> }).custom;
    expect(projects![0].templateKey).toBe("field-thanks");
    expect(Number(custom.matches)).toBeGreaterThanOrEqual(3);
    expect(custom.matches_1).toBeDefined();
    expect(custom.goals).toBeUndefined();
    expect(custom.km).toBeUndefined();
    await db.update(venueSettingsTable).set({ igSlots: {} }).where(eq(venueSettingsTable.academyId, venueId));
  });

  it("lists tonight's free kick-offs, and makes no scorers board from players who didn't agree to be shown", async () => {
    const venue = (await loadVenue(venueId))!;
    const [academy] = await db.select().from((await import("@workspace/db")).academiesTable).where(eq((await import("@workspace/db")).academiesTable.id, venueId));
    const slots = await openSlotsDesign(venue, academy, tomorrow, new Date(), "en");
    expect("parts" in slots && slots.parts[0].data.custom).toMatchObject({ t1: expect.any(String), free: "Free" });
    const board = await leaderboardDesign(venue, academy, ammanLocal(new Date()).slice(0, 7), "en");
    expect(board).toEqual({ skip: "Fewer than three scorers who agreed to be shown" });
  });
});

describe("7. Suggestions, always", () => {
  it("lists what the autopilot will post next that isn't on the calendar, adds one at its own time, and shows today's posts", async () => {
    await db.update(venueSettingsTable).set({ igSlots: { off: ["versus"] } }).where(eq(venueSettingsTable.academyId, venueId));
    const got = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    const sug = got.body.suggestions as Array<{ kind: string; placement: string; at: string; originKey: string }>;
    // Every kind that is on and not on the calendar yet comes up, free pitches for two days; versus is off,
    // and last week's thank-you is already on the calendar (made by the test above).
    const kinds = new Set(sug.map((x) => x.kind));
    for (const k of ["top5", "match_week", "player_week", "open_slots"]) expect(kinds.has(k)).toBe(true);
    expect(kinds.has("versus")).toBe(false);
    const onCalendar = new Set((await items()).map((i) => i.originKey));
    expect(sug.filter((x) => onCalendar.has(x.originKey))).toEqual([]);
    expect(sug.filter((x) => x.kind === "open_slots")).toHaveLength(2);
    expect(sug.find((x) => x.kind === "top5")).toMatchObject({ placement: "reel", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/) });
    expect(sug.find((x) => x.kind === "open_slots")?.placement).toBe("story");
    expect([...sug].map((x) => x.at)).toEqual([...sug].map((x) => x.at).sort());
    // Strangers see nothing; a made-up time or a switched-off kind is refused.
    await request(app).get(`${ig()}/today`).set(auth(strangerId)).expect((r) => expect([403, 404]).toContain(r.status));
    await request(app).post(`${ig()}/suggestions`).set(auth(strangerId)).send({ kind: "top5", at: sug[0].at }).expect((r) => expect([403, 404]).toContain(r.status));
    await request(app).post(`${ig()}/suggestions`).set(auth(ownerId)).send({ kind: "nope", at: sug[0].at }).expect(400);
    const thanks = sug.find((x) => x.kind === "top5")!;
    await request(app).post(`${ig()}/suggestions`).set(auth(ownerId)).send({ kind: "thanks", at: thanks.at.replace(/:\d{2}$/, ":07") }).expect(409);
    await request(app).post(`${ig()}/suggestions`).set(auth(ownerId)).send({ kind: "versus", at: thanks.at }).expect(409);
    // Adding one pins it under the autopilot's own key: on the calendar, gone from the suggestions, never twice.
    const added = await request(app).post(`${ig()}/suggestions`).set(auth(ownerId)).send({ kind: thanks.kind, at: thanks.at }).expect(201);
    expect(added.body.originKey).toBe(thanks.originKey);
    const [row] = (await items()).filter((i) => i.originKey === thanks.originKey);
    expect(row).toMatchObject({ kind: "top5", placement: "reel", pinned: true, status: "planned", projectId: null });
    expect(ammanLocal(row.slotAt!)).toBe(thanks.at);
    await request(app).post(`${ig()}/suggestions`).set(auth(ownerId)).send({ kind: thanks.kind, at: thanks.at }).expect(409);
    const again = await request(app).get(ig()).set(auth(ownerId)).expect(200);
    expect(again.body.suggestions.some((x: { originKey: string }) => x.originKey === thanks.originKey)).toBe(false);
    expect(again.body.suggestions.length).toBe(sug.length - 1);
    // The autopilot's own run later finds it there and adds nothing.
    const at = fromAmmanLocal(thanks.at)!;
    await scheduleFieldPosts((await loadVenue(venueId))!, new Date(at.getTime() - 3 * 3_600_000));
    expect((await items()).filter((i) => i.originKey === thanks.originKey)).toHaveLength(1);
    // Today: the day's posts and the next few suggestions, for the dashboard.
    const today = await request(app).get(`${ig()}/today`).set(auth(ownerId)).expect(200);
    expect(today.body).toMatchObject({ autopilot: expect.any(Boolean), consentMode: expect.any(String) });
    expect(today.body.suggestions.length).toBeGreaterThan(0);
    expect(today.body.suggestions.length).toBeLessThanOrEqual(4);
    const day = ammanLocal(new Date()).slice(0, 10);
    for (const i of today.body.items as Array<{ slotAt: string | null }>) expect(i.slotAt && ammanLocal(new Date(i.slotAt)).slice(0, 10)).toBe(day);
    await db.update(venueSettingsTable).set({ igSlots: {} }).where(eq(venueSettingsTable.academyId, venueId));
  });
});

describe("consent switched off", () => {
  it("takes everything waiting off the calendar and turns the autopilot off", async () => {
    const waiting = await playedBooking({ hoursAgo: 14, consent: "yes" });
    await tick();
    expect((await itemFor(waiting.booking.id)).status).toBe("planned");
    await request(app).put(`/api/admin/venues/${venueId}/instagram-consent`).set(auth(adminId)).send({ mode: "off" }).expect(200);
    expect(await itemFor(waiting.booking.id)).toMatchObject({ status: "skipped", error: "Instagram consent was switched off" });
    const [s] = await db.select().from(venueSettingsTable).where(eq(venueSettingsTable.academyId, venueId));
    expect(s.igAutopilot).toBe(false);
    const events = await db.select().from(venueIgConsentEventsTable).where(eq(venueIgConsentEventsTable.academyId, venueId));
    expect(events.map((e) => e.newMode).sort()).toEqual(["ask", "off", "owner"]);
    // Match pages stop offering anything.
    const page = await request(app).get(`/api/m/${waiting.code}/instagram`).set(auth(captainId)).expect(200);
    expect(page.body.enabled).toBe(false);
    void fromAmmanLocal;
  });
});

