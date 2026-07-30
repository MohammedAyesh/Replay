/**
 * End-to-end coverage for the clip download path.
 *
 * GET /user-clips/:id/download proxies the rendered MP4 from Bunny Storage
 * through this server, so the two things worth pinning down are that a real
 * byte stream survives the round trip intact, and that the ownership check
 * actually gates it. Both have been broken before: the export used to live at a
 * guessable `clips/<id>.mp4` path that made the ownership check decorative, and
 * the proxy used to `pipe()` without teardown, so an abandoned download left the
 * upstream body draining into a detached stream.
 *
 * A local HTTP origin stands in for Bunny Storage, including its AccessKey
 * requirement, so nothing here touches the network.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import http from "http";
import crypto from "crypto";
import { db, usersTable, userClipsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);

/** The rendered MP4 the fake storage origin serves. Big enough to span chunks. */
const CLIP_BYTES = crypto.randomBytes(512 * 1024);
const STORAGE_KEY = process.env.BUNNY_STORAGE_API_KEY ?? "";

let origin: http.Server;
let originUrl: string;
/** Requests the fake origin saw, so we can assert on auth headers and aborts. */
let originHits: { url: string; accessKey: string | undefined; aborted: boolean }[] = [];

let app: Express;
const TAG = `dl_${Date.now()}`;
let ownerId: number;
let strangerId: number;

async function insertClip(userId: number, exportedUrl: string | null, title = "My Clip") {
  const [row] = await db
    .insert(userClipsTable)
    .values({
      userId,
      videoId: `vid_${TAG}`,
      title,
      startTime: "0",
      endTime: "1",
      cropPath: [],
      aspectRatio: "16:9",
      visibility: "private",
      exportStatus: exportedUrl ? "done" : null,
      exportedUrl,
    })
    .returning({ id: userClipsTable.id });
  return row.id;
}

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    const hit = { url: req.url ?? "", accessKey: req.headers.accesskey as string | undefined, aborted: false };
    originHits.push(hit);
    req.on("aborted", () => { hit.aborted = true; });

    if (req.url === "/missing.mp4") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (req.url === "/private.mp4" && hit.accessKey !== STORAGE_KEY) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    if (req.url === "/slow.mp4") {
      // Headers, one chunk, then hang — stands in for a stalled CDN so we can
      // abandon the request mid-body.
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(CLIP_BYTES.length) });
      res.write(CLIP_BYTES.subarray(0, 1024));
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(CLIP_BYTES.length) });
    res.end(CLIP_BYTES);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const addr = origin.address() as { port: number };
  originUrl = `http://127.0.0.1:${addr.port}`;

  const { default: userClipsRouter } = await import("./userClips");
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", userClipsRouter);

  const [owner] = await db
    .insert(usersTable)
    .values({ name: "Owner", email: `owner_${TAG}@test.local`, isGuest: false, profileComplete: false })
    .returning({ id: usersTable.id });
  const [stranger] = await db
    .insert(usersTable)
    .values({ name: "Stranger", email: `stranger_${TAG}@test.local`, isGuest: false, profileComplete: false })
    .returning({ id: usersTable.id });
  ownerId = owner.id;
  strangerId = stranger.id;
});

afterAll(async () => {
  await db.delete(userClipsTable).where(inArray(userClipsTable.userId, [ownerId, strangerId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [ownerId, strangerId]));
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

describe("GET /user-clips/:id/download", () => {
  it("streams the rendered MP4 back byte-for-byte", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);
    const clipId = await insertClip(ownerId, `${originUrl}/clip.mp4`);

    const res = await request(app).get(`/api/user-clips/${clipId}/download`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-length"]).toBe(String(CLIP_BYTES.length));
    expect(Buffer.compare(res.body as Buffer, CLIP_BYTES)).toBe(0);
  });

  it("sends the Bunny Storage AccessKey upstream", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);
    const clipId = await insertClip(ownerId, `${originUrl}/private.mp4`);
    originHits = [];

    const res = await request(app).get(`/api/user-clips/${clipId}/download`);

    expect(res.status).toBe(200);
    expect(originHits.at(-1)?.accessKey).toBe(STORAGE_KEY);
  });

  it("sanitises the filename in Content-Disposition", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);
    const clipId = await insertClip(ownerId, `${originUrl}/clip.mp4`, 'Goal! "best" / 90+3\'');

    const res = await request(app).get(`/api/user-clips/${clipId}/download`);

    expect(res.status).toBe(200);
    const cd = res.headers["content-disposition"];
    // A stray quote would terminate the header value early and let the rest of
    // the title be read as parameters.
    expect(cd).toMatch(/^attachment; filename="[A-Za-z0-9_-]+\.mp4"$/);
  });

  it("refuses to serve another user's clip", async () => {
    const clipId = await insertClip(ownerId, `${originUrl}/clip.mp4`);
    mockedGetLocalUserId.mockResolvedValue(strangerId);

    const res = await request(app).get(`/api/user-clips/${clipId}/download`);

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("exportedUrl");
  });

  it("rejects an unauthenticated download", async () => {
    const clipId = await insertClip(ownerId, `${originUrl}/clip.mp4`);
    mockedGetLocalUserId.mockResolvedValue(null);

    const res = await request(app).get(`/api/user-clips/${clipId}/download`);

    expect(res.status).toBe(401);
  });

  it("404s a clip that has not been exported yet", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);
    const clipId = await insertClip(ownerId, null);

    const res = await request(app).get(`/api/user-clips/${clipId}/download`);

    expect(res.status).toBe(404);
  });

  it("502s when the export is gone from storage, without hanging", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);
    const clipId = await insertClip(ownerId, `${originUrl}/missing.mp4`);

    const res = await request(app).get(`/api/user-clips/${clipId}/download`);

    expect(res.status).toBe(502);
  });

  it("aborts the upstream fetch when the client goes away mid-download", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);
    const clipId = await insertClip(ownerId, `${originUrl}/slow.mp4`);
    originHits = [];

    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;

    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/user-clips/${clipId}/download`, (res) => {
        res.once("data", () => {
          // Walk away part-way through, the way closing a tab does.
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => resolve());
    });

    // Give the abort a moment to propagate to the upstream socket.
    await new Promise((r) => setTimeout(r, 500));
    expect(originHits.at(-1)?.aborted).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
