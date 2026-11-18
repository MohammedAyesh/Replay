import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import {
  academiesTable,
  academySessionsTable,
  analysisJobsTable,
  cameraKitsTable,
  db,
  fieldsTable,
  footageRequestsTable,
  recordingsTable,
  settingsRulesTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));

import { getLocalUserRecord } from "../lib/clerkUserBridge";
import ownerRouter, { refreshOwnerRequest, startCameraJob as startOwnerCameraJob } from "./owner";
import { startCameraJob as startFootageBookingCameraJob } from "../lib/footageBooking";
import { courtFromCamera, shouldAnalyseBooking } from "../lib/liveAnalysis";
import { invalidateSettingsCache } from "../lib/settings";

// A booking whose footage becomes ready must queue its analysis job (with the
// VPS job named, so the GPU worker uploads the bundle made during the match)
// exactly once, and only when "Analyse bookings during the match" is on.
const TAG = `live_${Date.now()}`;
const GUID_ON = "0f0e0d0c-0b0a-4908-8706-050403020100";
const GUID_OFF = "1f1e1d1c-1b1a-4918-8716-151413121110";
const GUID_REUSE_AUTO = "2f2e2d2c-2b2a-4928-8726-252423222120";
const GUID_REUSE_ADMIN = "3f3e3d3c-3b3a-4938-8736-353433323130";
const GUID_TRAINING = "4f4e4d4c-4b4a-4948-8746-454443424140";
const GUID_ACADEMY_MATCH = "5f5e5d5c-5b5a-4958-8756-555453525150";
const GUID_STREAMLESS = "6f6e5d4c-3b2a-4968-8766-656463626160";
let userId: number;
let adminId: number;
let fieldId: number;
let academyId: number;
let requestIds: number[] = [];
let kitIds: number[] = [];
let sessionIds: number[] = [];
let extraRecordingIds: number[] = [];
let extraJobIds: number[] = [];
let videoForJob = new Map<string, string>();
let streamlessJobs = new Set<string>();
let streamFetches: string[] = [];
let realFetch: typeof fetch;
let recordPosts: string[] = [];
let gapPullPosts: string[] = [];
let gapCoverageSeconds = 0;
let gapAvailabilityHasHour = false;
let app: Express;

async function setLive(on: boolean) {
  await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.scopeType, "field"),
    eq(settingsRulesTable.scopeId, fieldId), eq(settingsRulesTable.key, "stats.liveAnalysis")));
  if (on) {
    await db.insert(settingsRulesTable).values({ key: "stats.liveAnalysis", value: true, priority: 100,
      scopeType: "field", scopeId: fieldId });
  }
  invalidateSettingsCache();
}

async function booking(vpsJobId: string, status: "recording" | "failed" = "recording", academy = false) {
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: "cam1",
    requestedBy: userId,
    startLocal: "2020-01-02 22:00",
    endLocal: "2020-01-02 23:00",
    requestedSeconds: 3600,
    status,
    vpsJobId,
    rateFils: 0,
    ...(academy ? { academyId } : {}),
  }).returning();
  requestIds.push(row.id);
  return row;
}

async function academySession(row: Awaited<ReturnType<typeof booking>>, type: "training" | "match") {
  const [session] = await db.insert(academySessionsTable).values({
    academyId,
    type,
    startsAt: new Date("2020-01-02T22:00:00Z"),
    endsAt: new Date("2020-01-02T23:00:00Z"),
    location: "Test pitch",
    footageRequestId: row.id,
  }).returning({ id: academySessionsTable.id });
  sessionIds.push(session.id);
}

async function existingAnalysis(
  row: Awaited<ReturnType<typeof booking>>,
  videoId: string,
  params: Record<string, unknown>,
) {
  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "cam1",
    date: "2020-01-02",
    timeSlot: "22:00",
    duration: "60:00",
    videoUrl: `https://cdn.example.test/${videoId}/playlist.m3u8`,
    isVisible: true,
  }).returning();
  extraRecordingIds.push(recording.id);
  const [job] = await db.insert(analysisJobsTable).values({
    recordingId: recording.id,
    sourceRecordingIds: [recording.id],
    status: "succeeded",
    params,
  }).returning();
  extraJobIds.push(job.id);
  return { recording, job };
}

