import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable, academyCreativeProjectsTable, academyMembersTable, academySocialAccountsTable, academySocialPostsTable,
  creativeMusicTracksTable, creativeTemplateMusicTable, db, fieldsTable, renderSnapshotsTable, usersTable,
} from "@workspace/db";
import { buildTemplateScene, type CreativeBrand, type CreativeData, type Scene } from "@workspace/api-zod";
import { renderSceneMp4 } from "../lib/creative/renderVideo";

/**
 * A still with music goes out as a short video (Instagram takes music only
 * inside a video): an academy's line-up post and a field's birthday story get
 * music in the editor (the scene gains a duration, the music and the slow
 * zoom), render to a real MP4 with the soundtrack, and publish as a Reel /
 * video story (Facebook: a video). A still without music stays a photo.
 */

process.env.META_ACCESS_TOKEN = "test-token";
process.env.META_AD_ACCOUNT_ID = "123456";
process.env.META_APP_SECRET = "test-app-secret";
process.env.PUBLIC_BASE_URL = "https://replay.test";

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

const stamp = Date.now();
const graphCalls: Array<{ path: string; params: Record<string, string> }> = [];
let seq = 0;
const createdProjects: number[] = [];
vi.mock("../lib/meta/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/graph")>();
  return {
    ...actual,
    graphGet: vi.fn(async (p: string) => {
      if (p.startsWith("ig-container-")) return { status_code: "FINISHED" };
      if (p.startsWith("ig-published-")) return { permalink: `https://instagram.com/p/${p}` };
      return {};
    }),
    graphPost: vi.fn(async (p: string, params: Record<string, string> = {}) => {
      graphCalls.push({ path: p, params });
      seq += 1;
      if (p.endsWith("/media")) return { id: `ig-container-${seq}` };
      if (p.endsWith("/media_publish")) return { id: `ig-published-${seq}` };
      if (p.endsWith("/videos")) return { id: `fb-video-${seq}` };
      return { id: `x-${seq}` };
    }),
  };
});
// Rendered videos are kept on this machine instead of Bunny Storage.
vi.mock("../lib/meta/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/media")>();
  return { ...actual, storeVideo: vi.fn(async (academyId: number) => `https://storage.test/ad-media/${academyId}/${seq++}.mp4`) };
});

import { encryptToken } from "../lib/meta/crypto";
import { ensureReplayMusic } from "../lib/creative/music";
import { publishPost } from "../lib/social/posts";
import creativeRouter from "./academyCreative";
import renderRouter from "./academyCreativeRender";
import publishRouter from "./academyCreativePublish";

let app: Express;
let work: string;
const created: { users: number[]; academies: number[]; fields: number[] } = { users: [], academies: [], fields: [] };
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = (academyId: number) => `/api/academy/console/academies/${academyId}/creative`;

async function owner(kind: "academy" | "venue", n: number) {
  const [user] = await db.insert(usersTable).values({ name: `Photo music ${kind} ${n} ${stamp}`, email: `photo-music-${kind}-${n}-${stamp}@test.local` }).returning({ id: usersTable.id });
  const [field] = await db.insert(fieldsTable).values({ name: `Photo music field ${kind} ${stamp}`, cameraId: `camera${n}` }).returning({ id: fieldsTable.id });
  const [academy] = await db.insert(academiesTable).values({ name: `Photo Music ${kind} ${stamp}`, fieldId: field.id, kind }).returning({ id: academiesTable.id });
  await db.insert(academyMembersTable).values({ academyId: academy.id, userId: user.id, role: "owner" });
  await db.insert(academySocialAccountsTable).values({
    academyId: academy.id, tokenEnc: encryptToken("sys-token"), pageId: `7${n}${stamp}`, pageName: `Page ${kind}`, pageTokenEnc: encryptToken("page-token"),
    igUserId: `17${n}${stamp}`, igUsername: `photo.${kind}`, subscribed: true, status: "connected", connectedAt: new Date(),
  });
  created.users.push(user.id); created.academies.push(academy.id); created.fields.push(field.id);
  return { userId: user.id, academyId: academy.id, ig: `17${n}${stamp}`, page: `7${n}${stamp}` };
}

const trackId = async (key: string) => (await db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.key, key)))[0]!.id;

/** What the editor's "Add music" saves (photoVideoFrom): a duration, the music on, the slow zoom on; layers untouched. */
const withMusic = (scene: Scene, music: Scene["music"], durationMs: number): Scene => ({ ...scene, durationMs, music, slowZoom: true });

function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file]).toString();
  return JSON.parse(out) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>; format: { duration: string } };
}

async function renderAndWait(o: { userId: number; academyId: number }, id: number) {
  await request(app).post(`${base(o.academyId)}/projects/${id}/render`).set(auth(o.userId)).expect((r) => { if (r.status !== 200 && r.status !== 202) throw new Error(`render ${r.status}`); });
  for (let i = 0; i < 600; i++) {
    const [row] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, id));
    if (row.renderStatus === "done" || row.renderStatus === "failed") return row;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("render never finished");
}

