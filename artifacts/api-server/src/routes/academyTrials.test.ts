import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academiesTable,
  academyContactPlayersTable,
  academyContactsTable,
  academyMembersTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  academyTrialClipsTable,
  academyWhatsappMessagesTable,
  academyWhatsappSettingsTable,
  db,
  fieldsTable,
  recordingsTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";

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
vi.mock("./userClips", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./userClips")>();
  return { ...actual, queueUserClipExport: vi.fn(async () => null) };
});

import trialsRouter from "./academyTrials";
import featuredRouter from "./academyFeatured";
import whatsappRouter from "./academyWhatsapp";
import forYouRouter from "./academyCreativeForYou";
import profileRouter from "./academyProfile";
import { sweepTrialFollowUps } from "../lib/marketing/trials";
import { loadSessionSnapshot, nextDaySevenPm, queueReviewRequests, reviewTerm } from "../lib/whatsapp/automations";

const stamp = Date.now();
let app: Express;
let ownerId: number, coachId: number, otherOwnerId: number;
let academyId: number, otherAcademyId: number, fieldId: number;
let squadId: number, sessionId: number, otherSessionId: number;
let leadId: number, lead2Id: number, parentId: number, otherContactId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = (id = academyId) => `/api/academy/console/academies/${id}`;
const DAY = 86_400_000;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", trialsRouter, featuredRouter, whatsappRouter, forYouRouter, profileRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `tr-owner-${stamp}@test.local` },
    { name: `Coach ${stamp}`, email: `tr-coach-${stamp}@test.local` },
    { name: `Other ${stamp}`, email: `tr-other-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, otherOwnerId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Trial field ${stamp}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const academies = await db.insert(academiesTable).values([
    { name: `JUFA ${stamp}`, fieldId, joinCode: `jufa${stamp}` },
    { name: `Other ${stamp}`, fieldId },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: otherOwnerId, role: "owner" },
  ]);
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U10" }).returning();
  squadId = squad.id;
  const [kid] = await db.insert(academyPlayersTable).values({ academyId, squadId, name: "Omar Khaled", jerseyNumber: 7 }).returning();
  const sessions = await db.insert(academySessionsTable).values([
    { academyId, squadId, type: "training", startsAt: new Date(Date.now() - 5 * 3600_000), endsAt: new Date(Date.now() - 4 * 3600_000), location: "Galaxy" },
    { academyId: otherAcademyId, type: "training", startsAt: new Date(Date.now() - 5 * 3600_000), location: "Galaxy" },
  ]).returning();
  [sessionId, otherSessionId] = sessions.map((x) => x.id);
  const contacts = await db.insert(academyContactsTable).values([
    { academyId, phone: "962790000401", name: "Abu Yazan", kind: "lead", stage: "contacted" },
    { academyId, phone: "962790000402", name: "Um Kareem", kind: "lead", stage: "new" },
    { academyId, phone: "962790000403", name: "Abu Omar", kind: "parent" },
    { academyId: otherAcademyId, phone: "962790000404", name: "Elsewhere", kind: "parent" },
  ]).returning();
  [leadId, lead2Id, parentId, otherContactId] = contacts.map((c) => c.id);
  await db.insert(academyContactPlayersTable).values({ contactId: parentId, playerId: kid.id, relationship: "father" });
});

describe("trial sessions", () => {
  it("books the trial session on the person, moving the stage to trial", async () => {
    await request(app).put(`${base()}/contacts/${leadId}/trial`).set(auth(coachId)).send({ sessionId: otherSessionId }).expect(404);
    await request(app).put(`${base(otherAcademyId)}/contacts/${leadId}/trial`).set(auth(otherOwnerId)).send({ sessionId: otherSessionId }).expect(404);
    const res = await request(app).put(`${base()}/contacts/${leadId}/trial`).set(auth(coachId)).send({ sessionId }).expect(200);
    const t = res.body.trials.find((x: { contactId: number }) => x.contactId === leadId);
    expect(t).toMatchObject({ stage: "trial", session: { id: sessionId, hasVideo: false }, clip: null });
    // Due 24 hours after the session ended.
    expect(new Date(t.dueBy).getTime() - new Date(t.session.endsAt).getTime()).toBe(DAY);
  });

  it("cuts the moment only once the session has a video, and only inside it", async () => {
    await request(app).post(`${base()}/contacts/${leadId}/trial-clip`).set(auth(coachId)).send({ momentSeconds: 300, childName: "Yazan" }).expect(409);
    await request(app).post(`${base()}/contacts/${lead2Id}/trial-clip`).set(auth(coachId)).send({ momentSeconds: 300 }).expect(409);
    const [rec] = await db.insert(recordingsTable).values({ fieldId, court: "A", date: "2026-11-03", timeSlot: "16:00", duration: "01:00:00", videoUrl: "https://vz-test.b-cdn.net/0a1b2c3d-trial-video-guid/playlist.m3u8" }).returning({ id: recordingsTable.id });
    await db.insert(academyRecordingsTable).values({ academyId, recordingId: rec.id, sessionId });
    await request(app).post(`${base()}/contacts/${leadId}/trial-clip`).set(auth(coachId)).send({ momentSeconds: 3600 }).expect(400);
    const res = await request(app).post(`${base()}/contacts/${leadId}/trial-clip`).set(auth(coachId)).send({ momentSeconds: 300, childName: "Yazan" }).expect(201);
    const [clip] = await db.select().from(academyTrialClipsTable).where(eq(academyTrialClipsTable.id, res.body.clipId));
    expect(clip).toMatchObject({ status: "prepared", childName: "Yazan", momentSeconds: 300, sessionId });
    const [uc] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clip.userClipId!));
    // 12 seconds around minute 5 of a one-hour video, private, on the academy.
    expect(Number(uc.startTime) * 3600).toBeCloseTo(294, 1);
    expect(Number(uc.endTime) * 3600).toBeCloseTo(306, 1);
    expect(uc).toMatchObject({ visibility: "private", academyId, videoId: "0a1b2c3d-trial-video-guid" });
    // A second try replaces the clip that wasn't sent.
    const again = await request(app).post(`${base()}/contacts/${leadId}/trial-clip`).set(auth(coachId)).send({ momentSeconds: 310, childName: "Yazan" }).expect(201);
    const rows = await db.select().from(academyTrialClipsTable).where(eq(academyTrialClipsTable.contactId, leadId));
    expect(rows.map((r) => r.id)).toEqual([again.body.clipId]);
  });

  it("sends the clip to the family once, opens at /kc/<token>, and sets the follow-up", async () => {
    const [clip] = await db.select().from(academyTrialClipsTable).where(eq(academyTrialClipsTable.contactId, leadId));
    await request(app).get(`/api/kc/${clip.token}`).expect(404);
    const off = await request(app).post(`${base()}/trial-clips/${clip.id}/send`).set(auth(coachId)).expect(409);
    expect(off.body.code).toBe("whatsapp_off");
    await db.insert(academyWhatsappSettingsTable).values({ academyId, sender: "replay", locale: "en" });
    const res = await request(app).post(`${base()}/trial-clips/${clip.id}/send`).set(auth(coachId)).expect(200);
    expect(res.body.queued).toBe(1);
    const [msg] = await db.select().from(academyWhatsappMessagesTable).where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.kind, "trial_clip")));
    expect(msg.phone).toBe("962790000401");
    expect(msg.body).toContain("Hi Abu Yazan");
    expect(msg.body).toContain("Yazan in action at the trial session");
    expect(msg.body).toContain(`https://replay.test/kc/${clip.token}`);
    const [sent] = await db.select().from(academyTrialClipsTable).where(eq(academyTrialClipsTable.id, clip.id));
    expect(sent.followUpStatus).toBe("pending");
    expect(sent.followUpAt!.getTime() - sent.sentAt!.getTime()).toBe(2 * DAY);
    const again = await request(app).post(`${base()}/trial-clips/${clip.id}/send`).set(auth(coachId)).expect(200);
    expect(again.body).toMatchObject({ queued: 0, reason: "already_sent" });
    const page = await request(app).get(`/api/kc/${clip.token}`).expect(200);
    expect(page.body).toMatchObject({ trial: true, firstName: "Yazan", note: null });
  });

  it("follows up when due, with the registration link, unless People shows them joined", async () => {
    // A second family's trial: they joined before the follow-up was due.
    await request(app).put(`${base()}/contacts/${lead2Id}/trial`).set(auth(coachId)).send({ sessionId }).expect(200);
    const made = await request(app).post(`${base()}/contacts/${lead2Id}/trial-clip`).set(auth(coachId)).send({ momentSeconds: 600 }).expect(201);
    await request(app).post(`${base()}/trial-clips/${made.body.clipId}/send`).set(auth(coachId)).expect(200);
    await db.update(academyContactsTable).set({ stage: "joined" }).where(eq(academyContactsTable.id, lead2Id));
    const later = new Date(Date.now() + 2 * DAY + 60_000);
    expect(await sweepTrialFollowUps(new Date(Date.now() + 3600_000))).toEqual({ sent: 0, skipped: 0 });
    const result = await sweepTrialFollowUps(later);
    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    const fu = await db.select().from(academyWhatsappMessagesTable).where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.kind, "trial_follow_up")));
    expect(fu).toHaveLength(1);
    expect(fu[0].phone).toBe("962790000401");
    expect(fu[0].body).toContain(`https://replay.test/join/jufa${stamp}`);
    expect(await sweepTrialFollowUps(later)).toEqual({ sent: 0, skipped: 0 });
    const rows = await db.select().from(academyTrialClipsTable).where(eq(academyTrialClipsTable.academyId, academyId));
    expect(rows.map((r) => r.followUpStatus).sort()).toEqual(["sent", "skipped"]);
  });
});

