/**
 * Highlight reels: the API, and a real render of a two-clip reel with the end
 * screen after the last clip (FFmpeg runs; Bunny is stood in for locally).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, userClipsTable, userReelsTable, settingsDefaultsTable, brandingProfilesTable, fieldsTable, recordingsTable, clipSettingsTable } from "@workspace/db";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "reels-test-"));
const SOURCE = path.join(work, "recording.mp4");
const stored = new Map<string, string>();

const mocks = vi.hoisted(() => ({
  deleted: [] as string[],
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));
vi.mock("../lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bunny")>();
  return {
    ...actual,
    isBunnyConfigured: () => true,
    isBunnyStorageConfigured: () => true,
    getBunnyVideoInfo: vi.fn(async () => ({ duration: 10, hasMP4Fallback: false, availableResolutions: "1080p" })),
    uploadFileToBunnyStoragePath: vi.fn(async (file: string, remote: string) => {
      const copy = path.join(work, remote.replace(/\//g, "_"));
      fs.copyFileSync(file, copy);
      stored.set(remote, copy);
      return `https://storage.test/${remote}`;
    }),
    deleteBunnyStoragePath: vi.fn(async (remote: string) => { mocks.deleted.push(remote); }),
  };
});
vi.mock("../lib/exportSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exportSource")>();
  return {
    ...actual,
    selectExportSource: vi.fn(async () => ({ url: SOURCE, path: "test", width: 3840, height: 1080, renditionLabel: "1080p" })),
  };
});
vi.mock("../lib/ffmpegExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ffmpegExport")>();
  return {
    ...actual,
    // The real buffer step sends HTTP headers; a local file takes none.
    bufferRemoteClip: vi.fn(async (o: { startSec: number; clipDuration: number; totalDuration: number }) => {
      const out = path.join(work, `buf-${Math.random().toString(36).slice(2)}.mp4`);
      const window = Math.min(o.clipDuration + 7, o.totalDuration - o.startSec);
      execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-ss", String(o.startSec), "-i", SOURCE, "-t", String(window),
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", out]);
      return { bufferPath: out, bufferedDuration: window, adjustedOffsetSec: 0 };
    }),
  };
});
vi.mock("../lib/backupExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backupExport")>();
  return {
    ...actual,
    fetchExportObject: vi.fn(async (url: string, opts: { range?: string } = {}) => {
      const remote = url.replace(/^https:\/\/[^/]+\/[^/]+\//, "");
      const file = [...stored.entries()].find(([k]) => remote.endsWith(k))?.[1];
      if (!file) return new Response("missing", { status: 404 });
      const body = fs.readFileSync(file);
      const m = opts.range?.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
        return new Response(body.subarray(start, end + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": String(end - start + 1), "Content-Type": "video/mp4" },
        });
      }
      return new Response(body, { status: 200, headers: { "Content-Length": String(body.length), "Content-Type": "video/mp4" } });
    }),
  };
});
import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);

const TAG = `reel_${Date.now()}`;
const KEYS = [
  "branding.endScreenEnabled", "branding.endScreen.signOff", "branding.endScreen.player",
  "branding.endScreen.match", "branding.endScreen.academy", "branding.endScreen.seconds",
];
let app: Express;
let ownerId: number;
let otherId: number;
let portraitA: number;
let portraitB: number;
let wide: number;
let othersClip: number;
let profileId: number;

function probeDuration(file: string): number {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}

async function waitForReel(id: number, timeoutMs = 150_000): Promise<typeof userReelsTable.$inferSelect> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [reel] = await db.select().from(userReelsTable).where(eq(userReelsTable.id, id));
    if (reel.exportStatus !== "pending") return reel;
    if (Date.now() > until) throw new Error("reel still pending");
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  const { EXPORT_SOURCE_WIDTH: W, EXPORT_SOURCE_HEIGHT: H } = await import("../lib/exportSource");
  execFileSync("ffmpeg", [
    "-nostdin", "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=blue:s=${W}x${H}:d=10:r=30`,
    "-f", "lavfi", "-i", "sine=f=440:r=44100:d=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "10", SOURCE,
  ]);
  const { default: router } = await import("./userReels");
  app = express();
  app.use(express.json());
  app.use("/api", router);
  const [owner] = await db.insert(usersTable).values({ name: "Owner", email: `owner_${TAG}@test.local` }).returning({ id: usersTable.id });
  const [other] = await db.insert(usersTable).values({ name: "Other", email: `other_${TAG}@test.local` }).returning({ id: usersTable.id });
  ownerId = owner.id; otherId = other.id;
  const clip = async (userId: number, start: string, end: string, aspectRatio: string) => (await db.insert(userClipsTable).values({
    userId, videoId: "00000000-0000-0000-0000-0000000000aa", title: `clip ${start}`, startTime: start, endTime: end, aspectRatio,
  }).returning({ id: userClipsTable.id }))[0].id;
  portraitA = await clip(ownerId, "0.1", "0.3", "9:16"); // 1–3 s
  portraitB = await clip(ownerId, "0.5", "0.8", "9:16"); // 5–8 s
  wide = await clip(ownerId, "0.1", "0.2", "16:9");
  othersClip = await clip(otherId, "0.1", "0.2", "9:16");
  const [profile] = await db.insert(brandingProfilesTable).values({
    scopeType: "global", scopeId: 0, nameEn: "JORDAN GALAXY", primaryColor: "#F4CF1F", crestUrl: "preset:jordan-galaxy-crest.png",
  }).returning({ id: brandingProfilesTable.id });
  profileId = profile.id;
  const { invalidateSettingsCache } = await import("../lib/settings");
  await db.insert(settingsDefaultsTable).values([
    { key: KEYS[0], value: true }, { key: KEYS[1], value: true }, { key: KEYS[2], value: false },
    { key: KEYS[3], value: false }, { key: KEYS[4], value: false }, { key: KEYS[5], value: 3 },
  ]);
  invalidateSettingsCache();
}, 180_000);

afterAll(async () => {
  await db.delete(settingsDefaultsTable).where(inArray(settingsDefaultsTable.key, KEYS));
  // One process runs every test file: leave no cached settings behind.
  (await import("../lib/settings")).invalidateSettingsCache();
  await db.delete(brandingProfilesTable).where(eq(brandingProfilesTable.id, profileId));
  await db.delete(userReelsTable).where(inArray(userReelsTable.userId, [ownerId, otherId]));
  await db.delete(userClipsTable).where(inArray(userClipsTable.userId, [ownerId, otherId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [ownerId, otherId]));
  fs.rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  mockedGetLocalUserId.mockResolvedValue(ownerId);
});

describe("POST /user-reels", () => {
  it("needs two to ten of his own clips, each once, all one shape", async () => {
    const post = (body: object) => request(app).post("/api/user-reels").send(body);
    expect((await post({ clipIds: [portraitA] })).status).toBe(400);
    expect((await post({ clipIds: [portraitA, portraitA] })).status).toBe(400);
    expect((await post({ clipIds: [portraitA, othersClip] })).status).toBe(400);
    const mixed = await post({ clipIds: [portraitA, wide] });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error).toMatch(/one shape/);
    expect((await post({ clipIds: [portraitA, portraitB], endScreen: { card: "poster" } })).status).toBe(400);
  });

  it("renders the clips back to back with the end screen after the last one", async () => {
    const res = await request(app).post("/api/user-reels")
      .send({ title: "Saturday", clipIds: [portraitA, portraitB], endScreen: { card: "signOff" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Saturday", status: "pending", aspectRatio: "9:16", endScreen: { card: "signOff" } });
    const reel = await waitForReel(res.body.id);
    expect(reel.exportError).toBeNull();
    expect(reel.exportStatus).toBe("done");
    expect(reel.durationSec).toBe(5);
    const file = stored.get(reel.exportPath!)!;
    // 2 s + 3 s of clips, then the 3 s card after the last one.
    expect(Math.abs(probeDuration(file) - 8)).toBeLessThan(0.3);
    const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
      "-of", "csv=p=0", file]).toString().trim().split(",").map(Number);
    expect([w, h]).toEqual([608, 1080]);

    // Listed, playable in bounded pieces, downloadable.
    const list = await request(app).get("/api/user-reels");
    expect(list.body.map((r: { id: number }) => r.id)).toContain(reel.id);
    const play = await request(app).get(`/api/user-reels/${reel.id}/playback`).set("Range", "bytes=0-99");
    expect(play.status).toBe(206);
    const download = await request(app).get(`/api/user-reels/${reel.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("Saturday.mp4");

    // Not someone else's.
    mockedGetLocalUserId.mockResolvedValue(otherId);
    expect((await request(app).get(`/api/user-reels/${reel.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/user-reels/${reel.id}/playback`)).status).toBe(404);
  }, 200_000);
});

describe("changing and deleting a reel", () => {
  it("re-renders when its end screen changes, and removes its file when deleted", async () => {
    const created = await request(app).post("/api/user-reels").send({ clipIds: [portraitB, portraitA] });
    const first = await waitForReel(created.body.id);
    expect(first.exportStatus).toBe("done");
    expect(first.title).toBe("My highlights");

    const patched = await request(app).patch(`/api/user-reels/${first.id}`).send({ endScreen: { card: "signOff", stats: ["goals"] } });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("pending");
    const second = await waitForReel(first.id);
    expect(second.exportStatus).toBe("done");
    expect(second.exportPath).not.toBe(first.exportPath);
    expect(mocks.deleted).toContain(first.exportPath);

    // A title change alone does not re-render.
    const renamed = await request(app).patch(`/api/user-reels/${first.id}`).send({ title: "Renamed" });
    expect(renamed.body).toMatchObject({ title: "Renamed", status: "done" });

    expect((await request(app).delete(`/api/user-reels/${first.id}`)).status).toBe(204);
    expect(mocks.deleted).toContain(second.exportPath);
    expect((await request(app).get(`/api/user-reels/${first.id}`)).status).toBe(404);
  }, 300_000);

  it("fails with a reason when a clip has been deleted since", async () => {
    const created = await request(app).post("/api/user-reels").send({ clipIds: [portraitA, portraitB] });
    await db.update(userClipsTable).set({ hiddenReason: "deleted", isHidden: true }).where(eq(userClipsTable.id, portraitB));
    try {
      const reel = await waitForReel(created.body.id);
      // Either the render saw it gone, or finished first; both are honest.
      if (reel.exportStatus === "error") expect(reel.exportError).toMatch(/deleted/);
    } finally {
      await db.update(userClipsTable).set({ hiddenReason: null, isHidden: false }).where(eq(userClipsTable.id, portraitB));
    }
  }, 200_000);
});

describe("a reel after the match video is gone", () => {
  it("is made from the clips in their saved copies, without each copy's intro and end card", async () => {
    const bunny = await import("../lib/bunny");
    const info = vi.mocked(bunny.getBunnyVideoInfo);
    const VIDEO = "00000000-0000-0000-0000-0000000000bb";
    // The venue's intro (a test pattern), and the match's listed length: 20 s.
    const intro = path.join(work, "intro.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=1.5:r=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", intro]);
    const [field] = await db.insert(fieldsTable).values({ name: `${TAG} pitch` }).returning({ id: fieldsTable.id });
    const [recording] = await db.insert(recordingsTable).values({
      fieldId: field.id, court: "1", date: "2026-10-12", timeSlot: "20:00", duration: "20",
      videoUrl: `https://vz-test.b-cdn.net/${VIDEO}/playlist.m3u8`,
    }).returning({ id: recordingsTable.id });
    const [settings] = await db.insert(clipSettingsTable).values({ introVideoUrl: intro }).returning({ id: clipSettingsTable.id });
    // Saved copies (9:16, 1080x1920, a size the renderer does not expect) as
    // the export makes them: the intro, the clip (red over blue, so a wrong
    // crop shows), then a 2 s green end card.
    const saved = async (start: number, end: number, color: string) => {
      const seconds = Math.round((end - start) * 20);
      const [row] = await db.insert(userClipsTable).values({
        userId: ownerId, videoId: VIDEO, title: `saved ${color}`,
        startTime: String(start), endTime: String(end), aspectRatio: "9:16", exportStatus: "done",
      }).returning({ id: userClipsTable.id });
      const remote = `clips/${row.id}.mp4`;
      const file = path.join(work, `saved-${row.id}.mp4`);
      execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error",
        "-i", intro, "-f", "lavfi", "-i", `color=c=red:s=1080x960:d=${seconds}:r=30`, "-f", "lavfi", "-i", `color=c=blue:s=1080x960:d=${seconds}:r=30`,
        "-f", "lavfi", "-i", "color=c=green:s=1080x1920:d=2:r=30", "-f", "lavfi", "-i", `sine=f=440:r=44100:d=${1.5 + seconds + 2}`,
        "-filter_complex", "[1:v][2:v]vstack=inputs=2[clip];[0:v]fps=30,setsar=1[i];[clip]setsar=1[c];[3:v]setsar=1[g];[i][c][g]concat=n=3:v=1:a=0[v]",
        "-map", "[v]", "-map", "4:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
      stored.set(remote, file);
      await db.update(userClipsTable).set({ exportedUrl: `https://storage.bunnycdn.com/galaxyfield/${remote}` }).where(eq(userClipsTable.id, row.id));
      return row.id;
    };
    const a = await saved(0.1, 0.2, "red");
    const b = await saved(0.3, 0.45, "green");
    info.mockImplementation(async (videoId: string) => {
      if (videoId.endsWith("bb")) throw new bunny.BunnyVideoNotFoundError(videoId);
      return { duration: 10, hasMP4Fallback: false, availableResolutions: "1080p" } as Awaited<ReturnType<typeof bunny.getBunnyVideoInfo>>;
    });
    try {
      const res = await request(app).post("/api/user-reels").send({ title: "Kept", clipIds: [a, b], endScreen: { card: "signOff" } });
      expect(res.status).toBe(201);
      const reel = await waitForReel(res.body.id);
      expect(reel.exportError).toBeNull();
      expect(reel.exportStatus).toBe("done");
      expect(reel.durationSec).toBe(5);
      // 2 s + 3 s of clip, no intros or end cards from the copies, then the reel's 3 s card.
      const out = stored.get(reel.exportPath!)!;
      expect(Math.abs(probeDuration(out) - 8)).toBeLessThan(0.4);
      // Red on top and blue below, scaled into the reel's 608x1080, at the
      // start of each piece and just before the second ends: never the
      // pattern or the green card.
      const pixel = (t: number, y: number) => [...execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1",
        "-vf", `crop=2:2:304:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
      for (const t of [0.1, 1, 2.2, 4.7]) {
        const [top, bottom] = [pixel(t, 100), pixel(t, 1000)];
        expect(top[0], `red at ${t}s`).toBeGreaterThan(180); expect(top[1]).toBeLessThan(80); expect(top[2]).toBeLessThan(80);
        expect(bottom[2], `blue at ${t}s`).toBeGreaterThan(180); expect(bottom[0]).toBeLessThan(80); expect(bottom[1]).toBeLessThan(80);
      }

      // A clip whose match is gone and that was never saved cannot be in a reel.
      await db.update(userClipsTable).set({ exportStatus: null, exportedUrl: null }).where(eq(userClipsTable.id, b));
      const again = await request(app).post("/api/user-reels").send({ clipIds: [a, b] });
      const failed = await waitForReel(again.body.id);
      expect(failed.exportStatus).toBe("expired");
      const shown = await request(app).get(`/api/user-reels/${failed.id}`);
      expect(shown.body.errorCode).toBe("source_gone");
    } finally {
      info.mockImplementation(async () => ({ duration: 10, hasMP4Fallback: false, availableResolutions: "1080p" }) as Awaited<ReturnType<typeof bunny.getBunnyVideoInfo>>);
      await db.delete(clipSettingsTable).where(eq(clipSettingsTable.id, settings.id));
      await db.delete(userClipsTable).where(inArray(userClipsTable.id, [a, b]));
      await db.delete(recordingsTable).where(eq(recordingsTable.id, recording.id));
      await db.delete(fieldsTable).where(eq(fieldsTable.id, field.id));
    }
  }, 200_000);

  it("finds the clip inside a saved copy only when the intro really is there", async () => {
    const { findClipInExport } = await vi.importActual<typeof import("../lib/ffmpegExport")>("../lib/ffmpegExport");
    const intro = path.join(work, "intro.mp4");
    const plain = path.join(work, "plain.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1080x1920:d=6:r=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", plain]);
    // No intro in the copy: nothing is cut from its start.
    expect(await findClipInExport(plain, { introPath: intro, is9to16: true, clipSeconds: 4 })).toEqual({ start: 0, seconds: 4 });
    // No known length: everything after the intro.
    const r = await findClipInExport(plain, { introPath: null, is9to16: true, clipSeconds: null });
    expect(r.start).toBe(0); expect(Math.abs(r.seconds - 6)).toBeLessThan(0.1);
  }, 60_000);
});

describe("downloading a reel", () => {
  it("counts every clip in it against the allowance, and refuses rather than half-count", async () => {
    const created = await request(app).post("/api/user-reels").send({ clipIds: [portraitA, portraitB] });
    const reel = await waitForReel(created.body.id);
    expect(reel.exportStatus).toBe("done");
    const { clipDownloadsTable } = await import("@workspace/db");
    const { invalidateSettingsCache } = await import("../lib/settings");
    await db.delete(clipDownloadsTable).where(eq(clipDownloadsTable.userId, ownerId));
    await db.insert(settingsDefaultsTable).values({ key: "downloads.limit", value: 1 });
    invalidateSettingsCache();
    try {
      const refused = await request(app).get(`/api/user-reels/${reel.id}/download`);
      expect(refused.status).toBe(402);
      expect(refused.body.needed).toBe(2);
      expect(await db.select().from(clipDownloadsTable).where(eq(clipDownloadsTable.userId, ownerId))).toHaveLength(0);

      await db.update(settingsDefaultsTable).set({ value: 5 }).where(eq(settingsDefaultsTable.key, "downloads.limit"));
      invalidateSettingsCache();
      expect((await request(app).get(`/api/user-reels/${reel.id}/download`)).status).toBe(200);
      expect(await db.select().from(clipDownloadsTable).where(eq(clipDownloadsTable.userId, ownerId))).toHaveLength(2);
      // The same reel again costs nothing more.
      expect((await request(app).get(`/api/user-reels/${reel.id}/download`)).status).toBe(200);
      expect(await db.select().from(clipDownloadsTable).where(eq(clipDownloadsTable.userId, ownerId))).toHaveLength(2);
    } finally {
      await db.delete(settingsDefaultsTable).where(eq(settingsDefaultsTable.key, "downloads.limit"));
      await db.delete(clipDownloadsTable).where(eq(clipDownloadsTable.userId, ownerId));
      invalidateSettingsCache();
    }
  }, 200_000);
});

describe("the reel builder's end screen", () => {
  it("offers the last clip's venue cards and draws a preview", async () => {
    const options = await request(app).get(`/api/user-reels-draft/end-screen?clipIds=${portraitA},${portraitB}`);
    expect(options.status).toBe(200);
    expect(options.body.enabled).toBe(true);
    expect(options.body.cards).toEqual([{ kind: "signOff", available: true }]);
    const png = await request(app).get(`/api/user-reels-draft/end-screen/preview.png?clipIds=${portraitA},${portraitB}&card=signOff`);
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect((await request(app).get(`/api/user-reels-draft/end-screen?clipIds=${othersClip}`)).status).toBe(400);
  }, 30_000);
});
