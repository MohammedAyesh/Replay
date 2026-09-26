import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import {
  contentReportsTable,
  db,
  fieldOwnersTable,
  fieldsTable,
  followsTable,
  friendshipsTable,
  footageRequestsTable,
  matchPlayersTable,
  matchRoomsTable,
  userBlocksTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, Number(raw)));
    return user && !user.isGuest ? user.id : null;
  }),
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, Number(raw)));
    return user ?? null;
  }),
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    return raw ? Number(raw) : null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import safetyRouter from "./safety";
import userClipsRouter from "./userClips";
import usersRouter from "./users";
import matchRoomsRouter from "./matchRooms";
import adminRouter from "./admin";
import { ensureRoomForRequest } from "../lib/matchRooms";

const TAG = `safety_${Date.now()}`;
const users: Record<string, number> = {};
let app: Express;
let fieldId: number;
let roomCode: string;
const clipIds: number[] = [];
const requestIds: number[] = [];

const as = (name: string) => ({ "x-test-user": String(users[name]) });

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", safetyRouter);
  app.use("/api", userClipsRouter);
  app.use("/api", usersRouter);
  app.use("/api", matchRoomsRouter);
  app.use("/api", adminRouter);

  for (const name of ["owner", "reporter", "reporter2", "reporter3", "blocked", "admin", "guest", "other"]) {
    const [user] = await db.insert(usersTable).values({
      name: `${name} ${TAG}`,
      email: `${name}_${TAG}@test.local`,
      isAdmin: name === "admin",
      isGuest: name === "guest",
    }).returning({ id: usersTable.id });
    users[name] = user.id;
  }

  const [field] = await db.insert(fieldsTable).values({
    name: `Safety field ${TAG}`, location: "Test", cameraId: `camera-${TAG}`,
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  await db.insert(fieldOwnersTable).values({ userId: users.owner, fieldId });

  const [requestRow] = await db.insert(footageRequestsTable).values({
    fieldId, cameraId: `camera-${TAG}`, requestedBy: users.owner,
    startLocal: "2030-01-01 20:00", endLocal: "2030-01-01 21:00",
    requestedSeconds: 3600, status: "scheduled",
  }).returning();
  requestIds.push(requestRow.id);
  const room = await ensureRoomForRequest(requestRow);
  roomCode = room.code;

  for (let i = 0; i < 24; i++) {
    const [clip] = await db.insert(userClipsTable).values({
      userId: users.owner, videoId: `${TAG}-video-${i}`, title: `Safety clip ${i}`,
      startTime: "1", endTime: "2", visibility: "public",
      footageRequestId: requestRow.id,
    }).returning();
    clipIds.push(clip.id);
  }
  const [blockedClip] = await db.insert(userClipsTable).values({
    userId: users.blocked, videoId: `${TAG}-blocked-video`, title: "Blocked creator clip",
    startTime: "1", endTime: "2", visibility: "public", footageRequestId: requestRow.id,
  }).returning();
  clipIds.push(blockedClip.id);
});

afterAll(async () => {
  try {
    await db.delete(contentReportsTable).where(orTargets());
    await db.delete(userBlocksTable).where(orUsers());
    await db.delete(friendshipsTable).where(orFriendships());
    await db.delete(followsTable).where(orFollows());
    if (clipIds.length) await db.delete(userClipsTable).where(inArray(userClipsTable.id, clipIds));
    if (requestIds.length) await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
    await db.delete(fieldOwnersTable).where(eq(fieldOwnersTable.fieldId, fieldId));
    await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
    await db.delete(usersTable).where(inArray(usersTable.id, Object.values(users)));
  } catch {
    // The owner may not have applied the additive schema yet; there is no fixture
    // to clean up when setup failed before the first insert.
  }
});

function orTargets() {
  return inArray(contentReportsTable.reporterUserId, Object.values(users));
}
function orUsers() {
  return or(
    inArray(userBlocksTable.blockerId, Object.values(users)),
    inArray(userBlocksTable.blockedId, Object.values(users)),
  );
}
function orFriendships() {
  return or(
    inArray(friendshipsTable.userLowId, Object.values(users)),
    inArray(friendshipsTable.userHighId, Object.values(users)),
  );
}
function orFollows() {
  return or(
    inArray(followsTable.followerId, Object.values(users)),
    inArray(followsTable.followeeId, Object.values(users)),
  );
}

