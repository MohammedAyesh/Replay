import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  academyMembersTable,
  academyPlayersTable,
  academyRegistrationsTable,
  academySquadsTable,
  academiesTable,
  db,
  fieldsTable,
  usersTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, Number(raw)));
    return user && !user.isGuest && !user.isDisabled ? user : null;
  }),
  unauthenticatedResponse: vi.fn((res: {
    status: (code: number) => { json: (body: unknown) => void };
  }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import academyConsoleRouter from "./academyConsole";
import academyJoinRouter, { resetAcademyJoinState } from "./academyJoin";

const tag = `academy_join_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const JOIN_CODE = "ABCDEFGH";
const userIds: number[] = [];
const fieldIds: number[] = [];
const academyIds: number[] = [];
let ownerId: number;
let coachId: number;
let nonMemberId: number;
let academyId: number;
let otherAcademyId: number;
let squadId: number;
let otherSquadId: number;
let app: Express;

const as = (id: number) => ({ "x-test-user": String(id) });
const submission = (overrides: Record<string, unknown> = {}) => ({
  playerName: "Yazan Noor",
  guardianPhone: "+962 79 123 4567",
  locale: "ar",
  ...overrides,
});

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", academyJoinRouter);
  app.use("/api", academyConsoleRouter);

  for (const name of ["owner", "coach", "non-member"]) {
    const [user] = await db.insert(usersTable).values({
      name: `${name} ${tag}`,
      email: `${name}_${tag}@academy-join-test.local`,
    }).returning({ id: usersTable.id });
    userIds.push(user.id);
    if (name === "owner") ownerId = user.id;
    if (name === "coach") coachId = user.id;
    if (name === "non-member") nonMemberId = user.id;
  }

  const [field] = await db.insert(fieldsTable)
    .values({ name: `Join test field ${tag}` })
    .returning({ id: fieldsTable.id });
  fieldIds.push(field.id);
  const [academy] = await db.insert(academiesTable).values({
    name: `Join test academy ${tag}`,
    fieldId: field.id,
    joinCode: JOIN_CODE,
  }).returning({ id: academiesTable.id });
  const [otherAcademy] = await db.insert(academiesTable).values({
    name: `Other join academy ${tag}`,
    fieldId: field.id,
  }).returning({ id: academiesTable.id });
  academyId = academy.id;
  otherAcademyId = otherAcademy.id;
  academyIds.push(academyId, otherAcademyId);
  await db.insert(academyMembersTable).values([
    { userId: ownerId, academyId, role: "owner" },
    { userId: coachId, academyId, role: "coach" },
  ]);
  const [squad] = await db.insert(academySquadsTable).values({
    academyId,
    name: `Join squad ${tag}`,
    ageGroup: "U13",
  }).returning({ id: academySquadsTable.id });
  const [otherSquad] = await db.insert(academySquadsTable).values({
    academyId: otherAcademyId,
    name: `Other join squad ${tag}`,
  }).returning({ id: academySquadsTable.id });
  squadId = squad.id;
  otherSquadId = otherSquad.id;
});

afterAll(async () => {
  if (academyIds.length) {
    await db.delete(academyRegistrationsTable)
      .where(inArray(academyRegistrationsTable.academyId, academyIds));
    await db.delete(academyPlayersTable)
      .where(inArray(academyPlayersTable.academyId, academyIds));
    await db.delete(academySquadsTable)
      .where(inArray(academySquadsTable.academyId, academyIds));
    await db.delete(academyMembersTable)
      .where(inArray(academyMembersTable.academyId, academyIds));
    await db.delete(academiesTable).where(inArray(academiesTable.id, academyIds));
  }
  if (fieldIds.length) await db.delete(fieldsTable).where(inArray(fieldsTable.id, fieldIds));
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

beforeEach(() => {
  resetAcademyJoinState();
});

afterEach(async () => {
  resetAcademyJoinState();
  if (!academyIds.length) return;
  await db.delete(academyRegistrationsTable)
    .where(inArray(academyRegistrationsTable.academyId, academyIds));
  await db.delete(academyPlayersTable)
    .where(inArray(academyPlayersTable.academyId, academyIds));
});

describe("public academy registration", () => {
  it("serves academy details case-insensitively without caching", async () => {
    const response = await request(app).get(`/api/join/${JOIN_CODE.toLowerCase()}`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      academyName: `Join test academy ${tag}`,
      squads: [{ id: squadId, ageGroup: "U13" }],
    });
    expect(response.body.squads).toHaveLength(1);
  });

  it("normalizes Arabic phone digits and treats a matching pending registration as a duplicate", async () => {
    const first = await request(app)
      .post(`/api/join/${JOIN_CODE}`)
      .send(submission({
        playerName: "  Yazan Noor ",
        guardianPhone: "+٩٦٢ ٧٩ ١٢٣ ٤٥٦٧",
        preferredSquadId: squadId,
      }));
    const duplicate = await request(app)
      .post(`/api/join/${JOIN_CODE.toLowerCase()}`)
      .send(submission({
        playerName: "yazan noor",
        guardianPhone: "+962 79 123 4567",
        preferredSquadId: squadId,
      }));

    expect(first.status).toBe(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true });
    const [stored] = await db.select().from(academyRegistrationsTable)
      .where(and(
        eq(academyRegistrationsTable.academyId, academyId),
        eq(academyRegistrationsTable.playerName, "Yazan Noor"),
      ));
    expect(stored.guardianPhone).toBe("+962 79 123 4567");
    expect(stored.status).toBe("pending");
  });

  it("rejects invalid honeypot submissions and squads from another academy", async () => {
    const honeypot = await request(app)
      .post(`/api/join/${JOIN_CODE}`)
      .send(submission({ website: "not-a-human" }));
    const foreignSquad = await request(app)
      .post(`/api/join/${JOIN_CODE}`)
      .send(submission({ preferredSquadId: otherSquadId }));

    expect(honeypot.status).toBe(400);
    expect(foreignSquad.status).toBe(400);
    expect(await db.select().from(academyRegistrationsTable)
      .where(eq(academyRegistrationsTable.academyId, academyId))).toHaveLength(0);
  });

  it("limits public submissions to five per IP in ten minutes", async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await request(app)
        .post(`/api/join/${JOIN_CODE}`)
        .set("x-forwarded-for", "198.51.100.25")
        .send(submission({ playerName: `Rate limited ${index}` }));
      expect(response.status).toBe(201);
    }
    const limited = await request(app)
      .post(`/api/join/${JOIN_CODE}`)
      .set("x-forwarded-for", "198.51.100.25")
      .send(submission({ playerName: "Sixth registration" }));

    expect(limited.status).toBe(429);
  });
});

describe("academy registration review", () => {
  it("limits link management to owners and lets a coach approve atomically", async () => {
    const publicJoin = await request(app).get(`/api/join/${JOIN_CODE}`);
    const activeCountBefore = await request(app)
      .get(`/api/academy/console/academies/${academyId}/dashboard`)
      .set(as(coachId));
    expect(activeCountBefore.body.activePlayerCount).toBe(0);
    expect(activeCountBefore.body.pendingRegistrationCount).toBe(0);

    const post = await request(app).post(`/api/join/${JOIN_CODE}`)
      .send(submission({ playerName: `Approved player ${tag}`, preferredSquadId: squadId }));
    const ownerLink = await request(app)
      .get(`/api/academy/console/academies/${academyId}/join-link`)
      .set(as(ownerId));
    const coachLink = await request(app)
      .post(`/api/academy/console/academies/${academyId}/join-link`)
      .set(as(coachId));
    const coachRegistrations = await request(app)
      .get(`/api/academy/console/academies/${academyId}/registrations?status=pending`)
      .set(as(coachId));
    const nonMemberRegistrations = await request(app)
      .get(`/api/academy/console/academies/${academyId}/registrations`)
      .set(as(nonMemberId));

    expect(publicJoin.status).toBe(200);
    expect(activeCountBefore.status).toBe(200);
    expect(post.status).toBe(201);
    expect(ownerLink.status).toBe(200);
    expect(ownerLink.body).toMatchObject({ joinCode: JOIN_CODE });
    expect(coachLink.status).toBe(403);
    expect(coachRegistrations.status).toBe(200);
    expect(coachRegistrations.body).toHaveLength(1);
    expect(coachRegistrations.body[0]).toMatchObject({
      playerName: `Approved player ${tag}`,
      status: "pending",
      preferredSquadId: squadId,
    });
    expect(nonMemberRegistrations.status).toBe(403);

    const registrationId = coachRegistrations.body[0].id as number;
    const approved = await request(app)
      .post(`/api/academy/console/academies/${academyId}/registrations/${registrationId}/approve`)
      .set(as(coachId))
      .send({ squadId, jerseyNumber: 9, position: "Forward" });
    const retriedApproval = await request(app)
      .post(`/api/academy/console/academies/${academyId}/registrations/${registrationId}/approve`)
      .set(as(coachId))
      .send({ squadId, jerseyNumber: 9, position: "Forward" });
    const reviewed = await request(app)
      .get(`/api/academy/console/academies/${academyId}/registrations?status=approved`)
      .set(as(ownerId));
    const activeCountAfter = await request(app)
      .get(`/api/academy/console/academies/${academyId}/dashboard`)
      .set(as(coachId));
    const createdPlayers = await db.select().from(academyPlayersTable)
      .where(and(
        eq(academyPlayersTable.academyId, academyId),
        eq(academyPlayersTable.name, `Approved player ${tag}`),
      ));

    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      name: `Approved player ${tag}`,
      squadId,
      jerseyNumber: 9,
      position: "Forward",
    });
    expect(retriedApproval.status).toBe(409);
    expect(reviewed.body).toHaveLength(1);
    expect(reviewed.body[0]).toMatchObject({
      status: "approved",
      createdPlayerId: approved.body.id,
    });
    expect(createdPlayers).toHaveLength(1);
    expect(activeCountAfter.body.activePlayerCount).toBe(1);
    expect(activeCountAfter.body.pendingRegistrationCount).toBe(0);
  });

  it("rejects pending registrations without creating players", async () => {
    const submitted = await request(app)
      .post(`/api/join/${JOIN_CODE}`)
      .send(submission({ playerName: `Rejected player ${tag}` }));
    const [registration] = await db.select().from(academyRegistrationsTable)
      .where(and(
        eq(academyRegistrationsTable.academyId, academyId),
        eq(academyRegistrationsTable.playerName, `Rejected player ${tag}`),
      ));
    const rejected = await request(app)
      .post(`/api/academy/console/academies/${academyId}/registrations/${registration.id}/reject`)
      .set(as(coachId));
    const rejectedAgain = await request(app)
      .post(`/api/academy/console/academies/${academyId}/registrations/${registration.id}/reject`)
      .set(as(coachId));
    const players = await db.select().from(academyPlayersTable)
      .where(and(
        eq(academyPlayersTable.academyId, academyId),
        eq(academyPlayersTable.name, `Rejected player ${tag}`),
      ));
    const rejectedHistory = await request(app)
      .get(`/api/academy/console/academies/${academyId}/registrations?status=rejected`)
      .set(as(ownerId));

    expect(submitted.status).toBe(201);
    expect(rejected.status).toBe(204);
    expect(rejectedAgain.status).toBe(409);
    expect(players).toHaveLength(0);
    expect(rejectedHistory.body).toHaveLength(1);
    expect(rejectedHistory.body[0].status).toBe("rejected");
  });

  it("returns a newly generated owner link and denies guests", async () => {
    const generated = await request(app)
      .post(`/api/academy/console/academies/${academyId}/join-link`)
      .set(as(ownerId));
    const unauthenticated = await request(app)
      .get(`/api/academy/console/academies/${academyId}/join-link`);

    expect(generated.status).toBe(200);
    expect(generated.body.joinCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(generated.body.joinCode).not.toBe(JOIN_CODE);
    expect(generated.body.joinUrl).toContain(`/join/${generated.body.joinCode}`);
    expect(unauthenticated.status).toBe(401);
  });
});