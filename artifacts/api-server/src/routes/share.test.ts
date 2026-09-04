import { spawn } from "child_process";
import http from "http";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, userClipsTable, usersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createClipShareToken } from "../lib/shareLinks";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";
import shareRouter from "./share";
import userClipsRouter from "./userClips";

function runBinary(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${binary} exited ${code}: ${stderr.slice(-1000)}`));
      else resolve(Buffer.concat(stdout));
    });
  });
}

const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const TAG = `share_${Date.now()}`;
let origin: http.Server;
let originUrl: string;
let app: Express;
let ownerId: number;
let publicClipId: number;
let hiddenClipId: number;
let mp4Bytes: Buffer;

beforeAll(async () => {
  mp4Bytes = await runBinary("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-movflags", "+frag_keyframe+empty_moov",
    "-f", "mp4", "pipe:1",
  ]);
  origin = http.createServer((req, res) => {
    if (req.url !== "/clip.mp4") {
      res.writeHead(404).end();
      return;
    }
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : mp4Bytes.length - 1;
        const boundedEnd = Math.min(end, mp4Bytes.length - 1);
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Length": String(boundedEnd - start + 1),
          "Content-Range": `bytes ${start}-${boundedEnd}/${mp4Bytes.length}`,
          "Accept-Ranges": "bytes",
        });
        res.end(mp4Bytes.subarray(start, boundedEnd + 1));
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(mp4Bytes.length),
      "Accept-Ranges": "bytes",
    });
    res.end(mp4Bytes);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  originUrl = `http://127.0.0.1:${(origin.address() as { port: number }).port}`;

  const [owner] = await db
    .insert(usersTable)
    .values({ name: "Creator", email: `creator_${TAG}@test.local`, isGuest: false, profileComplete: false })
    .returning({ id: usersTable.id });
  ownerId = owner.id;
  const [publicClip] = await db
    .insert(userClipsTable)
    .values({
      userId: ownerId,
      videoId: `video_${TAG}`,
      title: `<script>alert("x")</script>`,
      startTime: "0",
      endTime: "1",
      cropPath: [],
      aspectRatio: "16:9",
      visibility: "public",
      isHidden: false,
      exportStatus: "done",
      exportedUrl: `${originUrl}/clip.mp4`,
      posterStoragePath: `clip-posters/${TAG}.jpg`,
    })
    .returning({ id: userClipsTable.id });
  publicClipId = publicClip.id;
  const [hiddenClip] = await db
    .insert(userClipsTable)
    .values({
      userId: ownerId,
      videoId: `hidden_${TAG}`,
      title: "Hidden",
      startTime: "0",
      endTime: "1",
      cropPath: [],
      aspectRatio: "16:9",
      visibility: "public",
      isHidden: true,
      exportStatus: "done",
      exportedUrl: `${originUrl}/clip.mp4`,
    })
    .returning({ id: userClipsTable.id });
  hiddenClipId = hiddenClip.id;

  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(shareRouter);
  app.use("/api", userClipsRouter);
});

afterAll(async () => {
  await db.delete(userClipsTable).where(inArray(userClipsTable.id, [publicClipId, hiddenClipId]));
  await db.delete(usersTable).where(eq(usersTable.id, ownerId));
  if (origin) {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});

describe("public clip sharing", () => {
  it("escapes hostile metadata and puts the video first in the body", async () => {
    const token = createClipShareToken(publicClipId);
    const res = await request(app).get(`/share/clips/${publicClipId}/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert");
    expect(res.text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(res.text).toMatch(/<body>\s*<video autoplay muted playsinline/);
    expect(res.text).toContain('<meta property="og:image:width" content="1200">');
    expect(res.text).toContain('<meta property="og:image:height" content="630">');
    expect(res.text).toContain('<meta property="og:video"');
  });

  it("makes wrong, missing, and admin-hidden clips indistinguishable 404s", async () => {
    const token = createClipShareToken(publicClipId);
    const wrong = await request(app).get(`/share/clips/${publicClipId}/${token.slice(0, -1)}0`);
    const missing = await request(app).get("/share/clips/999999/not-a-token");
    const hidden = await request(app).get(`/share/clips/${hiddenClipId}/${createClipShareToken(hiddenClipId)}`);
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(wrong.text).toBe(missing.text);
    expect(missing.text).toBe(hidden.text);
  });

  it("proxies a real MP4 range with 206 and Content-Range", async () => {
    const token = createClipShareToken(publicClipId);
    const res = await request(app)
      .get(`/share/clips/${publicClipId}/${token}/video`)
      .set("Range", "bytes=0-9")
      .buffer();
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-9/${mp4Bytes.length}`);
    expect(res.body.length).toBe(10);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("returns an absolute share link for the owner", async () => {
    mockedGetLocalUserId.mockResolvedValue(ownerId);
    const res = await request(app).get(`/api/user-clips/${publicClipId}/share-link`);
    expect(res.status).toBe(200);
    expect(res.body.shareUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:`));
    expect(res.body.shareUrl).toContain(`/share/clips/${publicClipId}/`);
    expect(res.body.posterUrl).toContain("/poster");
  });
});