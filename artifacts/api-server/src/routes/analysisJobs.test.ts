/**
 * The analysis queue's API.
 *
 * What is worth testing here is not that a row can be inserted. It is the
 * handful of places where getting it wrong produces a queue that looks like it
 * is working: two workers holding the same job, a cancelled job that carries on
 * because the worker had not noticed, a job marked succeeded with no bundle
 * behind it, and the order of the chosen recordings surviving the round trip.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import {
  db,
  usersTable,
  fieldsTable,
  recordingsTable,
  analysisJobsTable,
  analysisWorkersTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
} from "@workspace/db";

// The bundle store is Replit object storage; there is none here. Everything
// this file cares about happens before and after the bytes are written.
vi.mock("../lib/claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(async (relativePath: string) => ({
    objectPath: `/objects/claim-match/${relativePath}`,
    compressedBytes: 128,
  })),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));
import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);

/** The smallest bundle the validator accepts: one segment, frames 0..1. */
function bundleZip(videoStartSeconds = 0): Buffer {
  const segment = {
    version: 1,
    segmentIndex: 0,
    name: "one",
    startFrame: 0,
    endFrame: 1,
    startSeconds: 0,
    endSeconds: 0.08,
    tracks: [],
    crossings: [],
    inPlaySpans: [],
    events: [],
  };
  const manifest = {
    version: 1,
    label: "worker upload",
    width: 3840,
    height: 1080,
    frameRate: 25,
    frameCount: 2,
    duration: 0.08,
    matchOffset: 0,
    videoStartSeconds,
    segmentCount: 1,
    segments: [{
      index: 0, name: "one", startFrame: 0, endFrame: 1,
      startSeconds: 0, endSeconds: 0.08, objectPath: "",
    }],
  };
  return Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "segments/one.json": strToU8(JSON.stringify(segment)),
  }));
}

const TAG = `an_${Date.now()}`;
const KEY = "test-worker-key-0123456789";
let app: Express;
let adminId: number;
let plainId: number;
let fieldId: number;
let recA: number;
let recB: number;
let recNoVideo: number;

const guid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;

beforeAll(async () => {
  process.env.ANALYSIS_WORKER_KEY = KEY;
  const { default: analysisRouter } = await import("./analysisJobs");
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api", analysisRouter);

  const [admin] = await db.insert(usersTable)
    .values({ name: "Admin", email: `admin_${TAG}@test.local`, isAdmin: true })
    .returning({ id: usersTable.id });
  const [plain] = await db.insert(usersTable)
    .values({ name: "Plain", email: `plain_${TAG}@test.local` })
    .returning({ id: usersTable.id });
  adminId = admin.id;
  plainId = plain.id;

  const [field] = await db.insert(fieldsTable)
    .values({ name: `Analysis field ${TAG}`, location: "Test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;

  const rows = await db.insert(recordingsTable).values([
    { fieldId, court: "cam1", date: "2026-09-01", timeSlot: "20:00", duration: "60:00",
      videoUrl: `https://vz-x.b-cdn.net/${guid(1)}/playlist.m3u8`, isVisible: true },
    { fieldId, court: "cam1", date: "2026-09-01", timeSlot: "21:00", duration: "60:00",
      videoUrl: `https://vz-x.b-cdn.net/${guid(2)}/playlist.m3u8`, isVisible: true },
    { fieldId, court: "cam1", date: "2026-09-01", timeSlot: "22:00", duration: "60:00",
      videoUrl: "", isVisible: true },
  ]).returning({ id: recordingsTable.id });
  [recA, recB, recNoVideo] = rows.map((row) => row.id);
});

afterAll(async () => {
  await db.delete(recordingTrackingBundlesTable)
    .where(inArray(recordingTrackingBundlesTable.recordingId, [recA, recB, recNoVideo]));
  await db.delete(analysisJobsTable).where(inArray(analysisJobsTable.recordingId, [recA, recB, recNoVideo]));
  await db.delete(analysisWorkersTable)
    .where(inArray(analysisWorkersTable.id, ["w1", "w2", "w0", "w3", "w4", "w5", "w6", "w7"]));
  await db.delete(recordingsTable).where(inArray(recordingsTable.id, [recA, recB, recNoVideo]));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, plainId]));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  delete process.env.ANALYSIS_WORKER_KEY;
});

