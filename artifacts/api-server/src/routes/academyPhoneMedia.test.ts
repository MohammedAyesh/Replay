import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyAdMediaTable,
  academyMembersTable,
  academyPhoneMediaTable,
  academyPlayerFeaturesTable,
  academyPlayerGuardiansTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  db,
  fieldsTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";
import { readJpegExif } from "@workspace/api-zod";
import { createCanvas, loadImage } from "@napi-rs/canvas";

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
// Storage: keep a copy here so the test can check what would be stored.
const stored = vi.hoisted(() => ({ dir: "", files: [] as string[] }));
vi.mock("../lib/meta/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/media")>();
  return {
    ...actual,
    storeVideo: vi.fn(async (_academyId: number, filePath: string) => {
      const out = path.join(stored.dir, `stored-${stored.files.length}.mp4`);
      fs.copyFileSync(filePath, out);
      stored.files.push(out);
      return `https://storage.bunnycdn.com/ad-media/${path.basename(out)}`;
    }),
  };
});

import phoneRouter from "./academyPhoneMedia";
import { jpegWithExif } from "../lib/phoneCapture.test-helpers";

const stamp = Date.now();
let app: Express;
let work: string;
let owner: number;
let coach: number;
let parent: number;
let outsider: number;
let academyId: number;
let matchId: number;
let kidId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = () => `/api/academy/console/academies/${academyId}/phone-media`;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args]);
const tags = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json", file]).toString());

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "phone-media-routes-"));
  stored.dir = work;
  ff(["-f", "lavfi", "-i", "testsrc=d=4:s=320x180:r=30", "-f", "lavfi", "-i", "sine=d=4", "-shortest", "-c:v", "libx264", "-c:a", "aac",
    "-metadata", "creation_time=2026-11-01T15:05:32Z", "-metadata", "com.apple.quicktime.creationdate=2026-11-01T18:05:32+0300",
    "-metadata", "com.apple.quicktime.location.ISO6709=+31.9539+035.9106+0800.000/", "-metadata", "com.apple.quicktime.make=Apple",
    "-movflags", "use_metadata_tags", path.join(work, "IMG_4821.MOV")]);
  ff(["-f", "lavfi", "-i", "testsrc=d=5:s=320x180:r=30", "-c:v", "libx264", "-metadata", "creation_time=2026-11-02T09:41:10Z", path.join(work, "VID-20261101-WA0007.mp4")]);
  app = express();
  app.use(express.json());
  app.use("/api", phoneRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `pm-owner-${stamp}@test.local` },
    { name: `Coach ${stamp}`, email: `pm-coach-${stamp}@test.local` },
    { name: `Parent ${stamp}`, email: `pm-parent-${stamp}@test.local` },
    { name: `Outsider ${stamp}`, email: `pm-out-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [owner, coach, parent, outsider] = users.map((u) => u.id);
  // Jordan Galaxy's pin; the iPhone clip was filmed ~25 m from it.
  const [field] = await db.insert(fieldsTable).values({ name: `PM field ${stamp}`, cameraId: "camera1", latitude: 31.9541, longitude: 35.9104 }).returning({ id: fieldsTable.id });
  const [academy] = await db.insert(academiesTable).values({ name: `JUFA ${stamp}`, fieldId: field.id }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([{ academyId, userId: owner, role: "owner" }, { academyId, userId: coach, role: "coach" }]);
  const [kid] = await db.insert(academyPlayersTable).values({ academyId, name: "Omar", jerseyNumber: 7 }).returning();
  kidId = kid.id;
  await db.insert(academyPlayerGuardiansTable).values({ playerId: kidId, userId: parent, addedBy: "owner" });
  // Saturday's match, 18:00 Amman, recorded from 18:00 for 1 h 40.
  const [m] = await db.insert(academySessionsTable).values({ academyId, type: "match", startsAt: new Date("2026-11-01T15:00:00Z"), endsAt: new Date("2026-11-01T16:40:00Z"), location: "Galaxy" }).returning();
  matchId = m.id;
  const [rec] = await db.insert(recordingsTable).values({ fieldId: field.id, court: "A", date: "2026-11-01", timeSlot: "18:00–19:40", duration: "01:40:00", videoUrl: "https://example.test/x" }).returning();
  await db.insert(academyRecordingsTable).values({ academyId, recordingId: rec.id, sessionId: matchId });
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe("phone media: uploads", () => {
  let iphoneId: number;

  it("a coach's iPhone clip is sorted into the match, with its offset into the recording, and stored without GPS or dates", async () => {
    const capture = { quicktimeCreationDate: "2026-11-01T18:05:32+0300", durationSec: 4, lastModifiedMs: Date.parse("2026-11-01T15:05:36Z") };
    const res = await request(app).post(base()).set(auth(coach))
      .field("capture", JSON.stringify(capture)).field("gps", JSON.stringify({ lat: 31.9539, lon: 35.9106 }))
      .attach("file", path.join(work, "IMG_4821.MOV")).expect(201);
    iphoneId = res.body.item.id;
    expect(res.body.item).toMatchObject({
      kind: "video", uploaderRole: "coach", phase: "during", sessionId: matchId, offsetSec: 332, venue: "at_venue",
      captureSource: "quicktime", captureConfidence: "high", capturedAt: "2026-11-01T15:05:32.000Z", needsReview: false,
    });
    // What went to Storage has no tags at all: no location, no creation date, no device.
    const t = tags(stored.files.at(-1)!);
    expect(JSON.stringify(t)).not.toMatch(/ISO6709|location|creationdate|Apple|creation_time/i);
    // Nothing stores coordinates.
    const [row] = await db.select().from(academyPhoneMediaTable).where(eq(academyPhoneMediaTable.id, iphoneId));
    expect(JSON.stringify(row)).not.toMatch(/31\.95|35\.91/);
  });

  it("reads the file itself when the browser could not (the server fallback)", async () => {
    const res = await request(app).post(base()).set(auth(owner)).attach("file", path.join(work, "IMG_4821.MOV")).expect(201);
    expect(res.body.item).toMatchObject({ phase: "during", offsetSec: 332, venue: "at_venue", captureSource: "quicktime", uploaderRole: "owner" });
  });

  it("a parent's WhatsApp forward: only its day is known, so the coach is asked, and his pick sticks", async () => {
    const res = await request(app).post(`/api/academy/family/phone-media?playerId=${kidId}`).set(auth(parent))
      .attach("file", path.join(work, "VID-20261101-WA0007.mp4")).expect(201);
    const item = res.body.item;
    expect(item).toMatchObject({ uploaderRole: "parent", playerId: kidId, phase: "unlinked", needsReview: true, reviewReason: "date_only", captureDate: "2026-11-01" });
    // His child appeared (privately) in it.
    expect(await db.select().from(academyPlayerFeaturesTable).where(eq(academyPlayerFeaturesTable.itemId, String(item.id)))).toEqual([
      expect.objectContaining({ playerId: kidId, itemType: "phone_video", visibility: "private" }),
    ]);
    const review = await request(app).get(`${base()}?review=1`).set(auth(coach)).expect(200);
    expect(review.body.items.map((i: { id: number }) => i.id)).toContain(item.id);
    const day = await request(app).get(`${base()}/sessions?date=2026-11-01`).set(auth(coach)).expect(200);
    expect(day.body.sessions.map((s: { id: number }) => s.id)).toEqual([matchId]);
    const fixed = await request(app).patch(`${base()}/${item.id}`).set(auth(coach)).send({ sessionId: matchId, phase: "after" }).expect(200);
    expect(fixed.body.item).toMatchObject({ sessionId: matchId, phase: "after", linkedBy: "coach", needsReview: false, offsetSec: null });
    // Sorting again leaves a coach's choice alone.
    await request(app).post(`${base()}/resort`).set(auth(coach)).expect(200);
    const [row] = await db.select().from(academyPhoneMediaTable).where(eq(academyPhoneMediaTable.id, item.id));
    expect(row.phase).toBe("after");
  });

  it("a photo: EXIF time sorts it, it is stored upright and without EXIF", async () => {
    const jpg = jpegWithExif({ date: "2026:11:01 17:40:00", offset: "+03:00", lat: 31.9539, lon: 35.9106, orientation: 6, w: 40, h: 20 });
    const file = path.join(work, "IMG_0001.jpg");
    fs.writeFileSync(file, jpg);
    const res = await request(app).post(base()).set(auth(coach)).attach("file", file).expect(201);
    expect(res.body.item).toMatchObject({ kind: "image", phase: "before", sessionId: matchId, venue: "at_venue", captureSource: "exif" });
    const [m] = await db.select().from(academyAdMediaTable).where(eq(academyAdMediaTable.id, res.body.item.mediaId));
    const bytes = Buffer.from(m.imageData!.split(",")[1], "base64");
    expect(readJpegExif(new Uint8Array(bytes))).toBeNull();
    const img = await loadImage(bytes);
    expect([img.width, img.height]).toEqual([20, 40]);
    // Turned 90° clockwise: the left (red) half of the sensor image is now on top.
    const c = createCanvas(20, 40);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const top = ctx.getImageData(10, 5, 1, 1).data;
    const bottom = ctx.getImageData(10, 35, 1, 1).data;
    expect(top[0]).toBeGreaterThan(200);
    expect(bottom[2]).toBeGreaterThan(200);
  });

  it("tagging players logs a private appearance for each; only members see the list; only the owner or uploader deletes", async () => {
    await request(app).get(base()).set(auth(outsider)).expect(403);
    const tagged = await request(app).patch(`${base()}/${iphoneId}`).set(auth(coach)).send({ playerIds: [kidId, 999999] }).expect(200);
    expect(tagged.body.item.playerIds).toEqual([kidId]);
    expect(await db.select().from(academyPlayerFeaturesTable).where(eq(academyPlayerFeaturesTable.itemId, String(iphoneId)))).toHaveLength(1);
    const list = await request(app).get(`${base()}?sessionId=${matchId}&phase=during`).set(auth(coach)).expect(200);
    expect(list.body.items.every((i: { phase: string }) => i.phase === "during")).toBe(true);
    const thumb = await request(app).get(`${base()}/${iphoneId}/thumb`).set(auth(coach)).expect(200);
    expect(thumb.headers["content-type"]).toMatch(/^image\//);
    const mine = (await request(app).post(base()).set(auth(owner)).attach("file", path.join(work, "IMG_4821.MOV")).expect(201)).body.item.id;
    await request(app).delete(`${base()}/${mine}`).set(auth(coach)).expect(403);
    await request(app).delete(`${base()}/${iphoneId}`).set(auth(coach)).expect(200);
    expect(await db.select().from(academyPhoneMediaTable).where(eq(academyPhoneMediaTable.id, iphoneId))).toEqual([]);
  });
});
