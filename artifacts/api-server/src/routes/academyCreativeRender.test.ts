import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { academiesTable, academyAdMediaTable, academyMembersTable, academyRecordingsTable, db, fieldsTable, recordingsTable, usersTable } from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }),
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import renderRouter, { tintFromQuery } from "./academyCreativeRender";
import { clearTintedCache, rescanPlates } from "../lib/creative/renderMedia";
import { canViewBunnyVideo } from "../lib/publicFootage";
import { logger } from "../lib/logger";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let academyId: number;
let otherAcademyId: number;
let fieldId: number;
let greyMediaId: number;
let otherMediaId: number;
let artDir: string;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (p: string, academy = academyId) => `/api/academy/console/academies/${academy}/creative${p}`;

/** A flat grey PNG (w×h). */
function greyPng(w: number, h: number, v = 128): Buffer {
  const c = createCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = `rgb(${v},${v},${v})`;
  x.fillRect(0, 0, w, h);
  return c.toBuffer("image/png");
}

async function pixel(png: Buffer, x: number, y: number) {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, rgba: [...ctx.getImageData(x, y, 1, 1).data] };
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  artDir = fs.mkdtempSync(path.join(os.tmpdir(), "creative-art-"));
  fs.mkdirSync(path.join(artDir, "bg", "broadcast"), { recursive: true });
  fs.writeFileSync(path.join(artDir, "bg", "broadcast", "1-post.png"), greyPng(40, 50, 100));
  fs.writeFileSync(path.join(artDir, "bg", "broadcast", "1-story.png"), greyPng(36, 64, 200));
  fs.writeFileSync(path.join(artDir, "bg", "broadcast", "2-post.png"), greyPng(40, 50, 60));
  fs.writeFileSync(path.join(artDir, "bg", "broadcast", "notes.txt"), "ignored");
  process.env.CREATIVE_ARTWORK_DIR = artDir;
  rescanPlates();
  clearTintedCache();

  app = express();
  app.use(express.json());
  app.use("/api", renderRouter);
  app.get("/test/hls-auth/:videoId", async (req, res): Promise<void> => {
    const videoId = Array.isArray(req.params.videoId) ? req.params.videoId[0] : req.params.videoId;
    res.status(videoId && await canViewBunnyVideo(req, videoId) ? 200 : 404).end();
  });
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-render-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-render-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Render field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const academies = await db.insert(academiesTable).values([
    { name: `Render Academy ${tag}`, fieldId: field.id },
    { name: `Other Render ${tag}`, fieldId: field.id },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
  const media = await db.insert(academyAdMediaTable).values([
    { academyId, kind: "image", name: "Grey", imageData: `data:image/png;base64,${greyPng(20, 20).toString("base64")}`, status: "ready" },
    { academyId: otherAcademyId, kind: "image", name: "Not yours", imageData: `data:image/png;base64,${greyPng(20, 20).toString("base64")}`, status: "ready" },
  ]).returning({ id: academyAdMediaTable.id });
  [greyMediaId, otherMediaId] = media.map((m) => m.id);
});

afterAll(() => {
  delete process.env.CREATIVE_ARTWORK_DIR;
  rescanPlates();
  fs.rmSync(artDir, { recursive: true, force: true });
});

describe("GET …/creative/artwork/backgrounds", () => {
  it("is owner only and checks the style", async () => {
    expect((await request(app).get(url("/artwork/backgrounds?style=broadcast")).set(auth(coachId))).status).toBe(403);
    expect((await request(app).get(url("/artwork/backgrounds?style=broadcast"))).status).toBe(401);
    expect((await request(app).get(url("/artwork/backgrounds?style=nope")).set(auth(ownerId))).status).toBe(400);
  });

  it("lists the plates in the folder by number, with the aspects present", async () => {
    const res = await request(app).get(url("/artwork/backgrounds?style=broadcast")).set(auth(ownerId)).expect(200);
    expect(res.body).toEqual({
      style: "broadcast",
      plates: [
        { key: "bg/broadcast/1", n: 1, aspects: ["post", "story"] },
        { key: "bg/broadcast/2", n: 2, aspects: ["post"] },
      ],
    });
    const none = await request(app).get(url("/artwork/backgrounds?style=stadium")).set(auth(ownerId)).expect(200);
    expect(none.body).toEqual({ style: "stadium", plates: [] });
  });

  it("is an empty list when there is no plate folder", async () => {
    rescanPlates(path.join(artDir, "missing"));
    const res = await request(app).get(url("/artwork/backgrounds?style=broadcast")).set(auth(ownerId)).expect(200);
    expect(res.body.plates).toEqual([]);
    rescanPlates();
  });
});

