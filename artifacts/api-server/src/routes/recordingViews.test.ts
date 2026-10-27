import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import { db, fieldsTable, recordingsTable, recordingViewsTable, userClipsTable, usersTable } from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
}));

import { getLocalUserId, getLocalUserRecord } from "../lib/clerkUserBridge";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const mockedGetLocalUserRecord = vi.mocked(getLocalUserRecord);
const TEST_TAG = `recording-views-${Date.now()}`;
const VIDEO_ID = "1e69d9ea-e5ef-4c20-990d-a4fd678f7ace";
let app: Express;
let fieldId: number;
let recordingId: number;
let viewerId: number;
let guestId: number;
let adminId: number;
let userClipId: number;
let viewer: typeof usersTable.$inferSelect;

beforeAll(async () => {
  const { default: recordingsRouter } = await import("./recordings");
  app = express();
  app.use(express.json());
  app.use("/api", recordingsRouter);

  const [field] = await db.insert(fieldsTable).values({
    name: `Viewer tracking ${TEST_TAG}`,
    location: "Test",
  }).returning();
  fieldId = field.id;

  [viewer] = await db.insert(usersTable).values({
    name: `Test Viewer ${TEST_TAG}`,
    email: `${TEST_TAG}@test.local`,
    isGuest: false,
    profileComplete: true,
  }).returning();
  viewerId = viewer.id;

  const [guest] = await db.insert(usersTable).values({
    name: `Guest ${TEST_TAG}`,
    email: `guest-${TEST_TAG}@test.local`,
    isGuest: true,
  }).returning();
  guestId = guest.id;

  const [admin] = await db.insert(usersTable).values({
    name: `Test Admin ${TEST_TAG}`,
    email: `admin-${TEST_TAG}@test.local`,
    isGuest: false,
    isAdmin: true,
    profileComplete: true,
  }).returning();
  adminId = admin.id;

  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-10-27",
    timeSlot: "17:00",
    duration: "01:00:00",
    videoUrl: `https://vz-test.b-cdn.net/${VIDEO_ID}/playlist.m3u8`,
    isVisible: true,
  }).returning();
  recordingId = recording.id;
  const [userClip] = await db.insert(userClipsTable).values({
    userId: viewerId,
    videoId: VIDEO_ID,
    title: `Test clip ${TEST_TAG}`,
    startTime: "0",
    endTime: "0.1",
  }).returning({ id: userClipsTable.id });
  userClipId = userClip.id;
});

afterAll(async () => {
  await db.delete(recordingViewsTable).where(eq(recordingViewsTable.recordingId, recordingId));
  await db.delete(userClipsTable).where(eq(userClipsTable.id, userClipId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(eq(usersTable.id, viewerId));
  await db.delete(usersTable).where(eq(usersTable.id, guestId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("recording view tracking", () => {
  it("counts repeat playback starts for the same signed-in viewer", async () => {
    mockedGetLocalUserId.mockResolvedValue(viewerId);
    mockedGetLocalUserRecord.mockResolvedValue(viewer);

    await request(app).post("/api/recording-views")
      .send({ fieldId, videoId: VIDEO_ID }).expect(204);
    await request(app).post("/api/recording-views")
      .send({ fieldId, videoId: VIDEO_ID }).expect(204);

    const [row] = await db.select().from(recordingViewsTable).where(
      and(
        eq(recordingViewsTable.recordingId, recordingId),
        eq(recordingViewsTable.viewerUserId, viewerId),
      ),
    );
    expect(row?.viewCount).toBe(2);
  });

  it("does not log playback for a recording on a hidden field", async () => {
    await db.update(fieldsTable).set({ isHidden: true }).where(eq(fieldsTable.id, fieldId));
    mockedGetLocalUserId.mockResolvedValue(viewerId);
    mockedGetLocalUserRecord.mockResolvedValue(viewer);

    await request(app).post("/api/recording-views")
      .send({ fieldId, videoId: VIDEO_ID }).expect(404);
    const rows = await db.select().from(recordingViewsTable)
      .where(eq(recordingViewsTable.recordingId, recordingId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.viewCount).toBe(2);
    await db.update(fieldsTable).set({ isHidden: false }).where(eq(fieldsTable.id, fieldId));
  });

  it("records guest views and playback duration without exposing guest details", async () => {
    mockedGetLocalUserId.mockResolvedValue(guestId);
    await request(app).post("/api/recording-views")
      .send({ fieldId, videoId: VIDEO_ID }).expect(204);
    await request(app).post("/api/recording-views/watch-time")
      .send({ fieldId, videoId: VIDEO_ID, seconds: 12 }).expect(204);
    const [row] = await db.select().from(recordingViewsTable).where(
      and(
        eq(recordingViewsTable.recordingId, recordingId),
        eq(recordingViewsTable.viewerUserId, guestId),
      ),
    );
    expect(row).toMatchObject({ viewCount: 1, watchedSeconds: 12 });
  });

  it("shows viewer identities only to admins", async () => {
    mockedGetLocalUserId.mockResolvedValue(viewerId);
    await request(app).get(`/api/admin/recordings/${recordingId}/viewers`).expect(403);

    mockedGetLocalUserId.mockResolvedValue(adminId);
    const response = await request(app).get(`/api/admin/recordings/${recordingId}/viewers`).expect(200);
    expect(response.body).toHaveLength(2);
    expect(response.body.find((row: { userId: number }) => row.userId === viewerId)).toMatchObject({
      userId: viewerId,
      name: viewer.name,
      email: viewer.email,
      viewCount: 2,
      clipCount: 1,
    });
    expect(response.body.find((row: { userId: number }) => row.userId === guestId)).toMatchObject({
      name: "Guest",
      email: null,
      isGuest: true,
      viewCount: 1,
      watchedSeconds: 12,
      clipCount: 0,
    });
  });
});
