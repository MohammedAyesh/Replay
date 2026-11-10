import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { db, fieldsTable, footageRequestsTable, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

const h = vi.hoisted(() => ({
  queueAnalysis: vi.fn(async () => ({ queued: true, jobId: 1, recordingId: 1 })),
  attachAcademy: vi.fn(async () => {}),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));
vi.mock("../lib/liveAnalysis", () => ({
  liveAnalysisEnabled: vi.fn(async () => true),
  queueLiveAnalysisForBooking: h.queueAnalysis,
}));
vi.mock("../lib/academyFootage", () => ({
  attachAcademyRecordingsForFootageRequest: h.attachAcademy,
}));

import { getLocalUserRecord } from "../lib/clerkUserBridge";
import ownerRouter, { runOwnerStatusSync } from "./owner";

type JobReply = { status?: number; body?: unknown; networkError?: boolean };
const replies = new Map<string, JobReply>();
const pollCounts = new Map<string, number>();
const requestIds: number[] = [];
const tag = `owner-recovery-${Date.now()}`;
let nextJob = 0;
let app: Express;
let adminId: number;
let ownerId: number;
let fieldId: number;
let realFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function replyFor(jobId: string, reply: JobReply): void {
  replies.set(jobId, reply);
}

async function createFailedRequest(options: {
  status?: string;
  updatedAt?: Date;
  message?: string | null;
} = {}) {
  const jobId = `recovery-${tag}-${++nextJob}`;
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: "cam1",
    requestedBy: ownerId,
    startLocal: "2026-11-09 22:00",
    endLocal: "2026-11-10 00:00",
    requestedSeconds: 7200,
    status: options.status ?? "failed",
    vpsJobId: jobId,
    rateFils: 1000,
    amountFils: 0,
    billableHours: 0,
    message: options.message ?? "Original failure",
    updatedAt: options.updatedAt ?? new Date(),
  }).returning();
  requestIds.push(row.id);
  return row;
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://owner-recovery.test";
  process.env.CONTABO_CONTROL_KEY = "test-control-key";
  process.env.PUBLIC_SHARE_BASE_URL = "https://owner-recovery.example.test";

  app = express();
  app.use(express.json());
  app.use("/api", ownerRouter);

  const [owner] = await db.insert(usersTable).values({
    name: `Recovery owner ${tag}`,
    email: `${tag}-owner@test.local`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  const [admin] = await db.insert(usersTable).values({
    name: `Recovery admin ${tag}`,
    email: `${tag}-admin@test.local`,
    isAdmin: true,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  ownerId = owner.id;
  adminId = admin.id;

  const [field] = await db.insert(fieldsTable).values({
    name: `Recovery field ${tag}`,
    location: "Test",
    cameraId: "cam1",
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith("owner-recovery.test")) return realFetch(input, init);
    const parts = url.pathname.split("/").filter(Boolean);
    const jobId = decodeURIComponent(parts[parts.length - 1] ?? "");
    pollCounts.set(jobId, (pollCounts.get(jobId) ?? 0) + 1);
    const reply = replies.get(jobId);
    if (reply?.networkError) throw new Error("Control server temporarily unavailable");
    if (!reply) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(reply.body ?? {}, reply.status ?? 200);
  });
});

beforeEach(() => {
  replies.clear();
  pollCounts.clear();
  h.queueAnalysis.mockClear();
  h.attachAcademy.mockClear();
  vi.mocked(getLocalUserRecord).mockResolvedValue({
    id: adminId,
    isGuest: false,
    isAdmin: true,
  } as Awaited<ReturnType<typeof getLocalUserRecord>>);
});

afterEach(async () => {
  if (requestIds.length) {
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
    requestIds.length = 0;
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(fieldsTable).where(inArray(fieldsTable.id, [fieldId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [ownerId, adminId]));
});

describe("failed owner footage recovery", () => {
  it("completes a failed job that later reports done, and queues analysis once", async () => {
    const row = await createFailedRequest();
    const videoId = "95a477cd-6639-42dd-ad06-554eb3ff0c0c";
    replyFor(row.vpsJobId!, {
      body: { status: "done", message: "ready", videoId },
    });

    await runOwnerStatusSync();
    const [completed] = await db.select().from(footageRequestsTable)
      .where(inArray(footageRequestsTable.id, [row.id]));

    expect(completed).toMatchObject({
      status: "ready",
      videoId,
      billableHours: 2,
      amountFils: 2000,
    });
    expect(completed.readyAt).toBeInstanceOf(Date);
    expect(completed.shareToken).toMatch(/^[0-9a-f]{32}$/);
    expect(completed.shareExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(h.queueAnalysis).toHaveBeenCalledTimes(1);
    expect(h.attachAcademy).toHaveBeenCalledTimes(1);

    await runOwnerStatusSync();
    expect(h.queueAnalysis).toHaveBeenCalledTimes(1);
    expect(pollCounts.get(row.vpsJobId!)).toBe(1);
  });

  it("completes partial server results through the same completion path", async () => {
    const row = await createFailedRequest();
    replyFor(row.vpsJobId!, {
      body: {
        status: "partial",
        durationSeconds: 1800,
        message: "Partial recording available",
        videoId: "partial-recovery-video",
      },
    });

    await runOwnerStatusSync();
    const [completed] = await db.select().from(footageRequestsTable)
      .where(inArray(footageRequestsTable.id, [row.id]));
    expect(completed).toMatchObject({
      status: "partial",
      deliveredSeconds: 1800,
      videoId: "partial-recovery-video",
      progress: 100,
    });
    expect(completed.shareToken).toMatch(/^[0-9a-f]{32}$/);
    expect(h.queueAnalysis).toHaveBeenCalledTimes(1);
    expect(h.attachAcademy).toHaveBeenCalledTimes(1);
  });

  it("lists eligible recent failures for admins only", async () => {
    const row = await createFailedRequest();
    const response = await request(app).get("/api/admin/footage-requests").expect(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: row.id,
        fieldId,
        fieldName: expect.stringContaining("Recovery field"),
        ownerEmail: expect.stringContaining("owner-recovery-"),
        cameraId: "cam1",
      }),
    ]));

    vi.mocked(getLocalUserRecord).mockResolvedValue({
      id: ownerId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    await request(app).get("/api/admin/footage-requests").expect(403);
  });

  it("leaves failed rows unchanged when the server reports failed, running, 404, or an error", async () => {
    const stillFailed = await createFailedRequest({ message: "Keep this message" });
    const running = await createFailedRequest({ message: "Do not touch running result" });
    const missing = await createFailedRequest({ message: "Do not touch 404 result" });
    const errored = await createFailedRequest({ message: "Do not touch error result" });
    replyFor(stillFailed.vpsJobId!, { body: { status: "failed", message: "New server error" } });
    replyFor(running.vpsJobId!, { body: { status: "running", progress: 80 } });
    replyFor(missing.vpsJobId!, { status: 404, body: { error: "missing" } });
    replyFor(errored.vpsJobId!, { networkError: true });
    const before = new Map([stillFailed, running, missing, errored].map((row) => [row.id, row]));

    await runOwnerStatusSync();

    for (const id of before.keys()) {
      const [after] = await db.select().from(footageRequestsTable).where(inArray(footageRequestsTable.id, [id]));
      const original = before.get(id)!;
      expect(after).toMatchObject({
        status: "failed",
        message: original.message,
        updatedAt: original.updatedAt,
        videoId: original.videoId,
        progress: original.progress,
        amountFils: original.amountFils,
        shareToken: original.shareToken,
      });
    }
    expect(h.queueAnalysis).not.toHaveBeenCalled();
  });

  it("does not poll cancelled requests or failures older than three days", async () => {
    const cancelled = await createFailedRequest({ status: "cancelled" });
    const oldFailure = await createFailedRequest({
      updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 1),
    });
    replyFor(cancelled.vpsJobId!, { body: { status: "done", videoId: "should-not-attach" } });
    replyFor(oldFailure.vpsJobId!, { body: { status: "done", videoId: "should-not-attach" } });

    await runOwnerStatusSync();

    expect(pollCounts.get(cancelled.vpsJobId!)).toBeUndefined();
    expect(pollCounts.get(oldFailure.vpsJobId!)).toBeUndefined();
    const [cancelledAfter] = await db.select().from(footageRequestsTable)
      .where(inArray(footageRequestsTable.id, [cancelled.id]));
    const [oldAfter] = await db.select().from(footageRequestsTable)
      .where(inArray(footageRequestsTable.id, [oldFailure.id]));
    expect(cancelledAfter.status).toBe("cancelled");
    expect(oldAfter).toMatchObject({ status: "failed", message: oldFailure.message, updatedAt: oldFailure.updatedAt });
  });

  it("throttles background recovery to one poll per ten minutes", async () => {
    const row = await createFailedRequest();
    replyFor(row.vpsJobId!, { body: { status: "failed", message: "Still failed" } });
    const base = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      await runOwnerStatusSync();
      expect(pollCounts.get(row.vpsJobId!)).toBe(1);

      clock.mockReturnValue(base + 9 * 60 * 1000);
      await runOwnerStatusSync();
      expect(pollCounts.get(row.vpsJobId!)).toBe(1);

      clock.mockReturnValue(base + 10 * 60 * 1000);
      await runOwnerStatusSync();
      expect(pollCounts.get(row.vpsJobId!)).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("lets an admin re-check immediately, but never revives a cancelled row", async () => {
    const row = await createFailedRequest();
    replyFor(row.vpsJobId!, { body: { status: "failed", message: "Still failed" } });
    await runOwnerStatusSync();
    expect(pollCounts.get(row.vpsJobId!)).toBe(1);

    replyFor(row.vpsJobId!, {
      body: { status: "done", message: "ready", videoId: "admin-recheck-video" },
    });
    const response = await request(app).post(`/api/admin/footage-requests/${row.id}/recheck`).expect(200);
    expect(response.body).toMatchObject({ id: row.id, status: "ready", changed: true });
    expect(pollCounts.get(row.vpsJobId!)).toBe(2);

    const cancelled = await createFailedRequest({ status: "cancelled" });
    const rejected = await request(app).post(`/api/admin/footage-requests/${cancelled.id}/recheck`).expect(409);
    expect(rejected.body.error).toMatch(/recent failed requests/);
    expect(pollCounts.get(cancelled.vpsJobId!)).toBeUndefined();
  });

  it("keeps the admin re-check endpoint admin-only", async () => {
    const row = await createFailedRequest();
    vi.mocked(getLocalUserRecord).mockResolvedValue({
      id: ownerId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);

    await request(app).post(`/api/admin/footage-requests/${row.id}/recheck`).expect(403);
    expect(pollCounts.get(row.vpsJobId!)).toBeUndefined();
  });
});