async function downloadOutput(o: { userId: number; academyId: number }, id: number, name: string) {
  const res = await request(app).get(`${base(o.academyId)}/projects/${id}/output`).set(auth(o.userId))
    .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); })
    .expect(200);
  const file = path.join(work, name);
  fs.writeFileSync(file, res.body as Buffer);
  return { file, type: String(res.headers["content-type"]) };
}

function frameBytes(file: string, seconds: number): Buffer {
  return execFileSync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", file,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: 16 * 1024 * 1024 });
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "creative-photo-music-"));
  app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", creativeRouter, renderRouter, publishRouter);
  // Seeding measures every bundled track once (slow on a fresh database).
  await ensureReplayMusic();
  await db.delete(creativeTemplateMusicTable);
}, 300_000);

afterAll(async () => {
  for (const projectId of createdProjects) {
    await db.delete(renderSnapshotsTable).where(eq(renderSnapshotsTable.artifactKey, `creative_project:${projectId}`));
  }
  for (const id of created.academies) await db.delete(academiesTable).where(eq(academiesTable.id, id));
  for (const id of created.fields) await db.delete(fieldsTable).where(eq(fieldsTable.id, id));
  for (const id of created.users) await db.delete(usersTable).where(eq(usersTable.id, id));
  fs.rmSync(work, { recursive: true, force: true });
});

