import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express, type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  clipsTable, db, fieldsTable, footageRequestsTable, recordingsTable, userClipsTable, usersTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    return raw ? Number(raw) : null;
  }),
}));

vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    BUNNY_API_KEY: "test-key",
    BUNNY_LIBRARY_ID: "test-library",
    BUNNY_CDN_HOSTNAME: "vz-test.b-cdn.net",
    getBunnyVideoReadiness: vi.fn(async () => ({ ready: true, status: 4 })),
    getBunnyVideoInfo: vi.fn(async (id: string) => {
      if (id === "00000000-0000-4000-8000-000000000099") {
        const { BunnyVideoNotFoundError } = await import("../lib/bunny");
        throw new BunnyVideoNotFoundError(id);
      }
      return {
        duration: id.endsWith("002") ? 72.5 : id.endsWith("003") ? 75 : 72,
        hasMP4Fallback: true,
        availableResolutions: "1080p",
      };
    }),
  };
});

import { getLocalUserId } from "../lib/clerkUserBridge";
import { getBunnyVideoInfo, getBunnyVideoReadiness } from "../lib/bunny";
import adminRouter from "./admin";

const TAG = `replace_video_${Date.now()}`;
const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";
const BAD_LENGTH = "00000000-0000-4000-8000-000000000003";
const MISSING = "00000000-0000-4000-8000-000000000099";
const mockedUser = vi.mocked(getLocalUserId);
const readiness = vi.mocked(getBunnyVideoReadiness);
const info = vi.mocked(getBunnyVideoInfo);
let app: Express;
let adminId: number;
let memberId: number;
let fieldId: number;
const recordingIds: number[] = [];
const footageIds: number[] = [];
const clipIds: number[] = [];
const userClipIds: number[] = [];

const auth = (userId = adminId) => ({ "x-test-user": String(userId) });

async function seedReferences() {
  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-10-22",
    timeSlot: "22:30–23:30",
    duration: "60 min",
    videoUrl: `https://vz-test.b-cdn.net/${OLD}/playlist.m3u8`,
  }).returning({ id: recordingsTable.id });
  recordingIds.push(recording.id);
  const [footage] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: `camera-${TAG}-${recording.id}`,
    requestedBy: adminId,
    startLocal: "2026-10-22 22:30",
    endLocal: "2026-10-22 23:30",
    requestedSeconds: 3600,
    videoId: OLD,
  }).returning({ id: footageRequestsTable.id });
  footageIds.push(footage.id);
  const [clip] = await db.insert(clipsTable).values({
    recordingId: recording.id,
    momentLabel: "Goal",
    bunnyVideoId: OLD,
    bunnyPlaybackUrl: `https://vz-test.b-cdn.net/${OLD}/playlist.m3u8`,
    startTime: "12.500000",
    endTime: "17.500000",
  }).returning({ id: clipsTable.id });
  clipIds.push(clip.id);
  const [userClip] = await db.insert(userClipsTable).values({
    userId: memberId,
    videoId: OLD,
    footageRequestId: footage.id,
    title: "Saved moment",
    startTime: "12.500000",
    endTime: "17.500000",
  }).returning({ id: userClipsTable.id });
  userClipIds.push(userClip.id);
  return { recordingId: recording.id, footageId: footage.id, clipId: clip.id, userClipId: userClip.id };
}

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", adminRouter);
  const [admin] = await db.insert(usersTable).values({
    name: `Admin ${TAG}`, email: `admin_${TAG}@test.local`, isAdmin: true,
  }).returning({ id: usersTable.id });
  const [member] = await db.insert(usersTable).values({
    name: `Member ${TAG}`, email: `member_${TAG}@test.local`,
  }).returning({ id: usersTable.id });
  const [field] = await db.insert(fieldsTable).values({ name: `Field ${TAG}` })
    .returning({ id: fieldsTable.id });
  adminId = admin.id;
  memberId = member.id;
  fieldId = field.id;
});

afterAll(async () => {
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (adminId || memberId) await db.delete(usersTable).where(inArray(usersTable.id, [adminId, memberId]));
});

