import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academiesTable,
  academyContactPlayersTable,
  academyContactsTable,
  academyMatchLineupsTable,
  academyMatchPagesTable,
  academyMatchPlayerStatsTable,
  academyMembersTable,
  academyPlayerClipsTable,
  academyPlayerFeaturesTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
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
vi.mock("../lib/whatsapp/waha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/waha")>();
  return { ...actual, sendText: vi.fn(async () => { throw new Error("must not send in tests"); }) };
});

import featuredRouter from "./academyFeatured";

const stamp = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let otherOwnerId: number;
let academyId: number;
let otherAcademyId: number;
let squadId: number;
let kids: Array<{ id: number; name: string; jerseyNumber: number | null }>;
let matchId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = (id = academyId) => `/api/academy/console/academies/${id}`;
const token = (n: number) => n.toString(16).padStart(32, "0");

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", featuredRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `feat-owner-${stamp}@test.local` },
    { name: `Coach ${stamp}`, email: `feat-coach-${stamp}@test.local` },
    { name: `Other ${stamp}`, email: `feat-other-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, otherOwnerId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Feat field ${stamp}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([{ name: `JUFA ${stamp}`, fieldId: field.id }, { name: `Other ${stamp}`, fieldId: field.id }]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: otherOwnerId, role: "owner" },
  ]);
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U12" }).returning();
  squadId = squad.id;
  kids = await db.insert(academyPlayersTable).values([
    { academyId, squadId, name: "Omar Khaled", jerseyNumber: 7, publicPostsConsent: true },
    { academyId, squadId, name: "Zaid Khaled", jerseyNumber: 9, publicPostsConsent: true },
    { academyId, squadId, name: "Ali Hasan", jerseyNumber: 11 },
    { academyId, squadId, name: "Karim Saleh", jerseyNumber: 19 },
  ]).returning({ id: academyPlayersTable.id, name: academyPlayersTable.name, jerseyNumber: academyPlayersTable.jerseyNumber });
  // Omar and Zaid are brothers: one father's phone. Ali's mother has her own.
  const contacts = await db.insert(academyContactsTable).values([
    { academyId, phone: "962790000201", name: "Abu Omar", kind: "parent" },
    { academyId, phone: "962790000202", name: "Um Ali", kind: "parent" },
  ]).returning();
  await db.insert(academyContactPlayersTable).values([
    { contactId: contacts[0].id, playerId: kids[0].id, relationship: "father" },
    { contactId: contacts[0].id, playerId: kids[1].id, relationship: "father" },
    { contactId: contacts[1].id, playerId: kids[2].id, relationship: "mother" },
  ]);
  // An analysed match this month: Omar, Zaid and Ali found; Karim in the squad, no footage of him.
  const [m] = await db.insert(academySessionsTable).values({ academyId, squadId, type: "match", startsAt: new Date(Date.now() - 2 * 86_400_000), location: "Galaxy", opponent: "Wehdat" }).returning();
  matchId = m.id;
  await db.insert(academyMatchPagesTable).values({ sessionId: matchId, academyId, statsComputedAt: new Date() });
  await db.insert(academyMatchLineupsTable).values(kids.map((k) => ({ sessionId: matchId, playerId: k.id, shirtNumber: k.jerseyNumber, inSquad: true })));
  const [rec] = await db.insert(recordingsTable).values({ fieldId: field.id, court: "A", date: "2026-11-01", timeSlot: "18:00", duration: "01:00:00", videoUrl: "https://example.test/play/1/abc" }).returning({ id: recordingsTable.id });
  await db.insert(academyMatchPlayerStatsTable).values(kids.slice(0, 3).map((k) => ({
    sessionId: matchId, academyId, playerId: k.id, recordingId: rec.id, stats: { playerId: k.id, minutes: 30 },
  })));
  // Prepared clips for the three found (as preparePrivateClips leaves them), Ali's not exported yet.
  const clips = await db.insert(userClipsTable).values(kids.slice(0, 3).map((k, i) => ({
    userId: ownerId, videoId: "abc", title: k.name, startTime: "0.1", endTime: "0.2", academyId,
    exportStatus: i < 2 ? "done" : "pending",
  }))).returning({ id: userClipsTable.id });
  // Exported to Storage as the primary renderer names them (clips/<id>.mp4).
  for (const c of clips.slice(0, 2)) await db.update(userClipsTable).set({ exportedUrl: `https://storage.bunnycdn.com/clips/${c.id}.mp4` }).where(eq(userClipsTable.id, c.id));
  await db.insert(academyPlayerClipsTable).values(kids.slice(0, 3).map((k, i) => ({
    academyId, sessionId: matchId, playerId: k.id, recordingId: rec.id, userClipId: clips[i].id, token: token(stamp * 10 + i),
    momentKind: i === 0 ? "dribble" : "presence", momentSeconds: 100 + i,
    note: i === 0 ? { kind: "above", stat: "dribblesWon", value: 3, usual: 1, matches: 3 } : null,
  })));
});

