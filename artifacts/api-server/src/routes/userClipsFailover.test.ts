/**
 * The two-method export, end to end through the real routes.
 *
 * A local HTTP server stands in for vps1's control API (Method B). The cases
 * are the ones that produced "Export failed" in production or could have:
 *
 *   - a clip left `pending` with no local render (restart / another instance)
 *     is handed to Method B by the status poll, and finishes there;
 *   - a clip whose Method A already failed (`error`) is picked up by Method B
 *     instead of being reported to the user as a failure;
 *   - POST /export on a server where Method A cannot run goes straight to B;
 *   - only when Method B itself fails permanently does the user see "error";
 *   - a finished Method B file downloads byte for byte, with Range, through
 *     this server (the control key never reaches the client).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import http from "http";
import crypto from "crypto";
import { db, usersTable, userClipsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const exportMocks = vi.hoisted(() => ({
  primaryEnabled: false,
  backupEnabled: true,
  renderClip: vi.fn(async () => "/tmp/test-primary-export.mp4"),
  bufferRemoteClip: vi.fn(async () => ({
    bufferPath: "/tmp/test-primary-buffer.mp4",
    bufferedDuration: 60,
    adjustedOffsetSec: 0,
  })),
  getBunnyVideoInfo: vi.fn(async () => ({
    duration: 60,
    hasMP4Fallback: true,
    availableResolutions: "1080p",
  })),
  resolveExportSource: vi.fn(async () => ({
    url: "https://cdn.test/source.m3u8",
    path: "resolution-matched HLS variant" as const,
    width: 3840,
    height: 1080,
    renditionLabel: "2160p",
  })),
  uploadToBunnyStorage: vi.fn(async (_path: string, clipId: number) =>
    `https://storage.test/clips/${clipId}.mp4`,
  ),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));
vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    isBunnyConfigured: () => exportMocks.primaryEnabled,
    isBunnyStorageConfigured: () => exportMocks.primaryEnabled,
    getBunnyVideoInfo: exportMocks.getBunnyVideoInfo,
    uploadToBunnyStorage: exportMocks.uploadToBunnyStorage,
  };
});
vi.mock("../lib/ffmpegExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ffmpegExport")>();
  return {
    ...actual,
    renderClip: exportMocks.renderClip,
    bufferRemoteClip: exportMocks.bufferRemoteClip,
    cleanupTempFile: vi.fn(),
  };
});
vi.mock("../lib/exportSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exportSource")>();
  return { ...actual, selectExportSource: exportMocks.resolveExportSource };
});
vi.mock("../lib/backupExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backupExport")>();
  return { ...actual, isBackupExportConfigured: () => exportMocks.backupEnabled };
});
import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);
import { renderQueue, useLiveRenderSettings } from "../lib/renderQueue";

const FILE = crypto.randomBytes(300 * 1024);
const VIDEO = "1e69d9ea-e5ef-4c20-990d-a4fd678f7ace";
const TAG = `fo_${Date.now()}`;

type Job = { status: string; errorKind?: string | null; progress: number; submissions: number; retried: number };
const jobs = new Map<string, Job>();
const seen: { method: string; url: string; key: string | undefined; range: string | undefined }[] = [];
/** What the fake vps1 should do with the NEXT new job for a given clip id. */
const script = new Map<number, "ready" | "running" | "permanent" | "transient-then-ready">();
const unreachableSubmit = new Set<number>();

let vps1: http.Server;
let app: Express;
let ownerId: number;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function jobFor(clipId: number) {
  return `c${clipId}-${"0123456789abcdef"}`;
}

