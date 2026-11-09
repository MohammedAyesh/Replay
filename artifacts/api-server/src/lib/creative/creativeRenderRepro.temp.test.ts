import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { resolveSource, sceneForData, type CreativeBrand } from "@workspace/api-zod";
import { applyEndScreen } from "../clipBranding/endScreenVideo";
import { demoBrandLook } from "../clipBranding/demoLook";
import { bufferCameraHlsClip, EXPORT_ENCODE_ARGS } from "../ffmpegExport";
import { waitForCamera4kSource } from "../clipExportSource";
import { renderSceneMp4 } from "./renderVideo";
import { getUhdPlaylist } from "../uhdPlayback";

const project = JSON.parse(fs.readFileSync("/tmp/creative-project-53-repro.json", "utf8")) as {
  scene: Parameters<typeof sceneForData>[0];
  data: Parameters<typeof sceneForData>[1];
};
const metricsPath = "/tmp/creative-project-53-baseline-metrics.txt";
const recordingId = "ae39ed49-ba92-469a-8b0e-ef6f0bc6a2fc";
const workDirs: string[] = [];
const outputFiles: string[] = [];
const cgroupPeak = new Map<string, number>();
const measurements = new Map<string, { node: number; ffmpeg: number; tree: number; cgroup: number }>();
let measurementName: string | null = null;
let sampler: NodeJS.Timeout | null = null;
let safetyKillSent = false;

function report(message: string): void {
  fs.appendFileSync(metricsPath, `${message}\n`);
  console.info(message);
}

function readRssKb(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function processTree(rootPid: number): Array<{ pid: number; ppid: number; rss: number; comm: string }> {
  const processes = new Map<number, { pid: number; ppid: number; rss: number; comm: string }>();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      processes.set(pid, { pid, ppid, rss: readRssKb(pid), comm });
    } catch {
      // The process exited while /proc was being sampled.
    }
  }
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes.values()) {
      if (!found.has(proc.pid) && found.has(proc.ppid)) {
        found.add(proc.pid);
        changed = true;
      }
    }
  }
  return [...found].flatMap((pid) => {
    const proc = processes.get(pid);
    return proc ? [proc] : [];
  });
}

function sample(): void {
  if (!measurementName) return;
  const tree = processTree(process.pid);
  const node = readRssKb(process.pid);
  const ffmpeg = tree.filter((proc) => proc.comm === "ffmpeg").reduce((sum, proc) => sum + proc.rss, 0);
  const total = tree.reduce((sum, proc) => sum + proc.rss, 0);
  let cgroup = 0;
  try {
    cgroup = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim()) / 1024;
  } catch {
    // cgroup data is optional on non-Linux runners.
  }
  const peaks = measurements.get(measurementName) ?? { node: 0, ffmpeg: 0, tree: 0, cgroup: 0 };
  peaks.node = Math.max(peaks.node, node);
  peaks.ffmpeg = Math.max(peaks.ffmpeg, ffmpeg);
  peaks.tree = Math.max(peaks.tree, total);
  peaks.cgroup = Math.max(peaks.cgroup, cgroup);
  measurements.set(measurementName, peaks);
  cgroupPeak.set(measurementName, peaks.cgroup);
  if (cgroup > 7 * 1024 * 1024 && !safetyKillSent) {
    safetyKillSent = true;
    report(`[REPRO-GUARD] ${measurementName} stopped dual FFmpeg at ${Math.round(cgroup)} KiB cgroup RSS`);
    for (const proc of tree) {
      if (proc.comm === "ffmpeg") {
        try { process.kill(proc.pid, "SIGTERM"); } catch { /* process exited */ }
      }
    }
  }
}

function beginMeasurement(name: string): () => void {
  measurementName = name;
  measurements.set(name, { node: 0, ffmpeg: 0, tree: 0, cgroup: 0 });
  if (!sampler) sampler = setInterval(sample, 50);
  sample();
  return () => {
    sample();
    measurementName = null;
    report(`[REPRO-MEMORY] ${name} ${JSON.stringify(measurements.get(name))}`);
  };
}

function newWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creative-project-53-repro-"));
  workDirs.push(dir);
  return dir;
}

function brandFromData(): CreativeBrand {
  const academy = (project.data as Record<string, any>).academy ?? {};
  return {
    primary: "#D4FF4F",
    accent: "#39A8C6",
    ink: "#101820",
    paper: "#FFFFFF",
    muted: "#AAB2BA",
    nameEn: String(academy.name ?? "Jordan Galaxy"),
    nameAr: typeof academy.nameAr === "string" ? academy.nameAr : null,
  };
}

async function productionSource() {
  return waitForCamera4kSource(recordingId, { timeoutMs: 10_000, pollIntervalMs: 1_000 });
}

async function bufferWindow(source: Awaited<ReturnType<typeof productionSource>>) {
  return bufferCameraHlsClip({
    remoteUrl: source.url,
    playlist: source.playlist,
    referer: `${new URL(source.url).origin}/`,
    startSec: 3501.174,
    clipDuration: 3513.323 - 3501.174,
    totalDuration: source.duration,
  });
}

const placeholder = createCanvas(640, 360);
placeholder.getContext("2d").fillStyle = "#243344";
placeholder.getContext("2d").fillRect(0, 0, placeholder.width, placeholder.height);

