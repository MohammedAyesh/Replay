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

  it("lower-cases the new id before the reference guards, so letter case cannot bypass them", async () => {
    const { recordingId } = await seedReferences();
    const HEX = "abcdef01-2345-4678-89ab-cdef01234567";
    // Another user's clip already points at the new video (stored lower-case).
    const [elsewhere] = await db.insert(userClipsTable).values({
      userId: memberId, videoId: HEX, title: "Elsewhere", startTime: "1", endTime: "2",
    }).returning({ id: userClipsTable.id });
    userClipIds.push(elsewhere.id);

    const upper = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
      .set(auth()).send({ videoId: HEX.toUpperCase(), apply: true });
    expect(upper.status).toBe(409);
    expect(upper.body.error).toContain("already referenced");

    // A recording row that spells the id in upper case is caught too.
    await db.delete(userClipsTable).where(eq(userClipsTable.id, elsewhere.id));
    const [upperRecording] = await db.insert(recordingsTable).values({
      fieldId, court: "3", date: "2026-10-22", timeSlot: "20:00–21:00", duration: "60 min",
      videoUrl: `https://vz-test.b-cdn.net/${HEX.toUpperCase()}/playlist.m3u8`,
    }).returning({ id: recordingsTable.id });
    recordingIds.push(upperRecording.id);
    const lower = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
      .set(auth()).send({ videoId: HEX });
    expect(lower.status).toBe(409);
    expect(lower.body.error).toContain("already referenced");
  });

  it("treats the current id in another letter case as the same video", async () => {
    const HEX_OLD = "fedcba98-7654-4321-8fed-cba987654321";
    const [recording] = await db.insert(recordingsTable).values({
      fieldId, court: "4", date: "2026-10-22", timeSlot: "21:00–22:00", duration: "60 min",
      videoUrl: `https://vz-test.b-cdn.net/${HEX_OLD}/playlist.m3u8`,
    }).returning({ id: recordingsTable.id });
    recordingIds.push(recording.id);

    const response = await request(app).post(`/api/admin/recordings/${recording.id}/replace-video`)
      .set(auth()).send({ videoId: HEX_OLD.toUpperCase() });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("already assigned");
  });

  it("reports the new id lower-cased in the dry run", async () => {
    const { recordingId } = await seedReferences();
    const HEX = "0a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d";
    const response = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
      .set(auth()).send({ videoId: HEX.toUpperCase() });
    expect(response.status).toBe(200);
    expect(response.body.newVideoId).toBe(HEX);
    expect(response.body.lengthCheck).toMatchObject({ currentVideo: "ok", comparedWith: "current_video" });
  });

  describe("when the current video is failed or missing in Bunny", () => {
    function currentVideoFailed() {
      info.mockImplementation(async (id: string) => {
        if (id === OLD) throw new Error(`Could not determine duration for video ${id}: length=0`);
        return { duration: id === NEW ? 72.5 : 72, hasMP4Fallback: true, availableResolutions: "1080p" };
      });
      readiness.mockImplementation(async (id: string) => (
        id === OLD ? { ready: false, status: 5 } : { ready: true, status: 4 }
      ));
    }

    it("allows the swap, skips the length check and says so in the dry run", async () => {
      currentVideoFailed();
      const seeded = await seedReferences();
      const dryRun = await request(app).post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
        .set(auth()).send({ videoId: NEW });
      expect(dryRun.status).toBe(200);
      expect(dryRun.body.mode).toBe("dry_run");
      expect(dryRun.body.lengthCheck).toMatchObject({
        currentVideo: "failed",
        comparedWith: "skipped",
        currentDuration: null,
        newDuration: 72.5,
      });
      expect(dryRun.body.lengthCheck.note).toContain("length check was skipped");

      const applied = await request(app).post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
        .set(auth()).send({ videoId: NEW, apply: true });
      expect(applied.status).toBe(200);
      expect(applied.body.mode).toBe("applied");
      expect((await db.select().from(recordingsTable).where(eq(recordingsTable.id, seeded.recordingId)))[0].videoUrl)
        .toContain(NEW);
    });

    it("compares against the recording's stored duration when it has one", async () => {
      currentVideoFailed();
      const seeded = await seedReferences();
      await db.update(recordingsTable).set({ duration: "1:12" }).where(eq(recordingsTable.id, seeded.recordingId));
      const ok = await request(app).post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
        .set(auth()).send({ videoId: NEW });
      expect(ok.status).toBe(200);
      expect(ok.body.lengthCheck).toMatchObject({
        currentVideo: "failed", comparedWith: "recording_duration", currentDuration: 72,
      });
      expect(ok.body.lengthCheck.note).toContain("stored duration");

      await db.update(recordingsTable).set({ duration: "5:00" }).where(eq(recordingsTable.id, seeded.recordingId));
      const mismatch = await request(app).post(`/api/admin/recordings/${seeded.recordingId}/replace-video`)
        .set(auth()).send({ videoId: NEW });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body).toMatchObject({ currentVideo: "failed", recordingDuration: 300, newDuration: 72.5 });
    });

    it("allows the swap when the current video no longer exists in the library", async () => {
      info.mockImplementation(async (id: string) => {
        const { BunnyVideoNotFoundError } = await import("../lib/bunny");
        if (id === OLD) throw new BunnyVideoNotFoundError(id);
        return { duration: 72.5, hasMP4Fallback: true, availableResolutions: "1080p" };
      });
      const { recordingId } = await seedReferences();
      const response = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
        .set(auth()).send({ videoId: NEW });
      expect(response.status).toBe(200);
      expect(response.body.lengthCheck).toMatchObject({ currentVideo: "missing", comparedWith: "skipped" });
    });

    it("still fails loudly when Bunny's API itself is down", async () => {
      info.mockImplementation(async (id: string) => {
        if (id === OLD) throw new Error(`Bunny API error 503 fetching video info for ${id}`);
        return { duration: 72.5, hasMP4Fallback: true, availableResolutions: "1080p" };
      });
      const { recordingId } = await seedReferences();
      const response = await request(app).post(`/api/admin/recordings/${recordingId}/replace-video`)
        .set(auth()).send({ videoId: NEW });
      expect(response.status).toBe(500);
    });
  });
});