describe("Report & Block", () => {
  it("creates reports, rejects duplicates, self reports, and guests", async () => {
    const created = await request(app).post("/api/reports").set(as("reporter")).send({
      targetType: "user_clip", targetId: clipIds[0], reason: "spam",
    });
    expect(created.status).toBe(201);
    expect((await request(app).post("/api/reports").set(as("reporter")).send({
      targetType: "user_clip", targetId: clipIds[0], reason: "spam",
    })).status).toBe(409);
    expect((await request(app).post("/api/reports").set(as("owner")).send({
      targetType: "user_clip", targetId: clipIds[0], reason: "other",
    })).status).toBe(400);
    expect((await request(app).post("/api/reports").set(as("reporter")).send({
      targetType: "user", targetId: users.reporter, reason: "other",
    })).status).toBe(400);
    expect((await request(app).post("/api/reports").set(as("guest")).send({
      targetType: "user", targetId: users.owner, reason: "spam",
    })).status).toBe(401);
    expect((await request(app).post(`/api/blocks/${users.reporter}`).set(as("reporter"))).status).toBe(400);
    expect((await request(app).post(`/api/blocks/${users.guest}`).set(as("reporter"))).status).toBe(404);
    expect((await request(app).post("/api/blocks/invalid").set(as("reporter"))).status).toBe(400);
    expect((await request(app).post(`/api/blocks/${users.owner}`).set(as("guest"))).status).toBe(401);
    expect((await request(app).get("/api/blocks")).status).toBe(401);
    expect((await request(app).post(`/api/blocks/${users.owner}`)).status).toBe(401);
  });

  it("rate-limits the 21st report and auto-hides at three reporters or nudity", async () => {
    const responses = [];
    for (let i = 1; i <= 20; i++) {
      responses.push(await request(app).post("/api/reports").set(as("reporter2")).send({
        targetType: "user_clip", targetId: clipIds[i], reason: "other",
      }));
    }
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const rateLimited = await request(app).post("/api/reports").set(as("reporter2")).send({
      targetType: "user_clip", targetId: clipIds[21], reason: "other",
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body.reason).toBe("rate_limited");

    const first = await request(app).post("/api/reports").set(as("reporter3")).send({
      targetType: "user_clip", targetId: clipIds[22], reason: "violence",
    });
    expect(first.body.hidden).toBe(false);
    const second = await request(app).post("/api/reports").set(as("reporter")).send({
      targetType: "user_clip", targetId: clipIds[22], reason: "violence",
    });
    expect(second.body.hidden).toBe(false);
    const third = await request(app).post("/api/reports").set(as("blocked")).send({
      targetType: "user_clip", targetId: clipIds[22], reason: "violence",
    });
    expect(third.body.hidden).toBe(true);
    const [hidden] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipIds[22]));
    expect(hidden.hiddenReason).toBe("reports");

    const nudity = await request(app).post("/api/reports").set(as("reporter3")).send({
      targetType: "user_clip", targetId: clipIds[23], reason: "nudity",
    });
    expect(nudity.body).toMatchObject({ ok: true, hidden: true });
    const myClips = await request(app).get("/api/user-clips").set(as("owner"));
    expect(myClips.status).toBe(200);
    expect(myClips.body.find((clip: { id: number }) => clip.id === clipIds[22])).toMatchObject({
      isHidden: true, hiddenReason: "reports",
    });
  });

  it("blocks, removes social relationships, and restores profiles on unblock", async () => {
    await request(app).post(`/api/m/${roomCode}/join`).set(as("blocked")).send({ rsvp: "in" });
    await db.insert(followsTable).values([
      { followerId: users.reporter, followeeId: users.blocked },
      { followerId: users.blocked, followeeId: users.reporter },
    ]);
    await db.insert(friendshipsTable).values({
      userLowId: Math.min(users.reporter, users.blocked),
      userHighId: Math.max(users.reporter, users.blocked),
      requestedBy: users.reporter,
    });
    const blocked = await request(app).post(`/api/blocks/${users.blocked}`).set(as("reporter"));
    expect(blocked.status).toBe(200);
    expect(await db.select().from(followsTable).where(or(
      and(eq(followsTable.followerId, users.reporter), eq(followsTable.followeeId, users.blocked)),
      and(eq(followsTable.followerId, users.blocked), eq(followsTable.followeeId, users.reporter)),
    ))).toHaveLength(0);
    expect((await db.select().from(friendshipsTable).where(eq(friendshipsTable.userLowId, Math.min(users.reporter, users.blocked))))).toHaveLength(0);
    const blocks = await request(app).get("/api/blocks").set(as("reporter"));
    expect(blocks.status).toBe(200);
    expect(blocks.body.some((row: { userId: number; name: string; avatarUrl: string | null; blockedAt: string }) =>
      row.userId === users.blocked && typeof row.name === "string" && row.blockedAt && "avatarUrl" in row,
    )).toBe(true);
    for (const [path, viewer] of [
      [`/api/users/${users.blocked}`, "reporter"],
      [`/api/users/${users.reporter}`, "blocked"],
      [`/api/users/${users.blocked}/replay-profile`, "reporter"],
      [`/api/users/${users.reporter}/replay-profile`, "blocked"],
    ] as const) {
      const response = await request(app).get(path).set(as(viewer));
      expect(response.status).toBe(404);
      expect(response.body.reason).toBe("blocked");
    }
    const follow = await request(app).post(`/api/users/${users.blocked}/follow`).set(as("reporter"));
    expect(follow.status).toBe(403);
    expect(follow.body.reason).toBe("blocked");
    expect((await request(app).post(`/api/user-clips/${clipIds[24]}/like`).set(as("reporter"))).status).toBe(404);
    expect((await request(app).get(`/api/user-clips/${clipIds[24]}/share-link`).set(as("reporter"))).status).toBe(404);
    await db.update(userClipsTable).set({ isHidden: true }).where(eq(userClipsTable.id, clipIds[1]));
    expect((await request(app).post(`/api/user-clips/${clipIds[1]}/like`).set(as("other"))).status).toBe(404);
    expect((await request(app).get(`/api/user-clips/${clipIds[1]}/share-link`).set(as("other"))).status).toBe(404);
    const feed = await request(app).get("/api/feed").set(as("reporter"));
    expect(feed.body.some((clip: { creatorId: number }) => clip.creatorId === users.blocked)).toBe(false);
    const roomClips = await request(app).get(`/api/m/${roomCode}/clips`).set(as("reporter"));
    expect(roomClips.body.some((clip: { by: { userId: number } }) => clip.by.userId === users.blocked)).toBe(false);
    const room = await request(app).get(`/api/m/${roomCode}`).set(as("reporter"));
    expect(room.body.players.some((player: { userId: number }) => player.userId === users.blocked)).toBe(true);
    expect((await request(app).delete(`/api/blocks/${users.blocked}`).set(as("reporter"))).status).toBe(200);
    expect((await request(app).get(`/api/users/${users.blocked}`).set(as("reporter"))).status).toBe(200);
    expect((await request(app).get(`/api/user-clips/${clipIds[24]}/share-link`).set(as("reporter"))).status).toBe(200);
    const ownBlockList = await request(app).get("/api/blocks").set(as("reporter"));
    expect(ownBlockList.body.some((row: { userId: number }) => row.userId === users.blocked)).toBe(false);
  });

  it("lets an admin resolve every action and closes all open reports for a target", async () => {
    const adminPatchHidden = await request(app).patch(`/api/admin/clips/${clipIds[17]}`).set(as("admin")).send({ isHidden: true });
    expect(adminPatchHidden.body).toMatchObject({ isHidden: true });
    let [patchedClip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipIds[17]));
    expect(patchedClip.hiddenReason).toBe("admin");
    await request(app).patch(`/api/admin/clips/${clipIds[17]}`).set(as("admin")).send({ isHidden: false });
    [patchedClip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipIds[17]));
    expect(patchedClip.hiddenReason).toBeNull();

    const hideReport = await request(app).post("/api/reports").set(as("reporter")).send({
      targetType: "user_clip", targetId: clipIds[20], reason: "other",
    });
    const secondHideReport = await request(app).post("/api/reports").set(as("reporter3")).send({
      targetType: "user_clip", targetId: clipIds[20], reason: "violence",
    });
    expect(hideReport.status).toBe(201);
    expect(secondHideReport.status).toBe(201);
    const openBefore = await request(app).get("/api/admin/reports/open").set(as("admin"));
    expect(openBefore.status).toBe(200);
    const openClipReport = openBefore.body.find((row: { targetId: number; targetType: string }) =>
      row.targetType === "user_clip" && row.targetId === clipIds[20]);
    expect(openClipReport).toMatchObject({
      targetType: "user_clip",
      reason: expect.any(String),
      note: null,
      status: "open",
      reporter: { id: expect.any(Number), name: expect.any(String) },
      targetUser: { id: users.owner, name: expect.any(String), isDisabled: false },
      openReportsForTarget: 3,
      clip: { title: "Safety clip 20", visibility: "public", hiddenReason: "reports", posterUrl: null },
    });
    expect((await request(app).get("/api/admin/reports/open").set(as("reporter"))).status).toBe(403);
    const hideId = openClipReport.id;
    const resolve = (reportId: number, action: string) =>
      request(app).post(`/api/admin/reports/${reportId}/resolve`).set(as("admin")).send({ action });
    expect((await resolve(hideId, "hide_clip")).status).toBe(200);
    const [hiddenAfterAdmin] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipIds[20]));
    expect(hiddenAfterAdmin).toMatchObject({ isHidden: true, hiddenReason: "admin" });
    const resolved = await db.select().from(contentReportsTable).where(eq(contentReportsTable.targetId, clipIds[20]));
    expect(resolved).toHaveLength(3);
    expect(resolved.every((row) => row.status === "actioned" && row.reviewedBy === users.admin && row.actionTaken === "hide_clip")).toBe(true);
    const history = await request(app).get("/api/admin/reports/history").set(as("admin"));
    expect(history.status).toBe(200);
    expect(history.body.some((row: { id: number }) => row.id === hideId)).toBe(true);

    const unhideId = openBefore.body.find((row: { targetId: number; targetType: string }) =>
      row.targetType === "user_clip" && row.targetId === clipIds[18]).id;
    expect((await resolve(unhideId, "unhide_clip")).status).toBe(200);
    let [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipIds[18]));
    expect(clip).toMatchObject({ isHidden: false, hiddenReason: null });

    const removeReport = await request(app).post("/api/reports").set(as("other")).send({
      targetType: "user_clip", targetId: clipIds[19], reason: "personal_info",
    });
    const removeId = (await request(app).get("/api/admin/reports/open").set(as("admin"))).body.find(
      (row: { targetId: number; targetType: string }) => row.targetType === "user_clip" && row.targetId === clipIds[19],
    ).id;
    expect(removeReport.status).toBe(201);
    expect((await resolve(removeId, "remove_from_clip")).status).toBe(200);
    [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipIds[19]));
    expect(clip).toMatchObject({ isHidden: true, hiddenReason: "removal_request" });

    const dismissReport = await request(app).post("/api/reports").set(as("other")).send({
      targetType: "user_clip", targetId: clipIds[16], reason: "spam",
    });
    const dismissId = (await request(app).get("/api/admin/reports/open").set(as("admin"))).body.find(
      (row: { targetId: number; targetType: string }) => row.targetType === "user_clip" && row.targetId === clipIds[16],
    ).id;
    expect(dismissReport.status).toBe(201);
    expect((await resolve(dismissId, "dismiss")).status).toBe(200);
    const [dismissed] = await db.select().from(contentReportsTable).where(eq(contentReportsTable.id, dismissId));
    expect(dismissed.status).toBe("dismissed");

    const userReport = await request(app).post("/api/reports").set(as("reporter")).send({
      targetType: "user", targetId: users.other, reason: "harassment",
    });
    expect(userReport.status).toBe(201);
    const open = await request(app).get("/api/admin/reports/open").set(as("admin"));
    const userReportId = open.body.find((row: { targetId: number; targetType: string }) =>
      row.targetType === "user" && row.targetId === users.other).id;
    expect((await resolve(userReportId, "disable_user")).status).toBe(200);
    expect((await request(app).get(`/api/users/${users.other}`).set(as("reporter"))).status).toBe(404);

    const adminReport = await request(app).post("/api/reports").set(as("reporter3")).send({
      targetType: "user", targetId: users.admin, reason: "other",
    });
    const adminOpen = await request(app).get("/api/admin/reports/open").set(as("admin"));
    const adminReportId = adminOpen.body.find((row: { targetId: number; targetType: string }) =>
      row.targetType === "user" && row.targetId === users.admin).id;
    expect(adminReport.status).toBe(201);
    expect((await resolve(adminReportId, "disable_user")).status).toBe(409);
  });
});