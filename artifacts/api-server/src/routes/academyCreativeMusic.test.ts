import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { academiesTable, academyMembersTable, creativeMusicTracksTable, creativeTemplateMusicTable, db, fieldsTable, usersTable } from "@workspace/db";
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
  it("a goal video from its template gets its recommended track; a still and a design with music are left alone", async () => {
    await db.delete(creativeTemplateMusicTable);
    const scene = buildTemplateScene("goal", "broadcast", "story", "en");
    const res = await request(app).post(`/api/academy/console/academies/${academyA}/creative/projects`).set(auth(ownerA)).send({ scene }).expect(201);
    const music = res.body.project.scene.music;
    expect(music).toMatchObject({ volume: 0.7, duck: false });
    const [track] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.id, music.trackId));
    expect(track).toMatchObject({ scope: "replay", key: "cc0/energetic-electro-tune", mood: "hype", status: "active" });

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

describe("Creative music: template music in /admin", () => {
  const admin = (p = "") => `/api/admin/creative/music/templates${p}`;
  const idOf = async (key: string) => (await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.key, key)))[0]!.id;
  const body = (trackIds: number[], extra: Record<string, unknown> = {}) => ({ trackIds, volume: 0.45, duck: true, fadeInMs: 500, fadeOutMs: 2000, startMs: 3000, ...extra });
  const goalProject = () => request(app).post(`/api/academy/console/academies/${academyA}/creative/projects`).set(auth(ownerA))
    .send({ scene: buildTemplateScene("goal", "broadcast", "story", "en") }).expect(201);

  it("is admin only: an academy owner, a coach and an outsider can't read, save or reset", async () => {
    await db.delete(creativeTemplateMusicTable);
    for (const who of [ownerA, coachA, outsider]) {
      expect((await request(app).get(admin()).set(auth(who))).status).toBe(403);
      expect((await request(app).put(admin("/goal")).set(auth(who)).send(body([]))).status).toBe(403);
      expect((await request(app).delete(admin("/goal")).set(auth(who))).status).toBe(403);
    }
    expect((await request(app).get(admin())).status).toBe(401);
    expect(await db.$count(creativeTemplateMusicTable)).toBe(0);
  });

  it("lists all 31 templates with what they recommend and Replay's pick", async () => {
    const res = await request(app).get(admin()).set(auth(adminId)).expect(200);
    expect(res.body.templates).toHaveLength(31);
    const goal = res.body.templates.find((t: { key: string }) => t.key === "goal");
    const ids = await Promise.all(["cc0/energetic-electro-tune", "cc0/fight-for-a-better-future", "replay/matchday-anthem"].map(idOf));
    expect(goal).toMatchObject({ title: { en: "Goal clip" }, category: "players", kind: "video", saved: null, updatedAt: null,
      effective: { trackIds: ids, volume: 0.7, customised: false }, builtIn: { trackIds: ids } });
    expect(res.body.templates.find((t: { key: string }) => t.key === "fulltime")).toMatchObject({ kind: "image", effective: { volume: 0.6, fadeInMs: 300, fadeOutMs: 1500, duck: false } });
  });

  it("refuses what isn't valid: an unknown template, bad settings, a hidden, academy or missing track", async () => {
    const anthem = await idOf("replay/matchday-anthem");
    expect((await request(app).put(admin("/nope")).set(auth(adminId)).send(body([anthem]))).status).toBe(404);
    const bad = async (b: unknown) => (await request(app).put(admin("/goal")).set(auth(adminId)).send(b as object));
    expect((await bad(body([anthem], { volume: 1.5 }))).body.field).toBe("volume");
    expect((await bad(body([anthem], { fadeInMs: -10 }))).body.field).toBe("fadeInMs");
    expect((await bad(body([anthem], { fadeOutMs: 99_000 }))).body.field).toBe("fadeOutMs");
    expect((await bad(body([anthem], { startMs: 11 * 60_000 }))).body.field).toBe("startMs");
    expect((await bad(body([anthem], { duck: "yes" }))).body.field).toBe("duck");
    expect((await bad(body([1, 2, 3, 4, 5, 6]))).body.field).toBe("trackIds");
    expect((await bad(body([anthem, anthem]))).body.field).toBe("trackIds");
    // Only Replay's active tracks: not an academy's own, not a hidden one, not one that doesn't exist.
    const own = await bad(body([anthem, aTrack]));
    expect(own.status).toBe(400);
    expect(own.body.field).toBe("trackIds");
    expect((await bad(body([2_000_000_000]))).status).toBe(400);
    const stomp = await idOf("replay/stadium-stomp");
    await db.update(creativeMusicTracksTable).set({ status: "hidden" }).where(eq(creativeMusicTracksTable.id, stomp));
    try {
      expect((await bad(body([stomp]))).status).toBe(400);
    } finally {
      await db.update(creativeMusicTracksTable).set({ status: "active" }).where(eq(creativeMusicTracksTable.id, stomp));
    }
    expect(await db.$count(creativeTemplateMusicTable)).toBe(0);
  });

  it("saves a template's music; new goal videos and academies' recommendations follow it; reset goes back to Replay's", async () => {
    const [anthem, chill, electro] = await Promise.all(["replay/matchday-anthem", "cc0/chill-lofi", "cc0/energetic-electro-tune"].map(idOf));
    const saved = await request(app).put(admin("/goal")).set(auth(adminId)).send(body([anthem, chill])).expect(200);
    expect(saved.body.template).toMatchObject({ key: "goal", effective: { trackIds: [anthem, chill], volume: 0.45, duck: true, startMs: 3000, customised: true } });
    const [row] = await db.select().from(creativeTemplateMusicTable).where(eq(creativeTemplateMusicTable.templateKey, "goal"));
    expect(row).toMatchObject({ trackIds: [anthem, chill], updatedBy: adminId });

    expect((await goalProject()).body.project.scene.music).toEqual({ trackId: anthem, volume: 0.45, startMs: 3000, fadeInMs: 500, fadeOutMs: 2000, duck: true });
    const recs = await request(app).get(url(academyA, "/recommendations")).set(auth(ownerA)).expect(200);
    expect(recs.body.templates.goal).toEqual({ trackIds: [anthem, chill], volume: 0.45, duck: true, fadeInMs: 500, fadeOutMs: 2000, startMs: 3000 });
    expect(Object.keys(recs.body.templates)).toHaveLength(31);

    // A hidden track is skipped everywhere it's recommended.
    await db.update(creativeMusicTracksTable).set({ status: "hidden" }).where(eq(creativeMusicTracksTable.id, anthem));
    try {
      expect((await goalProject()).body.project.scene.music).toMatchObject({ trackId: chill, volume: 0.45 });
      expect((await request(app).get(url(academyB, "/recommendations")).set(auth(ownerB))).body.templates.goal.trackIds).toEqual([chill]);
    } finally {
      await db.update(creativeMusicTracksTable).set({ status: "active" }).where(eq(creativeMusicTracksTable.id, anthem));
    }

    // No tracks at all: the admin chose no music.
    await request(app).put(admin("/goal")).set(auth(adminId)).send(body([])).expect(200);
    expect((await goalProject()).body.project.scene.music).toBeUndefined();

    const reset = await request(app).delete(admin("/goal")).set(auth(adminId)).expect(200);
    expect(reset.body.template).toMatchObject({ saved: null, effective: { customised: false, volume: 0.7 } });
    expect(reset.body.template.effective.trackIds[0]).toBe(electro);
    expect(await db.$count(creativeTemplateMusicTable, eq(creativeTemplateMusicTable.templateKey, "goal"))).toBe(0);
    expect((await goalProject()).body.project.scene.music).toMatchObject({ trackId: electro, volume: 0.7 });
    expect((await request(app).delete(admin("/nope")).set(auth(adminId))).status).toBe(404);
  });

  it("gives an academy's console only Replay's tracks in recommendations, and only to its owner", async () => {
    const recs = await request(app).get(url(academyA, "/recommendations")).set(auth(ownerA)).expect(200);
    const ids = Object.values(recs.body.templates as Record<string, { trackIds: number[] }>).flatMap((r) => r.trackIds);
    expect(ids.length).toBeGreaterThan(31);
    const rows = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.scope, "replay"));
    const replay = new Set(rows.filter((r) => r.status === "active").map((r) => r.id));
    expect(ids.every((id) => replay.has(id))).toBe(true);
    expect((await request(app).get(url(academyA, "/recommendations")).set(auth(ownerB))).status).toBe(403);
    expect((await request(app).get(url(academyA, "/recommendations")).set(auth(outsider))).status).toBe(403);
  });
});