async function jobsFor(guid: string) {
  const recs = await db.select().from(recordingsTable).where(like(recordingsTable.videoUrl, `%/${guid}/%`));
  if (!recs.length) return { recs, jobs: [] as Array<typeof analysisJobsTable.$inferSelect> };
  const jobs = await db.select().from(analysisJobsTable)
    .where(inArray(analysisJobsTable.recordingId, recs.map((r) => r.id)));
  return { recs, jobs };
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://control.example.test";
  process.env.CONTABO_CONTROL_KEY = "test-key";
  const [u] = await db.insert(usersTable).values({ name: `Booker ${TAG}`, email: `${TAG}@test.local`,
    profileComplete: true }).returning({ id: usersTable.id });
  userId = u.id;
  const [admin] = await db.insert(usersTable).values({ name: `Admin ${TAG}`, email: `${TAG}-admin@test.local`,
    isAdmin: true, profileComplete: true }).returning({ id: usersTable.id });
  adminId = admin.id;
  const [f] = await db.insert(fieldsTable).values({ name: `Live Field ${TAG}`, location: "Test",
    cameraId: `live-camera-${TAG}` }).returning({ id: fieldsTable.id });
  fieldId = f.id;
  const [academy] = await db.insert(academiesTable).values({ name: `Live Academy ${TAG}`, fieldId })
    .returning({ id: academiesTable.id });
  academyId = academy.id;
  app = express();
  app.use(express.json());
  app.use("/api", ownerRouter);
  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("video.bunnycdn.com")) streamFetches.push(url);
    if (url.includes("/gapstore/") && url.includes("/coverage?")) {
      return new Response(JSON.stringify({ coveredSeconds: gapCoverageSeconds }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/sd/") && url.includes("/available?")) {
      return new Response(JSON.stringify({ hours: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/gapstore/") && url.includes("/available?")) {
      return new Response(JSON.stringify({ hours: gapAvailabilityHasHour ? [{ hour: 22 }] : [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/gapstore/") && url.includes("/pull?") && init?.method === "POST") {
      gapPullPosts.push(url);
      return new Response(JSON.stringify({ status: "scheduled", jobId: `gap-${gapPullPosts.length}` }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/record-hq/") && init?.method === "POST") {
      recordPosts.push(url);
      return new Response(JSON.stringify({ status: "scheduled", jobId: `posted-${recordPosts.length}` }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const m = /\/record-hq\/[^/]+\/([^/?]+)/.exec(url);
    if (m && videoForJob.has(m[1])) {
      return new Response(JSON.stringify({ status: "done", videoId: videoForJob.get(m[1]),
        streamless: streamlessJobs.has(m[1]),
        durationSeconds: 3600, updatedAt: new Date().toISOString() }),
      { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  });
});

beforeEach(() => {
  videoForJob = new Map();
  streamlessJobs = new Set();
  streamFetches = [];
  recordPosts = [];
  gapPullPosts = [];
  gapCoverageSeconds = 0;
  gapAvailabilityHasHour = false;
  vi.mocked(getLocalUserRecord).mockResolvedValue({
    id: adminId,
    isGuest: false,
    isAdmin: true,
  } as Awaited<ReturnType<typeof getLocalUserRecord>>);
});

afterAll(async () => {
  for (const guid of [GUID_ON, GUID_OFF, GUID_TRAINING, GUID_ACADEMY_MATCH, GUID_STREAMLESS]) {
    const { recs } = await jobsFor(guid);
    if (recs.length) {
      await db.delete(analysisJobsTable).where(inArray(analysisJobsTable.recordingId, recs.map((r) => r.id)));
      await db.delete(recordingsTable).where(inArray(recordingsTable.id, recs.map((r) => r.id)));
    }
  }
  if (kitIds.length) await db.delete(cameraKitsTable).where(inArray(cameraKitsTable.id, kitIds));
  if (extraJobIds.length) await db.delete(analysisJobsTable).where(inArray(analysisJobsTable.id, extraJobIds));
  if (extraRecordingIds.length) await db.delete(recordingsTable).where(inArray(recordingsTable.id, extraRecordingIds));
  if (sessionIds.length) await db.delete(academySessionsTable).where(inArray(academySessionsTable.id, sessionIds));
  if (requestIds.length) await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.scopeType, "field"), eq(settingsRulesTable.scopeId, fieldId)));
  invalidateSettingsCache();
  if (academyId) await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(inArray(usersTable.id, [userId, adminId]));
  vi.restoreAllMocks();
});

describe("analysing bookings during the match", () => {
  it("maps camera ids to the pipeline's court names", () => {
    expect(courtFromCamera("cam1")).toBe("cam1");
    expect(courtFromCamera("camera2")).toBe("cam2");
    expect(courtFromCamera("field-x")).toBe("field-x");
  });

  it("queues one analysis job naming the VPS job when the booking's footage is ready", async () => {
    await setLive(true);
    const row = await booking(`vps-on-${TAG}`);
    videoForJob.set(row.vpsJobId!, GUID_ON);

    await refreshOwnerRequest(row, "cam1");

    const [done] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, row.id));
    expect(done.status).toBe("ready");
    const { recs, jobs } = await jobsFor(GUID_ON);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ fieldId, court: "cam1", date: "2020-01-02", timeSlot: "22:00", isVisible: false });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ recordingId: recs[0].id, status: "queued", matchStartSeconds: 0 });
    expect(jobs[0].sourceRecordingIds).toEqual([recs[0].id]);
    expect(jobs[0].params).toMatchObject({ liveJob: row.vpsJobId, footageRequestId: row.id });
    expect(jobs[0].params).not.toHaveProperty("training");

    // a later refresh of the same (already ready) booking queues nothing more
    await refreshOwnerRequest({ ...row, status: "ready" }, "cam1");
    expect((await jobsFor(GUID_ON)).jobs).toHaveLength(1);
  });

  it("creates a Storage-backed analysis recording when a failed job recovers as streamless", async () => {
    await setLive(true);
    const row = await booking(`vps-streamless-${TAG}`, "failed");
    videoForJob.set(row.vpsJobId!, GUID_STREAMLESS);
    streamlessJobs.add(row.vpsJobId!);

    await refreshOwnerRequest(row, "cam1", Date.now(), true);

    const [done] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, row.id));
    const { recs, jobs } = await jobsFor(GUID_STREAMLESS);
    expect(done.status).toBe("ready");
    expect(recs).toHaveLength(1);
    expect(recs[0].videoUrl).toMatch(new RegExp(`/vod/${GUID_STREAMLESS}/8k\\.m3u8$`));
    expect(jobs).toHaveLength(1);
    expect(streamFetches).toEqual([]);
  });

  it("enables training mode for academy training footage but not academy matches", async () => {
    await setLive(true);
    const training = await booking(`academy-training-${TAG}`, "recording", true);
    await academySession(training, "training");
    videoForJob.set(training.vpsJobId!, GUID_TRAINING);
    await refreshOwnerRequest(training, "cam1");
    const trainingJobs = (await jobsFor(GUID_TRAINING)).jobs;
    expect(trainingJobs).toHaveLength(1);
    expect(trainingJobs[0].params).toMatchObject({ training: true, footageRequestId: training.id });

    const match = await booking(`academy-match-${TAG}`, "recording", true);
    await academySession(match, "match");
    videoForJob.set(match.vpsJobId!, GUID_ACADEMY_MATCH);
    await refreshOwnerRequest(match, "cam1");
    const matchJobs = (await jobsFor(GUID_ACADEMY_MATCH)).jobs;
    expect(matchJobs).toHaveLength(1);
    expect(matchJobs[0].params).not.toHaveProperty("training");
  });

  it("reuses and links an existing succeeded analysis during automatic recovery", async () => {
    await setLive(true);
    const vpsJobId = `existing-auto-${TAG}`;
    const row = await booking(vpsJobId, "failed");
    videoForJob.set(vpsJobId, GUID_REUSE_AUTO);
    const { recording, job } = await existingAnalysis(row, GUID_REUSE_AUTO, { footageRequestId: row.id });

    await refreshOwnerRequest(row, "cam1", Date.now(), true);

    const [completed] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, row.id));
    const { jobs } = await jobsFor(GUID_REUSE_AUTO);
    expect(completed.status).toBe("ready");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: job.id,
      status: "succeeded",
      recordingId: recording.id,
      params: { footageRequestId: row.id },
    });
  });

  it("reuses a live analysis from the admin re-check instead of queueing another", async () => {
    await setLive(true);
    const vpsJobId = `existing-admin-${TAG}`;
    const row = await booking(vpsJobId, "failed");
    videoForJob.set(vpsJobId, GUID_REUSE_ADMIN);
    const { recording, job } = await existingAnalysis(row, GUID_REUSE_ADMIN, { liveJob: vpsJobId });

    const response = await request(app)
      .post(`/api/admin/footage-requests/${row.id}/recheck`)
      .expect(200);

    const { jobs } = await jobsFor(GUID_REUSE_ADMIN);
    expect(response.body).toMatchObject({ status: "ready", changed: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: job.id,
      status: "succeeded",
      recordingId: recording.id,
      params: { liveJob: vpsJobId, footageRequestId: row.id },
    });
  });

  it("asks the VPS to analyse past bookings when the setting is on", async () => {
    await setLive(true);
    expect(await shouldAnalyseBooking(fieldId)).toBe(true);
    await startFootageBookingCameraJob(await booking(`past-analysis-${TAG}`), "cam1");

    expect(recordPosts).toHaveLength(1);
    expect(recordPosts[0]).toContain("&analyse=1");
    expect(recordPosts[0]).not.toContain("live=1");
  });

  it("does not ask for analysis when the setting is off on a regular field", async () => {
    await setLive(false);
    expect(await shouldAnalyseBooking(fieldId)).toBe(false);
    await startFootageBookingCameraJob(await booking(`past-no-analysis-${TAG}`), "cam1");

    expect(recordPosts).toHaveLength(1);
    expect(recordPosts[0]).not.toContain("analyse=");
  });

  it("asks the VPS to analyse recordings from portable-kit fields", async () => {
    await setLive(false);
    const [kit] = await db.insert(cameraKitsTable).values({
      name: `Analysis kit ${TAG}`,
      cameraId: "cam1",
      fieldId,
      token: `analysis-kit-${TAG}`,
    }).returning({ id: cameraKitsTable.id });
    kitIds.push(kit.id);
    expect(await shouldAnalyseBooking(fieldId)).toBe(true);
    await startFootageBookingCameraJob(await booking(`kit-analysis-${TAG}`), "cam1");

    expect(recordPosts).toHaveLength(1);
    expect(recordPosts[0]).toContain("&analyse=1");
    await db.delete(cameraKitsTable).where(eq(cameraKitsTable.id, kit.id));
    kitIds = kitIds.filter((id) => id !== kit.id);
  });

  it("keeps the owner route's future live flag conditional on the setting", async () => {
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString().slice(0, 10);
    const make = async () => {
      const [row] = await db.insert(footageRequestsTable).values({
        fieldId, cameraId: "cam1", requestedBy: userId, startLocal: `${future} 22:00`, endLocal: `${future} 23:00`,
        requestedSeconds: 3600, status: "queued", rateFils: 0,
      }).returning();
      requestIds.push(row.id);
      return row;
    };
    await setLive(true);
    await startOwnerCameraJob(await make(), "cam1");
    await setLive(false);
    await startOwnerCameraJob(await make(), "cam1");
    expect(recordPosts).toHaveLength(2);
    expect(recordPosts[0]).toContain("&live=1");
    expect(recordPosts[1]).not.toContain("live=");
  });

  it("sends both live and analyse flags for future footage bookings", async () => {
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString().slice(0, 10);
    const [row] = await db.insert(footageRequestsTable).values({
      fieldId, cameraId: "cam1", requestedBy: userId, startLocal: `${future} 22:00`, endLocal: `${future} 23:00`,
      requestedSeconds: 3600, status: "queued", rateFils: 0,
    }).returning();
    requestIds.push(row.id);
    await setLive(true);
    expect(await shouldAnalyseBooking(fieldId)).toBe(true);
    await startFootageBookingCameraJob(row, "cam1");

    expect(recordPosts).toHaveLength(1);
    expect(recordPosts[0]).toContain("&live=1");
    expect(recordPosts[0]).toContain("&analyse=1");
  });

  it("does not add the analysis marker to FTP gap pulls", async () => {
    await setLive(true);
    gapCoverageSeconds = 3600;
    gapAvailabilityHasHour = true;
    await startFootageBookingCameraJob(await booking(`ftp-no-analysis-${TAG}`), "cam1");

    expect(gapPullPosts).toHaveLength(1);
    expect(gapPullPosts[0]).not.toContain("analyse=");
    expect(recordPosts).toHaveLength(0);
  });

  it("creates a hidden Storage recording but queues no analysis while the setting is off", async () => {
    await setLive(false);
    const row = await booking(`vps-off-${TAG}`);
    videoForJob.set(row.vpsJobId!, GUID_OFF);
    streamlessJobs.add(row.vpsJobId!);

    await refreshOwnerRequest(row, "cam1");

    const [done] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, row.id));
    expect(done.status).toBe("ready");
    const { recs, jobs } = await jobsFor(GUID_OFF);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ isVisible: false, fieldId, court: "cam1", date: "2020-01-02", timeSlot: "22:00" });
    expect(recs[0].videoUrl).toMatch(new RegExp(`/vod/${GUID_OFF}/8k\\.m3u8$`));
    expect(jobs).toHaveLength(0);
  });
});
