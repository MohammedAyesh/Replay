import { spawn } from "node:child_process";
import { Router, type IRouter, type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  claimMatchProgressTable,
  db,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";
import { claimIdentityId } from "./claimChain";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { selectExportSource } from "../lib/exportSource";
import { loadRecordingPlay, type RecordingPlay } from "../lib/matchPlayLoad";

const router: IRouter = Router();

const SOURCE_WIDTH = 3840;
const SOURCE_HEIGHT = 1080;
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 540;
const FRAME_TIMEOUT_MS = 20_000;
const FRAME_CACHE_TTL_MS = 10 * 60 * 1000;
const FRAME_CACHE_LIMIT = 24;
const TRACK_BOXES_PER_SECOND = 4;
const COLOR_PALETTE = ["lime", "cyan", "yellow", "magenta", "orange", "deepskyblue"];

type CropRect = { x: number; y: number; width: number; height: number };
type Point = { frame: number; x: number; y: number };
type Box = { frame: number; x: number; y: number; w: number; h: number };
type ClaimView = {
  identityId: string;
  userId: number;
  userName: string;
  parts: Array<{ trackId: string; fromFrame: number; toFrame: number }>;
};

const frameCache = new Map<string, { bytes: Buffer; expiresAt: number }>();
let activeFrameGrabs = 0;
const frameWaiters: Array<() => void> = [];

export function clampCropRect(
  input: { cx?: number; cy?: number; w?: number; h?: number },
  frameWidth = SOURCE_WIDTH,
  frameHeight = SOURCE_HEIGHT,
): CropRect {
  const finite = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? value : fallback;
  const width = Math.max(1, Math.min(frameWidth, Math.round(finite(input.w, frameWidth))));
  const height = Math.max(1, Math.min(frameHeight, Math.round(finite(input.h, frameHeight))));
  const cx = finite(input.cx, frameWidth / 2);
  const cy = finite(input.cy, frameHeight / 2);
  const x = Math.max(0, Math.min(frameWidth - width, Math.round(cx - width / 2)));
  const y = Math.max(0, Math.min(frameHeight - height, Math.round(cy - height / 2)));
  return { x, y, width, height };
}

function parseSecond(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const second = Number(value);
  return Number.isFinite(second) && second >= 0 ? second : null;
}

function roundTime(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000) / 1000;
}

function pointsForWindow(play: RecordingPlay, from: number, to: number): Point[] {
  return play.sidecars.flatMap((sidecar) =>
    (sidecar?.ball ?? [])
      .filter(([frame]) => frame / play.fps >= from && frame / play.fps <= to)
      .map(([frame, x, y]) => ({ frame, x, y })),
  ).sort((a, b) => a.frame - b.frame);
}

function interpolateBall(points: Point[], frame: number, fps: number): { x: number; y: number } | null {
  if (!points.length) return null;
  let before: Point | undefined;
  let after: Point | undefined;
  for (const point of points) {
    if (point.frame <= frame) before = point;
    if (point.frame >= frame) {
      after = point;
      break;
    }
  }
  if (before && after) {
    if (before.frame === after.frame) return { x: before.x, y: before.y };
    if (after.frame - before.frame > fps) return null;
    const ratio = (frame - before.frame) / (after.frame - before.frame);
    return {
      x: before.x + (after.x - before.x) * ratio,
      y: before.y + (after.y - before.y) * ratio,
    };
  }
  const nearest = before ?? after;
  if (!nearest || Math.abs(nearest.frame - frame) > fps / 2) return null;
  return nearest ? { x: nearest.x, y: nearest.y } : null;
}

function cropFromRequest(req: Request): CropRect {
  const numberParam = (key: string): number | undefined => {
    const value = req.query[key];
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return clampCropRect({
    cx: numberParam("cx"),
    cy: numberParam("cy"),
    w: numberParam("w"),
    h: numberParam("h"),
  });
}

function getBunnyVideoId(videoUrl: string): string | null {
  try {
    const parsed = new URL(videoUrl);
    if (!/^[a-z0-9-]+\.b-cdn\.net$/i.test(parsed.hostname)) return null;
    const videoId = parsed.pathname.split("/").filter(Boolean)[0];
    if (!videoId || !/^[a-z0-9-]{8,}$/i.test(videoId)) return null;
    return videoId;
  } catch {
    return null;
  }
}

function escapeDrawText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
    .replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
    .replace(/;/g, "\\;").replace(/%/g, "\\%");
}

