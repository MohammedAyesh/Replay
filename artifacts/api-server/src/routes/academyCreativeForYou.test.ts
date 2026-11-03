import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  academiesTable,
  academyCreativeProjectsTable,
  academyMatchLineupsTable,
  academyMatchPlayerStatsTable,
  academyMembersTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  brandingProfilesTable,
  db,
  fieldsTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";

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

import forYouRouter from "./academyCreativeForYou";
import { resetAutoDraftThrottle } from "../lib/creative/autoDrafts";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let academyId: number;
let otherAcademyId: number;
let wonId: number;
let fixtureId: number;
let otherSessionId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (path: string, academy = academyId) => `/api/academy/console/academies/${academy}/creative${path}`;
const HOUR = 3_600_000;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", forYouRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-foryou-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-foryou-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `For you field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([
    { name: `For You Academy ${tag}`, nameAr: "أكاديمية إلك", fieldId: field.id },
    { name: `Other For You ${tag}`, fieldId: field.id },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: ownerId, role: "owner" },
  ]);
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U-12 Blue", ageGroup: "U-12" }).returning({ id: academySquadsTable.id });
  const now = Date.now();
  const sessions = await db.insert(academySessionsTable).values([
    { academyId, squadId: squad.id, type: "match", startsAt: new Date(now - 2 * 24 * HOUR), location: "Galaxy", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1 },
    { academyId, squadId: squad.id, type: "match", startsAt: new Date(now + 3 * 24 * HOUR), location: "Galaxy", opponent: "Ramtha" },
    { academyId: otherAcademyId, type: "match", startsAt: new Date(now - 24 * HOUR), location: "Elsewhere", opponent: "X", ownScore: 1, opponentScore: 0 },
  ]).returning({ id: academySessionsTable.id });
  [wonId, fixtureId, otherSessionId] = sessions.map((s) => s.id);
  // His parents ticked public-post consent: without it he is left out of every public draft (lib/featured).
  const [player] = await db.insert(academyPlayersTable).values({ academyId, squadId: squad.id, name: "Ahmad Saleh", jerseyNumber: 10, publicPostsConsent: true }).returning({ id: academyPlayersTable.id });
  const [rec] = await db.insert(recordingsTable).values({
    fieldId: field.id, court: "1", date: "2026-10-31", timeSlot: "18:00", duration: "60:00", videoUrl: `https://vz.test/foryou-${tag}/playlist.m3u8`,
  } as typeof recordingsTable.$inferInsert).returning({ id: recordingsTable.id });
  await db.insert(academyRecordingsTable).values({ academyId, recordingId: rec.id, sessionId: wonId });
  await db.insert(academyMatchLineupsTable).values({ sessionId: wonId, playerId: player.id, shirtNumber: 9 });
  await db.insert(academyMatchPlayerStatsTable).values({ sessionId: wonId, academyId, playerId: player.id, recordingId: rec.id, stats: { goals: 2 } });
});

afterAll(async () => {
  await db.delete(academyCreativeProjectsTable).where(inArray(academyCreativeProjectsTable.academyId, [academyId, otherAcademyId]));
  await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), inArray(brandingProfilesTable.scopeId, [academyId, otherAcademyId])));
});

describe("creative for you: access", () => {
  it("is owner only and scoped to the academy", async () => {
    expect((await request(app).get(url("/for-you")).set(auth(coachId))).status).toBe(403);
    expect((await request(app).get(url(`/sessions/${wonId}/data`)).set(auth(coachId))).status).toBe(403);
    expect((await request(app).post(url("/for-you/1/skip")).set(auth(coachId))).status).toBe(403);
    // Another academy's session is not found from this academy.
    expect((await request(app).get(url(`/sessions/${otherSessionId}/data`)).set(auth(ownerId))).status).toBe(404);
  });
});