describe("Creative music: field owners get the same music as academies", () => {
  it("a field's owner lists the library, sees recommendations, uploads its own track and gets music on a goal video", async () => {
    await db.delete(creativeTemplateMusicTable);
    const [u] = await db.insert(usersTable).values({ name: `Field owner ${tag}`, email: `music-field-owner-${tag}@test.local` }).returning({ id: usersTable.id });
    const [fieldRow] = await db.insert(fieldsTable).values({ name: `Music field ${tag}`, cameraId: "camera2" }).returning({ id: fieldsTable.id });
    const [venue] = await db.insert(academiesTable).values({ name: `Pitch Club ${tag}`, fieldId: fieldRow.id, kind: "venue" }).returning({ id: academiesTable.id });
    await db.insert(academyMembersTable).values({ academyId: venue.id, userId: u.id, role: "owner" });

    const lib = await request(app).get(url(venue.id)).set(auth(u.id)).expect(200);
    expect(lib.body.tracks.some((t: { scope: string }) => t.scope === "replay")).toBe(true);
    const recs = await request(app).get(url(venue.id, "/recommendations")).set(auth(u.id)).expect(200);
    expect(Object.keys(recs.body.templates)).toHaveLength(31);

    const up = await uploadAs(u.id, venue.id, { title: "Our pitch anthem", mood: "hype", rights: "true" });
    expect(up.status).toBe(201);
    expect((await request(app).get(url(venue.id, `/${up.body.track.trackId}/file`)).set(auth(u.id))).status).toBe(200);
    // Another academy can't use the field's own track.
    expect((await request(app).get(url(academyA, `/${up.body.track.trackId}/file`)).set(auth(ownerA))).status).toBe(404);

    const res = await request(app).post(`/api/academy/console/academies/${venue.id}/creative/projects`).set(auth(u.id))
      .send({ scene: buildTemplateScene("goal", "broadcast", "story", "en") }).expect(201);
    const [track] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.id, res.body.project.scene.music.trackId));
    expect(track).toMatchObject({ scope: "replay", key: "cc0/energetic-electro-tune" });
  });
});
