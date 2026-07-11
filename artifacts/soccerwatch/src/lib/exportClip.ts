import Hls from "hls.js";

type KF = { t: number; x: number; y: number; w: number; h: number };

function lerp(a: number, b: number, p: number) {
  return a + (b - a) * p;
}

function interpolateX(keyframes: KF[], t: number): number {
  if (keyframes.length === 0) return 0.5;
  if (keyframes.length === 1) return keyframes[0].x;
  if (t <= keyframes[0].t) return keyframes[0].x;
  if (t >= keyframes[keyframes.length - 1].t)
    return keyframes[keyframes.length - 1].x;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i],
      b = keyframes[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return lerp(a.x, b.x, p);
    }
  }
  return keyframes[keyframes.length - 1].x;
}

export interface ExportClipOptions {
  playbackUrl: string;
  startTime: number;
  endTime: number;
  cropPath: KF[];
  title: string;
  aspectRatio?: string;
  onProgress?: (progress: number) => void;
  /**
   * When true, returns the Blob instead of triggering a download.
   * Useful for saving to local storage (IndexedDB).
   */
  returnBlob?: boolean;
}

export type ExportResult = void | { blob: Blob; mimeType: string; ext: string };

/** Full source video dimensions (panoramic dual-camera) */
const SRC_W = 3840;
const SRC_H = 1080;

/** Maximum seconds to wait for video/HLS to become ready before giving up */
const LOAD_TIMEOUT_MS = 45_000;

export function canExportVideo(): boolean {
  try {
    return (
      typeof HTMLCanvasElement !== "undefined" &&
      typeof (HTMLCanvasElement.prototype as { captureStream?: unknown })
        .captureStream === "function" &&
      typeof MediaRecorder !== "undefined"
    );
  } catch {
    return false;
  }
}

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const mt of candidates) {
    if (MediaRecorder.isTypeSupported(mt)) return mt;
  }
  return "";
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function exportClip(options: ExportClipOptions): Promise<ExportResult> {
  const { playbackUrl, startTime, endTime, cropPath, title, aspectRatio, onProgress, returnBlob } =
    options;

  const is9to16 = aspectRatio === "9:16";
  /** Output canvas dimensions — portrait for 9:16, landscape for 16:9 */
  const OUT_W = is9to16 ? Math.round(SRC_H * 9 / 16) : 1920;
  const OUT_H = SRC_H;

  if (!canExportVideo()) {
    await fallbackShare(playbackUrl, title);
    return;
  }

  return new Promise<ExportResult>((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    Object.assign(video.style, {
      position: "fixed",
      left: "-9999px",
      top: "-9999px",
      width: `${SRC_W}px`,
      height: `${SRC_H}px`,
      pointerEvents: "none",
      opacity: "0",
    });
    document.body.appendChild(video);

    const canvas = document.createElement("canvas");
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext("2d")!;

    const chunks: BlobPart[] = [];
    let mediaRecorder: MediaRecorder | null = null;
    let rafId = 0;
    let startSec = 0;
    let endSec = 0;
    let clipDuration = 1;
    let hlsInstance: Hls | null = null;
    let durationInitialized = false;
    let recordingStarted = false;
    let finalMimeType = "";

    const loadTimeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Export timed out waiting for video"));
    }, LOAD_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(loadTimeoutId);
      cancelAnimationFrame(rafId);
      video.pause();
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      if (document.body.contains(video)) {
        document.body.removeChild(video);
      }
    }

    function tick() {
      const now = video.currentTime;
      const t = Math.max(0, Math.min(1, (now - startSec) / clipDuration));
      const x = interpolateX(cropPath, t);

      // x is the left-edge fraction of the panoramic source.
      // For 9:16 we center the crop window on the recorded crop center;
      // for 16:9 the crop width ≈ OUT_W so left-edge positioning is equivalent.
      const kfW = cropPath[0]?.w ?? (is9to16 ? 9 / 16 / (3840 / 1080) : 0.5);
      const cropCenterSrc = (x + kfW / 2) * SRC_W;
      const sourceX = Math.max(0, Math.min(SRC_W - OUT_W, cropCenterSrc - OUT_W / 2));
      ctx.drawImage(video, sourceX, 0, OUT_W, SRC_H, 0, 0, OUT_W, OUT_H);

      onProgress?.(t);

      if (now >= endSec - 0.05) {
        mediaRecorder?.stop();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }

    function startRecording() {
      if (recordingStarted) return;
      recordingStarted = true;

      let stream: MediaStream;
      try {
        stream = canvas.captureStream(30);
      } catch (err) {
        // canvas.captureStream() throws SecurityError when the canvas is tainted
        // (CORS not configured on the CDN). Fail fast instead of hanging 45 s.
        cleanup();
        reject(err instanceof Error ? err : new Error("captureStream failed — canvas tainted (CORS)"));
        return;
      }
      const mimeType = pickMimeType();
      finalMimeType = mimeType;
      mediaRecorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        cleanup();
        const ext = finalMimeType.startsWith("video/mp4") ? "mp4" : "webm";
        const blob = new Blob(chunks, { type: finalMimeType || "video/webm" });
        if (returnBlob) {
          resolve({ blob, mimeType: finalMimeType || "video/webm", ext });
        } else {
          triggerDownload(blob, `${title || "clip"}.${ext}`);
          resolve();
        }
      };

      mediaRecorder.onerror = () => {
        cleanup();
        reject(new Error("MediaRecorder error"));
      };

      mediaRecorder.start(200);

      video.play().catch((err) => {
        cleanup();
        reject(err);
      });

      rafId = requestAnimationFrame(tick);
    }

    /**
     * Called once we have a valid finite duration.
     * Sets up timing, then either seeks (and waits for seeked)
     * or starts recording directly if already at the right position.
     */
    function onDurationReady() {
      if (durationInitialized) return;
      const dur = video.duration;
      if (!dur || isNaN(dur) || !isFinite(dur)) return;
      durationInitialized = true;

      startSec = startTime * dur;
      endSec = endTime * dur;
      clipDuration = Math.max(0.1, endSec - startSec);

      if (startSec < 0.05) {
        // Already at the start of the video — seeked may not fire.
        // Wait until the video has enough data, then start recording.
        if (video.readyState >= 3) {
          startRecording();
        } else {
          video.addEventListener("canplay", () => startRecording(), {
            once: true,
          });
        }
      } else {
        // Seek to startSec; startRecording() fires from the seeked handler.
        video.addEventListener("seeked", () => startRecording(), { once: true });
        video.currentTime = startSec;
      }
    }

    // Listen to multiple events so we are robust across browsers and HLS buffering states.
    video.addEventListener("loadedmetadata", onDurationReady);
    video.addEventListener("durationchange", onDurationReady);

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsInstance = hls;
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      // MANIFEST_PARSED is a fast path; loadedmetadata/durationchange above handle the
      // cases where duration is not yet finite at manifest parse time.
      hls.on(Hls.Events.MANIFEST_PARSED, () => onDurationReady());
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          cleanup();
          reject(new Error("HLS load failed"));
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playbackUrl;
    } else {
      cleanup();
      fallbackShare(playbackUrl, title).then(resolve).catch(reject);
    }
  });
}

async function fallbackShare(url: string | null, title: string): Promise<void> {
  const shareUrl = url ?? window.location.href;
  const nav = navigator as Navigator & {
    share?: (data: { title?: string; url?: string }) => Promise<void>;
  };
  if (typeof nav.share === "function") {
    await nav.share({ title, url: shareUrl });
  } else {
    await navigator.clipboard.writeText(shareUrl);
  }
}
