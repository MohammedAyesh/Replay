import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";

const segment = {
  version: 1,
  segmentIndex: 0,
  name: "stats-test",
  startFrame: 0,
  endFrame: 9,
  startSeconds: 0,
  endSeconds: 10,
  tracks: [{
    id: "player-1",
    startFrame: 0,
    endFrame: 9,
    boxes: Array.from({ length: 10 }, (_, frame) => ({
      frame,
      x: 100 + frame,
      y: 200,
      w: 40,
      h: 80,
    })),
  }],
  crossings: [],
  inPlaySpans: [],
  events: [],
};

vi.mock("../lib/claimMatchStorage", () => ({
  readClaimSegment: vi.fn(async () => Buffer.from(JSON.stringify(segment))),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
  deleteClaimSegment: vi.fn(),
}));

import {
  db,
  claimMatchCorrectionsTable,
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  fieldsTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingSchedulesTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";
import { readClaimSegment } from "../lib/claimMatchStorage";

const readClaimSegmentMock = vi.mocked(readClaimSegment);

let app: Express;
let userId: number;
let emptyUserId: number;
let fieldId: number;
let recordingId: number;
let disputedRecordingId: number;
let invisibleRecordingId: number;
let bundleId: number;
let disputedBundleId: number;
let invisibleBundleId: number;

const manifest = {
  version: 1,
  label: "stats test",
  width: 1920,
  height: 1080,
  frameRate: 1,
  frameCount: 10,
  duration: 10,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [{
    index: 0,
    name: "stats-test",
    startFrame: 0,
    endFrame: 9,
    startSeconds: 0,
    endSeconds: 10,
    objectPath: "/objects/stats-test",
  }],
  summary: {
    segments: [{
      segmentIndex: 0,
      name: "stats-test",
      startFrame: 0,
      endFrame: 9,
      startSeconds: 0,
      endSeconds: 10,
      tracks: [{ id: "player-1", startFrame: 0, endFrame: 9 }],
      events: [],
    }],
  },
};

beforeAll(async () => {
  const { default: router } = await import("./users");
  app = express();
  app.use(express.json());
  app.use("/api", router);

  const [field] = await db.insert(fieldsTable).values({
    name: `Player stats field ${Date.now()}`,
    location: "Test",
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  const [user] = await db.insert(usersTable).values({
    name: "Stats player",
    email: `stats-player-${Date.now()}@test.local`,
    isGuest: false,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  userId = user.id;

  const [emptyUser] = await db.insert(usersTable).values({
    name: "No confirmed stats player",
    email: `stats-empty-${Date.now()}@test.local`,
    isGuest: false,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  emptyUserId = emptyUser.id;

  await db.insert(recordingSchedulesTable).values({
    fieldId,
    allowedDate: "2026-09-03",
    startTime: "00:00",
    endTime: "23:59",
    label: "Stats test visibility",
  });

  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-03",
    timeSlot: "10:00",
    duration: "00:00:10",
    videoUrl: "https://example.test/stats.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;

  const [disputedRecording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "2",
    date: "2026-09-03",
    timeSlot: "11:00",
    duration: "00:00:10",
    videoUrl: "https://example.test/disputed.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  disputedRecordingId = disputedRecording.id;

  const [invisibleRecording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "3",
    date: "2026-09-04",
    timeSlot: "12:00",
    duration: "00:00:10",
    videoUrl: "https://example.test/invisible.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  invisibleRecordingId = invisibleRecording.id;

  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId,
    uploadedBy: userId,
    manifest,
  }).returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
  const [disputedBundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId: disputedRecordingId,
    uploadedBy: userId,
    manifest: { ...manifest, label: "disputed stats test" },
  }).returning({ id: recordingTrackingBundlesTable.id });
  disputedBundleId = disputedBundle.id;
  const [invisibleBundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId: invisibleRecordingId,
    uploadedBy: userId,
    manifest: { ...manifest, label: "invisible stats test" },
  }).returning({ id: recordingTrackingBundlesTable.id });
  invisibleBundleId = invisibleBundle.id;

  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId,
    segmentIndex: 0,
    name: "stats-test",
    startFrame: 0,
    endFrame: 9,
    startSeconds: 0,
    endSeconds: 10,
    objectPath: "/objects/stats-test",
    compressedBytes: 0,
    trackCount: 1,
    crossingCount: 0,
  });

  await db.insert(claimMatchCorrectionsTable).values({
    userId,
    recordingId,
    clientId: "stats-answer",
    momentSeconds: 5,
    rejectedTrackId: null,
    chosenTrackId: "player-1",
    answerMethod: "anchor-yes",
    questionCount: 1,
    undone: false,
  });
  await db.insert(claimMatchOffPitchSpansTable).values({
    userId,
    recordingId,
    clientId: "stats-off-pitch",
    fromSeconds: 0,
    toSeconds: 5,
  });
  await db.insert(claimMatchIdentityBindingsTable).values({
    userId,
    recordingId,
    personId: "player-1",
    trackingBundleId: bundleId,
    bundleFingerprint: "stats-fingerprint",
    personParts: ["player-1"],
    vouchedFragments: [{ trackId: "player-1", fromFrame: 0, toFrame: 9 }],
    resolutionMethod: "track-fallback",
    supportCount: 1,
    acceptedAnswerCount: 1,
    supportPercent: 100,
    state: "confirmed",
    resolvedAt: new Date(),
  });
  await db.insert(claimMatchIdentityBindingsTable).values({
    userId,
    recordingId: disputedRecordingId,
    personId: "disputed-player",
    trackingBundleId: disputedBundleId,
    bundleFingerprint: "disputed-fingerprint",
    personParts: ["disputed-player"],
    vouchedFragments: [],
    resolutionMethod: "track-fallback",
    supportCount: 1,
    acceptedAnswerCount: 1,
    supportPercent: 100,
    state: "disputed",
  });
  await db.insert(claimMatchIdentityBindingsTable).values({
    userId,
    recordingId: invisibleRecordingId,
    personId: "invisible-player",
    trackingBundleId: invisibleBundleId,
    bundleFingerprint: "invisible-fingerprint",
    personParts: ["invisible-player"],
    vouchedFragments: [],
    resolutionMethod: "track-fallback",
    supportCount: 1,
    acceptedAnswerCount: 1,
    supportPercent: 100,
    state: "confirmed",
    computedStats: {
      minutesPlayed: 99,
      distanceMetres: 123,
      humanVouchedSeconds: 99,
      inferredSeconds: 0,
      offPitchSeconds: 0,
      heatmap: { coordinateSpace: "camera", cells: [] },
    },
    statsComputedAt: new Date(),
    statsInputFingerprint: "already-cached",
  });
});

afterAll(async () => {
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.userId, userId));
  await db.delete(claimMatchOffPitchSpansTable).where(eq(claimMatchOffPitchSpansTable.userId, userId));
  await db.delete(claimMatchCorrectionsTable).where(eq(claimMatchCorrectionsTable.userId, userId));
  await db.delete(recordingTrackingSegmentsTable).where(eq(recordingTrackingSegmentsTable.bundleId, bundleId));
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, bundleId));
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, disputedBundleId));
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, invisibleBundleId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, disputedRecordingId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, invisibleRecordingId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await db.delete(usersTable).where(eq(usersTable.id, emptyUserId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("public player stats", () => {
  it("counts confirmed claims, excludes disputed claims, removes off-pitch time, and preserves null distance", async () => {
    const response = await request(app).get(`/api/users/${userId}/stats`);

    expect(response.status).toBe(200);
    expect(response.body.excludedClaimCount).toBe(1);
    expect(response.body.totals.totalMatchesClaimed).toBe(1);
    expect(response.body.matches).toHaveLength(1);
    expect(response.body.matches[0]).toMatchObject({
      recordingId,
      minutesPlayed: 0.08,
      distanceMetres: null,
      humanVouchedSeconds: 5,
      inferredSeconds: 0,
      offPitchSeconds: 5,
      heatmap: { coordinateSpace: "camera" },
    });
    expect(response.body.matches.map((match: { recordingId: number }) => match.recordingId))
      .not.toContain(invisibleRecordingId);
  });

  it("serves the second request from the binding cache without object-storage reads", async () => {
    await db
      .update(claimMatchIdentityBindingsTable)
      .set({
        computedStats: null,
        statsComputedAt: null,
        statsInputFingerprint: null,
      })
      .where(and(
        eq(claimMatchIdentityBindingsTable.userId, userId),
        eq(claimMatchIdentityBindingsTable.recordingId, recordingId),
      ));
    readClaimSegmentMock.mockClear();
    const first = await request(app).get(`/api/users/${userId}/stats`);
    const readsAfterFirst = readClaimSegmentMock.mock.calls.length;
    const second = await request(app).get(`/api/users/${userId}/stats`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(readClaimSegmentMock).toHaveBeenCalledTimes(readsAfterFirst);
    expect(second.body).toEqual(first.body);
  });

  it("recomputes after an off-pitch period changes the fingerprint", async () => {
    const before = await request(app).get(`/api/users/${userId}/stats`);
    const [visibleSpan] = await db
      .select()
      .from(claimMatchOffPitchSpansTable)
      .where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId));
    await db.insert(claimMatchOffPitchSpansTable).values({
      userId,
      recordingId,
      clientId: "stats-off-pitch-extra",
      fromSeconds: 5,
      toSeconds: 7,
    });
    const after = await request(app).get(`/api/users/${userId}/stats`);

    expect(after.body.matches[0].minutesPlayed).toBeLessThan(before.body.matches[0].minutesPlayed);
    expect(after.body.matches[0].offPitchSeconds).toBe(7);
    expect(visibleSpan).toBeDefined();
  });

  it("recomputes after a correction is undone", async () => {
    await db
      .delete(claimMatchOffPitchSpansTable)
      .where(and(
        eq(claimMatchOffPitchSpansTable.userId, userId),
        eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
        eq(claimMatchOffPitchSpansTable.clientId, "stats-off-pitch-extra"),
      ));
    await db
      .update(claimMatchCorrectionsTable)
      .set({ undone: false, updatedAt: new Date() })
      .where(eq(claimMatchCorrectionsTable.clientId, "stats-answer"));
    const before = await request(app).get(`/api/users/${userId}/stats`);
    const [correction] = await db
      .select()
      .from(claimMatchCorrectionsTable)
      .where(eq(claimMatchCorrectionsTable.clientId, "stats-answer"));
    await db
      .update(claimMatchCorrectionsTable)
      .set({ undone: true, updatedAt: new Date() })
      .where(eq(claimMatchCorrectionsTable.id, correction.id));
    const after = await request(app).get(`/api/users/${userId}/stats`);

    expect(before.body.matches[0].minutesPlayed).toBeGreaterThan(0);
    expect(after.body.matches[0].minutesPlayed).toBe(0);
    expect(after.body.matches[0].humanVouchedSeconds).toBe(0);
  });

  it("returns no zero-stat rows when the player has no confirmed claims", async () => {
    const response = await request(app).get(`/api/users/${emptyUserId}/stats`);

    expect(response.status).toBe(200);
    expect(response.body.matches).toEqual([]);
    expect(response.body.totals).toMatchObject({
      totalMatchesClaimed: 0,
      totalMinutesPlayed: 0,
      totalDistanceMetres: 0,
    });
  });
});