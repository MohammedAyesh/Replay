import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { academiesTable, creativeMusicTracksTable, db, fieldsTable } from "@workspace/db";
import { MUSIC_LICENSES, MUSIC_MOODS, type Scene } from "@workspace/api-zod";
import {
  addTrack,
  analyzeMusic,
  locateMusic,
  parseEbur128,
  peaksFromSamples,
  resolveSceneMusic,
  sceneWithDefaultMusic,
  seedReplayMusic,
  titleFromFileName,
  isMusicUpload,
  tracksFor,
  usableTrack,
} from "./music";

const tag = Date.now();
let work: string;
let academyA: number;
let academyB: number;
const tone = (file: string, seconds: number, freq = 440) =>
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-ac", "2", file]);

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "creative-music-lib-"));
  process.env.CREATIVE_MUSIC_DIR = path.join(work, "store");
  const [field] = await db.insert(fieldsTable).values({ name: `Music field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const rows = await db.insert(academiesTable).values([{ name: `Music A ${tag}`, fieldId: field.id }, { name: `Music B ${tag}`, fieldId: field.id }]).returning({ id: academiesTable.id });
  [academyA, academyB] = rows.map((r) => r.id);
});
afterAll(() => {
  delete process.env.CREATIVE_MUSIC_DIR;
  delete process.env.CREATIVE_MUSIC_ASSET_DIR;
  fs.rmSync(work, { recursive: true, force: true });
});

describe("music analysis", () => {
  it("reduces samples to peaks scaled to the loudest slice", () => {
    const s = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) s[i] = i < 500 ? 0.25 * Math.sin(i) : -0.5;
    const peaks = peaksFromSamples(s, 10);
    expect(peaks).toHaveLength(10);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks[0]).toBeLessThanOrEqual(0.5);
    expect(peaks[9]).toBe(1);
    expect(peaksFromSamples(new Float32Array(0), 10)).toEqual([]);
    expect(peaksFromSamples(new Float32Array(50), 10)).toEqual(new Array(10).fill(0));
  });

  it("reads the integrated loudness from ebur128's summary", () => {
    expect(parseEbur128("[Parsed_ebur128_0] t: 1 M: -20 S: -20 I: -19.0 LUFS\n  Summary:\n\n  Integrated loudness:\n    I:         -14.3 LUFS\n")).toBe(-14.3);
    expect(parseEbur128("nothing here")).toBeNull();
  });

  it("measures a real file: duration, loudness and 200 peaks", async () => {
    const f = path.join(work, "tone.m4a");
    tone(f, 4);
    const facts = await analyzeMusic(f);
    expect(facts?.durationMs).toBeGreaterThan(3900);
    expect(facts?.durationMs).toBeLessThan(4200);
    expect(facts?.loudnessLufs).toBeGreaterThan(-30);
    expect(facts?.loudnessLufs).toBeLessThan(0);
    expect(facts?.waveform).toHaveLength(200);
    expect(await analyzeMusic(path.join(work, "missing.m4a"))).toBeNull();
  });

  it("knows an upload by extension and type, and names it from the file", () => {
    expect(isMusicUpload({ originalname: "song.mp3", mimetype: "audio/mpeg" })).toBe(true);
    expect(isMusicUpload({ originalname: "Voice Memo.m4a", mimetype: "application/octet-stream" })).toBe(true);
    expect(isMusicUpload({ originalname: "clip.wav", mimetype: "audio/x-wav" })).toBe(true);
    expect(isMusicUpload({ originalname: "film.mp4", mimetype: "video/mp4" })).toBe(false);
    expect(isMusicUpload({ originalname: "song.mp3", mimetype: "image/png" })).toBe(false);
    expect(isMusicUpload({ originalname: "notes.txt", mimetype: "audio/mpeg" })).toBe(false);
    expect(titleFromFileName("our_anthem-final.mp3")).toBe("our anthem final");
  });
});

describe("Replay's bundled library", () => {
  it("seeds library.json once: a second run adds nothing and an admin's edits stay", async () => {
    const dir = path.join(work, "assets");
    fs.mkdirSync(path.join(dir, `t${tag}`), { recursive: true });
    tone(path.join(dir, `t${tag}`, "one.m4a"), 3.5, 330);
    tone(path.join(dir, `t${tag}`, "two.m4a"), 3.5, 550);
    fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify({ tracks: [
      { key: `t${tag}/one`, title: "One", mood: "hype", bpm: 120 },
      { key: `t${tag}/two`, title: "Two", mood: "chill" },
      { key: `t${tag}/missing`, title: "No file", mood: "fun" },
      { key: "../escape", title: "Bad key", mood: "fun" },
      { key: `t${tag}/bad-mood`, title: "Bad mood", mood: "angry" },
    ] }));
    process.env.CREATIVE_MUSIC_ASSET_DIR = dir;
    try {
      expect(await seedReplayMusic(dir)).toBe(2);
      const rows = await db.select().from(creativeMusicTracksTable).where(inArray(creativeMusicTracksTable.key, [`t${tag}/one`, `t${tag}/two`]));
      expect(rows).toHaveLength(2);
      const one = rows.find((r) => r.key === `t${tag}/one`)!;
      expect(one).toMatchObject({ scope: "replay", academyId: null, title: "One", mood: "hype", bpm: 120, path: `asset:t${tag}/one`, license: MUSIC_LICENSES.generated, status: "active" });
      expect(one.durationMs).toBeGreaterThan(3400);
      expect(one.waveform).toHaveLength(200);
      expect(locateMusic(one)?.kind).toBe("asset");

      await db.update(creativeMusicTracksTable).set({ title: "Renamed", status: "hidden" }).where(eq(creativeMusicTracksTable.id, one.id));
      expect(await seedReplayMusic(dir)).toBe(0);
      const [again] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.id, one.id));
      expect(again).toMatchObject({ title: "Renamed", status: "hidden" });
      expect(await db.$count(creativeMusicTracksTable, inArray(creativeMusicTracksTable.key, [`t${tag}/one`, `t${tag}/two`]))).toBe(2);
    } finally {
      delete process.env.CREATIVE_MUSIC_ASSET_DIR;
    }
  });

  it("ships 6–8 generated tracks of 30–60 s, every mood covered, each seeded once", async () => {
    const lib = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../../../assets/creative/music/library.json"), "utf8")) as { tracks: Array<{ key: string; mood: string; license: string }> };
    expect(lib.tracks.length).toBeGreaterThanOrEqual(6);
    expect(lib.tracks.length).toBeLessThanOrEqual(8);
    expect(new Set(lib.tracks.map((t) => t.mood))).toEqual(new Set(MUSIC_MOODS));
    for (const t of lib.tracks) expect(t.license).toBe(MUSIC_LICENSES.generated);
    await seedReplayMusic();
    expect(await seedReplayMusic()).toBe(0);
    const rows = await db.select().from(creativeMusicTracksTable).where(inArray(creativeMusicTracksTable.key, lib.tracks.map((t) => t.key)));
    expect(rows).toHaveLength(lib.tracks.length);
    for (const r of rows) {
      expect(r.durationMs).toBeGreaterThanOrEqual(30_000);
      expect(r.durationMs).toBeLessThanOrEqual(60_000);
      // Mastered loud but not clipped: about -14 LUFS.
      expect(r.loudnessLufs).toBeGreaterThan(-16);
      expect(r.loudnessLufs).toBeLessThan(-12);
    }
  });
});

describe("whose music a render may use", () => {
  it("lets an academy use Replay's tracks and its own, never another academy's or a hidden one", async () => {
    const up = path.join(work, "own.wav");
    tone(up, 5, 660);
    const mine = await addTrack({ scope: "academy", academyId: academyA, uploadPath: up, title: "A's song", artist: null, mood: "fun", bpm: null, license: MUSIC_LICENSES.academy, createdBy: null });
    expect(mine).toMatchObject({ scope: "academy", academyId: academyA, mime: "audio/mp4" });
    expect(mine.path).toMatch(new RegExp(`^local:creative-music/${academyA}/[0-9a-f-]{36}\\.m4a$`));
    const [replay] = await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.key, "replay/matchday-anthem"));
    expect(replay).toBeTruthy();

    expect(await usableTrack(academyA, mine.id)).not.toBeNull();
    expect(await usableTrack(academyB, mine.id)).toBeNull();
    expect(await usableTrack(academyB, replay.id)).not.toBeNull();
    expect((await tracksFor(academyB)).some((t) => t.id === mine.id)).toBe(false);
    expect((await tracksFor(academyA, { scope: "academy" })).map((t) => t.id)).toEqual([mine.id]);

    const temps: string[] = [];
    const own = await resolveSceneMusic(academyA, { trackId: mine.id, volume: 0.5 }, temps);
    expect(own?.path && fs.existsSync(own.path)).toBe(true);
    expect(own?.loudnessLufs).toBeTypeOf("number");
    expect(await resolveSceneMusic(academyB, { trackId: mine.id, volume: 0.5 }, temps)).toBeNull();
    expect((await resolveSceneMusic(academyB, { trackId: replay.id, volume: 0.5 }, temps))?.durationMs).toBe(replay.durationMs);
    // Designs saved before the library point at the bundled file by key.
    expect((await resolveSceneMusic(academyB, { trackKey: "replay/matchday-anthem", volume: 0.5 }, temps))?.loudnessLufs).toBe(replay.loudnessLufs);
    expect(await resolveSceneMusic(academyB, { trackKey: "../../etc/passwd", volume: 0.5 }, temps)).toBeNull();
    expect(await resolveSceneMusic(academyB, { volume: 0.5 }, temps)).toBeNull();

    // A path that isn't the track's own scope is never read.
    expect(locateMusic({ ...mine, academyId: academyB })).toBeNull();

    await db.update(creativeMusicTracksTable).set({ status: "hidden" }).where(eq(creativeMusicTracksTable.id, mine.id));
    expect(await resolveSceneMusic(academyA, { trackId: mine.id, volume: 0.5 }, temps)).toBeNull();
  });
});

describe("template soundtracks", () => {
  const video = (key: string): Scene => ({ v: 1, format: "story", durationMs: 15000, background: "#000000", locale: "en", layers: [], template: { key, style: "broadcast" } });

  it("gives goal hype, training fun and talk chill (low, ducked) from the library, and leaves the rest alone", async () => {
    const lib = (await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.scope, "replay"))).filter((t) => t.status === "active").sort((a, b) => a.id - b.id);
    const first = (mood: string) => lib.find((t) => t.mood === mood)!.id;
    const goal = await sceneWithDefaultMusic(video("goal"), "goal");
    expect(goal.music).toMatchObject({ trackId: first("hype"), volume: 0.7, duck: false });
    expect((await sceneWithDefaultMusic(video("training"), "training")).music).toMatchObject({ trackId: first("fun") });
    expect((await sceneWithDefaultMusic(video("talk"), "talk")).music).toMatchObject({ trackId: first("chill"), volume: 0.25, duck: true });

    const still: Scene = { ...video("goal"), durationMs: undefined };
    expect((await sceneWithDefaultMusic(still, "goal")).music).toBeUndefined();
    const chosen: Scene = { ...video("goal"), music: { trackId: 999, volume: 0.1 } };
    expect((await sceneWithDefaultMusic(chosen, "goal")).music).toEqual({ trackId: 999, volume: 0.1 });
    expect((await sceneWithDefaultMusic(video("fulltime"), "fulltime")).music).toBeUndefined();
    // No track of the mood in the library: no music.
    expect((await sceneWithDefaultMusic(video("goal"), "goal", [])).music).toBeUndefined();
  });
});
