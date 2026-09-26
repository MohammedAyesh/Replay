import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analysisJobsTable,
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

import { refreshOwnerRequest, startCameraJob } from "./owner";
import { courtFromCamera } from "../lib/liveAnalysis";
import { invalidateSettingsCache } from "../lib/settings";

// A booking whose footage becomes ready must queue its analysis job (with the
// VPS job named, so the GPU worker uploads the bundle made during the match)
// exactly once, and only when "Analyse bookings during the match" is on.
const TAG = `live_${Date.now()}`;
const GUID_ON = "0f0e0d0c-0b0a-4908-8706-050403020100";
const GUID_OFF = "1f1e1d1c-1b1a-4918-8716-151413121110";
let userId: number;
let fieldId: number;
let requestIds: number[] = [];
let videoForJob = new Map<string, string>();
let realFetch: typeof fetch;
let recordPosts: string[] = [];

async function setLive(on: boolean) {
  await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.scopeType, "field"),
    eq(settingsRulesTable.scopeId, fieldId), eq(settingsRulesTable.key, "stats.liveAnalysis")));
  if (on) {
    await db.insert(settingsRulesTable).values({ key: "stats.liveAnalysis", value: true, priority: 100,
      scopeType: "field", scopeId: fieldId });
  }
  invalidateSettingsCache();
}

async function booking(vpsJobId: string) {
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: "cam1",
    requestedBy: userId,
    startLocal: "2020-01-02 22:00",
    endLocal: "2020-01-02 23:00",
    requestedSeconds: 3600,
    status: "recording",
    vpsJobId,
    rateFils: 0,
  }).returning();
  requestIds.push(row.id);
  return row;
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
  const [f] = await db.insert(fieldsTable).values({ name: `Live Field ${TAG}`, location: "Test",
    cameraId: `live-camera-${TAG}` }).returning({ id: fieldsTable.id });
  fieldId = f.id;
  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/record-hq/") && init?.method === "POST") {
      recordPosts.push(url);
      return new Response(JSON.stringify({ status: "scheduled", jobId: `posted-${recordPosts.length}` }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const m = /\/record-hq\/[^/]+\/([^/?]+)/.exec(url);
    if (m && videoForJob.has(m[1])) {
      return new Response(JSON.stringify({ status: "done", videoId: videoForJob.get(m[1]),
        durationSeconds: 3600, updatedAt: new Date().toISOString() }),
      { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  });
});

beforeEach(() => {
  videoForJob = new Map();
  recordPosts = [];
});

afterAll(async () => {
  for (const guid of [GUID_ON, GUID_OFF]) {
    const { recs } = await jobsFor(guid);
    if (recs.length) {
      await db.delete(analysisJobsTable).where(inArray(analysisJobsTable.recordingId, recs.map((r) => r.id)));
      await db.delete(recordingsTable).where(inArray(recordingsTable.id, recs.map((r) => r.id)));
    }
  }
  if (requestIds.length) await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.scopeType, "field"), eq(settingsRulesTable.scopeId, fieldId)));
  invalidateSettingsCache();
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
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

    // a later refresh of the same (already ready) booking queues nothing more
    await refreshOwnerRequest({ ...row, status: "ready" }, "cam1");
    expect((await jobsFor(GUID_ON)).jobs).toHaveLength(1);
  });

  it("asks the VPS to analyse a future booking live only when the setting is on", async () => {
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
    await startCameraJob(await make(), "cam1");
    await setLive(false);
    await startCameraJob(await make(), "cam1");
    expect(recordPosts).toHaveLength(2);
    expect(recordPosts[0]).toContain("&live=1");
    expect(recordPosts[1]).not.toContain("live=");
  });

  it("queues nothing while the setting is off", async () => {
    await setLive(false);
    const row = await booking(`vps-off-${TAG}`);
    videoForJob.set(row.vpsJobId!, GUID_OFF);

    await refreshOwnerRequest(row, "cam1");

    const [done] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, row.id));
    expect(done.status).toBe("ready");
    const { recs, jobs } = await jobsFor(GUID_OFF);
    expect(recs).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });
});