function buildFilter(
  crop: CropRect,
  ball: { x: number; y: number } | null,
  boxes: Array<{ box: Box; name: string; color: string }>,
): string {
  const scaleX = OUTPUT_WIDTH / crop.width;
  const scaleY = OUTPUT_HEIGHT / crop.height;
  const filters = [
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`,
  ];
  if (ball) {
    const x = Math.round((ball.x - crop.x) * scaleX - 8);
    const y = Math.round((ball.y - crop.y) * scaleY - 8);
    filters.push(`drawbox=x=${x}:y=${y}:w=16:h=16:color=red@0.95:t=2`);
  }
  for (const { box, name, color } of boxes) {
    const x = Math.round((box.x - crop.x) * scaleX);
    const y = Math.round((box.y - crop.y) * scaleY);
    const width = Math.max(1, Math.round(box.w * scaleX));
    const height = Math.max(1, Math.round(box.h * scaleY));
    filters.push(`drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${color}:t=3`);
    filters.push(`drawtext=text='${escapeDrawText(name)}':x=${x}:y=max(0\\,${y}-24):fontsize=18:fontcolor=${color}:box=1:boxcolor=black@0.65`);
  }
  return filters.join(",");
}

export function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(bytes ?? Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg frame capture timed out"));
    }, FRAME_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => errors.push(Buffer.from(chunk)));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error(`FFmpeg frame capture failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(-1000)}`));
      } else {
        finish(undefined, Buffer.concat(chunks));
      }
    });
  });
}

async function withFrameSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeFrameGrabs >= 2) {
    await new Promise<void>((resolve) => frameWaiters.push(resolve));
  } else {
    activeFrameGrabs++;
  }
  try {
    return await work();
  } finally {
    const next = frameWaiters.shift();
    if (next) next();
    else activeFrameGrabs--;
  }
}

function getCachedFrame(key: string, now = Date.now()): Buffer | undefined {
  for (const [cachedKey, entry] of frameCache) {
    if (entry.expiresAt <= now) frameCache.delete(cachedKey);
  }
  const entry = frameCache.get(key);
  if (!entry) return undefined;
  frameCache.delete(key);
  frameCache.set(key, entry);
  return entry.bytes;
}

function setCachedFrame(key: string, bytes: Buffer): void {
  frameCache.delete(key);
  frameCache.set(key, { bytes, expiresAt: Date.now() + FRAME_CACHE_TTL_MS });
  while (frameCache.size > FRAME_CACHE_LIMIT) {
    const oldest = frameCache.keys().next().value;
    if (oldest === undefined) break;
    frameCache.delete(oldest);
  }
}

async function requireDebugAdmin(req: Request): Promise<boolean> {
  const userId = await getLocalUserId(req);
  if (!userId) return false;
  const [user] = await db.select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isAdmin === true;
}

async function loadDebugRecording(recordingId: number) {
  const [recording] = await db.select({
    id: recordingsTable.id,
    videoUrl: recordingsTable.videoUrl,
  }).from(recordingsTable).where(eq(recordingsTable.id, recordingId)).limit(1);
  if (!recording) return null;
  const [bundle] = await db.select({
    id: recordingTrackingBundlesTable.id,
    updatedAt: recordingTrackingBundlesTable.updatedAt,
  }).from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId))
    .limit(1);
  if (!bundle) return null;
  const play = await loadRecordingPlay(recordingId, { keepSegments: true });
  if (!play?.segments) return null;
  const progress = await db.select({
    userId: claimMatchProgressTable.userId,
  }).from(claimMatchProgressTable)
    .where(eq(claimMatchProgressTable.recordingId, recordingId));
  const userIds = [...new Set(progress.map((row) => row.userId))];
  const claimants = userIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
      .where(inArray(usersTable.id, userIds))
    : [];
  return {
    recording,
    bundleUpdatedAt: bundle.updatedAt.toISOString(),
    play,
    usersById: new Map(claimants.map((user) => [user.id, user.name])),
  };
}

function claimsForWindow(
  play: RecordingPlay,
  usersById: Map<number, string>,
  recordingId: number,
  from: number,
  to: number,
): ClaimView[] {
  const claims: ClaimView[] = [];
  for (const [userId, userName] of usersById) {
    const identityId = claimIdentityId(userId, recordingId);
    const identity = play.manifest.identities?.find((candidate) => candidate.id === identityId);
    const parts = (identity?.parts ?? []).filter((part) =>
      part.toFrame / play.fps >= from && part.fromFrame / play.fps <= to,
    ).map(({ trackId, fromFrame, toFrame }) => ({ trackId, fromFrame, toFrame }));
    if (parts.length) claims.push({ identityId, userId, userName, parts });
  }
  return claims;
}

function boxesForClaims(
  play: RecordingPlay,
  claims: ClaimView[],
  from: number,
  to: number,
): Array<{ identityId: string; userName: string; trackId: string; boxes: Array<[number, number, number, number, number]> }> {
  const tracks = new Map(play.segments!.flatMap((segment) => segment.tracks.map((track) => [track.id, track] as const)));
  const result = [];
  for (const claim of claims) {
    for (const part of claim.parts) {
      const track = tracks.get(part.trackId);
      if (!track) continue;
      const boxes: Array<[number, number, number, number, number]> = [];
      const seenBuckets = new Set<number>();
      for (const box of track.boxes) {
        const second = box.frame / play.fps;
        if (box.frame < part.fromFrame || box.frame > part.toFrame || second < from || second > to) continue;
        const bucket = Math.floor(second * TRACK_BOXES_PER_SECOND);
        if (seenBuckets.has(bucket)) continue;
        seenBuckets.add(bucket);
        boxes.push([roundTime(box.frame, play.fps), box.x, box.y, box.w, box.h]);
      }
      if (boxes.length) result.push({ identityId: claim.identityId, userName: claim.userName, trackId: part.trackId, boxes });
    }
  }
  return result;
}

function claimantBoxesAtFrame(
  play: RecordingPlay,
  claims: ClaimView[],
  frame: number,
): Array<{ box: Box; name: string; color: string }> {
  const tracks = new Map(play.segments!.flatMap((segment) => segment.tracks.map((track) => [track.id, track] as const)));
  const overlays: Array<{ box: Box; name: string; color: string }> = [];
  for (const claim of claims) {
    for (const part of claim.parts) {
      if (frame < part.fromFrame || frame > part.toFrame) continue;
      const track = tracks.get(part.trackId);
      if (!track?.boxes.length) continue;
      let nearest: Box | undefined;
      for (const box of track.boxes) {
        if (box.frame < part.fromFrame || box.frame > part.toFrame) continue;
        if (!nearest || Math.abs(box.frame - frame) < Math.abs(nearest.frame - frame)) nearest = box;
      }
      if (!nearest || Math.abs(nearest.frame - frame) > Math.max(1, Math.round(play.fps / 4))) continue;
      overlays.push({
        box: nearest,
        name: claim.userName,
        color: COLOR_PALETTE[Math.abs(claim.identityId.charCodeAt(6)) % COLOR_PALETTE.length] ?? "lime",
      });
    }
  }
  return overlays;
}

function rawTouchesForWindow(play: RecordingPlay, from: number, to: number) {
  return play.sidecars.flatMap((sidecar) =>
    (sidecar?.touches ?? [])
      .filter(([frame]) => frame / play.fps >= from && frame / play.fps <= to)
      .map(([frame, x0, y0, x1, y1, ballX, ballY, speed]) =>
        [roundTime(frame, play.fps), x0, y0, x1, y1, ballX, ballY, speed] as const),
  ).sort((a, b) => a[0] - b[0]);
}

router.get("/admin/recordings/:id/debug/window", async (req, res): Promise<void> => {
  if (!(await requireDebugAdmin(req))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = Number.parseInt(req.params.id, 10);
  const from = parseSecond(req.query.from);
  const to = parseSecond(req.query.to);
  if (!Number.isInteger(recordingId) || recordingId < 1) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  if (from === null || to === null || to < from || to - from > 120) {
    res.status(400).json({ error: "Window must be a valid range of at most 120 seconds" });
    return;
  }
  const loaded = await loadDebugRecording(recordingId);
  if (!loaded) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const { play } = loaded;
  const claims = claimsForWindow(play, loaded.usersById, recordingId, from, to);
  const ball = pointsForWindow(play, from, to)
    .map((point) => [roundTime(point.frame, play.fps), point.x, point.y, false] as const);
  res.json({
    recordingId,
    from,
    to,
    videoUrl: loaded.recording.videoUrl,
    manifest: {
      fps: play.fps,
      frameRate: play.fps,
      width: play.manifest.width,
      height: play.manifest.height,
      frameCount: play.manifest.frameCount,
      duration: play.manifest.duration,
      videoStartSeconds: play.manifest.videoStartSeconds ?? 0,
      matchOffset: play.manifest.matchOffset ?? 0,
    },
    ball,
    touches: rawTouchesForWindow(play, from, to),
    claims,
    boxes: boxesForClaims(play, claims, from, to),
  });
});

router.get("/admin/recordings/:id/debug/frame", async (req, res): Promise<void> => {
  if (!(await requireDebugAdmin(req))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = Number.parseInt(req.params.id, 10);
  const second = parseSecond(req.query.t);
  if (!Number.isInteger(recordingId) || recordingId < 1) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  if (second === null) {
    res.status(400).json({ error: "A valid t parameter is required" });
    return;
  }
  const loaded = await loadDebugRecording(recordingId);
  if (!loaded) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const crop = cropFromRequest(req);
  const frame = Math.round(second * loaded.play.fps);
  const points = loaded.play.sidecars.flatMap((sidecar) => (sidecar?.ball ?? []).map(([f, x, y]) => ({ frame: f, x, y })))
    .sort((a, b) => a.frame - b.frame);
  const claims = claimsForWindow(loaded.play, loaded.usersById, recordingId, second, second);
  const boxOverlays = claimantBoxesAtFrame(loaded.play, claims, frame);
  const ball = interpolateBall(points, frame, loaded.play.fps);
  const filter = buildFilter(crop, ball, boxOverlays);
  const seekSecond = second + (loaded.play.manifest.videoStartSeconds ?? 0);
  const cacheKey = `${req.originalUrl}:${loaded.bundleUpdatedAt}`;
  let bytes = getCachedFrame(cacheKey);
  try {
    if (!bytes) {
      const videoId = getBunnyVideoId(loaded.recording.videoUrl);
      if (!videoId) {
        res.status(404).json({ error: "Bunny HLS rendition unavailable" });
        return;
      }
      let renditionUrl: string;
      try {
        const source = await selectExportSource({
          videoId,
          hasMP4Fallback: false,
          availableResolutions: "1080p",
          referer: "https://iframe.mediadelivery.net/",
        });
        renditionUrl = source.url;
      } catch {
        res.status(404).json({ error: "1080p Bunny HLS rendition unavailable" });
        return;
      }
      const args = [
        "-nostdin", "-loglevel", "error", "-ss", String(Math.max(0, seekSecond)),
        "-headers", "Referer: https://iframe.mediadelivery.net/\r\n",
        "-i", renditionUrl, "-frames:v", "1", "-an", "-vf", filter,
        "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      ];
      bytes = await withFrameSlot(() => runFfmpeg(args));
      if (bytes.byteLength === 0) throw new Error("FFmpeg returned an empty frame");
      setCachedFrame(cacheKey, bytes);
    }
  } catch {
    res.status(502).json({ error: "Could not capture the requested frame" });
    return;
  }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.send(bytes);
});

export default router;
