/**
 * End-to-end coverage for the share card.
 *
 * This is the one path in the product a stranger sees first, and it has to work
 * with no session, no JavaScript and no app. So the whole route runs for real
 * here: a real MP4 on a local origin, real FFmpeg producing the poster, the real
 * upload path, and the real proxy serving it back. Only the network hop to Bunny
 * Storage is doubled, by a fetch shim that maps the storage host onto a local
 * server and keeps the bytes in memory.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

process.env.BUNNY_STORAGE_HOSTNAME = "fake-storage.local";
process.env.BUNNY_STORAGE_ZONE = "galaxyfield";
process.env.BUNNY_STORAGE_API_KEY = "storage-key";
process.env.BUNNY_STORAGE_CDN_URL = "https://fake-cdn.local";
process.env.CLIP_SHARE_URL_SECRET = "share-secret";
process.env.PUBLIC_SHARE_BASE_URL = "https://replayjo.test";

const { db, usersTable, userClipsTable } = await import("@workspace/db");
const { inArray, eq } = await import("drizzle-orm");
const { shareToken } = await import("../lib/shareCard");

const TAG = `sh_${Date.now()}`;
let app: Express;
let origin: http.Server;
let originUrl: string;
let userId: number;
let readyClipId: number;
let pendingClipId: number;
let hiddenClipId: number;
let dir: string;
let mp4: Buffer;

/** Objects the fake Bunny Storage holds, keyed by path. */
const stored = new Map<string, Buffer>();
let realFetch: typeof fetch;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-"));
  const src = path.join(dir, "clip.mp4");
  // 6 seconds of real, non-black video at the export's output geometry.
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi",
    "-i", "testsrc2=s=1920x1080:r=25:d=6", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-y", src]);
  mp4 = fs.readFileSync(src);

  origin = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)!;
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : mp4.length - 1;
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${mp4.length}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
      });
      res.end(mp4.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(mp4.length) });
    res.end(mp4);
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originUrl = `http://127.0.0.1:${(origin.address() as { port: number }).port}`;

  // Stand in for Bunny Storage: PUT keeps the bytes, GET serves them with Range.
  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://fake-storage.local/")) return realFetch(input, init);
    if (init?.headers?.AccessKey !== "storage-key") return new Response("no key", { status: 401 });

    const key = url.replace("https://fake-storage.local/galaxyfield/", "");
    if (init?.method === "PUT") {
      stored.set(key, Buffer.from(await new Response(init.body).arrayBuffer()));
      return new Response("", { status: 201 });
    }
    const body = key === "clip.mp4" ? mp4 : stored.get(key);
    if (!body) return new Response("missing", { status: 404 });

    const range = init?.headers?.Range as string | undefined;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)!;
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;
      return new Response(body.subarray(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    return new Response(body, { status: 200, headers: { "Content-Length": String(body.length) } });
  });

  const { default: shareRouter } = await import("./share");
  app = express();
  app.use(shareRouter);

  const [user] = await db.insert(usersTable)
    .values({ name: "Mohammed", email: `share_${TAG}@test.local` })
    .returning({ id: usersTable.id });
  userId = user.id;

  const mk = async (overrides: Record<string, unknown>) => {
    const [row] = await db.insert(userClipsTable).values({
      userId, videoId: `vid_${TAG}`, title: "Volley from the edge of the box",
      startTime: "0", endTime: "1", cropPath: [], aspectRatio: "16:9",
      visibility: "private", ...overrides,
    } as never).returning({ id: userClipsTable.id });
    return row.id;
  };
  readyClipId = await mk({ exportStatus: "done", exportedUrl: `${originUrl}/clip.mp4` });
  pendingClipId = await mk({ title: "Still rendering" });
  hiddenClipId = await mk({ exportStatus: "done", exportedUrl: `${originUrl}/clip.mp4`, isHidden: true });
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(userClipsTable).where(inArray(userClipsTable.userId, [userId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [userId]));
  await new Promise<void>((r) => origin.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const cardUrl = (id: number, tok = shareToken(id)) => `/s/${id}/${tok}`;

describe("the card", () => {
  it("renders with the tags that decide the WhatsApp preview", async () => {
    const res = await request(app).get(cardUrl(readyClipId));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);

    const html = res.text;
    expect(html).toContain(`<meta property="og:image:width" content="1200" />`);
    expect(html).toContain(`<meta property="og:image:height" content="630" />`);
    expect(html).toContain(`content="summary_large_image"`);
    expect(html).toContain(`https://replayjo.test/s/${readyClipId}/${shareToken(readyClipId)}/poster.jpg`);
    expect(html).toContain(`<meta property="og:video:type" content="video/mp4" />`);
    expect(html).toContain("Volley from the edge of the box");
    expect(html).toContain("Clipped by Mohammed");
    // A muted inline autoplay player, and nothing in front of it.
    expect(html).toMatch(/<video[^>]*autoplay[^>]*>/s);
    expect(html.toLowerCase()).not.toMatch(/sign in|log in|install the app/);
  }, 180_000);

  it("is publicly cacheable — a crawler never sends a cookie", async () => {
    const res = await request(app).get(cardUrl(readyClipId));
    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(res.headers["cache-control"]).not.toMatch(/no-store/);
  });

  it("actually generated a poster and recorded where it came from", async () => {
    await request(app).get(cardUrl(readyClipId));
    const [row] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, readyClipId));
    expect(row.posterPath).toBe(`posters/${readyClipId}-${shareToken(readyClipId)}.jpg`);
    expect(Number(row.posterAtSec)).toBeGreaterThan(0);
    expect(stored.has(row.posterPath!)).toBe(true);
  }, 180_000);

  it("degrades to a poster-only card while the export is still rendering", async () => {
    const res = await request(app).get(cardUrl(pendingClipId));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("og:video");
    expect(res.text).toContain("still rendering");
  }, 60_000);
});

