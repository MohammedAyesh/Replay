import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { academiesTable, academyMembersTable, creativeMusicTracksTable, db, fieldsTable, usersTable } from "@workspace/db";
import { buildTemplateScene } from "@workspace/api-zod";

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

import musicRouter from "./academyCreativeMusic";
import creativeRouter from "./academyCreative";

const tag = Date.now();
let app: Express;
let ownerA: number;
let ownerB: number;
let coachA: number;
let outsider: number;
let adminId: number;
let academyA: number;
let academyB: number;
let work: string;
let song: string;
let wav: string;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (academy: number, p = "") => `/api/academy/console/academies/${academy}/creative/music${p}`;

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "creative-music-routes-"));
  process.env.CREATIVE_MUSIC_DIR = path.join(work, "store");
  song = path.join(work, "our-song.mp3");
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-ac", "2", "-c:a", "libmp3lame", song]);
  wav = path.join(work, "chant.wav");
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=5", "-ac", "1", wav]);
  app = express();
  app.use(express.json());
  app.use("/api", musicRouter, creativeRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner A ${tag}`, email: `music-owner-a-${tag}@test.local` },
    { name: `Owner B ${tag}`, email: `music-owner-b-${tag}@test.local` },
    { name: `Coach A ${tag}`, email: `music-coach-a-${tag}@test.local` },
    { name: `Outsider ${tag}`, email: `music-outsider-${tag}@test.local` },
    { name: `Admin ${tag}`, email: `music-admin-${tag}@test.local`, isAdmin: true },
  ]).returning({ id: usersTable.id });
  [ownerA, ownerB, coachA, outsider, adminId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Music routes ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const rows = await db.insert(academiesTable).values([{ name: `Songs A ${tag}`, fieldId: field.id }, { name: `Songs B ${tag}`, fieldId: field.id }]).returning({ id: academiesTable.id });
  [academyA, academyB] = rows.map((r) => r.id);
  await db.insert(academyMembersTable).values([
    { academyId: academyA, userId: ownerA, role: "owner" },
    { academyId: academyB, userId: ownerB, role: "owner" },
    { academyId: academyA, userId: coachA, role: "coach" },
  ]);
});
afterAll(() => {
  delete process.env.CREATIVE_MUSIC_DIR;
  fs.rmSync(work, { recursive: true, force: true });
});

const uploadAs = (user: number, academy: number, fields: Record<string, string>, file: string | Buffer | null = song, name = "our-song.mp3") => {
  let r = request(app).post(url(academy)).set(auth(user));
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  if (file !== null) r = r.attach("file", file, name);
  return r;
};

let aTrack: number;

describe("Creative music: uploads", () => {
  it("refuses an upload without the rights checkbox, a mood, a file, or something that isn't music", async () => {
    const noRights = await uploadAs(ownerA, academyA, { mood: "hype", title: "Ours" });
    expect(noRights.status).toBe(400);
    expect(noRights.body).toMatchObject({ code: "rights_required", field: "rights" });
    expect((await uploadAs(ownerA, academyA, { mood: "hype", rights: "false" })).body.code).toBe("rights_required");
    expect((await uploadAs(ownerA, academyA, { rights: "true" })).body.field).toBe("mood");
    expect((await uploadAs(ownerA, academyA, { mood: "loud", rights: "true" })).body.field).toBe("mood");
    expect((await uploadAs(ownerA, academyA, { mood: "fun", rights: "true" }, null)).body.field).toBe("file");
    expect((await uploadAs(ownerA, academyA, { mood: "fun", rights: "true" }, Buffer.from("hello"), "notes.txt")).body.field).toBe("file");
    // Named like music, isn't.
    const fake = await uploadAs(ownerA, academyA, { mood: "fun", rights: "true" }, Buffer.alloc(4096, 7), "song.mp3");
    expect(fake.status).toBe(400);
    expect(fake.body.error).toMatch(/isn't music/);
    // Too short to be a soundtrack.
    const blip = path.join(work, "blip.wav");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=500:duration=1", blip]);
    expect((await uploadAs(ownerA, academyA, { mood: "fun", rights: "true" }, blip, "blip.wav")).body.error).toMatch(/too short/);
    // Over 20 MB.
    const big = await uploadAs(ownerA, academyA, { mood: "fun", rights: "true" }, Buffer.alloc(21 * 1024 * 1024, 1), "big.wav");
    expect(big.status).toBe(413);
    expect(await db.$count(creativeMusicTracksTable, eq(creativeMusicTracksTable.academyId, academyA))).toBe(0);
  });

  it("only the owner uploads; a coach and an outsider can't", async () => {
    // (No file attached: the refusal comes before the upload is read.)
    expect((await uploadAs(coachA, academyA, { mood: "fun", rights: "true" }, null)).status).toBe(403);
    expect((await uploadAs(outsider, academyA, { mood: "fun", rights: "true" }, null)).status).toBe(403);
  });

  it("transcodes, measures and keeps the rights confirmation in the licence", async () => {
    const res = await uploadAs(ownerA, academyA, { mood: "hype", rights: "true", title: "  Our  anthem ", artist: "The squad", bpm: "128" });
    expect(res.status).toBe(201);
    const t = res.body.track;
    expect(t).toMatchObject({ scope: "academy", title: "Our anthem", artist: "The squad", mood: "hype", bpm: 128, mine: true, status: "active" });
    expect(t.durationMs).toBeGreaterThan(5800);
    expect(t.durationMs).toBeLessThan(6300);
    expect(t.waveform).toHaveLength(200);
    expect(t.loudnessLufs).toBeTypeOf("number");
    expect(t.license).toMatch(new RegExp(`^Academy confirms rights \\(user ${ownerA}, \\d{4}-\\d{2}-\\d{2}\\)$`));
    expect(t.url).toBe(`/api/academy/console/academies/${academyA}/creative/music/${t.trackId}/file`);
    expect(JSON.stringify(res.body)).not.toContain("creative-music/");
    aTrack = t.trackId;
    const [row] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.id, aTrack));
    expect(row.mime).toBe("audio/mp4");
    // WAV works too; the title comes from the file name when the form has none.
    const w = await uploadAs(ownerA, academyA, { mood: "chill", rights: "on" }, wav, "team_chant.wav");
    expect(w.status).toBe(201);
    expect(w.body.track.title).toBe("team chant");
  });
});

describe("Creative music: who sees and plays what", () => {
  it("lists Replay's library for every academy and each academy's own only for it", async () => {
    const a = await request(app).get(url(academyA)).set(auth(ownerA)).expect(200);
    const replay = a.body.tracks.filter((t: { scope: string }) => t.scope === "replay");
    expect(replay.length).toBeGreaterThanOrEqual(6);
    expect(replay.every((t: { mine: boolean; license: string }) => !t.mine && t.license.length > 0)).toBe(true);
    expect(a.body.tracks.some((t: { trackId: number }) => t.trackId === aTrack)).toBe(true);
    // Replay first, then our own.
    const firstOwn = a.body.tracks.findIndex((t: { scope: string }) => t.scope === "academy");
    expect(a.body.tracks.slice(firstOwn).every((t: { scope: string }) => t.scope === "academy")).toBe(true);

    const b = await request(app).get(url(academyB)).set(auth(ownerB)).expect(200);
    expect(b.body.tracks.some((t: { trackId: number }) => t.trackId === aTrack)).toBe(false);
    expect(b.body.tracks.filter((t: { scope: string }) => t.scope === "replay")).toHaveLength(replay.length);

    const own = await request(app).get(url(academyA, "?scope=academy&mood=hype")).set(auth(ownerA)).expect(200);
    expect(own.body.tracks.map((t: { trackId: number }) => t.trackId)).toEqual([aTrack]);
    const chill = await request(app).get(url(academyA, "?scope=replay&mood=chill")).set(auth(ownerA)).expect(200);
    expect(chill.body.tracks.length).toBeGreaterThan(0);
    expect(chill.body.tracks.every((t: { mood: string; scope: string }) => t.mood === "chill" && t.scope === "replay")).toBe(true);
    // B can't list A's music by asking under A.
    expect((await request(app).get(url(academyA)).set(auth(ownerB))).status).toBe(403);
  });

  it("streams a track with Range to the academy's members; another academy gets 404", async () => {
    const full = await request(app).get(url(academyA, `/${aTrack}/file`)).set(auth(ownerA)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(full.status).toBe(200);
    expect(full.headers["content-type"]).toBe("audio/mp4");
    expect((full.body as Buffer).subarray(4, 8).toString()).toBe("ftyp");
    const part = await request(app).get(url(academyA, `/${aTrack}/file`)).set(auth(coachA)).set("Range", "bytes=0-99");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toMatch(/^bytes 0-99\//);
    expect((await request(app).get(url(academyB, `/${aTrack}/file`)).set(auth(ownerB))).status).toBe(404);
    expect((await request(app).get(url(academyA, `/${aTrack}/file`)).set(auth(outsider))).status).toBe(403);
    // Replay's tracks play for any academy.
    const [replay] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.key, "replay/sunday-session"));
    const r = await request(app).get(url(academyB, `/${replay.id}/file`)).set(auth(ownerB)).set("Range", "bytes=0-9");
    expect(r.status).toBe(206);
  });

  it("lets only its own academy rename or delete a track, never Replay's", async () => {
    expect((await request(app).patch(url(academyB, `/${aTrack}`)).set(auth(ownerB)).send({ title: "Mine now" })).status).toBe(404);
    expect((await request(app).delete(url(academyB, `/${aTrack}`)).set(auth(ownerB))).status).toBe(404);
    const [replay] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.key, "replay/sunday-session"));
    expect((await request(app).patch(url(academyA, `/${replay.id}`)).set(auth(ownerA)).send({ title: "x" })).status).toBe(404);
    const ok = await request(app).patch(url(academyA, `/${aTrack}`)).set(auth(ownerA)).send({ title: "Anthem 2", mood: "epic", bpm: 90 }).expect(200);
    expect(ok.body.track).toMatchObject({ title: "Anthem 2", mood: "epic", bpm: 90 });
    expect((await request(app).patch(url(academyA, `/${aTrack}`)).set(auth(ownerA)).send({ mood: "angry" })).status).toBe(400);

    const extra = await uploadAs(ownerA, academyA, { mood: "fun", rights: "true", title: "Delete me" });
    const id = extra.body.track.trackId as number;
    const [row] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.id, id));
    const file = path.join(process.env.CREATIVE_MUSIC_DIR!, row.path.slice("local:".length));
    expect(fs.existsSync(file)).toBe(true);
    await request(app).delete(url(academyA, `/${id}`)).set(auth(ownerA)).expect(204);
    expect(fs.existsSync(file)).toBe(false);
    expect(await db.$count(creativeMusicTracksTable, eq(creativeMusicTracksTable.id, id))).toBe(0);
  });
});

describe("Creative music: admin manages Replay's library", () => {
  it("is admin only", async () => {
    expect((await request(app).get("/api/admin/creative/music").set(auth(ownerA))).status).toBe(403);
    expect((await request(app).post("/api/admin/creative/music").set(auth(ownerA)).field("mood", "fun")).status).toBe(403);
  });

  it("uploads, edits, hides and shows a Replay track; a hidden track leaves every academy's list", async () => {
    const up = await request(app).post("/api/admin/creative/music").set(auth(adminId))
      .field("mood", "cinematic").field("title", "Night game").field("license", "Bought from a library, licence #42").attach("file", song);
    expect(up.status).toBe(201);
    expect(up.body.track).toMatchObject({ scope: "replay", title: "Night game", mood: "cinematic", license: "Bought from a library, licence #42" });
    const id = up.body.track.trackId as number;
    const list = await request(app).get("/api/admin/creative/music").set(auth(adminId)).expect(200);
    expect(list.body.tracks.some((t: { trackId: number }) => t.trackId === id)).toBe(true);
    expect((await request(app).get(url(academyB)).set(auth(ownerB))).body.tracks.some((t: { trackId: number }) => t.trackId === id)).toBe(true);

    await request(app).patch(`/api/admin/creative/music/${id}`).set(auth(adminId)).send({ status: "hidden", bpm: 70 }).expect(200);
    expect((await request(app).get(url(academyB)).set(auth(ownerB))).body.tracks.some((t: { trackId: number }) => t.trackId === id)).toBe(false);
    expect((await request(app).get(url(academyB, `/${id}/file`)).set(auth(ownerB))).status).toBe(404);
    expect((await request(app).get(`/api/admin/creative/music/${id}/file`).set(auth(adminId)).set("Range", "bytes=0-9")).status).toBe(206);
    expect((await request(app).patch(`/api/admin/creative/music/${id}`).set(auth(adminId)).send({ status: "gone" })).status).toBe(400);
    // An academy's track isn't Replay's to edit.
    expect((await request(app).patch(`/api/admin/creative/music/${aTrack}`).set(auth(adminId)).send({ status: "hidden" })).status).toBe(404);
    await request(app).patch(`/api/admin/creative/music/${id}`).set(auth(adminId)).send({ status: "active" }).expect(200);
    expect((await request(app).get(url(academyB)).set(auth(ownerB))).body.tracks.some((t: { trackId: number }) => t.trackId === id)).toBe(true);
  });
});

describe("Creative music: templates start with a track", () => {
  it("a goal video from its template gets a hype track; a still and a design with music are left alone", async () => {
    const scene = buildTemplateScene("goal", "broadcast", "story", "en");
    const res = await request(app).post(`/api/academy/console/academies/${academyA}/creative/projects`).set(auth(ownerA)).send({ scene }).expect(201);
    const music = res.body.project.scene.music;
    expect(music).toMatchObject({ volume: 0.7, duck: false });
    const [track] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.id, music.trackId));
    expect(track).toMatchObject({ scope: "replay", mood: "hype", status: "active" });

    const talk = await request(app).post(`/api/academy/console/academies/${academyA}/creative/projects`).set(auth(ownerA))
      .send({ scene: buildTemplateScene("talk", "broadcast", "story", "en") }).expect(201);
    expect(talk.body.project.scene.music).toMatchObject({ volume: 0.25, duck: true });

    const still = await request(app).post(`/api/academy/console/academies/${academyA}/creative/projects`).set(auth(ownerA))
      .send({ scene: buildTemplateScene("fulltime", "broadcast", "post", "en") }).expect(201);
    expect(still.body.project.scene.music).toBeUndefined();

    const own = await request(app).post(`/api/academy/console/academies/${academyA}/creative/projects`).set(auth(ownerA))
      .send({ scene: { ...scene, music: { trackId: aTrack, volume: 0.4 } } }).expect(201);
    expect(own.body.project.scene.music).toEqual({ trackId: aTrack, volume: 0.4 });
  });
});
