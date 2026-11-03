import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyContactPlayersTable,
  academyContactsTable,
  academyMembersTable,
  academyPlayerClipsTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  academyAdWalletEntriesTable,
  academyRecordingsTable,
  academySocialPostsTable,
  academyPlayerGuardiansTable,
  academyValueReportSharesTable,
  academyWhatsappMessagesTable,
  metaAdLeadsTable,
  pool,
  recordingViewsTable,
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

import valueRouter from "./academyValueReport";
import { ensureAdditiveColumns } from "../lib/ensureAdditiveColumns";
import { ammanMonth } from "../lib/featured/rules";
import { groupFamilies, previousMonth } from "../lib/valueReport";

const stamp = Date.now();
let app: Express;
let ownerId: number, coachId: number, otherOwnerId: number, fatherId: number;
let academyId: number, otherAcademyId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = (id = academyId) => `/api/academy/console/academies/${id}/value-report`;
const token = (n: number) => n.toString(16).padStart(32, "0");
const month = ammanMonth(new Date());

beforeAll(async () => {
  // The People stage trigger is installed at boot, not by the schema push.
  await ensureAdditiveColumns(pool);
  app = express();
  app.use(express.json());
  app.use("/api", valueRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `vr-owner-${stamp}@test.local` },
    { name: `Coach ${stamp}`, email: `vr-coach-${stamp}@test.local` },
    { name: `Other ${stamp}`, email: `vr-other-${stamp}@test.local` },
    { name: `Father ${stamp}`, email: `vr-father-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, otherOwnerId, fatherId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `VR field ${stamp}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([{ name: `JUFA ${stamp}`, fieldId: field.id }, { name: `Other ${stamp}`, fieldId: field.id }]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: otherOwnerId, role: "owner" },
  ]);
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U12" }).returning();
  const kids = await db.insert(academyPlayersTable).values([
    { academyId, squadId: squad.id, name: "Omar Khaled", jerseyNumber: 7, publicPostsConsent: true },
    { academyId, squadId: squad.id, name: "Zaid Khaled", jerseyNumber: 9, publicPostsConsent: true },
    { academyId, squadId: squad.id, name: "Ali Hasan", jerseyNumber: 11 },
    { academyId, squadId: squad.id, name: "Karim Saleh", jerseyNumber: 19 },
  ]).returning({ id: academyPlayersTable.id });
  // Families: Omar and Zaid are brothers (one father's account); Ali's mother by phone; Karim alone. Three families... and Karim's.
  await db.insert(academyPlayerGuardiansTable).values([
    { playerId: kids[0].id, userId: fatherId, addedBy: "owner" },
    { playerId: kids[1].id, userId: fatherId, addedBy: "owner" },
  ]);
  const [mother] = await db.insert(academyContactsTable).values({ academyId, phone: "962790000301", name: "Um Ali", kind: "parent" }).returning();
  await db.insert(academyContactPlayersTable).values({ contactId: mother.id, playerId: kids[2].id, relationship: "mother" });
  // A match this month with its video.
  const [m] = await db.insert(academySessionsTable).values({ academyId, squadId: squad.id, type: "match", startsAt: new Date(Date.now() - 3600_000), location: "Galaxy" }).returning();
  const [rec] = await db.insert(recordingsTable).values({ fieldId: field.id, court: "A", date: "2026-11-01", timeSlot: "18:00", duration: "01:00:00", videoUrl: "https://example.test/play/1/abc" }).returning({ id: recordingsTable.id });
  await db.insert(academyRecordingsTable).values({ academyId, recordingId: rec.id, sessionId: m.id });
  // The father watched the match video; Ali's clip was sent and opened; Karim's sent, not opened.
  await db.insert(recordingViewsTable).values({ recordingId: rec.id, viewerUserId: fatherId });
  const clips = await db.insert(userClipsTable).values([0, 1, 2].map((i) => ({ userId: ownerId, videoId: "abc", title: `c${i}`, startTime: "0.1", endTime: "0.2", academyId }))).returning({ id: userClipsTable.id });
  await db.insert(academyPlayerClipsTable).values([
    { academyId, sessionId: m.id, playerId: kids[2].id, userClipId: clips[0].id, token: token(stamp * 10 + 1), status: "sent", sentAt: new Date(), openedAt: new Date() },
    { academyId, sessionId: m.id, playerId: kids[3].id, userClipId: clips[1].id, token: token(stamp * 10 + 2), status: "sent", sentAt: new Date() },
  ]);
  // Two posts published from Replay (one with reach), one still a draft.
  await db.insert(academySocialPostsTable).values([
    { academyId, status: "published", publishedAt: new Date(), insights: { instagram: { reach: 300 }, facebook: { reach: 120 } } },
    { academyId, status: "published", publishedAt: new Date() },
    { academyId, status: "draft" },
  ]);
  // Three WhatsApp messages left, one read; one failed; one incoming.
  await db.insert(academyWhatsappMessagesTable).values([
    { academyId, kind: "player_clip", phone: "962790000301", body: "x", status: "read", sentAt: new Date(), readAt: new Date() },
    { academyId, kind: "player_clip", phone: "962790000302", body: "x", status: "delivered", sentAt: new Date() },
    { academyId, kind: "reply", phone: "962790000303", body: "x", status: "sent", sentAt: new Date() },
    { academyId, kind: "reply", phone: "962790000304", body: "x", status: "failed" },
    { academyId, kind: "reply", direction: "in", phone: "962790000305", body: "x", status: "read", sentAt: new Date() },
  ]);
  // People: an ad lead goes to trial and joins as a parent; a walk-in enquiry stays new.
  const [lead] = await db.insert(academyContactsTable).values({ academyId, phone: "962790000310", kind: "lead", stage: "new", source: "meta_ad" }).returning();
  await db.insert(academyContactsTable).values({ academyId, phone: "962790000311", kind: "lead", stage: "new" });
  await db.update(academyContactsTable).set({ stage: "trial" }).where(eq(academyContactsTable.id, lead.id));
  await db.update(academyContactsTable).set({ stage: "joined" }).where(eq(academyContactsTable.id, lead.id));
  await db.update(academyContactsTable).set({ kind: "parent" }).where(eq(academyContactsTable.id, lead.id));
  await db.insert(metaAdLeadsTable).values({ academyId, contactId: lead.id, source: "whatsapp", externalId: `wa:${stamp}` });
  // 12.500 JOD of Replay-run ads this month; a pending top-up doesn't count.
  await db.insert(academyAdWalletEntriesTable).values([
    { academyId, kind: "spend", amountFils: -7500 },
    { academyId, kind: "spend", amountFils: -5000 },
    { academyId, kind: "topup", amountFils: 50000, status: "pending" },
  ]);
});

