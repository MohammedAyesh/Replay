import { Router } from "express";
import { spawn } from "child_process";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const router = Router();
const ALLOWED_HOST = "cam9.oss-me-central-1.aliyuncs.com";

interface TranscodeJob {
  dir: string;
  done: boolean;
  errored: boolean;
}

const jobMap = new Map<string, TranscodeJob>();

function makeJobId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** master.m3u8 → v0/index.m3u8 (only v0 has a video track) */
function masterToV0(url: string): string {
  return url.replace(/\/master\.m3u8(\?.*)?$/, "/v0/index.m3u8");
}

function fileReady(path: string): boolean {
  try { return existsSync(path) && statSync(path).size > 8; }
  catch { return false; }
}

function waitForFile(
  path: string,
  job: TranscodeJob,
  ms = 90_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (fileReady(path)) { resolve(true); return; }
      if (job.errored) { resolve(false); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(tick, 500);
    };
    tick();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hls/start?url=<encoded_master_m3u8>
//
// Starts an FFmpeg job that transcodes the H.265 HLS stream into H.264 HLS
// segments on disk. Waits until the first segment is ready before responding
// so the client can immediately begin playback.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/hls/start", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url : null;
  if (!rawUrl) { res.status(400).json({ error: "url required" }); return; }

  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { res.status(400).json({ error: "Invalid URL" }); return; }

  if (parsed.hostname !== ALLOWED_HOST) {
    res.status(403).json({ error: "Host not allowed" }); return;
  }

  const id = makeJobId(rawUrl);
  const dir = `/tmp/hls_${id}`;
  const firstSeg = join(dir, "seg0.m4s");

  // Re-use existing job if the first segment already exists
  if (jobMap.has(id) && fileReady(firstSeg)) {
    res.json({ jobId: id });
    return;
  }

  // Start a new FFmpeg job
  if (!jobMap.has(id)) {
    mkdirSync(dir, { recursive: true });

    const v0Url = masterToV0(rawUrl);
    req.log.info({ id, v0Url }, "Starting HLS transcode job");

    const proc = spawn("ffmpeg", [
      "-loglevel", "warning",
      // Input: the H.265 HLS variant with video
      "-i", v0Url,
      // Video: transcode to H.264
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      // Scale to 1280 wide (keeps the panoramic aspect ratio)
      "-vf", "scale=1280:-2",
      "-level", "5.1",
      // Audio: AAC
      "-c:a", "aac",
      "-b:a", "96k",
      // Output: HLS with fMP4 segments
      "-f", "hls",
      "-hls_segment_type", "fmp4",
      "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", join(dir, "seg%d.m4s"),
      "-hls_time", "4",
      "-hls_list_size", "0",
      "-hls_flags", "append_list",
      join(dir, "playlist.m3u8"),
    ], { stdio: ["ignore", "ignore", "pipe"] });

    const job: TranscodeJob = { dir, done: false, errored: false };
    jobMap.set(id, job);

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", (err) => {
      req.log.error({ err }, "FFmpeg spawn error");
      job.errored = true;
      job.done = true;
    });
    proc.on("close", (code) => {
      job.done = true;
      if (code !== 0) {
        job.errored = true;
        req.log.warn({ id, code, stderr: stderr.slice(-600) }, "FFmpeg job failed");
      } else {
        req.log.info({ id }, "FFmpeg job complete");
      }
    });
  }

  const job = jobMap.get(id)!;
  const ready = await waitForFile(firstSeg, job, 90_000);

  if (!ready) {
    if (job.errored) {
      res.status(500).json({ error: "Transcode failed — stream may be unavailable" });
    } else {
      res.status(504).json({ error: "Transcode timeout — try again" });
    }
    return;
  }

  res.json({ jobId: id });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hls/stream/:jobId/:filename
// Serves the generated playlist and segment files from /tmp/hls_<jobId>/
// ─────────────────────────────────────────────────────────────────────────────
router.get("/hls/stream/:jobId/:filename", (req, res) => {
  const { jobId, filename } = req.params;

  if (!jobId.match(/^[a-f0-9]+$/) || filename.includes("..") || filename.includes("/")) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  const filePath = join(`/tmp/hls_${jobId}`, filename);

  if (!existsSync(filePath)) {
    res.status(404).end();
    return;
  }

  const ext = filename.split(".").pop();
  if (ext === "m3u8") {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
  } else {
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=3600");
  }

  res.sendFile(filePath);
});

export default router;
