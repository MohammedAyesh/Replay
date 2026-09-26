import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  clipsTable,
  footageCancellationRequestsTable,
  footagePaymentsTable,
  footageRequestsTable,
  fieldsTable,
  likesTable,
  recordingsTable,
  statUnlocksTable,
  userClipsTable,
  usersTable,
  varMarksTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalAccountUserId: vi.fn(),
  deleteClerkUserAccount: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error });
  }),
}));

vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    deleteBunnyClipAssets: vi.fn().mockResolvedValue(undefined),
  };
});

import { deleteBunnyClipAssets } from "../lib/bunny";
import { deleteClerkUserAccount, getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const mockedDeleteBunnyAssets = vi.mocked(deleteBunnyClipAssets);
const mockedDeleteClerkUser = vi.mocked(deleteClerkUserAccount);
const mockedGetLocalAccountUserId = vi.mocked(getLocalAccountUserId);
const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const TAG = `account-delete-${Date.now()}`;
const DELETED_PLAYER_EMAIL = "deleted-player@soccerwatch.local";

let app: Express;
let adminId: number;
let fieldId: number;
let deletedPlayerExistedBeforeTest: boolean;
let sequence = 0;
const targetIds: number[] = [];
const footageRequestIds: number[] = [];
const userClipIds: number[] = [];
const recordingIds: number[] = [];
const legacyClipIds: number[] = [];
const unlockReferences: string[] = [];

async function createTarget(label: string) {
  sequence += 1;
  const clerkId = `clerk_${TAG}_${sequence}`;
  const [user] = await db.insert(usersTable).values({
    name: `${label} ${TAG}`,
    email: `${label.toLowerCase()}-${TAG}-${sequence}@test.local`,
    clerkId,
    isGuest: false,
  }).returning({ id: usersTable.id });
  targetIds.push(user.id);
  return { id: user.id, clerkId };
}

async function createFootageRequest(userId: number, status: string, label: string): Promise<number> {
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    requestedBy: userId,
    cameraId: "camera1",
    startLocal: `${TAG} ${label} start`,
    endLocal: `${TAG} ${label} end`,
    requestedSeconds: 1800,
    status,
    videoId: `${TAG}-${label}`,
  }).returning({ id: footageRequestsTable.id });
  footageRequestIds.push(row.id);
  return row.id;
}

async function cleanupPreviousTestRuns(): Promise<void> {
  const priorAdmins = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(like(usersTable.email, "account-deletion-admin-%@test.local"));

  for (const { email } of priorAdmins) {
    const tag = email.slice("account-deletion-admin-".length, -"@test.local".length);
    if (!tag) continue;

    const priorUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(like(usersTable.email, `%${tag}%@test.local`));
    const priorUserIds = priorUsers.map(({ id }) => id);
    const priorClips = await db
      .select({ id: userClipsTable.id })
      .from(userClipsTable)
      .where(like(userClipsTable.title, `%${tag}%`));
    const priorClipIds = priorClips.map(({ id }) => id);
    const priorRequests = await db
      .select({ id: footageRequestsTable.id })
      .from(footageRequestsTable)
      .where(like(footageRequestsTable.videoId, `${tag}-%`));
    const priorRequestIds = priorRequests.map(({ id }) => id);
    const priorFields = await db
      .select({ id: fieldsTable.id })
      .from(fieldsTable)
      .where(eq(fieldsTable.name, `Account deletion field ${tag}`));

    if (priorUserIds.length > 0) {
      await db.delete(likesTable).where(inArray(likesTable.userId, priorUserIds));
    }
    if (priorClipIds.length > 0) {
      await db.delete(likesTable).where(inArray(likesTable.userClipId, priorClipIds));
      await db.delete(userClipsTable).where(inArray(userClipsTable.id, priorClipIds));
    }
    if (priorRequestIds.length > 0) {
      await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, priorRequestIds));
    }
    if (priorFields.length > 0) {
      await db.delete(footagePaymentsTable).where(eq(footagePaymentsTable.fieldId, priorFields[0]!.id));
    }
    await db.delete(statUnlocksTable).where(like(statUnlocksTable.reference, `${tag}-unlock-%`));
    if (priorUserIds.length > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, priorUserIds));
    }
    if (priorFields.length > 0) {
      await db.delete(fieldsTable).where(eq(fieldsTable.id, priorFields[0]!.id));
    }
  }
}

beforeAll(async () => {
  await cleanupPreviousTestRuns();

  const [existingPlaceholder] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, DELETED_PLAYER_EMAIL));
  deletedPlayerExistedBeforeTest = Boolean(existingPlaceholder);

  const [admin] = await db.insert(usersTable).values({
    name: `Account deletion admin ${TAG}`,
    email: `account-deletion-admin-${TAG}@test.local`,
    clerkId: `clerk_${TAG}_admin`,
    isGuest: false,
    isAdmin: true,
  }).returning({ id: usersTable.id });
  adminId = admin.id;

  const [field] = await db.insert(fieldsTable).values({
    name: `Account deletion field ${TAG}`,
    location: "Test",
    isHidden: false,
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-21",
    timeSlot: TAG,
    duration: "00:30:00",
    videoUrl: `https://cdn.test/account-delete-${TAG}/playlist.m3u8`,
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingIds.push(recording.id);

  const [{ default: accountRouter }, { default: adminRouter }] = await Promise.all([
    import("./account"),
    import("./admin"),
  ]);
  app = express();
  app.use(express.json());
  app.use("/api", accountRouter);
  app.use("/api", adminRouter);
});