async function compose(
  buffer: Awaited<ReturnType<typeof bufferWindow>>,
  outputPath: string,
): Promise<number> {
  const scene = sceneForData(project.scene, project.data);
  const data = project.data ?? {};
  const resolvedSources = scene.layers
    .filter((layer) => layer.kind === "video")
    .map((layer) => resolveSource(layer.src, data));
  const recordingSources = resolvedSources.filter((source) => source?.type === "recording");
  if (!recordingSources.some((source) => source?.type === "recording" && source.recordingId === 413)) {
    throw new Error("Project 53 reproduction did not resolve recording 413.");
  }
  const dir = newWorkDir();
  const result = await renderSceneMp4({
    scene,
    data,
    brand: brandFromData(),
    images: async () => placeholder,
    videos: async (layer, source, need) => {
      if (source.type !== "recording" || source.recordingId !== 413) return null;
      return {
        path: buffer.bufferPath,
        zeroAtSec: -need.fromMs / 1000,
        durationMs: source.toMs - source.fromMs,
        hasAudio: false,
        sourceDimensions: buffer.sourceDimensions,
      };
    },
    branding: null,
    workDir: dir,
    out: outputPath,
  });
  return result.durationMs;
}

async function applyEndCard(mainPath: string, finalPath: string): Promise<void> {
  const look = await demoBrandLook({ look: "galaxy", name: "", color: "", persona: "pitch" });
  const withCard = await applyEndScreen({
    mainPath,
    dims: { w: 1080, h: 1920 },
    job: { spec: { kind: "signOff", look, dateLabel: null, link: "https://replayjo.com" }, seconds: 2.5, blur: 14, dim: 0.45 },
    start: JSON.parse(fs.readFileSync("/tmp/creative-project-53-repro.json", "utf8")).scene.durationMs / 1000,
    encode: EXPORT_ENCODE_ARGS,
    hasAudio: true,
  });
  await fs.promises.rename(withCard, finalPath);
  outputFiles.push(finalPath);
}

afterAll(async () => {
  if (sampler) clearInterval(sampler);
  if (measurementName) {
    sample();
    report(`[REPRO-MEMORY-ABORT] ${measurementName} ${JSON.stringify(measurements.get(measurementName))}`);
  }
  await Promise.all(workDirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
  await Promise.all(outputFiles.map((file) => fs.promises.rm(file, { force: true })));
});

it("measures the production project 53 template and 4K clip before changes", async () => {
  fs.writeFileSync(metricsPath, "");
  for (const videoId of ["abad0e28-372c-4a5d-b88a-3da8a5591d35", "798ffd2a-ef23-4f97-a40b-a9092c806bef"]) {
    const done = beginMeasurement(`4k-probe-${videoId}`);
    const playlist = await getUhdPlaylist(videoId);
    done();
    report(`[REPRO-SOURCE] ${videoId} camera4k=${Boolean(playlist)}`);
  }

  const resolveDone = beginMeasurement("source-resolve");
  const source = await productionSource();
  resolveDone();
  report(`[REPRO-SOURCE] project53 ${JSON.stringify({ videoId: recordingId, duration: source.duration })}`);

  const bufferDone = beginMeasurement("single-buffer-4096");
  const buffer = await bufferWindow(source);
  bufferDone();
  outputFiles.push(buffer.bufferPath);
  report(`[REPRO-BUFFER] ${JSON.stringify({ sourceDimensions: buffer.sourceDimensions, bufferedDuration: buffer.bufferedDuration, downloadedBytes: buffer.downloadedBytes })}`);

  const mainPath = path.join(newWorkDir(), "project-53-compose.mp4");
  const composeDone = beginMeasurement("single-compose");
  const durationMs = await compose(buffer, mainPath);
  composeDone();
  report(`[REPRO-COMPOSE] ${JSON.stringify({ durationMs, layers: project.scene.layers.length })}`);

  const endCardPath = path.join(os.tmpdir(), "creative-project-53-baseline-end-card.mp4");
  const cardDone = beginMeasurement("single-end-card");
  await applyEndCard(mainPath, endCardPath);
  cardDone();

  const dualDirs = [newWorkDir(), newWorkDir()];
  const dualBufferDone = beginMeasurement("two-concurrent-buffers");
  const dualBuffers = await Promise.all(dualDirs.map(() => bufferWindow(source)));
  dualBufferDone();
  outputFiles.push(...dualBuffers.map((item) => item.bufferPath));
  const dualMainPaths = dualDirs.map((dir, index) => path.join(dir, `project-53-concurrent-${index}.mp4`));
  const dualComposeDone = beginMeasurement("two-concurrent-compose");
  let dualComposeSucceeded = true;
  try {
    await Promise.all(dualBuffers.map((item, index) => compose(item, dualMainPaths[index]!)));
  } catch (error) {
    dualComposeSucceeded = false;
    report(`[REPRO-DUAL-COMPOSE-STOPPED] ${String((error as Error).message).slice(0, 240)}`);
  }
  dualComposeDone();
  if (dualComposeSucceeded) {
    const dualCardPaths = dualDirs.map((dir, index) => path.join(dir, `project-53-concurrent-card-${index}.mp4`));
    const dualCardsDone = beginMeasurement("two-concurrent-end-card");
    await Promise.all(dualMainPaths.map((file, index) => applyEndCard(file, dualCardPaths[index]!)));
    dualCardsDone();
  }

  const total = path.join(os.tmpdir(), "creative-project-53-baseline-4k-window.mp4");
  const final = path.join(os.tmpdir(), "creative-project-53-baseline.mp4");
  fs.copyFileSync(buffer.bufferPath, total);
  fs.copyFileSync(endCardPath, final);
  outputFiles.push(total, final);
  report(`[REPRO-FINAL] ${JSON.stringify({ localRenderComplete: fs.statSync(final).size > 0 })}`);
}, 900_000);
