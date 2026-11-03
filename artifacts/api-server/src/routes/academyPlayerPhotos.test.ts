import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  academiesTable,
  academyMembersTable,
  academyPlayerPhotosTable,
  academyPlayersTable,
  brandingProfilesTable,
  db,
  fieldsTable,
  usersTable,
} from "@workspace/db";

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

import photosRouter from "./academyPlayerPhotos";
import libraryRouter from "./academyCreativeLibrary";
import renderRouter from "./academyCreativeRender";
import { creativeImageResolver, serverData, withoutPlayerPictures } from "../lib/creative/renderMedia";
import { playerPictures } from "../lib/academyPlayerPhotos";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let outsiderId: number;
let kidUserId: number;
let academyId: number;
let otherAcademyId: number;
let kidId: number;
let omarId: number;
let otherPlayerId: number;
let dir: string;
const auth = (id: number) => ({ "x-test-user": String(id) });
const players = (path: string, academy = academyId) => `/api/academy/console/academies/${academy}/players${path}`;
const creative = (path: string, academy = academyId) => `/api/academy/console/academies/${academy}/creative${path}`;

/** A cut-out: a figure of simple shapes on a transparent background. */
function cutoutPng(w = 400, h = 600): Buffer {
  const cv = createCanvas(w, h);
  const g = cv.getContext("2d");
  g.fillStyle = "#C8102E";
  g.fillRect(w * 0.2, h * 0.35, w * 0.6, h * 0.65);
  g.beginPath(); g.arc(w / 2, h * 0.22, w * 0.15, 0, 7); g.fill();
  return cv.toBuffer("image/png");
}
function opaqueJpeg(w = 2400, h = 3200): Buffer {
  const cv = createCanvas(w, h);
  const g = cv.getContext("2d");
  g.fillStyle = "#2F7D3A"; g.fillRect(0, 0, w, h);
  return cv.toBuffer("image/jpeg", 85);
}

