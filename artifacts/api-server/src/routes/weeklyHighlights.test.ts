import express, { type Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  db, fieldsTable, footageRequestsTable, matchPlayersTable, recordingsTable,
  userClipsTable, usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ensureRoomForRequest } from "../lib/matchRooms";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    return Number.isInteger(id) && id > 0 ? id : null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import weeklyHighlightsRouter from "./weeklyHighlights";

const TAG = `weekly_manual_${Date.now()}`;
const weekStart = "2026-10-24";
let app: Express;
let adminId: number;
let playerId: number;
let fieldId: number;
let requestId: number;
let recordingId: number;
let clipId: number;
let unlinkedClipId: number;

describe("weekly highlight candidates", () => {
  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use("/api", weeklyHighlightsRouter);

    const [admin] = await db.insert(usersTable).values({
      name: `Admin ${TAG}`, email: `${TAG}_admin@test.local`, profileComplete: true, isAdmin: true,
    }).returning({ id: usersTable.id });
    adminId = admin.id;
    const [player] = await db.insert(usersTable).values({
      name: `Player ${TAG}`, email: `${TAG}_player@test.local`, profileComplete: true,
    }).returning({ id: usersTable.id });
    playerId = player.id;
    const [field] = await db.insert(fieldsTable).values({
      name: `Field ${TAG}`, location: "Test", cameraId: `${TAG}_camera`,
    }).returning({ id: fieldsTable.id });
    fieldId = field.id;
    const [footage] = await db.insert(footageRequestsTable).values({
      fieldId, cameraId: `${TAG}_camera`, requestedBy: adminId,
      startLocal: `${weekStart} 19:00`, endLocal: `${weekStart} 20:00`,
      requestedSeconds: 3600, status: "scheduled",
    }).returning({ id: footageRequestsTable.id, fieldId: footageRequestsTable.fieldId });
    requestId = footage.id;
    const room = await ensureRoomForRequest(footage);
    await db.insert(matchPlayersTable).values({
      matchId: room.id, userId: playerId, displayName: `Player ${TAG}`,
      inviteToken: `${TAG}_invite`, rsvp: "in",
    });

    const videoId = `${randomUUID()}`;
    const [recording] = await db.insert(recordingsTable).values({
      fieldId, court: "Main", date: weekStart, timeSlot: "19:00", duration: "01:00:00",
      videoUrl: `https://media.test/${videoId}/playlist.m3u8`,
    }).returning({ id: recordingsTable.id });
    recordingId = recording.id;
    const [clip] = await db.insert(userClipsTable).values({
      userId: playerId, videoId, title: "Manually saved shot",
      startTime: "120", endTime: "128", exportStatus: "done",
      sourceRecordingId: recordingId,
      exportedUrl: `https://storage.test/${TAG}.mp4`,
    }).returning({ id: userClipsTable.id });
    clipId = clip.id;
    const [unlinkedClip] = await db.insert(userClipsTable).values({
      userId: playerId, videoId, title: "Unlinked legacy shot",
      startTime: "140", endTime: "148", exportStatus: "done",
      exportedUrl: `https://storage.test/${TAG}-unlinked.mp4`,
    }).returning({ id: userClipsTable.id });
    unlinkedClipId = unlinkedClip.id;
  });

  afterAll(async () => {
    if (clipId || unlinkedClipId) await db.delete(userClipsTable).where(eq(userClipsTable.id, clipId || unlinkedClipId));
    if (unlinkedClipId) await db.delete(userClipsTable).where(eq(userClipsTable.id, unlinkedClipId));
    if (recordingId) await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
    if (requestId) await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
    if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
    if (adminId) await db.delete(usersTable).where(eq(usersTable.id, adminId));
    if (playerId) await db.delete(usersTable).where(eq(usersTable.id, playerId));
  });

  it("offers a player's manually saved recording clip for that week's personal and field highlights", async () => {
    const response = await request(app)
      .get("/api/admin/weekly-highlights/candidates")
      .set("x-test-user", String(adminId))
      .query({ weekStart });

    expect(response.status).toBe(200);
    const player = response.body.players.find((candidate: { userId: number }) => candidate.userId === playerId);
    expect(player.clips.map((clip: { id: number }) => clip.id)).toContain(clipId);
    expect(player.clips.map((clip: { id: number }) => clip.id)).not.toContain(unlinkedClipId);
    const field = response.body.fields.find((candidate: { id: number }) => candidate.id === fieldId);
    expect(field.clips.map((clip: { id: number }) => clip.id)).toContain(clipId);
    expect(field.clips.map((clip: { id: number }) => clip.id)).not.toContain(unlinkedClipId);
  });
});