describe("public-post consent", () => {
  it("is off until the owner ticks it, and only the owner can change it", async () => {
    const list = await request(app).get(`${base()}/players/public-consent`).set(auth(coachId)).expect(200);
    const byId = new Map(list.body.players.map((p: { playerId: number; consent: boolean }) => [p.playerId, p.consent]));
    expect(byId.get(kids[2].id)).toBe(false);
    await request(app).put(`${base()}/players/${kids[2].id}/public-consent`).set(auth(coachId)).send({ consent: true }).expect(403);
    await request(app).put(`${base(otherAcademyId)}/players/${kids[2].id}/public-consent`).set(auth(otherOwnerId)).send({ consent: true }).expect(404);
    await request(app).put(`${base()}/players/${kids[3].id}/public-consent`).set(auth(ownerId)).send({ consent: true }).expect(200);
    const [row] = await db.select().from(academyPlayersTable).where(eq(academyPlayersTable.id, kids[3].id));
    expect(row.publicPostsConsent).toBe(true);
    expect(row.publicPostsConsentAt).toBeInstanceOf(Date);
    await request(app).put(`${base()}/players/${kids[3].id}/public-consent`).set(auth(ownerId)).send({ consent: false }).expect(200);
  });
});

describe("targets", () => {
  it("default to one solo public post a month and a private clip per analysed match; the owner changes them", async () => {
    expect((await request(app).get(`${base()}/featured/targets`).set(auth(coachId)).expect(200)).body.targets).toEqual({ publicPostsPerMonth: 1, privateClipPerMatch: true });
    await request(app).put(`${base()}/featured/targets`).set(auth(coachId)).send({ publicPostsPerMonth: 2 }).expect(403);
    await request(app).put(`${base()}/featured/targets`).set(auth(ownerId)).send({ publicPostsPerMonth: 9 }).expect(400);
    const saved = await request(app).put(`${base()}/featured/targets`).set(auth(ownerId)).send({ publicPostsPerMonth: 2 }).expect(200);
    expect(saved.body.targets).toEqual({ publicPostsPerMonth: 2, privateClipPerMatch: true });
    await request(app).put(`${base()}/featured/targets`).set(auth(ownerId)).send({ publicPostsPerMonth: 1 }).expect(200);
  });
});