beforeAll(async () => {
  vps1 = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined, range: req.headers.range as string | undefined });
    if (req.headers["x-api-key"] !== "test-control-key") { res.writeHead(401); res.end(); return; }
    const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && req.url === "/export/clip") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (unreachableSubmit.has(body.clipId)) { send(503, { error: "offline" }); return; }
        const job = jobFor(body.clipId);
        let j = jobs.get(job);
        if (!j) {
          const plan = script.get(body.clipId) ?? "ready";
          j = {
            status: plan === "ready" ? "ready" : plan === "running" ? "encoding" : "failed",
            errorKind: plan === "permanent" ? "permanent" : plan === "transient-then-ready" ? "transient" : null,
            progress: plan === "ready" ? 100 : 40,
            submissions: 0,
            retried: 0,
          };
          jobs.set(job, j);
        } else if (body.retry && j.status === "failed" && j.errorKind === "transient") {
          j.retried++;
          j.status = "ready"; j.errorKind = null; j.progress = 100;
        }
        j.submissions++;
        send(200, { job, clipId: body.clipId, status: j.status, stage: null, progress: j.progress, error: j.errorKind ? "boom" : null, errorKind: j.errorKind ?? null, running: j.status !== "ready" && j.status !== "failed", output: j.status === "ready" ? { bytes: FILE.length, duration: 6, width: 1920, height: 1080 } : null });
      });
      return;
    }
    const m = req.url?.match(/^\/export\/clip\/(c\d+-[0-9a-f]{16})\/file$/);
    if (req.method === "GET" && m) {
      if (jobs.get(m[1])?.status !== "ready") { send(404, { detail: "export not ready" }); return; }
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : FILE.length - 1;
        res.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${FILE.length}` });
        res.end(FILE.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(FILE.length) });
      res.end(FILE);
      return;
    }
    send(404, {});
  });
  await new Promise<void>((r) => vps1.listen(0, "127.0.0.1", r));
  process.env.CONTABO_CONTROL_URL = `http://127.0.0.1:${(vps1.address() as { port: number }).port}`;
  process.env.CONTABO_CONTROL_KEY = "test-control-key";

  const { default: router } = await import("./userClips");
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", router);

  const [owner] = await db
    .insert(usersTable)
    .values({ name: "Owner", email: `owner_${TAG}@test.local`, isGuest: false, profileComplete: false, plan: "pro" })
    .returning({ id: usersTable.id });
  ownerId = owner.id;
});

afterAll(async () => {
  await db.delete(userClipsTable).where(inArray(userClipsTable.userId, [ownerId]));
  await db.delete(usersTable).where(eq(usersTable.id, ownerId));
  await new Promise<void>((r) => vps1.close(() => r()));
});

beforeEach(() => {
  mockedGetLocalUserId.mockResolvedValue(ownerId);
  seen.length = 0;
  unreachableSubmit.clear();
  exportMocks.primaryEnabled = false;
  exportMocks.backupEnabled = true;
  exportMocks.renderClip.mockClear();
  exportMocks.bufferRemoteClip.mockClear();
  exportMocks.getBunnyVideoInfo.mockClear();
  exportMocks.resolveExportSource.mockClear();
  exportMocks.uploadToBunnyStorage.mockClear();
  useLiveRenderSettings(async () => ({
    concurrency: 1,
    yieldToArchive: false,
    yieldCeilingMs: 0,
  }));
});

async function clip(exportStatus: string | null, plan?: "ready" | "running" | "permanent" | "transient-then-ready") {
  const [row] = await db
    .insert(userClipsTable)
    .values({
      userId: ownerId, videoId: VIDEO, title: "Roman Goal", startTime: "0.763406", endTime: "0.765336",
      cropPath: [{ t: 0, x: 0.5, y: 0, w: 0.5, h: 1 }], aspectRatio: "16:9", visibility: "private",
      exportStatus, exportedUrl: null,
    })
    .returning({ id: userClipsTable.id });
  if (plan) script.set(row.id, plan);
  return row.id;
}

