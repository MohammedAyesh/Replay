import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  db, fieldsTable, friendshipsTable, footageRequestsTable, matchPlayersTable, matchRoomsTable,
  userBlocksTable, usersTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, Number(raw)));
    return user && !user.isGuest ? user.id : null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import friendsRouter from "./friends";

const tag = `friends_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const ids: number[] = [];
const roomIds: number[] = [];
const requestIds: number[] = [];
let ownedPlaceholder: number | null = null;
let app: Express;
let owner: number;
let friend: number;
let other: number;
let incomingActor: number;
let guest: number;

const as = (id: number) => ({ "x-test-user": String(id) });

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", friendsRouter);
  for (const [name, flags] of [
    ["owner", {}], ["friend", {}], ["other", {}], ["guest", { isGuest: true }],
    ["disabled", { isDisabled: true }],
  ] as const) {
    const [user] = await db.insert(usersTable).values({
      name: `${name} ${tag}`, email: `${name}_${tag}@test.local`, ...flags,
    }).returning({ id: usersTable.id });
    ids.push(user.id);
    if (name === "owner") owner = user.id;
    if (name === "friend") friend = user.id;
    if (name === "other") other = user.id;
    if (name === "guest") guest = user.id;
  }
  const [existingPlaceholder] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.email, "deleted-player@soccerwatch.local"));
  if (!existingPlaceholder) {
    const [placeholder] = await db.insert(usersTable).values({
      name: "Deleted player", email: "deleted-player@soccerwatch.local", isGuest: true, isDisabled: true,
    }).returning({ id: usersTable.id });
    ownedPlaceholder = placeholder.id;
  }
});

afterAll(async () => {
  await db.delete(matchPlayersTable).where(inArray(matchPlayersTable.matchId, roomIds));
  await db.delete(matchRoomsTable).where(inArray(matchRoomsTable.id, roomIds));
  await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  await db.delete(userBlocksTable).where(or(inArray(userBlocksTable.blockerId, ids), inArray(userBlocksTable.blockedId, ids)));
  await db.delete(friendshipsTable).where(or(inArray(friendshipsTable.userLowId, ids), inArray(friendshipsTable.userHighId, ids)));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
  if (ownedPlaceholder) await db.delete(usersTable).where(eq(usersTable.id, ownedPlaceholder));
});

describe("friends API", () => {
  it("requires auth and supports request, addressee accept, listing, and removal", async () => {
    expect((await request(app).get("/api/friends")).status).toBe(401);
    expect((await request(app).get("/api/friends/suggestions").set(as(guest))).status).toBe(401);
    expect((await request(app).get("/api/friends/link").set(as(guest))).status).toBe(401);
    expect((await request(app).post("/api/friends/requests").set(as(guest)).send({ userId: friend })).status).toBe(401);
    const created = await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: friend });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    const [pair] = await db.select().from(friendshipsTable).where(eq(friendshipsTable.id, created.body.requestId));
    expect(pair.userLowId).toBe(Math.min(owner, friend));
    expect(pair.userHighId).toBe(Math.max(owner, friend));
    expect((await request(app).post(`/api/friends/requests/${created.body.requestId}/accept`).set(as(other))).status).toBe(404);
    expect((await request(app).post(`/api/friends/requests/${created.body.requestId}/accept`).set(as(friend))).body.status).toBe("accepted");
    const listed = (await request(app).get("/api/friends").set(as(owner))).body.friends;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ requestId: created.body.requestId, userId: friend, name: expect.any(String), position: null });
    expect(listed[0].since).toEqual(expect.any(String));
    expect((await request(app).delete(`/api/friends/${friend}`).set(as(owner))).status).toBe(200);
  });

  it("auto-accepts mutual requests, declines, and rejects invalid/self targets", async () => {
    const first = await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: other });
    expect(first.status).toBe(201);
    const mutual = await request(app).post("/api/friends/requests").set(as(other)).send({ userId: owner });
    expect(mutual.status).toBe(201);
    expect(mutual.body.status).toBe("accepted");
    await request(app).delete(`/api/friends/${other}`).set(as(owner));
    const cancel = await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: friend });
    expect(cancel.status).toBe(201);
    expect((await request(app).delete(`/api/friends/${owner}`).set(as(friend))).status).toBe(200);
    expect((await db.select().from(friendshipsTable).where(eq(friendshipsTable.id, cancel.body.requestId))).length).toBe(0);
    const declined = await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: friend });
    expect(declined.status).toBe(201);
    expect((await request(app).post(`/api/friends/requests/${declined.body.requestId}/decline`).set(as(friend))).status).toBe(200);
    expect((await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: owner })).status).toBe(400);
    expect((await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: 999999999 })).status).toBe(404);
  });

  it("blocks requests, link acceptance, and exposes create/reset/public lookup", async () => {
    await db.insert(userBlocksTable).values({ blockerId: owner, blockedId: friend });
    expect((await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: friend })).body.reason).toBe("blocked");
    expect((await request(app).post("/api/friends/link/invalid/accept").set(as(owner))).status).toBe(404);
    await db.delete(userBlocksTable).where(and(eq(userBlocksTable.blockerId, owner), eq(userBlocksTable.blockedId, friend)));
    const link = await request(app).get("/api/friends/link").set(as(friend));
    expect(link.status).toBe(200);
    expect(link.body.code).toHaveLength(8);
    expect(link.body.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(link.body.url).toContain(`/f/${link.body.code}`);
    expect((await request(app).get(`/api/friends/link/${link.body.code}`)).status).toBe(200);
    const reset = await request(app).post("/api/friends/link/reset").set(as(friend));
    expect(reset.status).toBe(200);
    expect((await request(app).get(`/api/friends/link/${link.body.code}`)).status).toBe(404);
    expect((await request(app).post(`/api/friends/link/${reset.body.code}/accept`).set(as(owner))).status).toBe(201);
  });

  it("rejects guest, disabled, and reserved deleted-player targets", async () => {
    const targets = await db.select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable).where(or(
        eq(usersTable.email, "deleted-player@soccerwatch.local"),
        eq(usersTable.isGuest, true), eq(usersTable.isDisabled, true),
      ));
    for (const target of targets) {
      expect((await request(app).post("/api/friends/requests").set(as(owner)).send({ userId: target.id })).status).toBe(404);
    }
  });

  it("enforces thirty outgoing requests per day and one hundred pending requests", async () => {
    const makeUsers = async (count: number, prefix: string) => {
      const created: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const [user] = await db.insert(usersTable).values({
          name: `${prefix} ${tag} ${i}`, email: `${prefix}_${tag}_${i}@test.local`,
        }).returning({ id: usersTable.id });
        ids.push(user.id); created.push(user.id);
      }
      return created;
    };
    const [rateActor] = await makeUsers(1, "rate-actor");
    const rateTargets = await makeUsers(31, "rate");
    for (const target of rateTargets.slice(0, 30)) {
      expect((await request(app).post("/api/friends/requests").set(as(rateActor)).send({ userId: target })).status).toBe(201);
    }
    const rateLimited = await request(app).post("/api/friends/requests").set(as(rateActor)).send({ userId: rateTargets[30] });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body.reason).toBe("rate_limited");
    const pendingTargets = await makeUsers(101, "pending");
    [incomingActor] = await makeUsers(1, "incoming");
    await db.insert(friendshipsTable).values(pendingTargets.slice(0, 100).map((target) => ({
      userLowId: Math.min(other, target), userHighId: Math.max(other, target), requestedBy: other,
    })));
    const capped = await request(app).post("/api/friends/requests").set(as(other)).send({ userId: pendingTargets[100] });
    expect(capped.status).toBe(429);
    expect(capped.body.reason).toBe("too_many_pending");
  });

  it("blocks incoming acceptance and link acceptance", async () => {
    await request(app).delete(`/api/friends/${friend}`).set(as(owner));
    const pending = await request(app).post("/api/friends/requests").set(as(incomingActor)).send({ userId: friend });
    expect(pending.status).toBe(201);
    await db.insert(userBlocksTable).values({ blockerId: friend, blockedId: incomingActor });
    const accepted = await request(app).post(`/api/friends/requests/${pending.body.requestId}/accept`).set(as(friend));
    expect(accepted.status).toBe(403);
    expect(accepted.body.reason).toBe("blocked");
    await db.delete(friendshipsTable).where(eq(friendshipsTable.id, pending.body.requestId));
    await db.delete(userBlocksTable).where(and(eq(userBlocksTable.blockerId, friend), eq(userBlocksTable.blockedId, incomingActor)));
    await db.insert(userBlocksTable).values({ blockerId: owner, blockedId: friend });
    const blockedLink = await request(app).get("/api/friends/link").set(as(friend));
    const linkBlocked = await request(app).post(`/api/friends/link/${blockedLink.body.code}/accept`).set(as(owner));
    expect(linkBlocked.status).toBe(403);
    expect(linkBlocked.body.reason).toBe("blocked");
    await db.delete(userBlocksTable).where(and(eq(userBlocksTable.blockerId, owner), eq(userBlocksTable.blockedId, friend)));
  });

  it("filters suggestions to recent shared in/maybe players", async () => {
    const makeUser = async (name: string, flags: Record<string, unknown> = {}) => {
      const [user] = await db.insert(usersTable).values({
        name: `${name} ${tag}`, email: `${name}_${tag}@test.local`, ...flags,
      }).returning({ id: usersTable.id });
      ids.push(user.id); return user.id;
    };
    const good = await makeUser("suggest-good");
    const additionalGood: number[] = [];
    for (let i = 0; i < 20; i += 1) additionalGood.push(await makeUser(`suggest-good-${i}`));
    const old = await makeUser("suggest-old");
    const invited = await makeUser("suggest-invited");
    const out = await makeUser("suggest-out");
    const nullUser = await makeUser("suggest-null");
    const blocked = await makeUser("suggest-blocked");
    const pending = await makeUser("suggest-pending");
    const accepted = await makeUser("suggest-accepted");
    const guest = await makeUser("suggest-guest", { isGuest: true });
    const disabled = await makeUser("suggest-disabled", { isDisabled: true });
    const [field] = await db.insert(fieldsTable).values({ name: `Friends field ${tag}` }).returning({ id: fieldsTable.id });
    const [footage] = await db.insert(footageRequestsTable).values({
      fieldId: field.id, cameraId: `friends-camera-${tag}`, requestedBy: owner,
      startLocal: "2030-01-01 20:00", endLocal: "2030-01-01 21:00", requestedSeconds: 3600,
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(footage.id);
    const [room] = await db.insert(matchRoomsTable).values({
      footageRequestId: footage.id, fieldId: field.id, code: `FR${tag.slice(-8)}`, captainToken: `token-${tag}`,
      createdAt: new Date(),
    }).returning({ id: matchRoomsTable.id });
    roomIds.push(room.id);
    const invite = (userId: number | null, rsvp: string, i: number) => ({
      matchId: room.id, userId, displayName: `player-${i}`, rsvp,
      inviteToken: `invite-${tag}-${i}`,
    });
    await db.insert(matchPlayersTable).values([
      invite(owner, "in", 0), invite(good, "maybe", 1), invite(old, "in", 2),
      invite(invited, "invited", 3), invite(out, "out", 4), invite(null, "in", 5),
      invite(blocked, "in", 6), invite(pending, "in", 7), invite(accepted, "in", 8),
      invite(guest, "in", 9), invite(disabled, "in", 10),
    ]);
    await db.update(matchRoomsTable).set({ createdAt: new Date(Date.now() - 61 * 86400000) })
      .where(eq(matchRoomsTable.id, room.id));
    // Reuse a recent room for the actual positive case, while old-only users remain excluded.
    await db.insert(matchRoomsTable).values({
      footageRequestId: (await db.insert(footageRequestsTable).values({
        fieldId: field.id, cameraId: `friends-camera-new-${tag}`, requestedBy: owner,
        startLocal: "2030-01-01 20:00", endLocal: "2030-01-01 21:00", requestedSeconds: 3600,
      }).returning({ id: footageRequestsTable.id }))[0].id,
      fieldId: field.id, code: `FN${tag.slice(-8)}`, captainToken: `token-new-${tag}`, createdAt: new Date(),
    }).returning({ id: matchRoomsTable.id });
    const [newRoom] = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable).where(eq(matchRoomsTable.code, `FN${tag.slice(-8)}`));
    roomIds.push(newRoom.id);
    const [newFootage] = await db.select({ id: footageRequestsTable.id }).from(footageRequestsTable)
      .where(eq(footageRequestsTable.cameraId, `friends-camera-new-${tag}`));
    requestIds.push(newFootage.id);
    const [deletedPlayer] = await db.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.email, "deleted-player@soccerwatch.local"));
    await db.insert(matchPlayersTable).values([
      { ...invite(owner, "in", 20), matchId: newRoom.id },
      { ...invite(good, "maybe", 21), matchId: newRoom.id },
      ...additionalGood.map((id, i) => ({ ...invite(id, "in", 22 + i), matchId: newRoom.id })),
      { ...invite(invited, "invited", 50), matchId: newRoom.id },
      { ...invite(out, "out", 51), matchId: newRoom.id },
      { ...invite(null, "in", 52), matchId: newRoom.id },
      { ...invite(blocked, "in", 53), matchId: newRoom.id },
      { ...invite(pending, "in", 54), matchId: newRoom.id },
      { ...invite(accepted, "in", 55), matchId: newRoom.id },
      { ...invite(guest, "in", 56), matchId: newRoom.id },
      { ...invite(disabled, "in", 57), matchId: newRoom.id },
      ...(deletedPlayer ? [{ ...invite(deletedPlayer.id, "in", 58), matchId: newRoom.id }] : []),
    ]);
    await db.insert(userBlocksTable).values({ blockerId: owner, blockedId: blocked });
    await db.insert(friendshipsTable).values({
      userLowId: Math.min(owner, pending), userHighId: Math.max(owner, pending), requestedBy: owner,
    });
    await db.insert(friendshipsTable).values({
      userLowId: Math.min(owner, accepted), userHighId: Math.max(owner, accepted), requestedBy: owner, status: "accepted",
    });
    const suggestions = await request(app).get("/api/friends/suggestions").set(as(owner));
    expect(suggestions.status).toBe(200);
    expect(suggestions.body).toHaveLength(20);
    const suggestedIds = new Set<number>(suggestions.body.map((item: { userId: number }) => item.userId));
    expect(Array.from(suggestedIds).every((id) => [good, ...additionalGood].includes(id))).toBe(true);
    expect([owner, old, invited, out, blocked, pending, accepted, guest, disabled, deletedPlayer?.id]
      .filter((id): id is number => id !== undefined).every((id) => !suggestedIds.has(id))).toBe(true);
    await db.delete(fieldsTable).where(eq(fieldsTable.id, field.id));
  });
});