/**
 * The intro proxy exists because handing a browser a Bunny Storage URL gives it
 * a 401, and clip playback runs the intro before the clip — so the viewer got a
 * black player and a clip that never started. These tests pin the two things
 * that matter: the browser gets playable bytes without knowing any key, and the
 * key never leaves for anywhere except the storage host.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import http from "http";
import crypto from "crypto";
import { db, academiesTable, clipSettingsTable, fieldsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const KEY = process.env.BUNNY_STORAGE_API_KEY ?? "";
const INTRO_BYTES = crypto.randomBytes(64 * 1024);

let origin: http.Server;
let originHost: string;
let seenKeys: (string | undefined)[] = [];

let app: Express;
let fieldId: number;
let academyId: number;
let settingsId: number | null = null;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    seenKeys.push(req.headers.accesskey as string | undefined);
    // Stands in for Bunny Storage: no key, no bytes.
    if (req.headers.accesskey !== KEY) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    if (req.headers.range) {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range as string)!;
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : INTRO_BYTES.length - 1;
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${INTRO_BYTES.length}`,
        "Content-Length": String(end - start + 1),
      });
      res.end(INTRO_BYTES.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(INTRO_BYTES.length) });
    res.end(INTRO_BYTES);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  originHost = `127.0.0.1:${(origin.address() as { port: number }).port}`;
  // The route only attaches the key when the host matches this.
  process.env.BUNNY_STORAGE_HOSTNAME = originHost;

  const { default: clipIntroRouter } = await import("./clipIntro");
  app = express();
  app.use("/api", clipIntroRouter);

  const [field] = await db
    .insert(fieldsTable)
    .values({ name: `Intro Test Field ${Date.now()}`, location: "test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;

  const [academy] = await db
    .insert(academiesTable)
    .values({
      name: `Intro Test Academy ${Date.now()}`,
      fieldId,
      daysOfWeek: "",
      cameraIds: "",
      introVideoUrl: `http://${originHost}/academy-intros/1/intro.mp4`,
    })
    .returning({ id: academiesTable.id });
  academyId = academy.id;

  const [settings] = await db
    .insert(clipSettingsTable)
    .values({ introVideoUrl: `http://${originHost}/clip-intro/intro.mp4` })
    .returning({ id: clipSettingsTable.id });
  settingsId = settings.id;
});

afterAll(async () => {
  await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (settingsId != null) await db.delete(clipSettingsTable).where(inArray(clipSettingsTable.id, [settingsId]));
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

describe("GET /clip-intro/:scope", () => {
  it("serves the academy intro to a browser that sends no key", async () => {
    seenKeys = [];
    const res = await request(app).get(`/api/clip-intro/${academyId}`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(Buffer.compare(res.body as Buffer, INTRO_BYTES)).toBe(0);
    // The proxy supplied the key the browser could not.
    expect(seenKeys).toContain(KEY);
  });

  it("falls back to the global intro for a clip with no academy", async () => {
    const res = await request(app).get("/api/clip-intro/global");
    expect(res.status).toBe(200);
  });

  it("supports Range, which iOS requires to start playback at all", async () => {
    const res = await request(app).get(`/api/clip-intro/${academyId}`).set("Range", "bytes=0-99");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-99/${INTRO_BYTES.length}`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });

  it("takes a scope, never a URL, so it cannot be pointed at another host", async () => {
    for (const scope of [
      encodeURIComponent("http://evil.example.com/x.mp4"),
      "../../etc/passwd",
      "1e9999",
      "abc",
    ]) {
      const res = await request(app).get(`/api/clip-intro/${scope}`);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("404s a scope with no intro rather than serving someone else's", async () => {
    // An academy id that does not exist falls through to the global intro,
    // which is configured here; with it removed there is nothing to serve.
    await db.update(clipSettingsTable).set({ introVideoUrl: null });
    const res = await request(app).get("/api/clip-intro/global");
    expect(res.status).toBe(404);
    await db.update(clipSettingsTable).set({ introVideoUrl: `http://${originHost}/clip-intro/intro.mp4` });
  });
});
