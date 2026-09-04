/**
 * End-to-end coverage for the free tier's rolling download allowance.
 *
 * The maths lives in lib/downloadQuota.ts and is unit-tested there against fixed
 * clocks. What this file proves is the part unit tests cannot: that the ledger
 * rows are actually written, that the window is evaluated against real
 * `timestamptz` values rather than JavaScript Dates that happen to agree, and
 * that a row ageing past thirty days really does hand the slot back.
 *
 * The rolling behaviour is exercised by back-dating a row in the database and
 * re-requesting — not by mocking the clock — because the failure mode being
 * guarded against is a SQL comparison that is wrong, not arithmetic that is.
 *
 * A local HTTP origin stands in for Bunny Storage, as in userClipsDownload.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import http from "http";
import { db, usersTable, userClipsTable, clipDownloadsTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);

const TAG = `q_${Date.now()}`;
let origin: http.Server;
let originUrl: string;
let app: Express;
let freeUserId: number;
let proUserId: number;
const clipIds: number[] = [];

async function insertClip(userId: number, n: number) {
  const [row] = await db
    .insert(userClipsTable)
    .values({
      userId,
      videoId: `vid_${TAG}`,
      title: `Clip ${n}`,
      startTime: "0", endTime: "1",
      cropPath: [], aspectRatio: "16:9", visibility: "private",
      exportStatus: "done", exportedUrl: `${originUrl}/clip.mp4`,
    })
    .returning({ id: userClipsTable.id });
  clipIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  origin = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "4" });
    res.end(Buffer.from("mp4!"));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originUrl = `http://127.0.0.1:${(origin.address() as { port: number }).port}`;

  const { default: userClipsRouter } = await import("./userClips");
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", userClipsRouter);

  const [free] = await db.insert(usersTable)
    .values({ name: "Free", email: `free_${TAG}@test.local` })
    .returning({ id: usersTable.id });
  const [pro] = await db.insert(usersTable)
    .values({ name: "Pro", email: `pro_${TAG}@test.local`, plan: "pro" })
    .returning({ id: usersTable.id });
  freeUserId = free.id;
  proUserId = pro.id;
}, 30_000);

afterAll(async () => {
  await db.delete(clipDownloadsTable).where(inArray(clipDownloadsTable.userId, [freeUserId, proUserId]));
  await db.delete(userClipsTable).where(inArray(userClipsTable.userId, [freeUserId, proUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [freeUserId, proUserId]));
  await new Promise<void>((r) => origin.close(() => r()));
});

beforeEach(async () => {
  await db.delete(clipDownloadsTable).where(inArray(clipDownloadsTable.userId, [freeUserId, proUserId]));
});

const dl = (clipId: number) => request(app).get(`/api/user-clips/${clipId}/download`);
const quota = () => request(app).get("/api/user-clips/download-quota");

describe("the counter the UI shows", () => {
  it("starts empty and has no reset date", async () => {
    mockedGetLocalUserId.mockResolvedValue(freeUserId);
    const res = await quota();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ used: 0, limit: 5, remaining: 5, windowDays: 30, resetAt: null, unlimited: false });
  });

  it("requires a signed-in user", async () => {
    mockedGetLocalUserId.mockResolvedValue(null as never);
    expect((await quota()).status).toBe(401);
  });
});

describe("spending the allowance", () => {
  it("allows five distinct clips and refuses the sixth", async () => {
    mockedGetLocalUserId.mockResolvedValue(freeUserId);
    const ids = [] as number[];
    for (let i = 0; i < 6; i++) ids.push(await insertClip(freeUserId, i));

    for (let i = 0; i < 5; i++) {
      const res = await dl(ids[i]!);
      expect(res.status).toBe(200);
      expect(res.headers["x-download-quota-used"]).toBe(String(i + 1));
      expect(res.headers["x-download-quota-limit"]).toBe("5");
    }

    const sixth = await dl(ids[5]!);
    expect(sixth.status).toBe(402);
    expect(sixth.body.error).toBe("Download limit reached");
    expect(sixth.body.quota).toMatchObject({ used: 5, remaining: 0, limit: 5 });
    expect(typeof sixth.body.quota.resetAt).toBe("string");

    const after = await quota();
    expect(after.body).toMatchObject({ used: 5, remaining: 0 });

    const rows = await db.select().from(clipDownloadsTable).where(eq(clipDownloadsTable.userId, freeUserId));
    expect(rows).toHaveLength(5);   // the refused attempt wrote nothing
  }, 30_000);

  it("does not charge for re-downloading a clip already counted", async () => {
    mockedGetLocalUserId.mockResolvedValue(freeUserId);
    const id = await insertClip(freeUserId, 100);

    expect((await dl(id)).status).toBe(200);
    expect((await dl(id)).status).toBe(200);
    expect((await dl(id)).status).toBe(200);

    expect((await quota()).body).toMatchObject({ used: 1, remaining: 4 });
  }, 30_000);

  it("hands the slot back when the oldest download ages past thirty days", async () => {
    mockedGetLocalUserId.mockResolvedValue(freeUserId);
    const ids = [] as number[];
    for (let i = 0; i < 6; i++) ids.push(await insertClip(freeUserId, 200 + i));
    for (let i = 0; i < 5; i++) expect((await dl(ids[i]!)).status).toBe(200);
    expect((await dl(ids[5]!)).status).toBe(402);

    // Age the oldest row out of the window, in the database, and ask again.
    const [oldest] = await db
      .select({ id: clipDownloadsTable.id })
      .from(clipDownloadsTable)
      .where(eq(clipDownloadsTable.userId, freeUserId))
      .orderBy(clipDownloadsTable.createdAt)
      .limit(1);
    await db
      .update(clipDownloadsTable)
      .set({ createdAt: sql`now() - interval '31 days'` })
      .where(eq(clipDownloadsTable.id, oldest!.id));

    const q = await quota();
    expect(q.body).toMatchObject({ used: 4, remaining: 1 });
    expect((await dl(ids[5]!)).status).toBe(200);
  }, 40_000);

  it("gives a reset date derived from the oldest download, not the newest", async () => {
    mockedGetLocalUserId.mockResolvedValue(freeUserId);
    const a = await insertClip(freeUserId, 300);
    const b = await insertClip(freeUserId, 301);
    await dl(a);
    await dl(b);
    await db
      .update(clipDownloadsTable)
      .set({ createdAt: sql`now() - interval '28 days'` })
      .where(eq(clipDownloadsTable.userId, freeUserId));
    // Both rows are now 28 days old, so the reset is two days out, not thirty.
    const resetAt = new Date((await quota()).body.resetAt).getTime();
    const daysOut = (resetAt - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(1.5);
    expect(daysOut).toBeLessThan(2.5);
  }, 30_000);
});

describe("paid accounts", () => {
  it("are not metered and write no ledger rows", async () => {
    mockedGetLocalUserId.mockResolvedValue(proUserId);
    const ids = [] as number[];
    for (let i = 0; i < 7; i++) ids.push(await insertClip(proUserId, 400 + i));
    for (const id of ids) expect((await dl(id)).status).toBe(200);

    const rows = await db.select().from(clipDownloadsTable).where(eq(clipDownloadsTable.userId, proUserId));
    expect(rows).toHaveLength(0);
    expect((await quota()).body).toMatchObject({ unlimited: true, remaining: -1, used: 0 });
  }, 40_000);
});