beforeEach(() => {
  mockedDeleteBunnyAssets.mockReset().mockResolvedValue(undefined);
  mockedDeleteClerkUser.mockReset().mockResolvedValue(undefined);
  mockedGetLocalAccountUserId.mockReset().mockResolvedValue(null);
  mockedGetLocalUserId.mockReset().mockResolvedValue(adminId);
});

afterAll(async () => {
  if (userClipIds.length > 0) {
    await db.delete(likesTable).where(inArray(likesTable.userClipId, userClipIds));
    await db.delete(userClipsTable).where(inArray(userClipsTable.id, userClipIds));
  }
  if (legacyClipIds.length > 0) {
    await db.delete(likesTable).where(inArray(likesTable.clipId, legacyClipIds));
    await db.delete(clipsTable).where(inArray(clipsTable.id, legacyClipIds));
  }
  if (footageRequestIds.length > 0) {
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, footageRequestIds));
  }
  await db.delete(footagePaymentsTable).where(eq(footagePaymentsTable.fieldId, fieldId));
  if (unlockReferences.length > 0) {
    await db.delete(statUnlocksTable).where(inArray(statUnlocksTable.reference, unlockReferences));
  }
  if (targetIds.length > 0) {
    await db.delete(likesTable).where(inArray(likesTable.userId, targetIds));
    await db.delete(usersTable).where(inArray(usersTable.id, targetIds));
  }
  if (recordingIds.length > 0) {
    await db.delete(recordingsTable).where(inArray(recordingsTable.id, recordingIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!deletedPlayerExistedBeforeTest) {
    await db.delete(usersTable).where(eq(usersTable.email, DELETED_PLAYER_EMAIL));
  }
});

