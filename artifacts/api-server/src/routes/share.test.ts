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
process.env.BUNNY_CDN_HOSTNAME = "private-cdn.local";
process.env.CLIP_SHARE_URL_SECRET = "share-secret";
process.env.PUBLIC_SHARE_BASE_URL = "https://replayjo.test";

const { db, usersTable, userClipsTable, fieldsTable, footageRequestsTable, varMarksTable } = await import("@workspace/db");
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
let ownerFieldId: number;
let ownerRequestIds: number[] = [];
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
    if (url === "https://private-cdn.local/private-video-guid/playlist.m3u8") {
      return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvideo/segment-001.ts\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (url === "https://private-cdn.local/private-video-guid/video/segment-001.ts") {
      return new Response("segment-bytes", {
        status: 200,
        headers: { "content-type": "video/mp2t", "content-length": "13" },
      });
    }
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

  const [ownerField] = await db.insert(fieldsTable).values({
    name: `Owner Share Field ${TAG}`,
    location: "Test",
  }).returning({ id: fieldsTable.id });
  ownerFieldId = ownerField.id;
  const now = new Date();
  const ownerRows = await db.insert(footageRequestsTable).values([
    {
      fieldId: ownerFieldId,
      cameraId: "share-camera",
      requestedBy: userId,
      startLocal: "2026-09-21 10:00",
      endLocal: "2026-09-21 10:15",
      requestedSeconds: 900,
      status: "ready",
      videoId: "private-video-guid",
      shareToken: "0123456789abcdef0123456789abcdef",
      shareExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    },
    {
      fieldId: ownerFieldId,
      cameraId: "share-camera",
      requestedBy: userId,
      startLocal: "2026-09-21 11:00",
      endLocal: "2026-09-21 11:15",
      requestedSeconds: 900,
      status: "ready",
      videoId: "private-revoked-video",
      shareToken: "abcdefabcdefabcdefabcdefabcdefab",
      shareExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      shareRevoked: true,
    },
    {
      fieldId: ownerFieldId,
      cameraId: "share-camera",
      requestedBy: userId,
      startLocal: "2026-09-21 12:00",
      endLocal: "2026-09-21 12:15",
      requestedSeconds: 900,
      status: "ready",
      videoId: "private-expired-video",
      shareToken: "fedcbafedcbafedcbafedcbafedcbafe",
      shareExpiresAt: new Date(now.getTime() - 60 * 1000),
    },
  ]).returning({ id: footageRequestsTable.id });
  ownerRequestIds = ownerRows.map(({ id }) => id);
  await db.insert(varMarksTable).values({
    footageRequestId: ownerRequestIds[0],
    atUtc: new Date("2026-09-21T07:01:30.000Z"),
    kind: "goal",
    note: "Top corner",
    createdBy: userId,
  });
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(userClipsTable).where(inArray(userClipsTable.userId, [userId]));
  if (ownerRequestIds.length) {
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, ownerRequestIds));
  }
  await db.delete(fieldsTable).where(eq(fieldsTable.id, ownerFieldId));
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