beforeEach(async () => {
  await db.delete(recordingTrackingBundlesTable)
    .where(inArray(recordingTrackingBundlesTable.recordingId, [recA, recB, recNoVideo]));
  await db.delete(analysisJobsTable).where(inArray(analysisJobsTable.recordingId, [recA, recB, recNoVideo]));
  await db.delete(analysisWorkersTable)
    .where(inArray(analysisWorkersTable.id, ["w1", "w2", "w0", "w3", "w4", "w5", "w6", "w7"]));
  mockedGetLocalUserId.mockResolvedValue(adminId);
  process.env.ANALYSIS_WORKER_KEY = KEY;
});

const asWorker = (path: string, worker = "w1") =>
  request(app).post(path).set("x-worker-key", KEY).send({ workerId: worker });

function queueJob(body: Record<string, unknown> = {}) {
  return request(app).post("/api/admin/analysis-jobs").send({
    recordingId: recA,
    sourceRecordingIds: [recA, recB],
    matchStartSeconds: 1080,
    ...body,
  });
}

describe("queueing a job", () => {
  it("stores the chosen recordings in the operator's order", async () => {
    // Asked for the 21:00 hour first. The database would happily return them
    // by id; the order the operator chose is the order the match was played in.
    const res = await request(app).post("/api/admin/analysis-jobs").send({
      recordingId: recB,
      sourceRecordingIds: [recB, recA],
      matchStartSeconds: 0,
    }).expect(201);
    expect(res.body.sourceRecordingIds).toEqual([recB, recA]);
    expect(res.body.sources.map((s: { recordingId: number }) => s.recordingId)).toEqual([recB, recA]);
    expect(res.body.sources[0].videoGuid).toBe(guid(2));
    expect(res.body.sources[0].title).toBe("cam1_2026-09-01_21:00");
  });

  it("refuses a plain user", async () => {
    mockedGetLocalUserId.mockResolvedValue(plainId);
    await queueJob().expect(401);
  });

  it("refuses a recording with no video, and a kick-off past the end", async () => {
    const noVideo = await queueJob({ recordingId: recNoVideo, sourceRecordingIds: [recNoVideo] });
    expect(noVideo.status).toBe(400);
    expect(noVideo.body.error).toContain("no video");

    const late = await queueJob({ matchStartSeconds: 99999 });
    expect(late.status).toBe(400);
    expect(late.body.error).toContain("past the end");
  });

  it("refuses a target that is not one of the chosen recordings", async () => {
    const res = await queueJob({ recordingId: recNoVideo, sourceRecordingIds: [recA, recB] });
    expect(res.status).toBe(400);
  });

  it("refuses a second active job for the same recording", async () => {
    await queueJob().expect(201);
    const second = await queueJob();
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already");
  });
});

describe("worker authentication", () => {
  it("rejects a missing or wrong key", async () => {
    await request(app).post("/api/worker/analysis/ping").send({ workerId: "w1" }).expect(401);
    await request(app).post("/api/worker/analysis/ping")
      .set("x-worker-key", "nope").send({ workerId: "w1" }).expect(401);
  });

  it("says so plainly when the deployment has no key at all", async () => {
    delete process.env.ANALYSIS_WORKER_KEY;
    const res = await request(app).post("/api/worker/analysis/ping")
      .set("x-worker-key", "").send({ workerId: "w1" });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("ANALYSIS_WORKER_KEY");
  });

  it("requires a worker id", async () => {
    await request(app).post("/api/worker/analysis/ping").set("x-worker-key", KEY).send({}).expect(400);
  });
});