describe("what is not reachable", () => {
  it("404s a wrong token without revealing that the clip exists", async () => {
    const res = await request(app).get(cardUrl(readyClipId, "0".repeat(20)));
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Volley");
  });

  it("404s an id whose token belongs to a different clip", async () => {
    expect((await request(app).get(cardUrl(readyClipId, shareToken(pendingClipId)))).status).toBe(404);
  });

  it("404s an admin-hidden clip even with the right token", async () => {
    expect((await request(app).get(cardUrl(hiddenClipId))).status).toBe(404);
  });

  it("404s an id that does not exist", async () => {
    expect((await request(app).get(cardUrl(99_999_999))).status).toBe(404);
  });
});

describe("the assets", () => {
  it("serves the poster as a real JPEG of the declared size", async () => {
    const res = await request(app).get(`${cardUrl(readyClipId)}/poster.jpg`).buffer(true)
      .parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toMatch(/public/);

    const p = path.join(dir, "poster.jpg");
    fs.writeFileSync(p, res.body as Buffer);
    const dims = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", p]).toString().trim();
    expect(dims).toBe("1200x630");
  }, 180_000);

  it("answers a ranged request with 206 — iOS will not start playback otherwise", async () => {
    const res = await request(app).get(`${cardUrl(readyClipId)}/clip.mp4`).set("Range", "bytes=0-99");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-99/${mp4.length}`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
  }, 60_000);

  it("never exposes the storage key to the client", async () => {
    const res = await request(app).get(`${cardUrl(readyClipId)}/clip.mp4`).set("Range", "bytes=0-9");
    expect(JSON.stringify(res.headers)).not.toContain("storage-key");
  }, 60_000);

  it("404s assets on a wrong token too", async () => {
    expect((await request(app).get(`${cardUrl(readyClipId, "0".repeat(20))}/poster.jpg`)).status).toBe(404);
    expect((await request(app).get(`${cardUrl(readyClipId, "0".repeat(20))}/clip.mp4`)).status).toBe(404);
  });
});