describe("private clips", () => {
  it("lists each child's clip with its family link", async () => {
    const res = await request(app).get(`${base()}/matches/${matchId}/private-clips`).set(auth(coachId)).expect(200);
    expect(res.body.clips.map((c: { number: number }) => c.number)).toEqual([7, 9, 11]);
    expect(res.body.clips[0]).toMatchObject({ status: "prepared", momentKind: "dribble", url: `https://replay.test/kc/${token(stamp * 10)}` });
  });

  it("prepares nothing for a match without footage, and says why", async () => {
    const [m] = await db.insert(academySessionsTable).values({ academyId, squadId, type: "match", startsAt: new Date(Date.now() - 86_400_000), location: "Galaxy" }).returning();
    await request(app).post(`${base()}/matches/${m.id}/private-clips/prepare`).set(auth(coachId)).expect(403);
    const res = await request(app).post(`${base()}/matches/${m.id}/private-clips/prepare`).set(auth(ownerId)).expect(200);
    expect(res.body).toMatchObject({ prepared: 0, reason: "no_recording", clips: [] });
  });

  it("a family link does not open before the clip is sent", async () => {
    await request(app).get(`/api/kc/${token(stamp * 10)}`).expect(404);
    await request(app).get(`/api/kc/not-a-token`).expect(404);
  });

  it("needs WhatsApp on, and only the owner sends", async () => {
    await request(app).post(`${base()}/matches/${matchId}/private-clips/send`).set(auth(coachId)).send({}).expect(403);
    const off = await request(app).post(`${base()}/matches/${matchId}/private-clips/send`).set(auth(ownerId)).send({}).expect(409);
    expect(off.body.code).toBe("whatsapp_off");
  });

  it("sends one message per family: brothers' clips go to their father together", async () => {
    await db.insert(academyWhatsappSettingsTable).values({ academyId, sender: "replay", locale: "en" });
    const res = await request(app).post(`${base()}/matches/${matchId}/private-clips/send`).set(auth(ownerId)).send({}).expect(200);
    expect(res.body).toMatchObject({ messages: 2, children: 3, unreachable: [] });
    const sent = await db.select().from(academyWhatsappMessagesTable)
      .where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.kind, "player_clip")));
    expect(sent).toHaveLength(2);
    const father = sent.find((m) => m.phone === "962790000201")!;
    expect(father.playerId).toBeNull();
    expect(father.body).toContain(`• Omar: his dribble — 3 dribbles won, more than his usual 1\nhttps://replay.test/kc/${token(stamp * 10)}`);
    expect(father.body).toContain(`• Zaid: him in action\nhttps://replay.test/kc/${token(stamp * 10 + 1)}`);
    const mother = sent.find((m) => m.phone === "962790000202")!;
    expect(mother.playerId).toBe(kids[2].id);
    expect(mother.body).not.toContain("Omar");
    // Each child's clip is now his private appearance.
    const logged = await db.select().from(academyPlayerFeaturesTable).where(eq(academyPlayerFeaturesTable.academyId, academyId));
    expect(logged.filter((f) => f.itemType === "clip").map((f) => f.playerId).sort()).toEqual(kids.slice(0, 3).map((k) => k.id).sort());
    // Sending again sends nothing new.
    const again = await request(app).post(`${base()}/matches/${matchId}/private-clips/send`).set(auth(ownerId)).send({}).expect(200);
    expect(again.body).toMatchObject({ messages: 0, children: 0 });
  });

  it("opens for the family without an account, and counts as opened only when the video is played", async () => {
    const meta = await request(app).get(`/api/kc/${token(stamp * 10)}`).expect(200);
    expect(meta.body).toMatchObject({ firstName: "Omar", momentKind: "dribble", ready: true });
    expect(meta.body.academy.name).toBe(`JUFA ${stamp}`);
    let [row] = await db.select().from(academyPlayerClipsTable).where(eq(academyPlayerClipsTable.token, token(stamp * 10)));
    expect(row.openedAt).toBeNull();
    const video = await request(app).get(`/api/kc/${token(stamp * 10)}/video`).expect(302);
    expect(video.headers.location).toMatch(/^https:\/\/replayjo\.b-cdn\.net\/clips\/\d+\.mp4$/);
    [row] = await db.select().from(academyPlayerClipsTable).where(eq(academyPlayerClipsTable.token, token(stamp * 10)));
    expect(row.openedAt).toBeInstanceOf(Date);
    // Not exported yet: the page says so instead of playing.
    await request(app).get(`/api/kc/${token(stamp * 10 + 2)}/video`).expect(202);
  });
});

describe("the squad grid", () => {
  it("colours every child, writes the summary and flags the child with no footage", async () => {
    await db.insert(academyPlayerFeaturesTable).values({ academyId, playerId: kids[0].id, itemType: "post", itemId: `x${stamp}`, visibility: "public", solo: true, featuredAt: new Date() });
    const res = await request(app).get(`${base()}/featured`).set(auth(coachId)).expect(200);
    const by = Object.fromEntries(res.body.cells.map((c: { number: number }) => [c.number, c]));
    // Omar: his solo post and his clip → green.
    expect(by[7]).toMatchObject({ status: "green", mode: "public" });
    // Zaid: clip yes, solo public post not yet.
    expect(by[9]).toMatchObject({ status: "amber", missing: ["public_post"] });
    // Ali: private only, got his clip.
    expect(by[11]).toMatchObject({ status: "green", mode: "private_only" });
    // Karim: never featured, no footage.
    expect(by[19]).toMatchObject({ status: "red" });
    expect(res.body.summary).toMatchObject({ featured: 2, total: 4 });
    expect(res.body.summary.notYet.map((x: { number: number }) => x.number)).toEqual([9, 19]);
    expect(res.body.gaps).toEqual([expect.objectContaining({ playerId: kids[3].id, number: 19, matches: 1, latestSessionId: matchId })]);
    expect(res.body.canEdit).toBe(false);
    expect((await request(app).get(`${base()}/featured`).set(auth(ownerId)).expect(200)).body.canEdit).toBe(true);
    await request(app).get(`${base()}/featured`).set(auth(otherOwnerId)).expect(403);
  });
});
