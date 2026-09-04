import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  fieldsTable,
  recordingsTable,
  usersTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  claimMatchProgressTable,
  claimMatchIdentityBindingsTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(),
}));

import { getLocalUserRecord } from "../lib/clerkUserBridge";

const mockedGetLocalUserRecord = vi.mocked(getLocalUserRecord);
const TEST_TAG = `field-recordings-${Date.now()}`;
let app: Express;
let fieldId: number;
let viewerId: number;
let recordingIds: number[] = [];
let bundleIds: number[] = [];

beforeAll(async () => {
  const [{ default: fieldsRouter }] = await Promise.all([
    import("./fields"),
  ]);
  app = express();
  app.use(express.json());
  app.use("/api", fieldsRouter);

  const [field] = await db
    .insert(fieldsTable)
    .values({ name: `Claim field ${TEST_TAG}`, location: "Test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;

  const [viewer] = await db
    .insert(usersTable)
    .values({
      name: `Claim viewer ${TEST_TAG}`,
      email: `${TEST_TAG}@test.local`,
      isGuest: false,
      profileComplete: true,
    })
    .returning({ id: usersTable.id });
  viewerId = viewer.id;

  const recordings = await db
    .insert(recordingsTable)
    .values([
      {
        fieldId,
        court: "1",
        date: "2026-09-01",
        timeSlot: "10:00",
        duration: "00:30:00",
        videoUrl: "https://example.test/no-tracking.m3u8",
        isVisible: true,
      },
      {
        fieldId,
        court: "2",
        date: "2026-09-02",
        timeSlot: "11:00",
        duration: "00:30:00",
        videoUrl: "https://example.test/tracked.m3u8",
        isVisible: true,
      },
      {
        fieldId,
        court: "3",
        date: "2026-09-03",
        timeSlot: "12:00",
        duration: "00:30:00",
        videoUrl: "https://example.test/progress.m3u8",
        isVisible: true,
      },
      {
        fieldId,
        court: "4",
        date: "2026-09-04",
        timeSlot: "13:00",
        duration: "00:30:00",
        videoUrl: "https://example.test/empty-bundle.m3u8",
        isVisible: true,
      },
    ])
    .returning({ id: recordingsTable.id });
  recordingIds = recordings.map((recording) => recording.id);

  const bundles = await db
    .insert(recordingTrackingBundlesTable)
    .values(
      recordingIds.slice(1).map((recordingId) => ({
        recordingId,
        manifest: {
          version: 1,
          label: "test",
          width: 1920,
          height: 1080,
          frameRate: 25,
          frameCount: 750,
          duration: 30,
          matchOffset: 0,
          videoStartSeconds: 0,
          segmentCount: 1,
          segments: [],
        },
        uploadedBy: viewerId,
      })),
    )
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleIds = bundles.map((bundle) => bundle.id);

  // Bundles 0 and 1 get a real stored segment; the last one deliberately gets
  // none. A manifest that claims segments but has nothing stored is exactly the
  // shape a half-uploaded or malformed zip leaves behind, and it must not offer
  // the claim entry point.
  await db.insert(recordingTrackingSegmentsTable).values(
    bundleIds.slice(0, 2).map((bundleId) => ({
      bundleId,
      segmentIndex: 0,
      name: "segment-000",
      startFrame: 0,
      endFrame: 749,
      startSeconds: 0,
      endSeconds: 30,
      objectPath: `tracking/${bundleId}/segment-000.json.gz`,
      compressedBytes: 1024,
      trackCount: 4,
      crossingCount: 0,
    })),
  );

  await db.insert(claimMatchIdentityBindingsTable).values({
    userId: viewerId,
    recordingId: recordingIds[1],
    trackingBundleId: bundleIds[0],
    bundleFingerprint: "tracked-fingerprint",
    personId: "player-1",
    personParts: ["player-1"],
    vouchedFragments: [],
    resolutionMethod: "track-fallback",
    state: "confirmed",
    resolvedAt: new Date(),
  });

  await db.insert(claimMatchProgressTable).values({
    userId: viewerId,
    recordingId: recordingIds[2],
    stage: "picker",
    correctionCount: 1,
    claimedPercent: 12,
  });
});

beforeEach(() => {
  mockedGetLocalUserRecord.mockResolvedValue({ id: viewerId, isGuest: false } as Awaited<ReturnType<typeof getLocalUserRecord>>);
});

afterAll(async () => {
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.userId, viewerId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.userId, viewerId));
  if (bundleIds.length) {
    await db
      .delete(recordingTrackingSegmentsTable)
      .where(inArray(recordingTrackingSegmentsTable.bundleId, bundleIds));
    await db.delete(recordingTrackingBundlesTable).where(inArray(recordingTrackingBundlesTable.id, bundleIds));
  }
  if (recordingIds.length) {
    await db.delete(recordingsTable).where(inArray(recordingsTable.id, recordingIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, viewerId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("GET /api/fields/:id/recordings", () => {
  it("returns tracking availability and the viewer's own claim state", async () => {
    const response = await request(app).get(`/api/fields/${fieldId}/recordings`).expect(200);

    expect(response.body).toHaveLength(4);
    expect(response.body.find((recording: { id: number }) => recording.id === recordingIds[0]))
      .toMatchObject({
        hasTracking: false,
        viewerHasClaim: false,
        viewerClaimState: null,
      });
    expect(response.body.find((recording: { id: number }) => recording.id === recordingIds[1]))
      .toMatchObject({
        hasTracking: true,
        viewerHasClaim: true,
        viewerClaimState: "confirmed",
      });
    expect(response.body.find((recording: { id: number }) => recording.id === recordingIds[2]))
      .toMatchObject({
        hasTracking: true,
        viewerHasClaim: false,
        viewerClaimState: "in_progress",
      });
  });

  it("does not report tracking for a bundle that stored no segments", async () => {
    const response = await request(app).get(`/api/fields/${fieldId}/recordings`).expect(200);
    const emptyBundle = response.body.find(
      (recording: { id: number }) => recording.id === recordingIds[3],
    );

    expect(emptyBundle).toMatchObject({ hasTracking: false });
  });

  it("does not expose viewer claim state to a guest", async () => {
    mockedGetLocalUserRecord.mockResolvedValue({ id: viewerId, isGuest: true } as Awaited<ReturnType<typeof getLocalUserRecord>>);

    const response = await request(app).get(`/api/fields/${fieldId}/recordings`).expect(200);
    const tracked = response.body.find((recording: { id: number }) => recording.id === recordingIds[1]);

    expect(tracked).toMatchObject({
      hasTracking: true,
      viewerHasClaim: false,
      viewerClaimState: null,
    });
  });
});