const allowNames = async (on: boolean) => {
  await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyId)));
  if (on) await db.insert(brandingProfilesTable).values({ scopeType: "academy", scopeId: academyId, nameEn: "Photos", showPlayerNames: true });
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "player-photos-test-"));
  process.env.PLAYER_PHOTO_DIR = dir;
  app = express();
  app.use(express.json());
  app.use("/api", photosRouter);
  app.use("/api", libraryRouter);
  app.use("/api", renderRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-pp-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-pp-${tag}@test.local` },
    { name: `Out ${tag}`, email: `out-pp-${tag}@test.local` },
    { name: `Kid ${tag}`, email: `kid-pp-${tag}@test.local`, avatarPath: `avatars/u1-abc123.jpg` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, outsiderId, kidUserId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Photos field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([
    { name: `Photos Academy ${tag}`, fieldId: field.id },
    { name: `Other Photos ${tag}`, fieldId: field.id },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: ownerId, role: "owner" },
  ]);
  const rows = await db.insert(academyPlayersTable).values([
    { academyId, name: "Ahmad Saleh", jerseyNumber: 10, position: "MF", userId: kidUserId },
    { academyId, name: "Omar Khaled", jerseyNumber: 7, position: "FW" },
    { academyId: otherAcademyId, name: "Someone Else", jerseyNumber: 9 },
  ]).returning({ id: academyPlayersTable.id });
  [kidId, omarId, otherPlayerId] = rows.map((r) => r.id);
});

afterAll(async () => {
  await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  await db.delete(academiesTable).where(eq(academiesTable.id, otherAcademyId));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("player photo galleries", () => {
  let cutoutId: number;
  let jpegId: number;

  it("keeps a cut-out's transparency (PNG) and makes the first photo the main one", async () => {
    const res = await request(app).post(players(`/${omarId}/photos`)).set(auth(coachId))
      .field("label", "home kit").attach("file", cutoutPng(), { filename: "7.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.photo).toMatchObject({ playerId: omarId, transparent: true, isPrimary: true, label: "home kit", width: 400, height: 600 });
    expect(res.body.photo.url).toMatch(new RegExp(`/players/${omarId}/photos/\\d+/file`));
    expect(JSON.stringify(res.body)).not.toContain("academy-players/");
    cutoutId = res.body.photo.photoId;
    const [row] = await db.select().from(academyPlayerPhotosTable).where(eq(academyPlayerPhotosTable.id, cutoutId));
    expect(row.mime).toBe("image/png");
  });

  it("stores an opaque photo as WebP, scaled to 1600 px at most, not as the main one", async () => {
    const res = await request(app).post(players(`/${omarId}/photos`)).set(auth(ownerId))
      .attach("file", opaqueJpeg(), { filename: "omar.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(201);
    expect(res.body.photo).toMatchObject({ transparent: false, isPrimary: false, width: 1200, height: 1600 });
    jpegId = res.body.photo.photoId;
    const [row] = await db.select().from(academyPlayerPhotosTable).where(eq(academyPlayerPhotosTable.id, jpegId));
    expect(row.mime).toBe("image/webp");
  });

  it("serves the file with its alpha to members only, never across academies", async () => {
    const file = await request(app).get(players(`/${omarId}/photos/${cutoutId}/file`)).set(auth(coachId)).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["cache-control"]).toContain("private");
    const img = await loadImage(file.body as Buffer);
    const cv = createCanvas(img.width, img.height);
    cv.getContext("2d").drawImage(img, 0, 0);
    expect(cv.getContext("2d").getImageData(2, 2, 1, 1).data[3]).toBe(0);
    expect((await request(app).get(players(`/${omarId}/photos/${cutoutId}/file`)).set(auth(outsiderId))).status).toBe(403);
    // The right photo id under another academy's URL (the owner owns both): not found.
    expect((await request(app).get(players(`/${omarId}/photos/${cutoutId}/file`, otherAcademyId)).set(auth(ownerId))).status).toBe(404);
    expect((await request(app).get(players(`/${otherPlayerId}/photos`)).set(auth(ownerId))).status).toBe(404);
    expect((await request(app).post(players(`/${otherPlayerId}/photos`)).set(auth(ownerId))
      .attach("file", cutoutPng(), { filename: "9.png", contentType: "image/png" })).status).toBe(404);
  });

  it("refuses non-images", async () => {
    const res = await request(app).post(players(`/${omarId}/photos`)).set(auth(ownerId))
      .attach("file", Buffer.from("not an image"), { filename: "x.gif", contentType: "image/gif" });
    expect(res.status).toBe(400);
  });

  it("switches the main photo, labels, and promotes another when the main one is deleted", async () => {
    let res = await request(app).patch(players(`/${omarId}/photos/${jpegId}`)).set(auth(ownerId)).send({ isPrimary: true, label: "  celebration  " });
    expect(res.body.photo).toMatchObject({ isPrimary: true, label: "celebration" });
    res = await request(app).get(players(`/${omarId}/photos`)).set(auth(ownerId));
    expect(res.body.photos.map((p: { photoId: number }) => p.photoId)).toEqual([jpegId, cutoutId]);
    expect(res.body.photos.filter((p: { isPrimary: boolean }) => p.isPrimary)).toHaveLength(1);
    expect((await request(app).delete(players(`/${omarId}/photos/${jpegId}`)).set(auth(ownerId))).status).toBe(204);
    res = await request(app).get(players(`/${omarId}/photos`)).set(auth(ownerId));
    expect(res.body.photos).toEqual([expect.objectContaining({ photoId: cutoutId, isPrimary: true })]);
  });

  it("takes a photoshoot in one go, each file for the player picked in the review", async () => {
    const res = await request(app).post(players("/photos/bulk")).set(auth(ownerId))
      .field("assign", JSON.stringify([{ playerId: kidId }, { playerId: otherPlayerId }, { playerId: kidId, label: "away" }]))
      .attach("files", cutoutPng(), { filename: "10.png", contentType: "image/png" })
      .attach("files", cutoutPng(), { filename: "9.png", contentType: "image/png" })
      .attach("files", cutoutPng(), { filename: "10-away.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.added).toHaveLength(2);
    expect(res.body.added[0]).toMatchObject({ playerId: kidId, isPrimary: true });
    expect(res.body.added[1]).toMatchObject({ playerId: kidId, isPrimary: false, label: "away" });
    // Another academy's player is never written to.
    expect(res.body.skipped).toEqual([expect.objectContaining({ index: 1 })]);
    const other = await db.select().from(academyPlayerPhotosTable).where(eq(academyPlayerPhotosTable.playerId, otherPlayerId));
    expect(other).toEqual([]);
  });
});

describe("player photos in the Creative hub (names rule)", () => {
  it("photo precedence: the academy's main photo, else the linked account's avatar, else nothing", async () => {
    const pics = await playerPictures(academyId, [kidId, omarId, otherPlayerId]);
    expect(pics.get(kidId)).toMatchObject({ kind: "photo" });
    expect(pics.get(omarId)).toMatchObject({ kind: "photo" });
    expect(pics.has(otherPlayerId)).toBe(false);
    await db.delete(academyPlayerPhotosTable).where(eq(academyPlayerPhotosTable.playerId, kidId));
    expect((await playerPictures(academyId, [kidId])).get(kidId)).toMatchObject({ kind: "avatar", userId: kidUserId });
  });

  it("lists no photos and numbers only while the academy doesn't show names", async () => {
    await allowNames(false);
    const list = await request(app).get(creative("/library/players")).set(auth(ownerId));
    expect(list.body.players.every((p: { photo: unknown; firstName: unknown }) => p.photo === null && p.firstName === null)).toBe(true);
    const media = await request(app).get(creative(`/library/players/${omarId}/media`)).set(auth(ownerId));
    expect(media.status).toBe(200);
    expect(media.body).toMatchObject({ showNames: false, photos: [], player: { number: 7, firstName: null } });
  });

  it("shows the main photo and the gallery once names are allowed; another academy's player is not found", async () => {
    await allowNames(true);
    const list = await request(app).get(creative("/library/players")).set(auth(ownerId));
    const omar = list.body.players.find((p: { playerId: number }) => p.playerId === omarId);
    expect(omar).toMatchObject({ firstName: "Omar", position: "FW", photo: expect.objectContaining({ transparent: true, isPrimary: true }) });
    const media = await request(app).get(creative(`/library/players/${omarId}/media`)).set(auth(ownerId));
    expect(media.body.photos[0].source).toEqual({ type: "player-photo", photoId: media.body.photos[0].photoId, cutout: true });
    expect((await request(app).get(creative(`/library/players/${otherPlayerId}/media`)).set(auth(ownerId))).status).toBe(404);
  });

  it("the media route and the renderer draw a player photo only for its own academy, with names allowed", async () => {
    const [photo] = await db.select().from(academyPlayerPhotosTable).where(eq(academyPlayerPhotosTable.playerId, omarId));
    const src = (s: unknown) => `?src=${encodeURIComponent(JSON.stringify(s))}&want=still`;
    await allowNames(true);
    let res = await request(app).get(creative(`/media${src({ type: "player-photo", photoId: photo.id })}`)).set(auth(ownerId)).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect((await request(app).get(creative(`/media${src({ type: "player", playerId: omarId })}`)).set(auth(ownerId))).status).toBe(200);
    // The same photo asked for under the other academy: refused.
    expect((await request(app).get(creative(`/media${src({ type: "player-photo", photoId: photo.id })}`, otherAcademyId)).set(auth(ownerId))).status).toBe(404);
    expect((await request(app).get(creative(`/media${src({ type: "player", playerId: omarId })}`, otherAcademyId)).set(auth(ownerId))).status).toBe(404);
    const layer = { id: "p", kind: "image", src: { type: "player-photo", photoId: photo.id }, fit: "contain", x: 0, y: 0, w: 10, h: 10 } as never;
    expect(await creativeImageResolver(academyId, { crest: null })(layer, { type: "player-photo", photoId: photo.id }, { format: "post" })).not.toBeNull();
    expect(await creativeImageResolver(otherAcademyId, { crest: null })(layer, { type: "player-photo", photoId: photo.id }, { format: "post" })).toBeNull();
    expect(await creativeImageResolver(otherAcademyId, { crest: null })(layer, { type: "player", playerId: omarId }, { format: "post" })).toBeNull();

    await allowNames(false);
    res = await request(app).get(creative(`/media${src({ type: "player-photo", photoId: photo.id })}`)).set(auth(ownerId));
    expect(res.status).toBe(404);
    expect(await creativeImageResolver(academyId, { crest: null })(layer, { type: "player-photo", photoId: photo.id }, { format: "post" })).toBeNull();
    expect(await creativeImageResolver(academyId, { crest: null })(layer, { type: "player", playerId: omarId }, { format: "post" })).toBeNull();
  });
});

describe("render data without names", () => {
  it("drops every player picture (row photos, player.photo, media) and keeps other pictures", () => {
    const out = withoutPlayerPictures({
      media: { type: "player", playerId: 1 },
      more: [{ type: "upload", mediaId: 3 }, { type: "player-photo", photoId: 4 }],
      photos: [{ type: "player", playerId: 1, cutout: true }, { type: "upload", mediaId: 5 }],
      player: { number: 7, photo: { type: "player", playerId: 1 } },
    });
    expect(out.media).toBeUndefined();
    expect(out.photos).toBeUndefined();
    expect(out.player).toEqual({ number: 7 });
    expect(out.more?.[0]).toEqual({ type: "upload", mediaId: 3 });
    expect(out.more?.[1]).toBeNull();
  });

  it("serverData applies it whenever the academy doesn't show names", () => {
    const access = { academyId: 1, academy: { whatsappPhone: null, contactPhone: null, instagramUrl: null } } as never;
    const look = { nameEn: "A", nameAr: null, bookingPhone: null, instagram: null } as never;
    const raw = { photos: [{ type: "player", playerId: 1 }], player: { name: "Ahmad Saleh", number: 10, photo: { type: "player", playerId: 1 } } };
    const off = serverData(access, { brand: {} as never, look, showNames: false }, raw);
    expect(off.photos).toBeUndefined();
    expect(off.player).toEqual({ name: null, number: 10 });
    const on = serverData(access, { brand: {} as never, look, showNames: true }, raw);
    expect(on.photos).toHaveLength(1);
    expect(on.player).toMatchObject({ name: "Ahmad", photo: { type: "player", playerId: 1 } });
  });
});