describe("account deletion", () => {
  it("deletes the account and clips while preserving historical records under Deleted player", async () => {
    const target = await createTarget("self-delete");
    mockedGetLocalAccountUserId.mockResolvedValue(target.id);
    const requestId = await createFootageRequest(target.id, "ready", "history");

    await db.insert(footageCancellationRequestsTable).values({
      footageRequestId: requestId,
      requestedBy: target.id,
      reason: "Test cancellation",
    });
    await db.insert(footagePaymentsTable).values({
      fieldId,
      amountFils: 1250,
      method: "cash",
      note: "Historical payment",
      recordedBy: target.id,
    });
    await db.insert(varMarksTable).values({
      footageRequestId: requestId,
      atUtc: new Date("2026-09-21T12:00:00.000Z"),
      kind: "goal",
      note: "Historical VAR mark",
      createdBy: target.id,
    });
    const references = [`${TAG}-unlock-a`, `${TAG}-unlock-b`];
    unlockReferences.push(...references);
    await db.insert(statUnlocksTable).values(references.map((reference) => ({
      userId: target.id,
      kind: "match",
      amountFils: 500,
      reference,
      status: "paid",
    })));

    const [survivingClip] = await db.insert(userClipsTable).values({
      userId: adminId,
      videoId: "surviving-bunny-video",
      title: `Surviving clip ${TAG}`,
      startTime: "1.0",
      endTime: "4.0",
      likeCount: 1,
    }).returning({ id: userClipsTable.id });
    userClipIds.push(survivingClip.id);
    const [ownedClip] = await db.insert(userClipsTable).values({
      userId: target.id,
      videoId: "owned-bunny-video",
      title: `Owned clip ${TAG}`,
      startTime: "2.0",
      endTime: "5.0",
      exportedUrl: "https://storage.example/clips/owned.mp4",
      likeCount: 1,
    }).returning({ id: userClipsTable.id });
    const posterPath = `posters/${ownedClip.id}-fixture.jpg`;
    await db.update(userClipsTable).set({ posterPath }).where(eq(userClipsTable.id, ownedClip.id));
    userClipIds.push(ownedClip.id);
    await db.insert(likesTable).values([
      { userId: target.id, userClipId: survivingClip.id },
      { userId: adminId, userClipId: ownedClip.id },
    ]);
    const [legacyClip] = await db.insert(clipsTable).values({
      recordingId: recordingIds[0]!,
      creatorId: adminId,
      momentLabel: `Legacy clip ${TAG}`,
      likeCount: 1,
    }).returning({ id: clipsTable.id });
    legacyClipIds.push(legacyClip.id);
    await db.insert(likesTable).values({ userId: target.id, clipId: legacyClip.id });

    await request(app).delete("/api/account").expect(200, { ok: true });

    expect(mockedDeleteClerkUser).toHaveBeenCalledWith(target.clerkId);
    expect(mockedDeleteBunnyAssets).toHaveBeenCalledWith(ownedClip.id, posterPath);
    expect(await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, target.id))).toHaveLength(0);

    const [updatedSurvivingClip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, survivingClip.id));
    expect(updatedSurvivingClip.likeCount).toBe(0);
    const [updatedLegacyClip] = await db.select().from(clipsTable).where(eq(clipsTable.id, legacyClip.id));
    expect(updatedLegacyClip.likeCount).toBe(0);
    expect(await db.select().from(userClipsTable).where(eq(userClipsTable.id, ownedClip.id))).toHaveLength(0);
    expect(await db.select().from(likesTable).where(eq(likesTable.userClipId, ownedClip.id))).toHaveLength(0);

    const [deletedPlayer] = await db.select().from(usersTable).where(eq(usersTable.email, DELETED_PLAYER_EMAIL));
    expect(deletedPlayer.name).toBe("Deleted player");
    expect(deletedPlayer.isGuest).toBe(true);
    expect(deletedPlayer.isDisabled).toBe(true);

    const [storedRequest] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
    const [storedCancellation] = await db.select().from(footageCancellationRequestsTable)
      .where(eq(footageCancellationRequestsTable.footageRequestId, requestId));
    const [storedPayment] = await db.select().from(footagePaymentsTable).where(eq(footagePaymentsTable.fieldId, fieldId));
    const [storedMark] = await db.select().from(varMarksTable).where(eq(varMarksTable.footageRequestId, requestId));
    const storedUnlocks = await db.select().from(statUnlocksTable)
      .where(inArray(statUnlocksTable.reference, references));

    expect(storedRequest.requestedBy).toBe(deletedPlayer.id);
    expect(storedCancellation.requestedBy).toBe(deletedPlayer.id);
    expect(storedPayment).toMatchObject({ amountFils: 1250, method: "cash", recordedBy: deletedPlayer.id });
    expect(storedMark).toMatchObject({ kind: "goal", note: "Historical VAR mark", createdBy: deletedPlayer.id });
    expect(storedUnlocks).toHaveLength(2);
    expect(storedUnlocks.map(({ reference }) => reference).sort()).toEqual([...references].sort());
    expect(storedUnlocks.every(({ userId }) => userId === deletedPlayer.id)).toBe(true);
  });

  it("uses the same deletion flow from the administrator endpoint", async () => {
    const target = await createTarget("admin-delete");
    mockedGetLocalUserId.mockResolvedValue(adminId);

    await request(app).delete(`/api/admin/users/${target.id}`).expect(200, { ok: true });

    expect(mockedDeleteClerkUser).toHaveBeenCalledWith(target.clerkId);
    expect(await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, target.id))).toHaveLength(0);
  });

  it("blocks deletion before Clerk when active owner footage requests exist", async () => {
    const target = await createTarget("active-footage");
    mockedGetLocalAccountUserId.mockResolvedValue(target.id);
    await createFootageRequest(target.id, "running", "active");

    const response = await request(app).delete("/api/account").expect(409);

    expect(response.body.activeFootageRequests).toBe(1);
    expect(mockedDeleteClerkUser).not.toHaveBeenCalled();
    const [stillPresent] = await db.select().from(usersTable).where(eq(usersTable.id, target.id));
    expect(stillPresent.isDisabled).toBe(false);
  });

  it("makes no local changes when Clerk deletion fails", async () => {
    const target = await createTarget("clerk-failure");
    mockedGetLocalAccountUserId.mockResolvedValue(target.id);
    mockedDeleteClerkUser.mockRejectedValueOnce(new Error("Clerk unavailable"));
    const [clip] = await db.insert(userClipsTable).values({
      userId: target.id,
      videoId: "clerk-failure-video",
      title: `Must remain ${TAG}`,
      startTime: "0",
      endTime: "3",
    }).returning({ id: userClipsTable.id });
    userClipIds.push(clip.id);

    await request(app).delete("/api/account").expect(502);

    const [stillPresent] = await db.select().from(usersTable).where(eq(usersTable.id, target.id));
    expect(stillPresent.isDisabled).toBe(false);
    expect(await db.select().from(userClipsTable).where(eq(userClipsTable.id, clip.id))).toHaveLength(1);
  });

  it("disables the local account if the database transaction fails", async () => {
    const target = await createTarget("database-failure");
    mockedGetLocalAccountUserId.mockResolvedValue(target.id);
    const transactionSpy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Forced transaction failure"));

    try {
      await request(app).delete("/api/account").expect(500);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(mockedDeleteClerkUser).toHaveBeenCalledWith(target.clerkId);
    const [disabled] = await db.select().from(usersTable).where(eq(usersTable.id, target.id));
    expect(disabled.isDisabled).toBe(true);
  });

  it("rejects guest or unauthenticated self-service deletion", async () => {
    mockedGetLocalAccountUserId.mockResolvedValue(null);
    await request(app).delete("/api/account").expect(401);
    expect(mockedDeleteClerkUser).not.toHaveBeenCalled();
  });
});