describe("claiming", () => {
  it("gives each waiting job to exactly one worker", async () => {
    // Two jobs, eight workers, all asking at once.
    //
    // Being honest about what this proves: the safety is in the statement, not
    // in this test. A SELECT-then-UPDATE claim can win a race like this by
    // luck, because the first transaction often commits before the others even
    // read. What the test does catch is the cheap mistake - a claim that hands
    // the same row out twice under any interleaving - and the assertion on
    // `attempts` is the sharper half: a row claimed twice has been counted
    // twice, whether or not both callers got a reply.
    await queueJob().expect(201);
    await request(app).post("/api/admin/analysis-jobs")
      .send({ recordingId: recB, sourceRecordingIds: [recB], matchStartSeconds: 0 })
      .expect(201);

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => asWorker("/api/worker/analysis/claim", `w${i}`)),
    );
    const claimed = responses.map((r) => r.body.job).filter(Boolean);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((job: { id: number }) => job.id)).size).toBe(2);

    const rows = await db.select().from(analysisJobsTable)
      .where(inArray(analysisJobsTable.recordingId, [recA, recB]));
    expect(rows.map((row) => row.attempts)).toEqual([1, 1]);
    expect(rows.every((row) => row.status === "claimed")).toBe(true);

    const twoHourJob = claimed.find((job: { recordingId: number }) => job.recordingId === recA);
    expect(twoHourJob.sources).toHaveLength(2);
    expect(twoHourJob.matchStartSeconds).toBe(1080);
  });

  it("answers with no job when the queue is empty", async () => {
    const res = await asWorker("/api/worker/analysis/claim").expect(200);
    expect(res.body.job).toBeNull();
  });

  it("records the worker as seen even when it takes nothing", async () => {
    await asWorker("/api/worker/analysis/claim", "w2").expect(200);
    const [worker] = await db.select().from(analysisWorkersTable).where(eq(analysisWorkersTable.id, "w2"));
    expect(worker.status).toBe("idle");
  });
});

describe("heartbeat and cancellation", () => {
  it("moves a claimed job to running and records the stage", async () => {
    await queueJob().expect(201);
    const claim = await asWorker("/api/worker/analysis/claim").expect(200);
    const id = claim.body.job.id;

    const beat = await request(app).post(`/api/worker/analysis/${id}/heartbeat`)
      .set("x-worker-key", KEY)
      .send({ workerId: "w1", stage: "analysing chunk 2 of 6", progress: 31 })
      .expect(200);
    expect(beat.body.stop).toBe(false);

    const [row] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.id, id));
    expect(row.status).toBe("running");
    expect(row.stage).toBe("analysing chunk 2 of 6");
    expect(row.progress).toBe(31);
  });

  it("tells a worker to stop once the job has been cancelled, and does not revive it", async () => {
    await queueJob().expect(201);
    const claim = await asWorker("/api/worker/analysis/claim").expect(200);
    const id = claim.body.job.id;
    await request(app).post(`/api/admin/analysis-jobs/${id}/cancel`).send({}).expect(200);

    const beat = await request(app).post(`/api/worker/analysis/${id}/heartbeat`)
      .set("x-worker-key", KEY).send({ workerId: "w1", stage: "still going", progress: 90 })
      .expect(200);
    expect(beat.body.stop).toBe(true);

    const [row] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.id, id));
    expect(row.status).toBe("cancelled");
    expect(row.stage).not.toBe("still going");
  });

  it("tells a worker that no longer holds the job to stop, rather than 404ing at it", async () => {
    await queueJob().expect(201);
    const claim = await asWorker("/api/worker/analysis/claim", "w1").expect(200);
    const res = await request(app).post(`/api/worker/analysis/${claim.body.job.id}/heartbeat`)
      .set("x-worker-key", KEY).send({ workerId: "w2" }).expect(200);
    expect(res.body.stop).toBe(true);
    expect(res.body.reason).toContain("Another worker");
  });
});

describe("finishing", () => {
  it("refuses to mark a job succeeded when no bundle was uploaded", async () => {
    // The failure this prevents: six hours of GPU time, a green tick in the
    // console, and nothing for anyone to claim.
    await queueJob().expect(201);
    const claim = await asWorker("/api/worker/analysis/claim").expect(200);
    const res = await asWorker(`/api/worker/analysis/${claim.body.job.id}/complete`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No bundle");
  });

  it("requeues a failure while attempts remain, and gives up after the limit", async () => {
    await queueJob().expect(201);
    let status = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claim = await asWorker("/api/worker/analysis/claim");
      if (!claim.body.job) break;
      const failed = await request(app).post(`/api/worker/analysis/${claim.body.job.id}/fail`)
        .set("x-worker-key", KEY).send({ workerId: "w1", error: `boom ${attempt}` });
      status = failed.body.job.status;
    }
    expect(status).toBe("failed");
    const [row] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.recordingId, recA));
    expect(row.error).toContain("boom");
  });

  it("lets an operator retry a failed job from the console", async () => {
    await queueJob().expect(201);
    const [row] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.recordingId, recA));
    await db.update(analysisJobsTable).set({ status: "failed", attempts: 3, error: "boom" })
      .where(eq(analysisJobsTable.id, row.id));
    const res = await request(app).post(`/api/admin/analysis-jobs/${row.id}/retry`).send({}).expect(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.attempts).toBe(0);
    expect(res.body.error).toBeNull();
  });
});