describe("path prefixes", () => {
  // The router in front of this app and the SPA decides by path prefix. Where
  // only /api reaches this process, a bare /s link lands on the SPA and the
  // crawler quietly gets the generic card, so both forms have to answer.
  it("answers on /api/s/... as well as /s/...", async () => {
    const tok = shareToken(readyClipId);
    const viaApi = await request(app).get(`/api/s/${readyClipId}/${tok}`);
    expect(viaApi.status).toBe(200);
    expect(viaApi.text).toContain("og:image:width");

    const poster = await request(app).get(`/api/s/${readyClipId}/${tok}/poster.jpg`);
    expect(poster.status).toBe(200);
    expect(poster.headers["content-type"]).toBe("image/jpeg");

    const mp4 = await request(app).get(`/api/s/${readyClipId}/${tok}/clip.mp4`).set("Range", "bytes=0-9");
    expect(mp4.status).toBe(206);
  }, 180_000);

  it("answers owner watch pages and manifests on the /api fallback prefix", async () => {
    const ownerToken = "0123456789abcdef0123456789abcdef";
    const page = await request(app).get(`/api/w/${ownerToken}`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);

    const manifest = await request(app).get(`/api/w/${ownerToken}/manifest.m3u8`);
    expect(manifest.status).toBe(200);
    expect(manifest.text).toMatch(/^#EXTM3U/);
  });

  it("escapes the /api no-store block even when served under /api", async () => {
    // Reproduces app.ts's ordering: the share router is mounted before the
    // middleware that stamps no-store and Vary on everything under /api. Get
    // that order wrong and the card still renders but becomes uncacheable, and
    // a Vary on Cookie fragments every crawler fetch — silently, since nothing
    // about the page looks different.
    const stacked = express();
    const { default: sr } = await import("./share");
    stacked.use(sr);
    stacked.use("/api", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Cookie, Authorization");
      next();
    });
    stacked.use("/api", (_req, res) => res.status(404).end());

    const tok = shareToken(readyClipId);
    const viaApi = await request(stacked).get(`/api/s/${readyClipId}/${tok}`);
    expect(viaApi.status).toBe(200);
    expect(viaApi.headers["cache-control"]).toMatch(/public/);
    expect(viaApi.headers["cache-control"]).not.toMatch(/no-store/);
    expect(viaApi.headers["vary"]).toBeUndefined();
  }, 180_000);

  it("emits whichever form SHARE_PATH_PREFIX selects", async () => {
    const saved = process.env.SHARE_PATH_PREFIX;
    process.env.SHARE_PATH_PREFIX = "/api/s";
    vi.resetModules();
    try {
      const { shareCardPath: prefixed } = await import("../lib/shareCard");
      expect(prefixed(readyClipId)).toBe(`/api/s/${readyClipId}/${shareToken(readyClipId)}`);
    } finally {
      if (saved === undefined) delete process.env.SHARE_PATH_PREFIX;
      else process.env.SHARE_PATH_PREFIX = saved;
      vi.resetModules();
    }
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

describe("public owner watch links", () => {
  const token = "0123456789abcdef0123456789abcdef";

  it("serves a bilingual watch page without exposing the private CDN URL", async () => {
    const res = await request(app).get(`/w/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain("English");
    expect(res.text).toContain("العربية");
    expect(res.text).toContain("REPLAY");
    expect(res.text).toContain("#D4FF4F");
    expect(res.text).toContain("#0B0F1A");
    expect(res.text).toContain("Owner Share Field");
    expect(res.text).toContain("Monday 21 September · 10:00–10:15");
    expect(res.text).toContain("متاح حتى");
    expect(res.text).toContain("Want your own clips?");
    expect(res.text).toContain("بدك مقاطعك الخاصة؟");
    expect(res.text).toContain("controlsList=\"nodownload noplaybackrate\"");
    expect(res.text).toContain("og:title");
    expect(res.text).toContain("https://replayjo.test");
    expect(res.text).not.toContain("Owner footage from");
    expect(res.text).not.toContain("private-video-guid");
    expect(res.text).not.toContain("private-cdn.local");
  });

  it("returns active owner-share metadata as JSON", async () => {
    const res = await request(app).get(`/w/${token}/meta`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      token,
      fieldName: expect.stringContaining("Owner Share Field"),
      startLocal: "2026-09-21 10:00",
      endLocal: "2026-09-21 10:15",
    });
    expect(res.body.expiresAt).toBeTruthy();
    expect(res.body.keyMoments).toEqual([
      { kind: "goal", note: "Top corner", offsetSeconds: 90 },
    ]);
  });

  it("uses the branded bilingual 404 for inactive owner-share metadata", async () => {
    const res = await request(app).get("/w/fedcbafedcbafedcbafedcbafedcbafe/meta");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("This link is no longer available.");
    expect(res.text).toContain("هذا الرابط لم يعد متاحاً.");
  });

  it("rewrites manifests and segments through opaque token-bound resources", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const manifest = await request(app).get(`/w/${token}/manifest.m3u8`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers["content-type"]).toContain("mpegurl");
      expect(manifest.text).not.toContain("private-video-guid");
      expect(manifest.text).not.toContain("private-cdn.local");
      const resourcePath = manifest.text.trim().split("\n").at(-1);
      expect(resourcePath).toMatch(
        new RegExp(`/w/${token}/resource/[A-Za-z0-9_-]+\\.[0-9a-f]{32}$`),
      );

      const tampered = `${resourcePath!.slice(0, -1)}${resourcePath!.endsWith("0") ? "1" : "0"}`;
      expect((await request(app).get(tampered)).status).toBe(404);

      vi.advanceTimersByTime(20 * 60 * 1000);
      const segment = await request(app).get(resourcePath!);
      expect(segment.status).toBe(200);
      expect(Buffer.isBuffer(segment.body)).toBe(true);
      expect(segment.body.toString()).toBe("segment-bytes");

      await db
        .update(footageRequestsTable)
        .set({ shareRevoked: true })
        .where(eq(footageRequestsTable.shareToken, token));
      expect((await request(app).get(resourcePath!)).status).toBe(404);
    } finally {
      await db
        .update(footageRequestsTable)
        .set({ shareRevoked: false })
        .where(eq(footageRequestsTable.shareToken, token));
      vi.useRealTimers();
    }
  });

  it.each([
    "0123456789abcdef0123456789abcde0",
    "abcdefabcdefabcdefabcdefabcdefab",
    "fedcbafedcbafedcbafedcbafedcbafe",
    "not-a-token",
  ])("collapses unknown, revoked, and expired tokens to the same 404", async (invalidToken) => {
    const res = await request(app).get(`/w/${invalidToken}`);
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("This link is no longer available.");
    expect(res.text).toContain("هذا الرابط لم يعد متاحاً.");
  });
});