describe("referrals", () => {
  it("records who referred a family and what they get, within the academy only", async () => {
    await request(app).patch(`${base()}/contacts/${leadId}`).set(auth(ownerId)).send({ referredByContactId: otherContactId }).expect(400);
    await request(app).patch(`${base()}/contacts/${leadId}`).set(auth(ownerId)).send({ referredByContactId: leadId }).expect(400);
    const res = await request(app).patch(`${base()}/contacts/${leadId}`).set(auth(ownerId)).send({ referredByContactId: parentId, referralNote: "10% off December" }).expect(200);
    expect(res.body).toMatchObject({ referredByContactId: parentId, referralNote: "10% off December" });
    const list = await request(app).get(`${base()}/contacts`).set(auth(ownerId)).expect(200);
    expect(list.body.find((c: { id: number }) => c.id === leadId)).toMatchObject({ referredByContactId: parentId, referralNote: "10% off December", trialSessionId: sessionId });
    const cleared = await request(app).patch(`${base()}/contacts/${leadId}`).set(auth(ownerId)).send({ referredByContactId: null, referralNote: "" }).expect(200);
    expect(cleared.body).toMatchObject({ referredByContactId: null, referralNote: null });
  });
});

describe("Google review requests", () => {
  it("are off by default, need the review link, go the next day at 7 pm, once per family per term", async () => {
    const session = (await loadSessionSnapshot(academyId, sessionId))!;
    const now = new Date("2026-11-03T15:00:00Z");
    expect(await queueReviewRequests(academyId, session, now)).toBe(0);
    await db.update(academyWhatsappSettingsTable).set({ automations: { review_request: { enabled: true } } }).where(eq(academyWhatsappSettingsTable.academyId, academyId));
    expect(await queueReviewRequests(academyId, session, now)).toBe(0);
    await request(app).put(`${base()}/profile`).set(auth(ownerId)).send({ name: `JUFA ${stamp}`, googleReviewUrl: "g.page/r/jufa-review" }).expect(200);
    expect(await queueReviewRequests(academyId, session, now)).toBe(1);
    const [msg] = await db.select().from(academyWhatsappMessagesTable).where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.kind, "review_request")));
    expect(msg.phone).toBe("962790000403");
    expect(msg.scheduledFor.toISOString()).toBe("2026-11-04T16:00:00.000Z");
    expect(msg.body).toContain("https://g.page/r/jufa-review");
    expect(msg.body).toContain("Omar");
    // Again later the same term: nothing new. The next term: one more.
    expect(await queueReviewRequests(academyId, session, new Date("2026-12-20T15:00:00Z"))).toBe(0);
    expect(await queueReviewRequests(academyId, session, new Date("2027-01-10T15:00:00Z"))).toBe(1);
  });

  it("keeps the review link when a profile save doesn't mention it", async () => {
    const res = await request(app).put(`${base()}/profile`).set(auth(ownerId)).send({ name: `JUFA ${stamp}` }).expect(200);
    expect(res.body.googleReviewUrl).toBe("https://g.page/r/jufa-review");
    const bad = await request(app).put(`${base()}/profile`).set(auth(ownerId)).send({ name: `JUFA ${stamp}`, googleReviewUrl: "not a link" }).expect(400);
    expect(bad.body.fields.googleReviewUrl).toBe("invalid_link");
  });

  it("names terms Sep–Dec, Jan–Apr and May–Aug, and 7 pm Amman the next day", () => {
    expect(reviewTerm(new Date("2026-09-01T00:00:00Z"))).toBe("2026-sep");
    expect(reviewTerm(new Date("2026-12-31T21:30:00Z"))).toBe("2027-jan"); // already 1 January in Amman
    expect(reviewTerm(new Date("2027-04-30T12:00:00Z"))).toBe("2027-jan");
    expect(reviewTerm(new Date("2027-05-01T12:00:00Z"))).toBe("2027-may");
    expect(nextDaySevenPm(new Date("2026-11-30T22:30:00Z")).toISOString()).toBe("2026-12-02T16:00:00.000Z"); // 1:30 am on the 1st in Amman
  });
});