describe("POST …/creative/playback-telemetry", () => {
  const body = {
    sessionId: `test-session-${tag}`,
    event: "sample",
    elapsedMs: 4_000,
    engine: "native-hls",
    sourceType: "camera-4k-full",
    hevcSupported: true,
    detail: {
      currentTime: 2701,
      duration: 5400,
      readyState: 3,
      networkState: 2,
      paused: false,
      seeking: false,
      buffered: [[2700, 2704]],
    },
  };

  it("accepts bounded diagnostic samples from an academy owner and writes the searchable prefix", async () => {
    const info = vi.spyOn(logger, "info");
    try {
      await request(app).post(url("/playback-telemetry")).send(body).expect(401);
      await request(app).post(url("/playback-telemetry")).set(auth(coachId)).send(body).expect(403);
      await request(app).post(url("/playback-telemetry")).set(auth(ownerId)).send(body).expect(204);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ academyId, ...body }),
        "[creative-framer-playback]",
      );
    } finally {
      info.mockRestore();
    }
  });

  it("rejects unknown event data rather than logging arbitrary client payloads", async () => {
    await request(app).post(url("/playback-telemetry")).set(auth(ownerId))
      .send({ ...body, event: "unknown", extra: "not allowed" })
      .expect(400);
  });
});

describe("GET …/creative/media for plates and tints", () => {
  const plate = (n = 1) => encodeURIComponent(JSON.stringify({ type: "artwork", key: `bg/broadcast/${n}` }));

  it("returns owner-scoped HLS source choices for a recording moment", async () => {
    const videoId = "123e4567-e89b-12d3-a456-426614174000";
    const [recording] = await db.insert(recordingsTable).values({
      fieldId,
      court: "1",
      date: "2025-01-02",
      timeSlot: "18:00",
      duration: "90:00",
      videoUrl: videoId,
    }).returning({ id: recordingsTable.id });
    await db.insert(academyRecordingsTable).values({ academyId, recordingId: recording.id });
    const source = encodeURIComponent(JSON.stringify({
      type: "recording",
      recordingId: recording.id,
      fromMs: 2_700_000,
      toMs: 2_715_000,
    }));

    const response = await request(app)
      .get(url(`/media?src=${source}&want=video&sources=1`))
      .set(auth(ownerId))
      .expect(200);

    expect(response.body.sources[0]).toEqual({
      kind: "camera-4k",
      url: `/api/hls-proxy/uhd/${videoId}.m3u8?fromMs=2700000&toMs=2715000`,
      fullUrl: `/api/hls-proxy/uhd/${videoId}.m3u8`,
    });
    expect(response.body.sources.every((item: { url: string }) => item.url.startsWith("/api/hls-proxy/"))).toBe(true);
    expect((await request(app).get(url(`/media?src=${source}&want=video&sources=1`)).set(auth(coachId))).status).toBe(403);
  });

  it("picks the post or story file by format (story falls back to post)", async () => {
    const post = await request(app).get(url(`/media?src=${plate()}&format=post`)).set(auth(ownerId)).buffer(true).parse(binary).expect(200);
    expect((await pixel(post.body, 1, 1)).w).toBe(40);
    const square = await request(app).get(url(`/media?src=${plate()}&format=square`)).set(auth(ownerId)).buffer(true).parse(binary).expect(200);
    expect((await pixel(square.body, 1, 1)).w).toBe(40);
    const story = await request(app).get(url(`/media?src=${plate()}&format=story`)).set(auth(ownerId)).buffer(true).parse(binary).expect(200);
    expect((await pixel(story.body, 1, 1)).w).toBe(36);
    const storyOnlyPost = await request(app).get(url(`/media?src=${plate(2)}&format=story`)).set(auth(ownerId)).buffer(true).parse(binary).expect(200);
    expect((await pixel(storyOnlyPost.body, 1, 1)).w).toBe(40);
    expect((await request(app).get(url(`/media?src=${plate(9)}&format=post`)).set(auth(ownerId))).status).toBe(404);
  });

  it("returns the plate tinted as the renderer tints it", async () => {
    const res = await request(app).get(url(`/media?src=${plate()}&format=story&tint=%23C8102E`)).set(auth(ownerId))
      .buffer(true).parse(binary).expect(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    const { w, rgba } = await pixel(res.body, 5, 5);
    expect(w).toBe(36);
    expect(rgba[0]).toBeGreaterThan(rgba[1] + 60);
    expect(rgba[0]).toBeGreaterThan(rgba[2] + 40);
    // Cached: the same bytes again.
    const again = await request(app).get(url(`/media?src=${plate()}&format=story&tint=C8102E`)).set(auth(ownerId)).buffer(true).parse(binary).expect(200);
    expect(Buffer.compare(again.body, res.body)).toBe(0);
    // Half strength sits between the grey and the full tint.
    const half = await request(app).get(url(`/media?src=${plate()}&format=story&tint=C8102E&tintAmount=0.5`)).set(auth(ownerId)).buffer(true).parse(binary).expect(200);
    const h = (await pixel(half.body, 5, 5)).rgba;
    expect(h[0]).toBeGreaterThan(200);
    expect(h[0]).toBeLessThan(rgba[0]);
  });

  it("tints the academy's own uploads, never another academy's", async () => {
    const mine = encodeURIComponent(JSON.stringify({ type: "upload", mediaId: greyMediaId }));
    const res = await request(app).get(url(`/media?src=${mine}&tint=%232B3DA8&tintMode=multiply`)).set(auth(ownerId)).buffer(true).parse(binary).expect(200);
    const { rgba } = await pixel(res.body, 3, 3);
    expect(rgba[2]).toBeGreaterThan(rgba[0]);
    const theirs = encodeURIComponent(JSON.stringify({ type: "upload", mediaId: otherMediaId }));
    expect((await request(app).get(url(`/media?src=${theirs}&tint=%232B3DA8`)).set(auth(ownerId))).status).toBe(404);
    expect((await request(app).get(url(`/media?src=${mine}&tint=%232B3DA8`)).set(auth(coachId))).status).toBe(403);
  });

  it("reads tint parameters strictly", () => {
    expect(tintFromQuery({ tint: "#c8102e" })).toEqual({ color: "#C8102E", mode: "color", amount: 1 });
    expect(tintFromQuery({ tint: "C8102E", tintMode: "screen", tintAmount: "0.3" })).toEqual({ color: "#C8102E", mode: "screen", amount: 0.3 });
    expect(tintFromQuery({ tint: "C8102E", tintMode: "overlay", tintAmount: "7" })).toEqual({ color: "#C8102E", mode: "color", amount: 1 });
    expect(tintFromQuery({ tint: "@primary" })).toBeNull();
    expect(tintFromQuery({ tint: "C8102E", tintAmount: "0" })).toBeNull();
    expect(tintFromQuery({})).toBeNull();
  });
});

describe("private venue recording HLS authorization", () => {
  it("allows only the owner of the venue attached to a private field recording", async () => {
    const videoId = "223e4567-e89b-12d3-a456-426614174000";
    const [venue] = await db.insert(academiesTable).values({
      name: `HLS Venue ${tag}`,
      kind: "venue",
      fieldId,
    }).returning({ id: academiesTable.id });
    await db.insert(academyMembersTable).values([
      { academyId: venue.id, userId: ownerId, role: "owner" },
      { academyId: venue.id, userId: coachId, role: "coach" },
    ]);
    await db.insert(recordingsTable).values({
      fieldId,
      court: "1",
      date: "2025-01-02",
      timeSlot: "18:00",
      duration: "90:00",
      videoUrl: videoId,
      isVisible: false,
    });

    await request(app).get(`/test/hls-auth/${videoId}`).set(auth(ownerId)).expect(200);
    await request(app).get(`/test/hls-auth/${videoId}`).set(auth(coachId)).expect(404);
  });
});