describe("value report", () => {
  it("counts the month for the owner, and only the owner", async () => {
    await request(app).get(`${base()}?month=${month}`).set(auth(coachId)).expect(403);
    await request(app).get(`${base()}?month=${month}`).set(auth(otherOwnerId)).expect(403);
    const res = await request(app).get(`${base()}?month=${month}`).set(auth(ownerId)).expect(200);
    const r = res.body.report;
    expect(r.month).toBe(month);
    expect(r.partial).toBe(true);
    expect(r.footage).toEqual({ matchVideos: 1, clipsMade: 3, privateClipsSent: 2 });
    expect(r.posts).toEqual({ published: 2, reach: 420 });
    expect(r.messages).toEqual({ sent: 3, read: 1 });
    // Families: the brothers' (watched the video), Ali's (opened), Karim's (sent, not opened).
    expect(r.families).toEqual({ total: 3, reached: 3, opened: 2, openedPct: 67 });
    expect(r.featured.total).toBe(4);
    expect(r.people).toMatchObject({ enquiries: 2, trials: 1, joined: 1 });
    expect(r.people.trackedSince).toEqual(expect.any(String));
    expect(r.ads).toEqual({ ran: true, spendJod: 12.5, joinedFromAds: 1, costPerJoinedJod: 12.5 });
    expect(res.body.share).toBeNull();
  });

  it("says no ads ran, and gives no cost per player, in a month without spend", async () => {
    const res = await request(app).get(`${base(otherAcademyId)}?month=${month}`).set(auth(otherOwnerId)).expect(200);
    expect(res.body.report.ads).toEqual({ ran: false, spendJod: null, joinedFromAds: 0, costPerJoinedJod: null });
    expect(res.body.report.families).toMatchObject({ total: 0, openedPct: null });
  });

  it("refuses a month that hasn't started", async () => {
    const [y] = month.split("-").map(Number);
    await request(app).get(`${base()}?month=${y + 1}-01`).set(auth(ownerId)).expect(400);
  });

  it("shares a month by link, without naming or numbering any child, until the owner turns it off", async () => {
    await request(app).post(`${base()}/share`).set(auth(coachId)).send({ month }).expect(403);
    const made = await request(app).post(`${base()}/share`).set(auth(ownerId)).send({ month }).expect(201);
    const again = await request(app).post(`${base()}/share`).set(auth(ownerId)).send({ month }).expect(200);
    expect(again.body.share.token).toBe(made.body.share.token);
    const own = await request(app).get(`${base()}?month=${month}`).set(auth(ownerId)).expect(200);
    expect(own.body.share.token).toBe(made.body.share.token);
    expect(own.body.report.featured.notYet.length).toBeGreaterThan(0);
    const pub = await request(app).get(`/api/vr/${made.body.share.token}`).expect(200);
    expect(pub.headers["x-robots-tag"]).toBe("noindex");
    expect(pub.body.report.footage.matchVideos).toBe(1);
    expect(pub.body.report.featured.notYet).toEqual([]);
    expect(JSON.stringify(pub.body)).not.toMatch(/Omar|Zaid|Ali Hasan|Karim/);
    await request(app).delete(`${base(otherAcademyId)}/share/${made.body.share.id}`).set(auth(otherOwnerId)).expect(404);
    await request(app).delete(`${base()}/share/${made.body.share.id}`).set(auth(ownerId)).expect(200);
    await request(app).get(`/api/vr/${made.body.share.token}`).expect(404);
    await request(app).get(`/api/vr/not-a-token`).expect(404);
    const rows = await db.select().from(academyValueReportSharesTable).where(eq(academyValueReportSharesTable.academyId, academyId));
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
  });
});

describe("helpers", () => {
  it("joins children who share a parent into one family", () => {
    const f = groupFamilies([1, 2, 3, 4], [{ playerId: 1, key: "u9" }, { playerId: 2, key: "u9" }, { playerId: 2, key: "c5" }, { playerId: 3, key: "c5" }]);
    expect(new Set(f.values()).size).toBe(2);
    expect(f.get(3)).toBe(f.get(1));
  });
  it("steps back a month across a year", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-11")).toBe("2026-10");
  });
});