describe("content calendar", () => {
  it("starts on the default week, takes the owner's week, and goes back to the default", async () => {
    const def = await request(app).get(`${base()}/creative/content-calendar`).set(auth(ownerId)).expect(200);
    expect(def.body).toEqual({ isDefault: true, slots: [{ day: 1, kind: "player" }, { day: 3, kind: "training" }, { day: 4, kind: "matchday" }, { day: 6, kind: "fulltime" }] });
    await request(app).get(`${base()}/creative/content-calendar`).set(auth(coachId)).expect(403);
    await request(app).put(`${base()}/creative/content-calendar`).set(auth(ownerId)).send({ slots: [{ day: 7, kind: "player" }] }).expect(400);
    const mine = await request(app).put(`${base()}/creative/content-calendar`).set(auth(ownerId)).send({ slots: [{ day: 5, kind: "matchday" }, { day: 0, kind: "weekly" }, { day: 5, kind: "matchday" }] }).expect(200);
    expect(mine.body).toEqual({ isDefault: false, slots: [{ day: 0, kind: "weekly" }, { day: 5, kind: "matchday" }] });
    const reset = await request(app).put(`${base()}/creative/content-calendar`).set(auth(ownerId)).send({ slots: null }).expect(200);
    expect(reset.body.isDefault).toBe(true);
  });
});