describe("Creative hub: a photo with music goes out as a video", () => {
  it("saves a video render snapshot and reproduces its duration and frame", async () => {
    const o = await owner("academy", 3);
    const scene: Scene = {
      v: 1, format: "post", durationMs: 2000, background: "#0B0F1A", locale: "en",
      layers: [
        { id: "panel", kind: "shape", shape: "rect", x: 80, y: 80, w: 920, h: 1190, fill: "#D4FF4F" },
        { id: "title", kind: "text", text: "SNAPSHOT REPLAY", font: "display", size: 96, weight: 700, color: "#0B0F1A",
          align: "center", dir: "auto", x: 80, y: 500, w: 920, h: 180 },
      ],
    };
    const made = await request(app).post(`${base(o.academyId)}/projects`).set(auth(o.userId)).send({ scene }).expect(201);
    createdProjects.push(made.body.project.id);
    const row = await renderAndWait(o, made.body.project.id);
    expect(row).toMatchObject({ renderStatus: "done", outputMime: "video/mp4" });
    const { file } = await downloadOutput(o, row.id, "snapshot-original.mp4");
    const [saved] = await db.select().from(renderSnapshotsTable)
      .where(eq(renderSnapshotsTable.outputLocator, row.outputPath!));
    expect(saved?.snapshot).toMatchObject({
      renderKind: "creative_project",
      output: { mimeType: "video/mp4", width: 1080, height: 1350, durationMs: 2000 },
      template: { id: null },
      replayable: true,
      assets: [],
    });

    const content = saved.snapshot.content;
    const replay = path.join(work, "snapshot-replay.mp4");
    await renderSceneMp4({
      scene: content.effectiveScene as Scene,
      brand: content.brand as CreativeBrand,
      data: content.data as CreativeData,
      videos: async () => null,
      workDir: work,
      out: replay,
    });
    const originalInfo = probe(file);
    const replayInfo = probe(replay);
    expect(Math.abs(Number(originalInfo.format.duration) - Number(replayInfo.format.duration))).toBeLessThan(0.02);
    expect(frameBytes(file, 0.6)).toEqual(frameBytes(replay, 0.6));
  }, 240_000);

  it("an academy's line-up post: saved as a video, renders H.264 + AAC with the music, posts as a Reel and a Facebook video, never a feed photo", async () => {
    const o = await owner("academy", 1);
    // From the template it is a still, without music: nothing changes by default.
    const still = buildTemplateScene("lineup", "broadcast", "post", "en");
    const made = await request(app).post(`${base(o.academyId)}/projects`).set(auth(o.userId)).send({ scene: still, templateKey: "lineup" }).expect(201);
    expect(made.body.project).toMatchObject({ kind: "image" });
    expect(made.body.project.scene.music).toBeUndefined();
    expect(made.body.project.scene.durationMs).toBeUndefined();

    const music = { trackId: await trackId("cc0/now-thats-automation"), volume: 0.6, startMs: 0, fadeInMs: 300, fadeOutMs: 1500, duck: false };
    const saved = await request(app).patch(`${base(o.academyId)}/projects/${made.body.project.id}`).set(auth(o.userId))
      .send({ scene: withMusic(made.body.project.scene, music, 15_000) }).expect(200);
    expect(saved.body.project).toMatchObject({ kind: "video", renderStatus: "none" });
    expect(saved.body.project.scene).toMatchObject({ durationMs: 15_000, slowZoom: true, music: { trackId: music.trackId } });

    const row = await renderAndWait(o, made.body.project.id);
    expect(row.renderError).toBeNull();
    expect(row).toMatchObject({ renderStatus: "done", outputMime: "video/mp4", kind: "video" });
    const { file, type } = await downloadOutput(o, row.id, "lineup.mp4");
    expect(type).toContain("video/mp4");
    const info = probe(file);
    expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: 1350 });
    expect(info.streams.find((s) => s.codec_type === "audio")?.codec_name).toBe("aac");
    expect(Math.abs(Number(info.format.duration) - 15)).toBeLessThan(0.15);
    expect(fs.statSync(file).size).toBeLessThan(8 * 1024 * 1024);

    // Not a feed photo any more: a Reel (Instagram feed video) and a Facebook video.
    const feed = await request(app).post(`${base(o.academyId)}/projects/${row.id}/publish`).set(auth(o.userId))
      .send({ targets: ["instagram"], placement: "feed", caption: "Line-up" });
    expect(feed.status).toBe(400);
    expect(feed.body).toMatchObject({ code: "placement", allowed: ["reel"] });
    const res = await request(app).post(`${base(o.academyId)}/projects/${row.id}/publish`).set(auth(o.userId))
      .send({ targets: ["instagram", "facebook"], caption: "Our line-up" }).expect(201);
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, res.body.post.id));
    expect(post).toMatchObject({ format: "reel", status: "scheduled" });
    expect(post.media).toEqual([expect.objectContaining({ type: "video" })]);
    graphCalls.length = 0;
    await publishPost(post.id);
    const ig = graphCalls.find((c) => c.path === `${o.ig}/media`)!;
    expect(ig.params).toMatchObject({ media_type: "REELS", share_to_feed: "true", caption: "Our line-up" });
    expect(ig.params.video_url).toMatch(/^https:\/\/replay\.test\//);
    expect(ig.params.image_url).toBeUndefined();
    expect(graphCalls.some((c) => c.path === `${o.page}/videos`)).toBe(true);
    expect(graphCalls.some((c) => c.path === `${o.page}/photos`)).toBe(false);
  }, 240_000);

  it("a field's birthday story (academies.kind = 'venue') goes out as a video story with the music; back to a photo it's an image story again", async () => {
    const o = await owner("venue", 2);
    const still = buildTemplateScene("birthday", "broadcast", "story", "en");
    const made = await request(app).post(`${base(o.academyId)}/projects`).set(auth(o.userId)).send({ scene: still, templateKey: "birthday" }).expect(201);
    const music = { trackId: await trackId("cc0/beach-sports"), volume: 0.6, startMs: 0, fadeInMs: 300, fadeOutMs: 1500, duck: false };
    await request(app).patch(`${base(o.academyId)}/projects/${made.body.project.id}`).set(auth(o.userId))
      .send({ scene: withMusic(made.body.project.scene, music, 10_000) }).expect(200);
    const row = await renderAndWait(o, made.body.project.id);
    expect(row).toMatchObject({ renderStatus: "done", outputMime: "video/mp4" });
    const { file } = await downloadOutput(o, row.id, "birthday.mp4");
    const info = probe(file);
    expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(info.streams.find((s) => s.codec_type === "audio")?.codec_name).toBe("aac");
    expect(Math.abs(Number(info.format.duration) - 10)).toBeLessThan(0.15);
    // Instagram stories: ≤ 60 s; kept small.
    expect(Number(info.format.duration)).toBeLessThanOrEqual(60);
    expect(fs.statSync(file).size).toBeLessThan(8 * 1024 * 1024);
    // The music is in it, not a silent track.
    const err = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-ss", "3", "-t", "2", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    expect(Number(/mean_volume: (-?[\d.]+) dB/.exec(err)?.[1] ?? -99)).toBeGreaterThan(-40);

    const res = await request(app).post(`${base(o.academyId)}/projects/${row.id}/publish`).set(auth(o.userId))
      .send({ targets: ["instagram"] }).expect(201);
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, res.body.post.id));
    expect(post).toMatchObject({ format: "story", caption: "" });
    expect(post.media).toEqual([expect.objectContaining({ type: "video" })]);
    graphCalls.length = 0;
    await publishPost(post.id);
    const ig = graphCalls.find((c) => c.path === `${o.ig}/media`)!;
    expect(ig.params.media_type).toBe("STORIES");
    expect(ig.params.video_url).toMatch(/^https:\/\/replay\.test\//);

    // "Back to a photo": the saved scene loses its duration and music, and it is an image story again.
    const back = { ...made.body.project.scene } as Scene;
    const photo = await request(app).patch(`${base(o.academyId)}/projects/${row.id}`).set(auth(o.userId)).send({ scene: back }).expect(200);
    expect(photo.body.project).toMatchObject({ kind: "image", renderStatus: "none" });
    const again = await renderAndWait(o, row.id);
    expect(again).toMatchObject({ renderStatus: "done", outputMime: "image/png" });
  }, 240_000);
});
