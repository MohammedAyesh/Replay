import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  academyAnnouncementsTable,
  academyAttendanceTable,
  academyMembersTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  academiesTable,
  db,
  fieldsTable,
  recordingsTable,
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
import academyConsoleSectionsRouter from "./academyConsoleSections";

const tag = `academy_console_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const userIds: number[] = [];
const fieldIds: number[] = [];
const academyIds: number[] = [];
let ownerId: number;
let adminId: number;
let nonMemberId: number;
let coachId: number;
let targetId: number;
let academyAId: number;
let academyBId: number;
let squadAId: number;
let squadBId: number;
let playerAId: number;
let inactivePlayerAId: number;
let playerBId: number;
let sessionAId: number;
let sessionWideAId: number;
let sessionBId: number;
const temporaryPlayerIds: number[] = [];
const recordingIds: number[] = [];
let app: Express;

const as = (id: number) => ({ "x-test-user": String(id) });

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", academyConsoleRouter);
  app.use("/api", academyConsoleSectionsRouter);

  for (const [name, flags] of [
    ["owner", {}],
    ["admin", { isAdmin: true }],
    ["non-member", {}],
    ["coach-only", {}],
    ["target", {}],
  ] as const) {
    const [user] = await db.insert(usersTable).values({
      name: `${name} ${tag}`,
      email: `${name.replace("-", ".")}_${tag}@academy-test.local`,
      ...flags,
    }).returning({ id: usersTable.id });
    userIds.push(user.id);
    if (name === "owner") ownerId = user.id;
    if (name === "admin") adminId = user.id;
    if (name === "non-member") nonMemberId = user.id;
    if (name === "coach-only") coachId = user.id;
    if (name === "target") targetId = user.id;
  }

  const [fieldA] = await db.insert(fieldsTable).values({ name: `Academy test field A ${tag}` })
    .returning({ id: fieldsTable.id });
  const [fieldB] = await db.insert(fieldsTable).values({ name: `Academy test field B ${tag}` })
    .returning({ id: fieldsTable.id });
  fieldIds.push(fieldA.id, fieldB.id);

  const [academyA] = await db.insert(academiesTable).values({
    name: `Academy A ${tag}`,
    fieldId: fieldA.id,
  }).returning({ id: academiesTable.id });
  const [academyB] = await db.insert(academiesTable).values({
    name: `Academy B ${tag}`,
    fieldId: fieldB.id,
  }).returning({ id: academiesTable.id });
  academyAId = academyA.id;
  academyBId = academyB.id;
  academyIds.push(academyAId, academyBId);

  await db.insert(academyMembersTable).values([
    { userId: ownerId, academyId: academyAId, role: "owner" },
    { userId: ownerId, academyId: academyAId, role: "coach" },
    { userId: ownerId, academyId: academyBId, role: "coach" },
    { userId: coachId, academyId: academyAId, role: "coach" },
  ]);

  const [squadA] = await db.insert(academySquadsTable).values({
    academyId: academyAId,
    name: `Academy A squad ${tag}`,
  }).returning({ id: academySquadsTable.id });
  squadAId = squadA.id;
  const academyBSquads = await db.insert(academySquadsTable).values([
    { academyId: academyBId, name: `Academy B squad one ${tag}` },
    { academyId: academyBId, name: `Academy B squad two ${tag}` },
  ]).returning({ id: academySquadsTable.id, name: academySquadsTable.name });
  squadBId = academyBSquads[0].id;

  const players = await db.insert(academyPlayersTable).values([
    { academyId: academyAId, squadId: squadA.id, name: `Active player ${tag}`, isActive: true },
    { academyId: academyAId, squadId: squadA.id, name: `Inactive player ${tag}`, isActive: false },
    { academyId: academyBId, squadId: squadBId, name: `Other academy player one ${tag}`, isActive: true },
    { academyId: academyBId, name: `Other academy player two ${tag}`, isActive: true },
  ]).returning({ id: academyPlayersTable.id });
  playerAId = players[0].id;
  inactivePlayerAId = players[1].id;
  playerBId = players[2].id;

  const now = Date.now();
  const sessions = await db.insert(academySessionsTable).values([
    {
      academyId: academyAId,
      squadId: squadA.id,
      type: "training",
      startsAt: new Date(now + 24 * 60 * 60 * 1000),
      location: "Test pitch",
    },
    {
      academyId: academyAId,
      type: "match",
      startsAt: new Date(now + 8 * 24 * 60 * 60 * 1000),
      location: "Test pitch",
    },
    {
      academyId: academyBId,
      type: "training",
      startsAt: new Date(now + 48 * 60 * 60 * 1000),
      location: "Other pitch",
    },
  ]).returning({ id: academySessionsTable.id });
  sessionAId = sessions[0].id;
  sessionWideAId = sessions[1].id;
  sessionBId = sessions[2].id;
});

afterAll(async () => {
  if (academyIds.length > 0) {
    await db.delete(academyAnnouncementsTable).where(inArray(academyAnnouncementsTable.academyId, academyIds));
    await db.delete(academyRecordingsTable).where(inArray(academyRecordingsTable.academyId, academyIds));
    await db.delete(academySessionsTable).where(inArray(academySessionsTable.academyId, academyIds));
    await db.delete(academyPlayersTable).where(inArray(academyPlayersTable.academyId, academyIds));
    await db.delete(academySquadsTable).where(inArray(academySquadsTable.academyId, academyIds));
    await db.delete(academyMembersTable).where(inArray(academyMembersTable.academyId, academyIds));
    await db.delete(academiesTable).where(inArray(academiesTable.id, academyIds));
  }
  if (recordingIds.length > 0) {
    await db.delete(recordingsTable).where(inArray(recordingsTable.id, recordingIds));
  }
  if (fieldIds.length > 0) {
    await db.delete(fieldsTable).where(inArray(fieldsTable.id, fieldIds));
  }
  if (userIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
});

afterEach(async () => {
  if (temporaryPlayerIds.length > 0) {
    await db.delete(academyPlayersTable).where(inArray(academyPlayersTable.id, temporaryPlayerIds));
    temporaryPlayerIds.length = 0;
  }
});

describe("Academy Console API", () => {
  it("enforces signed-in, membership, and admin boundaries", async () => {
    expect((await request(app).get("/api/academy/console/memberships")).status).toBe(401);
    expect((await request(app).get("/api/academy/console/academies/not-a-number/dashboard")).status).toBe(401);
    expect((await request(app).get(`/api/admin/academies/${academyAId}/members`)).status).toBe(401);
    expect((await request(app).post(`/api/admin/academies/${academyAId}/members`)
      .send({ email: "nobody@academy-test.local", role: "coach" })).status).toBe(401);
    expect((await request(app).delete(`/api/admin/academies/${academyAId}/members/${ownerId}/owner`)).status)
      .toBe(401);

    expect((await request(app).get("/api/academy/console/memberships").set(as(nonMemberId))).status).toBe(403);
    expect((await request(app).get("/api/academy/console/memberships").set(as(adminId))).status).toBe(403);
    expect((await request(app).get(`/api/academy/console/academies/${academyAId}/dashboard`)
      .set(as(nonMemberId))).status).toBe(403);
    expect((await request(app).get(`/api/admin/academies/${academyAId}/members`)
      .set(as(ownerId))).status).toBe(403);
    expect((await request(app).get(`/api/admin/academies/${academyAId}/members`)
      .set(as(adminId))).status).toBe(200);
  });

  it("returns academy roles and dashboard counts scoped to the selected academy", async () => {
    const memberships = await request(app)
      .get("/api/academy/console/memberships")
      .set(as(ownerId));
    expect(memberships.status).toBe(200);
    expect(memberships.body).toEqual([
      {
        academyId: academyAId,
        academyName: `Academy A ${tag}`,
        roles: ["owner", "coach"],
      },
      {
        academyId: academyBId,
        academyName: `Academy B ${tag}`,
        roles: ["coach"],
      },
    ]);

    const dashboard = await request(app)
      .get(`/api/academy/console/academies/${academyAId}/dashboard`)
      .set(as(ownerId));
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toEqual({
      academyId: academyAId,
      academyName: `Academy A ${tag}`,
      roles: ["owner", "coach"],
      squadCount: 1,
      activePlayerCount: 1,
      upcomingSessionCount: 1,
    });

    const otherAcademy = await request(app)
      .get(`/api/academy/console/academies/${academyBId}/dashboard`)
      .set(as(ownerId));
    expect(otherAcademy.status).toBe(200);
    expect(otherAcademy.body).toEqual({
      academyId: academyBId,
      academyName: `Academy B ${tag}`,
      roles: ["coach"],
      squadCount: 2,
      activePlayerCount: 2,
      upcomingSessionCount: 1,
    });
  });

  it("assigns existing users idempotently and removes only the selected role", async () => {
    const url = `/api/admin/academies/${academyAId}/members`;
    const email = `target_${tag}@academy-test.local`;

    expect((await request(app).post(url).set(as(adminId)).send({ email: "missing@academy-test.local", role: "owner" }))
      .status).toBe(404);

    const ownerRole = await request(app).post(url).set(as(adminId)).send({ email, role: "owner" });
    expect(ownerRole.status).toBe(200);
    expect(ownerRole.body).toMatchObject({ userId: targetId, roles: ["owner"] });

    const duplicateOwnerRole = await request(app).post(url).set(as(adminId)).send({ email, role: "owner" });
    expect(duplicateOwnerRole.status).toBe(200);
    expect(duplicateOwnerRole.body.roles).toEqual(["owner"]);

    const coachRole = await request(app).post(url).set(as(adminId)).send({ email, role: "coach" });
    expect(coachRole.body.roles).toEqual(["owner", "coach"]);

    const listed = await request(app).get(url).set(as(adminId));
    expect(listed.body.find((member: { userId: number }) => member.userId === targetId).roles)
      .toEqual(["owner", "coach"]);

    const removedOwner = await request(app).delete(`${url}/${targetId}/owner`).set(as(adminId));
    expect(removedOwner.status).toBe(204);
    const afterOwnerRemoval = await request(app).get(url).set(as(adminId));
    expect(afterOwnerRemoval.body.find((member: { userId: number }) => member.userId === targetId).roles)
      .toEqual(["coach"]);

    const removedCoach = await request(app).delete(`${url}/${targetId}/coach`).set(as(adminId));
    expect(removedCoach.status).toBe(204);
    const afterAllRolesRemoved = await request(app).get(url).set(as(adminId));
    expect(afterAllRolesRemoved.body.some((member: { userId: number }) => member.userId === targetId)).toBe(false);
  });

  it("scopes player management, counts active players, validates squads, and links existing accounts", async () => {
    const playersUrl = `/api/academy/console/academies/${academyAId}/players`;
    const email = `target_${tag}@academy-test.local`;
    const playerName = `Academy API player ${tag}`;

    expect((await request(app).get(playersUrl)).status).toBe(401);
    expect((await request(app).post(playersUrl).send({ name: "Anonymous player" })).status).toBe(401);
    expect((await request(app).patch(`${playersUrl}/${playerAId}`).send({ name: "Anonymous edit" })).status)
      .toBe(401);
    for (const userId of [nonMemberId, adminId]) {
      expect((await request(app).get(playersUrl).set(as(userId))).status).toBe(403);
      expect((await request(app).post(playersUrl).set(as(userId)).send({ name: "Denied player" })).status)
        .toBe(403);
      expect((await request(app).patch(`${playersUrl}/${playerAId}`).set(as(userId)).send({ isActive: false }))
        .status).toBe(403);
    }

    expect((await request(app).post(playersUrl).set(as(coachId))
      .send({ name: "Cross-academy squad player", squadId: squadBId })).status).toBe(404);
    expect((await request(app).patch(`${playersUrl}/${playerBId}`).set(as(ownerId))
      .send({ name: "Cross-academy player edit" })).status).toBe(404);

    const listedBeforeCreate = await request(app).get(playersUrl).set(as(ownerId));
    expect(listedBeforeCreate.status).toBe(200);
    expect(listedBeforeCreate.body).toHaveLength(2);
    expect(listedBeforeCreate.body.find((player: { id: number }) => player.id === playerAId)).toMatchObject({
      academyId: academyAId,
      squadId: squadAId,
      squadName: `Academy A squad ${tag}`,
      isActive: true,
    });

    const created = await request(app)
      .post(playersUrl)
      .set(as(coachId))
      .send({
        name: playerName,
        jerseyNumber: 24,
        position: "Forward",
        dateOfBirth: "2012-05-12",
        guardianPhone: "+962790000000",
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      academyId: academyAId,
      squadId: null,
      squadName: null,
      name: playerName,
      jerseyNumber: 24,
      position: "Forward",
      dateOfBirth: "2012-05-12",
      guardianPhone: "+962790000000",
      userId: null,
      linkedUserEmail: null,
      isActive: true,
    });
    const createdPlayerId = created.body.id as number;
    temporaryPlayerIds.push(createdPlayerId);

    const assignedAndLinked = await request(app)
      .patch(`${playersUrl}/${createdPlayerId}`)
      .set(as(coachId))
      .send({ squadId: squadAId, linkedUserEmail: email });
    expect(assignedAndLinked.status).toBe(200);
    expect(assignedAndLinked.body).toMatchObject({
      squadId: squadAId,
      squadName: `Academy A squad ${tag}`,
      userId: targetId,
      linkedUserEmail: email,
    });

    const dashboardWithNewPlayer = await request(app)
      .get(`/api/academy/console/academies/${academyAId}/dashboard`)
      .set(as(ownerId));
    expect(dashboardWithNewPlayer.body.activePlayerCount).toBe(2);
    const squadsWithNewPlayer = await request(app).get(`/api/academy/console/academies/${academyAId}/squads`)
      .set(as(ownerId));
    expect(squadsWithNewPlayer.body.find((squad: { id: number }) => squad.id === squadAId).activePlayerCount)
      .toBe(2);

    expect((await request(app).patch(`${playersUrl}/${createdPlayerId}`).set(as(ownerId))
      .send({ squadId: squadBId })).status).toBe(404);
    expect((await request(app).patch(`${playersUrl}/${createdPlayerId}`).set(as(ownerId))
      .send({ linkedUserEmail: `missing_${tag}@academy-test.local` })).status).toBe(404);
    const afterRejectedUpdates = await request(app).get(playersUrl).set(as(ownerId));
    expect(afterRejectedUpdates.body.find((player: { id: number }) => player.id === createdPlayerId))
      .toMatchObject({ squadId: squadAId, userId: targetId, linkedUserEmail: email });

    const deactivated = await request(app)
      .patch(`${playersUrl}/${createdPlayerId}`)
      .set(as(ownerId))
      .send({ isActive: false });
    expect(deactivated.body.isActive).toBe(false);
    const dashboardWithoutInactivePlayer = await request(app)
      .get(`/api/academy/console/academies/${academyAId}/dashboard`)
      .set(as(ownerId));
    expect(dashboardWithoutInactivePlayer.body.activePlayerCount).toBe(1);
    const squadsWithoutInactivePlayer = await request(app)
      .get(`/api/academy/console/academies/${academyAId}/squads`)
      .set(as(ownerId));
    expect(squadsWithoutInactivePlayer.body.find((squad: { id: number }) => squad.id === squadAId).activePlayerCount)
      .toBe(1);
    expect((await request(app).get(playersUrl).set(as(ownerId))).body
      .find((player: { id: number }) => player.id === createdPlayerId).isActive).toBe(false);

    const unassignedAndUnlinked = await request(app)
      .patch(`${playersUrl}/${createdPlayerId}`)
      .set(as(coachId))
      .send({ isActive: true, squadId: null, linkedUserEmail: null });
    expect(unassignedAndUnlinked.body).toMatchObject({
      isActive: true,
      squadId: null,
      squadName: null,
      userId: null,
      linkedUserEmail: null,
    });
    const dashboardAfterReactivation = await request(app)
      .get(`/api/academy/console/academies/${academyAId}/dashboard`)
      .set(as(ownerId));
    expect(dashboardAfterReactivation.body.activePlayerCount).toBe(2);
  });

  it("scopes squad CRUD to academy members and preserves players when a squad is deleted", async () => {
    const academySquadsUrl = `/api/academy/console/academies/${academyAId}/squads`;
    const squadUrl = `${academySquadsUrl}/${squadAId}`;
    const newSquadName = `Coach-created squad ${tag}`;

    expect((await request(app).get(academySquadsUrl)).status).toBe(401);
    expect((await request(app).post(academySquadsUrl).send({ name: "Anonymous squad" })).status).toBe(401);
    expect((await request(app).patch(squadUrl).send({ name: "Anonymous rename" })).status).toBe(401);
    expect((await request(app).delete(squadUrl)).status).toBe(401);

    for (const userId of [nonMemberId, adminId]) {
      expect((await request(app).get(academySquadsUrl).set(as(userId))).status).toBe(403);
      expect((await request(app).post(academySquadsUrl).set(as(userId)).send({ name: "Denied squad" })).status)
        .toBe(403);
      expect((await request(app).patch(squadUrl).set(as(userId)).send({ name: "Denied rename" })).status).toBe(403);
      expect((await request(app).delete(squadUrl).set(as(userId))).status).toBe(403);
    }

    const initialList = await request(app).get(academySquadsUrl).set(as(ownerId));
    expect(initialList.status).toBe(200);
    expect(initialList.body).toHaveLength(1);
    expect(initialList.body[0]).toMatchObject({
      id: squadAId,
      academyId: academyAId,
      name: `Academy A squad ${tag}`,
      activePlayerCount: 1,
    });

    const created = await request(app)
      .post(academySquadsUrl)
      .set(as(coachId))
      .send({ name: newSquadName, ageGroup: "U15", description: "Coach managed group" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      academyId: academyAId,
      name: newSquadName,
      ageGroup: "U15",
      description: "Coach managed group",
      activePlayerCount: 0,
    });
    const createdSquadId = created.body.id as number;

    const updated = await request(app)
      .patch(`${academySquadsUrl}/${createdSquadId}`)
      .set(as(coachId))
      .send({ name: `Renamed squad ${tag}`, ageGroup: null, description: "Updated description" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: createdSquadId,
      academyId: academyAId,
      name: `Renamed squad ${tag}`,
      ageGroup: null,
      description: "Updated description",
      activePlayerCount: 0,
    });

    expect((await request(app)
      .patch(`/api/academy/console/academies/${academyAId}/squads/${squadBId}`)
      .set(as(ownerId))
      .send({ name: "Cross-academy rename" })).status).toBe(404);
    expect((await request(app)
      .delete(`/api/academy/console/academies/${academyAId}/squads/${squadBId}`)
      .set(as(ownerId))).status).toBe(404);
    const [untouchedOtherAcademySquad] = await db
      .select({ name: academySquadsTable.name })
      .from(academySquadsTable)
      .where(eq(academySquadsTable.id, squadBId));
    expect(untouchedOtherAcademySquad?.name).toBe(`Academy B squad one ${tag}`);

    expect((await request(app).delete(`${academySquadsUrl}/${createdSquadId}`).set(as(coachId))).status).toBe(403);
    expect((await request(app).delete(`${academySquadsUrl}/${createdSquadId}`).set(as(ownerId))).status).toBe(204);
    expect((await request(app).delete(squadUrl).set(as(ownerId))).status).toBe(204);
    const [retainedPlayer] = await db
      .select({ id: academyPlayersTable.id, squadId: academyPlayersTable.squadId })
      .from(academyPlayersTable)
      .where(eq(academyPlayersTable.id, playerAId));
    expect(retainedPlayer).toEqual({ id: playerAId, squadId: null });
  });

  it("prevents deleting a squad when an assigned player has an outstanding subscription balance", async () => {
    const [debtSquad] = await db.insert(academySquadsTable).values({
      academyId: academyAId,
      name: `Protected debt squad ${tag}`,
      monthlyFeeFils: 30000,
    }).returning({ id: academySquadsTable.id });
    const [debtPlayer] = await db.insert(academyPlayersTable).values({
      academyId: academyAId,
      squadId: debtSquad.id,
      name: `Protected debt player ${tag}`,
      isActive: true,
      subscriptionExpiresOn: "2000-01-01",
    }).returning({ id: academyPlayersTable.id });
    const deleteUrl = `/api/academy/console/academies/${academyAId}/squads/${debtSquad.id}`;

    expect((await request(app).delete(deleteUrl).set(as(coachId))).status).toBe(403);
    const blocked = await request(app).delete(deleteUrl).set(as(ownerId));
    expect(blocked.status).toBe(409);
    const [retained] = await db.select({
      squadId: academyPlayersTable.squadId,
    }).from(academyPlayersTable).where(eq(academyPlayersTable.id, debtPlayer.id));
    expect(retained?.squadId).toBe(debtSquad.id);
  });

  it("scopes session management, validates match results, uses UTC timestamps, and removes attendance on delete", async () => {
    const sessionsUrl = `/api/academy/console/academies/${academyAId}/sessions`;
    const sessionUrl = (sessionId: number) => `${sessionsUrl}/${sessionId}`;
    const startsAt = "2026-10-02T22:30:00.000Z";

    expect((await request(app).get(sessionsUrl)).status).toBe(401);
    expect((await request(app).post(sessionsUrl).send({
      type: "training",
      startsAt,
      location: "Anonymous pitch",
    })).status).toBe(401);
    expect((await request(app).patch(sessionUrl(1)).send({ location: "Anonymous edit" })).status).toBe(401);
    expect((await request(app).delete(sessionUrl(1))).status).toBe(401);

    for (const userId of [nonMemberId, adminId]) {
      expect((await request(app).get(sessionsUrl).set(as(userId))).status).toBe(403);
      expect((await request(app).post(sessionsUrl).set(as(userId)).send({
        type: "training",
        startsAt,
        location: "Denied pitch",
      })).status).toBe(403);
      expect((await request(app).patch(sessionUrl(1)).set(as(userId)).send({ location: "Denied edit" }))
        .status).toBe(403);
      expect((await request(app).delete(sessionUrl(1)).set(as(userId))).status).toBe(403);
    }

    expect((await request(app).post(sessionsUrl).set(as(coachId)).send({
      type: "training",
      startsAt,
      location: "Cross-academy squad",
      squadId: squadBId,
    })).status).toBe(404);
    expect((await request(app).post(sessionsUrl).set(as(coachId)).send({
      type: "training",
      startsAt,
      location: "Training with opponent",
      opponent: "Should be rejected",
    })).status).toBe(400);
    expect((await request(app).patch(sessionUrl(sessionBId)).set(as(ownerId))
      .send({ location: "Cross-academy edit" })).status).toBe(404);
    expect((await request(app).delete(sessionUrl(sessionBId)).set(as(ownerId))).status).toBe(404);

    const [sessionSquad] = await db.insert(academySquadsTable).values({
      academyId: academyAId,
      name: `Schedule test squad ${tag}`,
    }).returning({ id: academySquadsTable.id });

    const created = await request(app)
      .post(sessionsUrl)
      .set(as(coachId))
      .send({
        type: "match",
        startsAt,
        endsAt: "2026-10-02T23:30:00.000Z",
        squadId: sessionSquad.id,
        location: "Match pitch",
        opponent: "North Academy",
        notes: "Evening match",
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      academyId: academyAId,
      squadId: sessionSquad.id,
      squadName: `Schedule test squad ${tag}`,
      type: "match",
      startsAt,
      endsAt: "2026-10-02T23:30:00.000Z",
      opponent: "North Academy",
      ownScore: null,
      opponentScore: null,
    });
    const createdSessionId = created.body.id as number;

    const listed = await request(app).get(sessionsUrl).set(as(ownerId));
    expect(listed.status).toBe(200);
    expect(listed.body.some((session: { academyId: number; id: number }) => (
      session.id === createdSessionId && session.academyId === academyAId
    ))).toBe(true);
    expect(listed.body.every((session: { academyId: number }) => session.academyId === academyAId)).toBe(true);
    const listedCreated = listed.body.find((session: { id: number }) => session.id === createdSessionId);
    expect(listedCreated.startsAt).toBe(startsAt);
    const ammanParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Amman",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(listedCreated.startsAt)).map((part) => [part.type, part.value]));
    expect(`${ammanParts.year}-${ammanParts.month}-${ammanParts.day}`).toBe("2026-10-03");

    expect((await request(app).patch(sessionUrl(createdSessionId)).set(as(coachId))
      .send({ ownScore: 2 })).status).toBe(400);
    expect((await request(app).patch(sessionUrl(createdSessionId)).set(as(coachId))
      .send({ ownScore: 2, opponentScore: -1 })).status).toBe(400);
    expect((await request(app).patch(sessionUrl(createdSessionId)).set(as(coachId))
      .send({ ownScore: 2_147_483_648, opponentScore: 1 })).status).toBe(400);
    expect((await request(app).patch(`${sessionsUrl}/999999`).set(as(coachId))
      .send({ location: "Not in academy" })).status).toBe(404);
    expect((await request(app).patch(`${sessionsUrl}/999999`).set(as(ownerId))
      .send({ squadId: squadBId })).status).toBe(404);

    const updated = await request(app)
      .patch(sessionUrl(createdSessionId))
      .set(as(ownerId))
      .send({
        startsAt: "2026-10-02T23:00:00.000Z",
        ownScore: 2,
        opponentScore: 1,
      });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      startsAt: "2026-10-02T23:00:00.000Z",
      ownScore: 2,
      opponentScore: 1,
      opponent: "North Academy",
    });

    const training = await request(app)
      .post(sessionsUrl)
      .set(as(coachId))
      .send({ type: "training", startsAt: "2026-10-03T20:00:00.000Z", location: "Training pitch" });
    expect(training.status).toBe(201);
    expect((await request(app).patch(sessionUrl(training.body.id)).set(as(coachId))
      .send({ ownScore: 1, opponentScore: 0 })).status).toBe(400);

    const convertedToTraining = await request(app)
      .patch(sessionUrl(createdSessionId))
      .set(as(ownerId))
      .send({ type: "training" });
    expect(convertedToTraining.status).toBe(200);
    expect(convertedToTraining.body).toMatchObject({
      type: "training",
      opponent: null,
      ownScore: null,
      opponentScore: null,
    });

    await db.insert(academyAttendanceTable).values({
      sessionId: createdSessionId,
      playerId: playerAId,
      status: "present",
    });
    const attendanceBeforeDelete = await db.select({ id: academyAttendanceTable.id })
      .from(academyAttendanceTable)
      .where(eq(academyAttendanceTable.sessionId, createdSessionId));
    expect(attendanceBeforeDelete).toHaveLength(1);

    expect((await request(app).delete(sessionUrl(createdSessionId)).set(as(coachId))).status).toBe(204);
    const attendanceAfterDelete = await db.select({ id: academyAttendanceTable.id })
      .from(academyAttendanceTable)
      .where(eq(academyAttendanceTable.sessionId, createdSessionId));
    expect(attendanceAfterDelete).toHaveLength(0);
    expect((await request(app).delete(sessionUrl(createdSessionId)).set(as(coachId))).status).toBe(404);
  });

  it("loads academy-scoped attendance rosters and upserts statuses per player", async () => {
    const [attendanceSquad] = await db.insert(academySquadsTable).values({
      academyId: academyAId,
      name: `Attendance squad ${tag}`,
    }).returning({ id: academySquadsTable.id });
    const attendancePlayers = await db.insert(academyPlayersTable).values([
      { academyId: academyAId, squadId: attendanceSquad.id, name: `Attendance active ${tag}`, isActive: true },
      { academyId: academyAId, squadId: attendanceSquad.id, name: `Attendance inactive ${tag}`, isActive: false },
    ]).returning({ id: academyPlayersTable.id });
    const attendancePlayerId = attendancePlayers[0].id;
    const inactiveAttendancePlayerId = attendancePlayers[1].id;
    const [foreignPlayer] = await db.insert(academyPlayersTable).values({
      academyId: academyBId,
      name: `Foreign attendance player ${tag}`,
      isActive: true,
    }).returning({ id: academyPlayersTable.id });
    const attendanceSessions = await db.insert(academySessionsTable).values([
      {
        academyId: academyAId,
        squadId: attendanceSquad.id,
        type: "training",
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        location: "Attendance test pitch",
      },
      {
        academyId: academyAId,
        type: "training",
        startsAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        location: "Academy-wide test pitch",
      },
      {
        academyId: academyBId,
        type: "training",
        startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        location: "Foreign test pitch",
      },
    ]).returning({ id: academySessionsTable.id });
    const attendanceSessionId = attendanceSessions[0].id;
    const academyWideSessionId = attendanceSessions[1].id;
    const foreignSessionId = attendanceSessions[2].id;
    const attendanceUrl = `/api/academy/console/academies/${academyAId}/sessions/${attendanceSessionId}/attendance`;

    expect((await request(app).get(attendanceUrl)).status).toBe(401);
    expect((await request(app).put(attendanceUrl).send({ entries: [] })).status).toBe(401);
    expect((await request(app).get(attendanceUrl).set(as(nonMemberId))).status).toBe(403);
    expect((await request(app).get(
      `/api/academy/console/academies/${academyAId}/sessions/${foreignSessionId}/attendance`,
    ).set(as(coachId))).status).toBe(404);

    const initial = await request(app).get(attendanceUrl).set(as(coachId));
    expect(initial.status).toBe(200);
    expect(initial.body.players).toEqual(expect.arrayContaining([
      { playerId: attendancePlayerId, playerName: `Attendance active ${tag}`, jerseyNumber: null, status: null },
      { playerId: inactiveAttendancePlayerId, playerName: `Attendance inactive ${tag}`, jerseyNumber: null, status: null },
    ]));

    const firstSave = await request(app)
      .put(attendanceUrl)
      .set(as(coachId))
      .send({
        entries: [
          { playerId: attendancePlayerId, status: "present" },
          { playerId: inactiveAttendancePlayerId, status: "excused" },
        ],
      });
    expect(firstSave.status).toBe(200);

    await db.update(academyPlayersTable)
      .set({ squadId: null })
      .where(eq(academyPlayersTable.id, inactiveAttendancePlayerId));
    const rosterAfterSquadChange = await request(app).get(attendanceUrl).set(as(coachId));
    expect(rosterAfterSquadChange.body.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: inactiveAttendancePlayerId, status: "excused" }),
    ]));

    const remark = await request(app)
      .put(attendanceUrl)
      .set(as(coachId))
      .send({ entries: [{ playerId: attendancePlayerId, status: "late" }] });
    expect(remark.status).toBe(200);
    expect(remark.body.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: attendancePlayerId, status: "late" }),
      expect.objectContaining({ playerId: inactiveAttendancePlayerId, status: "excused" }),
    ]));

    const clearedInactive = await request(app)
      .put(attendanceUrl)
      .set(as(coachId))
      .send({ entries: [{ playerId: inactiveAttendancePlayerId, status: null }] });
    expect(clearedInactive.status).toBe(200);
    expect(clearedInactive.body.players.map((player: { playerId: number }) => player.playerId))
      .not.toContain(inactiveAttendancePlayerId);

    expect((await request(app).put(attendanceUrl).set(as(coachId)).send({
      entries: [
        { playerId: attendancePlayerId, status: "present" },
        { playerId: attendancePlayerId, status: "absent" },
      ],
    })).status).toBe(400);
    expect((await request(app).put(attendanceUrl).set(as(coachId))
      .send({ entries: [{ playerId: foreignPlayer.id, status: "present" }] })).status).toBe(404);

    const academyWideUrl = `/api/academy/console/academies/${academyAId}/sessions/${academyWideSessionId}/attendance`;
    const academyWide = await request(app).get(academyWideUrl).set(as(ownerId));
    expect(academyWide.status).toBe(200);
    const academyWidePlayerIds = academyWide.body.players.map((player: { playerId: number }) => player.playerId);
    expect(academyWidePlayerIds).toContain(attendancePlayerId);
    expect(academyWidePlayerIds).not.toContain(inactiveAttendancePlayerId);
    expect(academyWidePlayerIds).not.toContain(foreignPlayer.id);
    expect((await request(app).put(academyWideUrl).set(as(coachId))
      .send({ entries: [{ playerId: inactiveAttendancePlayerId, status: "present" }] })).status).toBe(404);

    await db.insert(academyAttendanceTable).values({
      sessionId: academyWideSessionId,
      playerId: inactiveAttendancePlayerId,
      status: "absent",
    });
    const inactiveMarked = await request(app).get(academyWideUrl).set(as(ownerId));
    expect(inactiveMarked.body.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: inactiveAttendancePlayerId, status: "absent" }),
    ]));
    const clearAcademyWide = await request(app).put(academyWideUrl).set(as(ownerId))
      .send({ entries: [{ playerId: inactiveAttendancePlayerId, status: null }] });
    expect(clearAcademyWide.status).toBe(200);
    expect(clearAcademyWide.body.players.map((player: { playerId: number }) => player.playerId))
      .not.toContain(inactiveAttendancePlayerId);
    const wideAttendanceRows = await db.select().from(academyAttendanceTable)
      .where(eq(academyAttendanceTable.sessionId, academyWideSessionId));
    expect(wideAttendanceRows.some((row) => row.playerId === inactiveAttendancePlayerId)).toBe(false);

    const listedSessions = await request(app)
      .get(`/api/academy/console/academies/${academyAId}/sessions`)
      .set(as(coachId));
    const sessionSummary = listedSessions.body.find((session: { id: number }) => session.id === attendanceSessionId);
    expect(sessionSummary.attendanceCounts).toEqual({
      present: 0,
      absent: 0,
      late: 1,
      excused: 0,
    });
    expect(listedSessions.body.every((session: { academyId: number }) => session.academyId === academyAId))
      .toBe(true);
  });

  it("lists academy-linked recordings without exposing another academy's links", async () => {
    const [recordingA, recordingB, recordingOther] = await db.insert(recordingsTable).values([
      {
        fieldId: fieldIds[0],
        court: "Court A",
        date: "2026-09-01",
        timeSlot: "10:00",
        duration: "60 min",
        videoUrl: "https://media.example/academy-a-old.m3u8",
      },
      {
        fieldId: fieldIds[0],
        court: "Court A",
        date: "2026-09-02",
        timeSlot: "11:00",
        duration: "60 min",
        videoUrl: "https://media.example/academy-a-new.m3u8",
      },
      {
        fieldId: fieldIds[1],
        court: "Court B",
        date: "2026-09-03",
        timeSlot: "12:00",
        duration: "60 min",
        videoUrl: "https://media.example/academy-b.m3u8",
      },
    ]).returning({ id: recordingsTable.id });
    recordingIds.push(recordingA.id, recordingB.id, recordingOther.id);
    await db.insert(academyRecordingsTable).values([
      { academyId: academyAId, recordingId: recordingA.id },
      { academyId: academyAId, recordingId: recordingB.id },
      { academyId: academyBId, recordingId: recordingOther.id },
    ]);

    const recordingsUrl = `/api/academy/console/academies/${academyAId}/recordings`;
    expect((await request(app).get(recordingsUrl)).status).toBe(401);
    expect((await request(app).get(recordingsUrl).set(as(nonMemberId))).status).toBe(403);
    const listed = await request(app).get(recordingsUrl).set(as(coachId));
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(2);
    expect(listed.body.map((recording: { id: number }) => recording.id))
      .toEqual([recordingB.id, recordingA.id]);
    expect(listed.body.every((recording: { fieldName: string | null }) => (
      recording.fieldName === `Academy test field A ${tag}`
    ))).toBe(true);
    expect((await request(app)
      .get(`/api/academy/console/academies/${academyBId}/recordings`)
      .set(as(ownerId))).body.map((recording: { id: number }) => recording.id))
      .toEqual([recordingOther.id]);
  });

  it("supports localized announcement CRUD and scopes optional squads", async () => {
    const announcementsUrl = `/api/academy/console/academies/${academyAId}/announcements`;
    const [announcementSquad] = await db.insert(academySquadsTable).values({
      academyId: academyAId,
      name: `Announcement squad ${tag}`,
    }).returning({ id: academySquadsTable.id });
    const [foreignSquad] = await db.insert(academySquadsTable).values({
      academyId: academyBId,
      name: `Foreign announcement squad ${tag}`,
    }).returning({ id: academySquadsTable.id });
    expect((await request(app).get(announcementsUrl)).status).toBe(401);
    expect((await request(app).post(announcementsUrl).send({ title: "T", body: "B" })).status).toBe(401);
    expect((await request(app).get(announcementsUrl).set(as(nonMemberId))).status).toBe(403);

    const created = await request(app).post(announcementsUrl).set(as(coachId)).send({
      title: "تدريب اليوم",
      body: "التدريب الساعة السادسة مساءً",
      squadId: announcementSquad.id,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      academyId: academyAId,
      squadId: announcementSquad.id,
      squadName: `Announcement squad ${tag}`,
      title: "تدريب اليوم",
      body: "التدريب الساعة السادسة مساءً",
      createdBy: coachId,
      authorName: `coach-only ${tag}`,
    });
    const announcementUrl = `${announcementsUrl}/${created.body.id}`;
    expect((await request(app).post(announcementsUrl).set(as(coachId)).send({
      title: "Wrong squad",
      body: "Should fail",
      squadId: foreignSquad.id,
    })).status).toBe(404);

    const updated = await request(app).patch(announcementUrl).set(as(ownerId)).send({
      title: "Academy notice",
      squadId: null,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      squadId: null,
      squadName: null,
      title: "Academy notice",
      body: "التدريب الساعة السادسة مساءً",
    });
    expect((await request(app).patch(announcementUrl).set(as(coachId))
      .send({ squadId: foreignSquad.id })).status).toBe(404);

    const listed = await request(app).get(announcementsUrl).set(as(coachId));
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: created.body.id,
      title: "Academy notice",
      createdBy: coachId,
    });
    expect((await request(app).delete(announcementUrl).set(as(coachId))).status).toBe(204);
    expect((await request(app).delete(announcementUrl).set(as(coachId))).status).toBe(404);
    expect((await request(app).get(announcementsUrl).set(as(ownerId))).body).toEqual([]);
  });
});