describe("the bundle the worker sends back", () => {
  async function claimAJob() {
    await queueJob().expect(201);
    const claim = await asWorker("/api/worker/analysis/claim").expect(200);
    return claim.body.job.id as number;
  }

  /**
   * These exercise the exact multipart shape analysis-worker.ps1 builds with
   * curl - field names included - because that is the one part of the worker
   * that cannot be run from here, and a mismatched field name would only show
   * up six GPU-hours into a real job.
   */
  it("stores a bundle against the named source recording", async () => {
    const id = await claimAJob();
    const res = await request(app).put(`/api/worker/analysis/${id}/bundle`)
      .set("x-worker-key", KEY)
      .field("workerId", "w1")
      .field("recordingId", String(recB))
      .field("videoStartSeconds", "0")
      .attach("bundle", bundleZip(), "idbundle.zip");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, recordingId: recB });
    expect(res.body.remaining).toEqual([recA]);

    const [row] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.id, id));
    expect(row.bundleRecordingIds).toEqual([recB]);
  });

  it("takes the kick-off from the form, not from whatever the bundle carried", async () => {
    // The same tracking can be attached to a differently trimmed video, so the
    // pairing owns this number. Getting it wrong draws every box against the
    // wrong part of the match and looks like broken tracking.
    const id = await claimAJob();
    await request(app).put(`/api/worker/analysis/${id}/bundle`)
      .set("x-worker-key", KEY)
      .field("workerId", "w1")
      .field("recordingId", String(recA))
      .field("videoStartSeconds", "1080")
      .attach("bundle", bundleZip(0), "idbundle.zip")
      .expect(200);

    const [bundle] = await db.select().from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recA));
    expect(bundle.manifest.videoStartSeconds).toBe(1080);
  });

  it("refuses a recording that is not part of the job", async () => {
    const id = await claimAJob();
    const res = await request(app).put(`/api/worker/analysis/${id}/bundle`)
      .set("x-worker-key", KEY)
      .field("workerId", "w1")
      .field("recordingId", String(recNoVideo))
      .attach("bundle", bundleZip(), "idbundle.zip");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("source recordings");
  });

  it("completes once a bundle has landed, and the segments are there to claim", async () => {
    const id = await claimAJob();
    await request(app).put(`/api/worker/analysis/${id}/bundle`)
      .set("x-worker-key", KEY)
      .field("workerId", "w1")
      .field("recordingId", String(recA))
      .field("videoStartSeconds", "60")
      .attach("bundle", bundleZip(), "idbundle.zip")
      .expect(200);

    const done = await asWorker(`/api/worker/analysis/${id}/complete`).expect(200);
    expect(done.body.job.status).toBe("succeeded");

    // The point of the whole exercise: a stored segment row, which is what
    // makes the recording claimable rather than merely bundled.
    const [bundle] = await db.select().from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recA));
    const segments = await db.select().from(recordingTrackingSegmentsTable)
      .where(eq(recordingTrackingSegmentsTable.bundleId, bundle.id));
    expect(segments).toHaveLength(1);
  });
});

describe("the queue as the console sees it", () => {
  it("numbers the waiting jobs and reports whether the workstation is online", async () => {
    await queueJob().expect(201);
    await request(app).post("/api/admin/analysis-jobs").send({
      recordingId: recB, sourceRecordingIds: [recB], matchStartSeconds: 0,
    }).expect(201);
    await asWorker("/api/worker/analysis/ping").expect(200);

    const res = await request(app).get("/api/admin/analysis-jobs").expect(200);
    const positions = res.body.jobs.map((job: { queuePosition: number }) => job.queuePosition).sort();
    expect(positions).toEqual([1, 2]);
    expect(res.body.workers.find((w: { id: string }) => w.id === "w1").online).toBe(true);
  });

  it("tells the ping how much is waiting, so an idle worker can back off", async () => {
    await queueJob().expect(201);
    const res = await asWorker("/api/worker/analysis/ping").expect(200);
    expect(res.body.queued).toBe(1);
  });
});