describe("creative for you: session data", () => {
  it("fills the match, scorers by shirt number while names are off", async () => {
    const res = await request(app).get(url(`/sessions/${wonId}/data?locale=en`)).set(auth(ownerId));
    expect(res.status).toBe(200);
    expect(res.body.data.match).toMatchObject({ ownName: `For You Academy ${tag}`, opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1, squad: "U-12 Blue", place: "Galaxy", scorers: "#9 ×2" });
    expect(res.body.data.match.date).toMatch(/^[A-Z]{3} \d{1,2} [A-Z]{3}$/);
    expect(JSON.stringify(res.body)).not.toContain("Ahmad");
    // Footage but no moment: a still from the recording.
    expect(res.body.data.media).toMatchObject({ type: "frame" });
    const ar = await request(app).get(url(`/sessions/${wonId}/data`)).set(auth(ownerId));
    expect(ar.body.data.match.ownName).toBe("أكاديمية إلك");
  });

  it("shows a first name only once the academy allows names", async () => {
    await db.insert(brandingProfilesTable).values({ scopeType: "academy", scopeId: academyId, nameEn: `For You Academy ${tag}`, showPlayerNames: true });
    try {
      const res = await request(app).get(url(`/sessions/${wonId}/data?locale=en`)).set(auth(ownerId));
      expect(res.body.data.match.scorers).toBe("Ahmad ×2");
      expect(JSON.stringify(res.body)).not.toContain("Saleh");
    } finally {
      await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyId)));
    }
  });
});

describe("creative for you: drafts", () => {
  it("prepares drafts once, idempotently, and a skipped draft never comes back", async () => {
    resetAutoDraftThrottle();
    const first = await request(app).get(url("/for-you")).set(auth(ownerId));
    expect(first.status).toBe(200);
    const fulltime = first.body.drafts.find((d: { originKey: string }) => d.originKey === `fulltime:session:${wonId}`);
    expect(fulltime).toMatchObject({ origin: "auto", status: "draft", group: "after", sourceSessionId: wonId, templateKey: "fulltime", style: "broadcast" });
    expect(fulltime.reason).toMatchObject({ kind: "fulltime", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1 });
    expect(fulltime.data.match).toMatchObject({ opponent: "Al-Wehdat", ownScore: 3, scorers: "#9 ×2" });
    expect(first.body.upcoming).toEqual([expect.objectContaining({ sessionId: fixtureId, opponent: "Ramtha", squad: "U-12 Blue" })]);
    const countRows = async () => (await db.select({ id: academyCreativeProjectsTable.id }).from(academyCreativeProjectsTable)
      .where(eq(academyCreativeProjectsTable.academyId, academyId))).length;
    const made = await countRows();
    expect(made).toBeGreaterThan(0);

    resetAutoDraftThrottle();
    await request(app).get(url("/for-you")).set(auth(ownerId));
    expect(await countRows()).toBe(made);

    const skip = await request(app).post(url(`/for-you/${fulltime.id}/skip`)).set(auth(ownerId));
    expect(skip.status).toBe(200);
    expect(skip.body.project.status).toBe("skipped");
    resetAutoDraftThrottle();
    const after = await request(app).get(url("/for-you")).set(auth(ownerId));
    expect(after.body.drafts.find((d: { id: number }) => d.id === fulltime.id)).toBeUndefined();
    expect(await countRows()).toBe(made);
    // Nothing leaked into the other academy's feed from this one.
    const other = await request(app).get(url("/for-you", otherAcademyId)).set(auth(ownerId));
    expect(other.body.drafts.every((d: { sourceSessionId: number | null }) => d.sourceSessionId !== wonId)).toBe(true);
  });

  it("cannot skip another academy's draft", async () => {
    const [row] = await db.select({ id: academyCreativeProjectsTable.id }).from(academyCreativeProjectsTable)
      .where(eq(academyCreativeProjectsTable.academyId, academyId)).limit(1);
    expect((await request(app).post(url(`/for-you/${row.id}/skip`, otherAcademyId)).set(auth(ownerId))).status).toBe(404);
  });
});