const status = (id: number, q = "") => request(app).get(`/api/user-clips/${id}/export-status${q}`);
const rowOf = async (id: number) => (await db.select().from(userClipsTable).where(eq(userClipsTable.id, id)))[0];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitForExportStatus(id: number, expected: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await rowOf(id))?.exportStatus === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Clip ${id} did not reach export status ${expected}`);
}

describe("export failover to the backup renderer", () => {
  it("finishes a clip whose primary render failed (the 2026-09-29 incident) on vps1", async () => {
    const id = await clip("error", "ready");
    const res = await status(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.method).toBe("backup");
    const row = await rowOf(id);
    expect(row.exportStatus).toBe("done");
    expect(row.exportedUrl).toBe(`vps1-export:${jobFor(id)}`);
  });

  it("picks up a pending clip nobody here is rendering, and reports calm progress meanwhile", async () => {
    const id = await clip("pending", "running");
    const res = await status(id);
    expect(res.body).toMatchObject({ status: "pending", method: "backup", progress: "backup", backupProgress: 40 });
    expect((await rowOf(id)).exportStatus).toBe("pending");
  });

  it("relaunches a transient backup failure instead of reporting it", async () => {
    const id = await clip("error", "transient-then-ready");
    const first = await status(id);
    expect(first.body.status).toBe("pending");
    expect(jobs.get(jobFor(id))?.retried).toBe(1);
  });

  it("reports an error only when the backup has failed for good too", async () => {
    const id = await clip("pending", "permanent");
    const res = await status(id);
    expect(res.body.status).toBe("error");
    expect((await rowOf(id)).exportStatus).toBe("error");
  });

  it("sends POST /export straight to the backup when this server cannot render", async () => {
    // The test environment has no Bunny Stream/Storage configuration, which is
    // exactly the "primary cannot run" case.
    const id = await clip(null, "ready");
    const res = await request(app).post(`/api/user-clips/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect((await rowOf(id)).exportedUrl).toBe(`vps1-export:${jobFor(id)}`);
  });

  it("downloads a backup export byte for byte through this server, and never leaks the control key", async () => {
    const id = await clip("error", "ready");
    await status(id);
    const res = await request(app).get(`/api/user-clips/${id}/download`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(Buffer.compare(res.body as Buffer, FILE)).toBe(0);
    expect(JSON.stringify(res.headers)).not.toContain("test-control-key");
    expect(seen.some((h) => h.url === `/export/clip/${jobFor(id)}/file` && h.key === "test-control-key")).toBe(true);
  });

  it("verify=1 confirms a finished backup file is still there before the client downloads", async () => {
    const id = await clip("error", "ready");
    await status(id);
    const res = await status(id, "?verify=1");
    expect(res.body.status).toBe("done");
    expect(seen.some((h) => h.range === "bytes=0-0")).toBe(true);
  });

  it("re-renders a finished backup export whose file has gone, instead of a broken download", async () => {
    const id = await clip("error", "ready");
    await status(id);
    jobs.get(jobFor(id))!.status = "failed";          // file no longer served…
    jobs.get(jobFor(id))!.errorKind = "transient";     // …and the job relaunches on resubmit
    const res = await status(id, "?verify=1");
    expect(["pending", "done"]).toContain(res.body.status);
    expect(res.body.status).not.toBe("error");
  });
});

