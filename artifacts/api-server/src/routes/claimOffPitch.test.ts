import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  normaliseOffPitchSpans,
  offPitchConflicts,
  subtractSpans,
  totalSeconds,
} from "./claimOffPitch";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(),
}));

import { getLocalAccountUserId } from "../lib/clerkUserBridge";
import {
  db,
  claimMatchCorrectionsTable,
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  fieldsTable,
  recordingTrackingBundlesTable,
  recordingSchedulesTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";

const mockedGetLocalAccountUserId = vi.mocked(getLocalAccountUserId);
let app: Express;
let fieldId: number;
let userId: number;
let otherUserId: number;
let recordingId: number;
let bundleId: number;

beforeAll(async () => {
  const { default: router } = await import("./claimOffPitch");
  app = express();
  app.use(express.json());
  app.use("/api", router);
  const [field] = await db.insert(fieldsTable).values({
    name: `Off-pitch test field ${Date.now()}`,
    location: "Test",
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [user] = await db.insert(usersTable).values({
    name: "Off-pitch test user",
    email: `off-pitch-${Date.now()}@test.local`,
    isGuest: false,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  userId = user.id;
  const [otherUser] = await db.insert(usersTable).values({
    name: "Other off-pitch test user",
    email: `off-pitch-other-${Date.now()}@test.local`,
    isGuest: false,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  otherUserId = otherUser.id;
  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-03",
    timeSlot: "10:00",
    duration: "00:01:40",
    videoUrl: "https://example.test/tracked.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(recordingSchedulesTable).values({
    fieldId,
    allowedDate: "2026-09-03",
    startTime: "00:00",
    endTime: "23:59",
    label: "Test visibility",
  });
  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId,
    uploadedBy: userId,
    manifest: {
      version: 1,
      label: "off-pitch test",
      width: 1920,
      height: 1080,
      frameRate: 1,
      frameCount: 100,
      duration: 100,
      matchOffset: 0,
      videoStartSeconds: 0,
      segmentCount: 1,
      segments: [{
        index: 0,
        name: "only",
        startFrame: 0,
        endFrame: 99,
        startSeconds: 0,
        endSeconds: 100,
        objectPath: "",
      }],
    },
  }).returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
});

beforeEach(async () => {
  mockedGetLocalAccountUserId.mockResolvedValue(userId);
  await db.delete(claimMatchOffPitchSpansTable).where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId));
  await db.delete(claimMatchCorrectionsTable).where(eq(claimMatchCorrectionsTable.recordingId, recordingId));
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
});

afterAll(async () => {
  await db.delete(claimMatchOffPitchSpansTable).where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId));
  await db.delete(claimMatchCorrectionsTable).where(eq(claimMatchCorrectionsTable.recordingId, recordingId));
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(usersTable).where(eq(usersTable.id, otherUserId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("claim match off-pitch intervals", () => {
  it("clamps, removes invalid spans, sorts, and merges touching intervals", () => {
    expect(normaliseOffPitchSpans([
      { fromSeconds: 9, toSeconds: 12 },
      { fromSeconds: 2, toSeconds: 4 },
      { fromSeconds: 4, toSeconds: 6 },
      { fromSeconds: -2, toSeconds: 1 },
      { fromSeconds: 7, toSeconds: 7 },
      { fromSeconds: Number.NaN, toSeconds: 8 },
      { fromSeconds: 90, toSeconds: 120 },
    ], 100)).toEqual([
      { fromSeconds: 0, toSeconds: 1 },
      { fromSeconds: 2, toSeconds: 6 },
      { fromSeconds: 9, toSeconds: 12 },
      { fromSeconds: 90, toSeconds: 100 },
    ]);
  });

  it("subtracts half-open exclusions without changing tracking-time coordinates", () => {
    expect(subtractSpans(
      [{ fromSeconds: 0, toSeconds: 20 }],
      [{ fromSeconds: 5, toSeconds: 10 }, { fromSeconds: 15, toSeconds: 25 }],
    )).toEqual([
      { fromSeconds: 0, toSeconds: 5 },
      { fromSeconds: 10, toSeconds: 15 },
    ]);
    expect(subtractSpans(
      [{ fromSeconds: 0, toSeconds: 5 }],
      [{ fromSeconds: 5, toSeconds: 8 }],
    )).toEqual([{ fromSeconds: 0, toSeconds: 5 }]);
  });

  it("sums valid spans and detects only positive overlap", () => {
    expect(totalSeconds([
      { fromSeconds: 0, toSeconds: 2.125 },
      { fromSeconds: 4, toSeconds: 7.126 },
      { fromSeconds: 8, toSeconds: 8 },
    ])).toBe(5.25);
    expect(offPitchConflicts(
      [{ fromSeconds: 10, toSeconds: 20 }, { fromSeconds: 30, toSeconds: 40 }],
      { fromSeconds: 20, toSeconds: 30 },
    )).toEqual([]);
    expect(offPitchConflicts(
      [{ fromSeconds: 10, toSeconds: 20 }],
      { fromSeconds: 19.5, toSeconds: 21 },
    )).toEqual([{ fromSeconds: 10, toSeconds: 20 }]);
  });
});

describe("claim match off-pitch endpoints", () => {
  it("persists a clamped span and returns the original row for an idempotent replay", async () => {
    const first = await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/off-pitch`)
      .send({ clientId: "same-client", fromSeconds: 90, toSeconds: 120 })
      .expect(201);
    expect(first.body).toMatchObject({
      clientId: "same-client",
      fromSeconds: 90,
      toSeconds: 100,
    });

    const replay = await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/off-pitch`)
      .send({ clientId: "same-client", fromSeconds: 10, toSeconds: 20 })
      .expect(200);
    expect(replay.body).toEqual(first.body);
  });

  it("does not compare against another user's vouched fragment", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId: otherUserId,
      recordingId,
      trackingBundleId: bundleId,
      bundleFingerprint: "other-user",
      personId: "other-player",
      personParts: [],
      vouchedFragments: [{ trackId: "other-player", fromFrame: 20, toFrame: 30 }],
      resolutionMethod: "track-fallback",
      state: "confirmed",
      resolvedAt: new Date(),
    });
    mockedGetLocalAccountUserId.mockResolvedValue(userId);
    await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/off-pitch`)
      .send({ clientId: "different-player", fromSeconds: 20, toSeconds: 30 })
      .expect(201);
    const [otherBinding] = await db
      .select({ vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.userId, otherUserId));
    expect(otherBinding?.vouchedFragments).toEqual([
      { trackId: "other-player", fromFrame: 20, toFrame: 30 },
    ]);
  });

  it("reports only the user's overlapping range without identity metadata", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId,
      recordingId,
      trackingBundleId: bundleId,
      bundleFingerprint: "test",
      personId: "player-1",
      personParts: [],
      vouchedFragments: [{ trackId: "player-1", fromFrame: 20, toFrame: 30 }],
      resolutionMethod: "track-fallback",
      supportCount: 1,
      acceptedAnswerCount: 1,
      supportPercent: 100,
      state: "confirmed",
      resolvedAt: new Date(),
    });
    const path = `/api/recordings/${recordingId}/claim-match/off-pitch`;
    const response = await request(app)
      .post(path)
      .send({ clientId: "conflict-client", fromSeconds: 25, toSeconds: 35 })
      .expect(409);
    expect(response.body.conflicts).toEqual([{ fromSeconds: 25, toSeconds: 31 }]);
    expect(JSON.stringify(response.body)).not.toContain("userId");
    expect(JSON.stringify(response.body)).not.toContain("personId");
    expect(JSON.stringify(response.body)).not.toContain("bindingId");
    const [notWritten] = await db
      .select()
      .from(claimMatchOffPitchSpansTable)
      .where(eq(claimMatchOffPitchSpansTable.clientId, "conflict-client"));
    expect(notWritten).toBeUndefined();
  });

  it("trims the user's vouched fragment when the conflict is confirmed", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId,
      recordingId,
      trackingBundleId: bundleId,
      bundleFingerprint: "trim",
      personId: "player-1",
      personParts: [],
      vouchedFragments: [{ trackId: "player-1", fromFrame: 20, toFrame: 30 }],
      resolutionMethod: "track-fallback",
      state: "confirmed",
      resolvedAt: new Date(),
    });
    const path = `/api/recordings/${recordingId}/claim-match/off-pitch`;
    await request(app)
      .post(path)
      .send({ clientId: "conflict-client", fromSeconds: 25, toSeconds: 35, confirmConflict: true })
      .expect(201);
    const [binding] = await db
      .select({
        state: claimMatchIdentityBindingsTable.state,
        vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
      })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.userId, userId));
    expect(binding).toEqual({
      state: "confirmed",
      vouchedFragments: [{ trackId: "player-1", fromFrame: 20, toFrame: 24 }],
    });
  });

  it("splits a vouched fragment that straddles the confirmed period", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId,
      recordingId,
      trackingBundleId: bundleId,
      bundleFingerprint: "split",
      personId: "player-1",
      personParts: [],
      vouchedFragments: [{ trackId: "player-1", fromFrame: 10, toFrame: 40 }],
      resolutionMethod: "track-fallback",
      state: "confirmed",
      resolvedAt: new Date(),
    });
    await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/off-pitch`)
      .send({ clientId: "split-client", fromSeconds: 20, toSeconds: 30, confirmConflict: true })
      .expect(201);
    const [binding] = await db
      .select({ vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.userId, userId));
    expect(binding?.vouchedFragments).toEqual([
      { trackId: "player-1", fromFrame: 10, toFrame: 19 },
      { trackId: "player-1", fromFrame: 30, toFrame: 40 },
    ]);
  });

  it("releases a binding when its only vouched fragment is removed", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId,
      recordingId,
      trackingBundleId: bundleId,
      bundleFingerprint: "release",
      personId: "player-1",
      personParts: [],
      vouchedFragments: [{ trackId: "player-1", fromFrame: 20, toFrame: 30 }],
      resolutionMethod: "track-fallback",
      state: "confirmed",
      resolvedAt: new Date(),
    });
    await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/off-pitch`)
      .send({ clientId: "release-client", fromSeconds: 15, toSeconds: 35, confirmConflict: true })
      .expect(201);
    const [binding] = await db
      .select({
        state: claimMatchIdentityBindingsTable.state,
        vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
      })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.userId, userId));
    expect(binding).toEqual({ state: "released", vouchedFragments: [] });
  });

  it("reports and undoes only the user's accepted corrections inside the period", async () => {
    const correctionValues = [
      {
        userId,
        clientId: "inside-correction",
        momentSeconds: 25,
        chosenTrackId: "player-1",
      },
      {
        userId,
        clientId: "outside-correction",
        momentSeconds: 50,
        chosenTrackId: "player-1",
      },
      {
        userId: otherUserId,
        clientId: "other-correction",
        momentSeconds: 25,
        chosenTrackId: "other-player",
      },
    ];
    await db.insert(claimMatchCorrectionsTable).values(correctionValues.map((value) => ({
      ...value,
      recordingId,
      rejectedTrackId: null,
      answerMethod: "anchor-yes",
      questionCount: 1,
    })));
    const path = `/api/recordings/${recordingId}/claim-match/off-pitch`;
    const warning = await request(app)
      .post(path)
      .send({ clientId: "correction-client", fromSeconds: 20, toSeconds: 30 })
      .expect(409);
    expect(warning.body.correctionCount).toBe(1);
    await request(app)
      .post(path)
      .send({ clientId: "correction-client", fromSeconds: 20, toSeconds: 30, confirmConflict: true })
      .expect(201);
    const corrections = await db
      .select({
        userId: claimMatchCorrectionsTable.userId,
        clientId: claimMatchCorrectionsTable.clientId,
        undone: claimMatchCorrectionsTable.undone,
      })
      .from(claimMatchCorrectionsTable)
      .where(eq(claimMatchCorrectionsTable.recordingId, recordingId));
    expect(corrections).toEqual(expect.arrayContaining([
      { userId, clientId: "inside-correction", undone: true },
      { userId, clientId: "outside-correction", undone: false },
      { userId: otherUserId, clientId: "other-correction", undone: false },
    ]));
  });

  it("supports deletion after a confirmed conflict", async () => {
    await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/off-pitch`)
      .send({ clientId: "delete-client", fromSeconds: 10, toSeconds: 20 })
      .expect(201);
    await request(app)
      .delete(`/api/recordings/${recordingId}/claim-match/off-pitch/delete-client`)
      .expect(200, { deleted: true, clientId: "delete-client" });
    const [remaining] = await db
      .select()
      .from(claimMatchOffPitchSpansTable)
      .where(and(
        eq(claimMatchOffPitchSpansTable.userId, userId),
        eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
      ));
    expect(remaining).toBeUndefined();
  });

  it("does not allow another account to delete the claimant's span", async () => {
    const path = `/api/recordings/${recordingId}/claim-match/off-pitch`;
    await request(app)
      .post(path)
      .send({ clientId: "private-client", fromSeconds: 10, toSeconds: 20 })
      .expect(201);

    mockedGetLocalAccountUserId.mockResolvedValue(otherUserId);
    await request(app)
      .delete(`${path}/private-client`)
      .expect(404);
    mockedGetLocalAccountUserId.mockResolvedValue(userId);
    const [remaining] = await db
      .select()
      .from(claimMatchOffPitchSpansTable)
      .where(eq(claimMatchOffPitchSpansTable.clientId, "private-client"));
    expect(remaining?.userId).toBe(userId);
  });
});