afterEach(async () => {
  if (userClipIds.length) await db.delete(userClipsTable).where(inArray(userClipsTable.id, userClipIds));
  if (clipIds.length) await db.delete(clipsTable).where(inArray(clipsTable.id, clipIds));
  if (footageIds.length) await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, footageIds));
  if (recordingIds.length) await db.delete(recordingsTable).where(inArray(recordingsTable.id, recordingIds));
  userClipIds.length = 0;
  clipIds.length = 0;
  footageIds.length = 0;
  recordingIds.length = 0;
});

describe("admin recording video replacement", () => {
  beforeEach(() => {
    mockedUser.mockImplementation(async (req: Request) => {
      const raw = req.headers["x-test-user"];
      return typeof raw === "string" ? Number(raw) : null;
    });
    readiness.mockReset().mockResolvedValue({ ready: true, status: 4 });
    info.mockReset().mockImplementation(async (id: string) => {
      if (id === MISSING) {
        const { BunnyVideoNotFoundError } = await import("../lib/bunny");
        throw new BunnyVideoNotFoundError(id);
      }
      return {
        duration: id === BAD_LENGTH ? 75 : id === NEW ? 72.5 : 72,
        hasMP4Fallback: true,
        availableResolutions: "1080p",
      };
    });
  });

  it("is admin-only and validates a missing Bunny video", async () => {
    const { recordingId } = await seedReferences();
    expect((await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
      .set(auth(memberId)).send({ videoId: NEW })).status).toBe(403);
    const missing = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
      .set(auth()).send({ videoId: MISSING });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("not found");
  });

  it("rejects non-ready videos and mismatched lengths", async () => {
    const { recordingId } = await seedReferences();
    readiness.mockResolvedValueOnce({ ready: false, status: 3 });
    const notReady = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
      .set(auth()).send({ videoId: NEW });
    expect(notReady.status).toBe(409);
    expect(notReady.body.status).toBe(3);
    const lengthMismatch = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
      .set(auth()).send({ videoId: BAD_LENGTH });
    expect(lengthMismatch.status).toBe(409);
    expect(lengthMismatch.body.error).toContain("within 2 seconds");
  });

  it("allows replacing a failed current video with zero duration", async () => {
    const seeded = await seedReferences();
    info.mockImplementation(async (id: string) => ({
      duration: id === OLD ? 0 : 72.5,
      hasMP4Fallback: true,
      availableResolutions: "1080p",
    }));
    const response = await request(app).post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
      .set(auth()).send({ videoId: NEW });
    expect(response.status).toBe(200);
  });

  it("lowercases a replacement id before checking references", async () => {
    const seeded = await seedReferences();
    const [referenced] = await db.insert(clipsTable).values({
      recordingId: seeded.recordingId,
      momentLabel: "Other clip",
      bunnyVideoId: NEW,
      startTime: "1",
      endTime: "2",
    }).returning({ id: clipsTable.id });
    clipIds.push(referenced.id);
    const response = await request(app).post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
      .set(auth()).send({ videoId: NEW.toUpperCase() });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("already referenced");
  });

  it("defaults to a dry run and lists exact changes without writing", async () => {
    const seeded = await seedReferences();
    const response = await request(app).post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
      .set(auth()).send({ videoId: NEW });
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("dry_run");
    expect(response.body.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "recordings", rowId: seeded.recordingId, field: "video_url", oldValue: expect.stringContaining(OLD), newValue: expect.stringContaining(NEW) }),
      expect.objectContaining({ table: "clips", rowId: seeded.clipId, field: "bunny_video_id", oldValue: OLD, newValue: NEW }),
      expect.objectContaining({ table: "clips", rowId: seeded.clipId, field: "bunny_playback_url", oldValue: expect.stringContaining(OLD), newValue: expect.stringContaining(NEW) }),
      expect.objectContaining({ table: "footage_requests", rowId: seeded.footageId, field: "video_id", oldValue: OLD, newValue: NEW }),
      expect.objectContaining({ table: "user_clips", rowId: seeded.userClipId, field: "video_id", oldValue: OLD, newValue: NEW }),
    ]));
    const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, seeded.recordingId));
    const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, seeded.clipId));
    const [footage] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, seeded.footageId));
    const [userClip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, seeded.userClipId));
    expect(recording.videoUrl).toContain(OLD);
    expect(clip.bunnyVideoId).toBe(OLD);
    expect(footage.videoId).toBe(OLD);
    expect(userClip.videoId).toBe(OLD);
  });

  it("applies all references atomically and can restore the exact prior values", async () => {
    const seeded = await seedReferences();
    const [siblingRecording] = await db.insert(recordingsTable).values({
      fieldId,
      court: "2",
      date: "2026-10-22",
      timeSlot: "22:30–23:30",
      duration: "60 min",
      videoUrl: `https://vz-test.b-cdn.net/${OLD}/playlist.m3u8`,
    }).returning({ id: recordingsTable.id });
    recordingIds.push(siblingRecording.id);
    const [siblingClip] = await db.insert(clipsTable).values({
      recordingId: siblingRecording.id,
      momentLabel: "Save",
      bunnyVideoId: OLD,
      bunnyPlaybackUrl: `https://vz-test.b-cdn.net/${OLD}/playlist.m3u8`,
      startTime: "30.000000",
      endTime: "34.000000",
    }).returning({ id: clipsTable.id });
    clipIds.push(siblingClip.id);
    const beforeClip = (await db.select().from(clipsTable).where(eq(clipsTable.id, seeded.clipId)))[0];
    const beforeUserClip = (await db.select().from(userClipsTable).where(eq(userClipsTable.id, seeded.userClipId)))[0];
    const apply = async (videoId: string) => request(app)
      .post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
      .set(auth()).send({ videoId, apply: true });
    const first = await apply(NEW);
    expect(first.status).toBe(200);
    expect(first.body.mode).toBe("applied");
    expect(first.body.oldVideoId).toBe(OLD);
    expect(first.body.changes).toHaveLength(8);
    expect((await db.select().from(recordingsTable).where(eq(recordingsTable.id, seeded.recordingId)))[0].videoUrl).toContain(NEW);
    expect((await db.select().from(recordingsTable).where(eq(recordingsTable.id, siblingRecording.id)))[0].videoUrl).toContain(NEW);
    expect((await db.select().from(clipsTable).where(eq(clipsTable.id, seeded.clipId)))[0]).toMatchObject({
      bunnyVideoId: NEW, bunnyPlaybackUrl: expect.stringContaining(NEW),
      startTime: beforeClip.startTime, endTime: beforeClip.endTime,
    });
    expect((await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, seeded.footageId)))[0].videoId).toBe(NEW);
    expect((await db.select().from(userClipsTable).where(eq(userClipsTable.id, seeded.userClipId)))[0]).toMatchObject({
      videoId: NEW, startTime: beforeUserClip.startTime, endTime: beforeUserClip.endTime,
    });
    expect((await db.select().from(clipsTable).where(eq(clipsTable.id, siblingClip.id)))[0]).toMatchObject({
      bunnyVideoId: NEW, bunnyPlaybackUrl: expect.stringContaining(NEW),
      startTime: "30.000000", endTime: "34.000000",
    });
    const reverse = await apply(OLD);
    expect(reverse.status).toBe(200);
    expect(reverse.body.oldVideoId).toBe(NEW);
    expect((await db.select().from(recordingsTable).where(eq(recordingsTable.id, seeded.recordingId)))[0].videoUrl)
      .toBe(`https://vz-test.b-cdn.net/${OLD}/playlist.m3u8`);
    expect((await db.select().from(recordingsTable).where(eq(recordingsTable.id, siblingRecording.id)))[0].videoUrl)
      .toBe(`https://vz-test.b-cdn.net/${OLD}/playlist.m3u8`);
    expect((await db.select().from(clipsTable).where(eq(clipsTable.id, seeded.clipId)))[0]).toMatchObject({
      bunnyVideoId: beforeClip.bunnyVideoId, bunnyPlaybackUrl: beforeClip.bunnyPlaybackUrl,
      startTime: beforeClip.startTime, endTime: beforeClip.endTime,
    });
    expect((await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, seeded.footageId)))[0].videoId).toBe(OLD);
    expect((await db.select().from(userClipsTable).where(eq(userClipsTable.id, seeded.userClipId)))[0]).toMatchObject({
      videoId: beforeUserClip.videoId, startTime: beforeUserClip.startTime, endTime: beforeUserClip.endTime,
    });
    expect((await db.select().from(clipsTable).where(eq(clipsTable.id, siblingClip.id)))[0]).toMatchObject({
      bunnyVideoId: OLD, bunnyPlaybackUrl: `https://vz-test.b-cdn.net/${OLD}/playlist.m3u8`,
      startTime: "30.000000", endTime: "34.000000",
    });
  });
});
