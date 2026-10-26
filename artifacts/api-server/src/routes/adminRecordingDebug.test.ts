import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import {
  claimMatchProgressTable,
  db,
  fieldsTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
  type TrackingManifest,
} from "@workspace/db";

const { spawnMock, loadPlayMock, getLocalUserIdMock, selectExportSourceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  loadPlayMock: vi.fn(),
  getLocalUserIdMock: vi.fn(),
  selectExportSourceMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../lib/matchPlayLoad", () => ({ loadRecordingPlay: loadPlayMock }));
vi.mock("../lib/clerkUserBridge", () => ({ getLocalUserId: getLocalUserIdMock }));
vi.mock("../lib/exportSource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/exportSource")>()),
  selectExportSource: selectExportSourceMock,
}));

import router, { clampCropRect, runFfmpeg } from "./adminRecordingDebug";
import { claimIdentityId } from "./claimChain";

const TAG = `recording-debug-${Date.now()}`;
let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let nonAdminId: number;
let recordingId: number;
const fps = 2;
let manifest: TrackingManifest;
const identityId = () => claimIdentityId(playerId, recordingId);

beforeAll(async () => {
  const [field] = await db.insert(fieldsTable).values({ name: TAG, location: "Test" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [admin] = await db.insert(usersTable).values({
    name: `${TAG} Admin`, email: `${TAG}-admin@test.local`, isAdmin: true, isGuest: false,
  }).returning({ id: usersTable.id });
  adminId = admin.id;
  const [player] = await db.insert(usersTable).values({
    name: `${TAG} Player`, email: `${TAG}-player@test.local`, isAdmin: false, isGuest: false,
  }).returning({ id: usersTable.id });
  playerId = player.id;
  const [nonAdmin] = await db.insert(usersTable).values({
    name: `${TAG} Nonadmin`, email: `${TAG}-nonadmin@test.local`, isAdmin: false, isGuest: false,
  }).returning({ id: usersTable.id });
  nonAdminId = nonAdmin.id;
  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-10-01",
    timeSlot: "10:00",
    duration: "00:02",
    videoUrl: "https://vz-test.b-cdn.net/12345678-abcd/playlist.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  manifest = {
    version: 1,
    label: "debug fixture",
    width: 3840,
    height: 1080,
    frameRate: fps,
    frameCount: 6,
    duration: 3,
    matchOffset: 0,
    videoStartSeconds: 0,
    segmentCount: 1,
    segments: [{
      index: 0,
      name: "only",
      startFrame: 0,
      endFrame: 5,
      startSeconds: 0,
      endSeconds: 3,
      objectPath: `${TAG}/segment-0.json`,
    }],
    identities: [{
      id: identityId(),
      name: "Player",
      parts: [{ trackId: "s0:t1", fromFrame: 0, toFrame: 5 }],
    }],
  };
  await db.insert(recordingTrackingBundlesTable).values({ recordingId, manifest });
  await db.insert(claimMatchProgressTable).values({ userId: playerId, recordingId });
  app = express();
  app.use("/api", router);
});

afterAll(async () => {
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, playerId));
  await db.delete(usersTable).where(eq(usersTable.id, nonAdminId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

function setPlayFixture() {
  loadPlayMock.mockResolvedValue({
    recordingId,
    manifest,
    fps,
    sidecars: [{
      v: 1,
      fps,
      touches: [[2, 10, 20, 30, 40, 25, 35, 1.5]],
      ball: [[0, 100, 200], [2, 110, 210], [4, 120, 220]],
      kits: {},
    }],
    segments: [{
      segmentIndex: 0,
      name: "only",
      startFrame: 0,
      endFrame: 5,
      startSeconds: 0,
      endSeconds: 3,
      tracks: [{
        id: "s0:t1",
        startFrame: 0,
        endFrame: 5,
        boxes: [
          { frame: 0, x: 100, y: 100, w: 20, h: 40 },
          { frame: 1, x: 101, y: 101, w: 20, h: 40 },
          { frame: 2, x: 102, y: 102, w: 20, h: 40 },
          { frame: 3, x: 103, y: 103, w: 20, h: 40 },
          { frame: 4, x: 104, y: 104, w: 20, h: 40 },
        ],
      }],
    }],
  });
}

function makeFfmpegChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function mockSuccessfulFrameCapture(bytes = Buffer.from([0xff, 0xd8, 0xff])) {
  const child = makeFfmpegChild();
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.end(bytes);
      child.emit("close", 0);
    });
    return child;
  });
}

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("admin recording tracker debug API", () => {
  it("returns 403 to a non-admin", async () => {
    getLocalUserIdMock.mockResolvedValueOnce(nonAdminId);
    const response = await request(app)
      .get(`/api/admin/recordings/${recordingId}/debug/window?from=0&to=1`);
    expect(response.status).toBe(403);
  });

  it("returns window metadata, sidecar samples, claimant parts, and thinned boxes", async () => {
    getLocalUserIdMock.mockResolvedValueOnce(adminId);
    setPlayFixture();
    const response = await request(app)
      .get(`/api/admin/recordings/${recordingId}/debug/window?from=0&to=1`);

    expect(response.status).toBe(200);
    expect(response.body.manifest).toMatchObject({ fps, width: 3840, height: 1080, duration: 3 });
    expect(response.body.videoUrl).toContain("vz-test.b-cdn.net");
    expect(response.body.ball).toEqual([[0, 100, 200, false], [1, 110, 210, false]]);
    expect(response.body.touches).toEqual([[1, 10, 20, 30, 40, 25, 35, 1.5]]);
    expect(response.body.claims).toEqual([{
      identityId: identityId(),
      userId: playerId,
      userName: `${TAG} Player`,
      color: expect.any(String),
      parts: [{ trackId: "s0:t1", fromFrame: 0, toFrame: 5 }],
    }]);
    expect(response.body.boxes[0]).toMatchObject({
      identityId: identityId(),
      userName: `${TAG} Player`,
      trackId: "s0:t1",
    });
    expect(response.body.boxes[0].boxes.length).toBeLessThanOrEqual(4);
  });

  it("returns 404 for the frame endpoint when the recording has no bundle", async () => {
    await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    getLocalUserIdMock.mockResolvedValueOnce(adminId);
    const response = await request(app)
      .get(`/api/admin/recordings/${recordingId}/debug/frame?t=1`);
    expect(response.status).toBe(404);
    await db.insert(recordingTrackingBundlesTable).values({ recordingId, manifest });
  });

  it("seeks the video by vo while drawing the overlays at t", async () => {
    getLocalUserIdMock.mockResolvedValueOnce(adminId);
    setPlayFixture();
    manifest.videoStartSeconds = 10;
    const renditionUrl = "https://vz-test.b-cdn.net/12345678-abcd/2160p/video.m3u8";
    selectExportSourceMock.mockResolvedValueOnce({
      url: renditionUrl,
      path: "resolution-matched HLS variant",
      width: 3840,
      height: 1080,
      renditionLabel: "2160p",
    });
    mockSuccessfulFrameCapture();

    const response = await request(app)
      .get(`/api/admin/recordings/${recordingId}/debug/frame?t=1&vo=0.5`);
    manifest.videoStartSeconds = 0;

    expect(response.status).toBe(200);
    const args = spawnMock.mock.calls[0][1] as string[];
    const inputIndex = args.indexOf("-i");
    const firstSeekIndex = args.indexOf("-ss");
    const secondSeekIndex = args.indexOf("-ss", firstSeekIndex + 1);
    expect(args.slice(firstSeekIndex, firstSeekIndex + 2)).toEqual(["-ss", "5.5"]);
    expect(args.slice(secondSeekIndex, secondSeekIndex + 2)).toEqual(["-ss", "6"]);
    expect(firstSeekIndex).toBeLessThan(inputIndex);
    expect(secondSeekIndex).toBeGreaterThan(inputIndex);
    expect(args.slice(args.indexOf("-headers"), args.indexOf("-headers") + 2))
      .toEqual(["-headers", "Referer: https://iframe.mediadelivery.net/\r\n"]);
    expect(args[inputIndex + 1]).toBe(renditionUrl);
    expect(selectExportSourceMock).toHaveBeenCalledWith({
      videoId: "12345678-abcd",
      hasMP4Fallback: false,
      availableResolutions: "1080p",
      referer: "https://iframe.mediadelivery.net/",
    });
    expect(args.join(" ")).toContain("drawbox=x=47:y=97");
    expect(args.join(" ")).toContain("drawbox=x=51:y=51");
  });

  it("reuses a captured frame for ten minutes, then captures it again", async () => {
    spawnMock.mockReset();
    selectExportSourceMock.mockReset();
    getLocalUserIdMock.mockResolvedValue(adminId);
    setPlayFixture();
    selectExportSourceMock.mockResolvedValue({
      url: "https://vz-test.b-cdn.net/12345678-abcd/2160p/video.m3u8",
      path: "resolution-matched HLS variant",
      width: 3840,
      height: 1080,
      renditionLabel: "2160p",
    });
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const path = `/api/admin/recordings/${recordingId}/debug/frame?t=1&ball=0&claims=0`;
    mockSuccessfulFrameCapture();
    mockSuccessfulFrameCapture();

    try {
      const first = await request(app).get(path);
      const cached = await request(app).get(path);
      expect(first.status).toBe(200);
      expect(cached.status).toBe(200);
      expect(cached.body).toEqual(first.body);
      expect(cached.headers["cache-control"]).toBe("private, max-age=600");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(selectExportSourceMock).toHaveBeenCalledTimes(1);

      dateNow.mockImplementation(() => now + 10 * 60 * 1000 + 1);
      const expired = await request(app).get(path);
      expect(expired.status).toBe(200);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(selectExportSourceMock).toHaveBeenCalledTimes(2);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("limits concurrent FFmpeg frame grabs to two", async () => {
    spawnMock.mockReset();
    selectExportSourceMock.mockReset();
    getLocalUserIdMock.mockResolvedValue(adminId);
    setPlayFixture();
    selectExportSourceMock.mockResolvedValue({
      url: "https://vz-test.b-cdn.net/12345678-abcd/2160p/video.m3u8",
      path: "resolution-matched HLS variant",
      width: 3840,
      height: 1080,
      renditionLabel: "2160p",
    });

    let active = 0;
    let maxActive = 0;
    const pending: Array<{ child: ReturnType<typeof makeFfmpegChild>; release: () => void }> = [];
    spawnMock.mockImplementation(() => {
      const child = makeFfmpegChild();
      active++;
      maxActive = Math.max(maxActive, active);
      let released = false;
      pending.push({
        child,
        release: () => {
          if (released) return;
          released = true;
          active--;
          child.stdout.end(Buffer.from([0xff, 0xd8, 0xff]));
          child.emit("close", 0);
        },
      });
      return child;
    });

    const paths = [0.1, 0.2, 0.3].map((time) =>
      `/api/admin/recordings/${recordingId}/debug/frame?t=${time}&ball=0&claims=0`,
    );
    const responses = paths.map((path) => request(app).get(path).then((response) => response));

    try {
      await waitFor(() => selectExportSourceMock.mock.calls.length === 3, "all three rendition resolutions");
      await waitFor(() => spawnMock.mock.calls.length === 2, "the first two FFmpeg grabs");
      expect(maxActive).toBe(2);
      pending[0]!.release();
      await waitFor(() => spawnMock.mock.calls.length === 3, "the queued FFmpeg grab");
      expect(maxActive).toBe(2);
      pending[1]!.release();
      pending[2]!.release();

      const results = await Promise.all(responses);
      expect(results.map((response) => response.status)).toEqual([200, 200, 200]);
      expect(maxActive).toBe(2);
    } finally {
      pending.forEach(({ release }) => release());
    }
  });

  it("rejects video offsets outside the supported range", async () => {
    getLocalUserIdMock.mockResolvedValueOnce(adminId);
    const response = await request(app)
      .get(`/api/admin/recordings/${recordingId}/debug/frame?t=1&vo=5.01`);
    expect(response.status).toBe(400);
  });

  it("clamps requested crop rectangles inside the 3840×1080 source", () => {
    expect(clampCropRect({ cx: -50, cy: 1200, w: 100, h: 100 })).toEqual({
      x: 0, y: 980, width: 100, height: 100,
    });
    expect(clampCropRect({ cx: 0, cy: 0, w: 9000, h: 9000 })).toEqual({
      x: 0, y: 0, width: 3840, height: 1080,
    });
  });

  it("uses a mocked ffmpeg process and returns its JPEG bytes", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    spawnMock.mockReturnValueOnce(child);
    const output = runFfmpeg(["-nostdin", "-ss", "1", "-i", "fixture.m3u8", "-frames:v", "1"]);
    child.stdout.write(Buffer.from([0xff, 0xd8, 0xff]));
    child.emit("close", 0);
    await expect(output).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(spawnMock).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(["-nostdin", "-frames:v", "1"]), {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});