describe("Method A overflow to vps1", () => {
  it("uses a free local slot instead of sending work to vps1", async () => {
    exportMocks.primaryEnabled = true;
    const id = await clip(null);

    const res = await request(app).post(`/api/user-clips/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    await waitForExportStatus(id, "done");

    expect(exportMocks.renderClip).toHaveBeenCalledTimes(1);
    expect(seen.some((entry) => entry.url === "/export/clip")).toBe(false);
    expect((await rowOf(id)).exportedUrl).toBe(`https://storage.test/clips/${id}.mp4`);
  });

  it("hands overflow to vps1 and keeps duplicate requests from starting locally", async () => {
    exportMocks.primaryEnabled = true;
    const gate = deferred<void>();
    const localBlocker = renderQueue.run("overflow-test-blocker", () => gate.promise);
    await tick();

    try {
      const id = await clip(null, "running");
      const res = await request(app).post(`/api/user-clips/${id}/export`);
      expect(res.status).toBe(200);
      await waitForExportStatus(id, "pending_vps1_overflow");

      const polled = await status(id);
      expect(polled.body).toMatchObject({
        status: "pending",
        method: "backup",
        progress: "backup",
        backupProgress: 40,
      });
      const duplicate = await request(app).post(`/api/user-clips/${id}/export`);
      expect(duplicate.body.status).toBe("pending");
      expect(exportMocks.renderClip).not.toHaveBeenCalled();
      expect((await rowOf(id)).exportStatus).toBe("pending_vps1_overflow");
      expect(seen.some((entry) => entry.url === "/export/clip")).toBe(true);
    } finally {
      gate.resolve();
      await localBlocker;
    }
  });

  it("queues locally when vps1 is disabled and resumes after local capacity opens", async () => {
    exportMocks.primaryEnabled = true;
    exportMocks.backupEnabled = false;
    const gate = deferred<void>();
    const localBlocker = renderQueue.run("disabled-backup-blocker", () => gate.promise);
    await tick();

    try {
      const id = await clip(null);
      const res = await request(app).post(`/api/user-clips/${id}/export`);
      expect(res.body.status).toBe("pending");
      await tick();
      expect((await rowOf(id)).exportStatus).toBe("pending");
      expect(exportMocks.renderClip).not.toHaveBeenCalled();
      expect(seen.some((entry) => entry.url === "/export/clip")).toBe(false);

      gate.resolve();
      await localBlocker;
      await waitForExportStatus(id, "done");
      expect(exportMocks.renderClip).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await localBlocker;
    }
  });

  it("falls back to the local queue immediately when vps1 is unreachable", async () => {
    exportMocks.primaryEnabled = true;
    const gate = deferred<void>();
    const localBlocker = renderQueue.run("unreachable-backup-blocker", () => gate.promise);
    await tick();

    try {
      const id = await clip(null);
      unreachableSubmit.add(id);
      const res = await request(app).post(`/api/user-clips/${id}/export`);
      expect(res.body.status).toBe("pending");
      await waitForExportStatus(id, "pending_local_fallback");
      expect(exportMocks.renderClip).not.toHaveBeenCalled();

      gate.resolve();
      await localBlocker;
      await waitForExportStatus(id, "done");
      expect(exportMocks.renderClip).toHaveBeenCalledTimes(1);
      expect((await rowOf(id)).exportedUrl).toBe(`https://storage.test/clips/${id}.mp4`);
    } finally {
      gate.resolve();
      await localBlocker;
    }
  });

  it("falls back locally when an accepted vps1 overflow job fails", async () => {
    exportMocks.primaryEnabled = true;
    const gate = deferred<void>();
    const localBlocker = renderQueue.run("failed-backup-blocker", () => gate.promise);
    await tick();

    try {
      const id = await clip(null, "running");
      const res = await request(app).post(`/api/user-clips/${id}/export`);
      expect(res.body.status).toBe("pending");
      await waitForExportStatus(id, "pending_vps1_overflow");
      jobs.get(jobFor(id))!.status = "failed";
      jobs.get(jobFor(id))!.errorKind = "permanent";

      const polled = await status(id);
      expect(polled.body).toMatchObject({ status: "pending", method: "primary" });
      expect((await rowOf(id)).exportStatus).toBe("pending_local_fallback");
      expect(exportMocks.renderClip).not.toHaveBeenCalled();

      gate.resolve();
      await localBlocker;
      await waitForExportStatus(id, "done");
      expect(exportMocks.renderClip).toHaveBeenCalledTimes(1);
      expect((await rowOf(id)).exportedUrl).toBe(`https://storage.test/clips/${id}.mp4`);
    } finally {
      gate.resolve();
      await localBlocker;
    }
  });
});
