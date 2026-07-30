import Hls from "hls.js";
import {
  DEFAULT_SRC_ASPECT,
  OUT_ASPECT,
  interpolateFrame,
  normalizePath,
  type AspectRatio,
} from "./cropFrame";

type KF = { t: number; x: number; y: number; w: number; h: number };

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

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Rewrite a Bunny Stream HLS URL to go through our server-side proxy so the
 * canvas never directly touches the CDN. This prevents the canvas from being
 * tainted (no CORS headers needed from Bunny).
 */
function toProxiedHlsUrl(url: string): string {
  try {
    const { hostname } = new URL(url);
    if (/^[a-zA-Z0-9-]+\.b-cdn\.net$|^video\.bunnycdn\.com$/.test(hostname)) {
      return `${basePath}/api/hls-proxy/manifest?url=${encodeURIComponent(url)}`;
    }
  } catch { /* not a valid URL — leave unchanged */ }
  return url;
}

export async function exportClip(options: ExportClipOptions): Promise<ExportResult> {
  const { startTime, endTime, cropPath, title, aspectRatio, onProgress, returnBlob } = options;
  const playbackUrl = toProxiedHlsUrl(options.playbackUrl);

  const is9to16 = aspectRatio === "9:16";
  /** Output canvas dimensions — portrait for 9:16, landscape for 16:9 */
  const OUT_W = is9to16 ? Math.round(SRC_H * 9 / 16) : 1920;
  const OUT_H = SRC_H;

  // Rewrite pre-frame-model keyframes exactly as the editor and the server-side
  // renderer do, so all three agree on what a clip looks like.
  const outAspect = OUT_ASPECT[(is9to16 ? "9:16" : "16:9") as AspectRatio];
  const framePath = normalizePath(cropPath, DEFAULT_SRC_ASPECT, outAspect);

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
    let captureStream: MediaStream | null = null;
    let durationInitialized = false;
    let recordingStarted = false;
    let finalMimeType = "";

    // Bounds the *load* phase only. It used to be cleared solely inside
    // cleanup(), which on the success path does not run until MediaRecorder
    // stops — i.e. after real-time capture — so any clip longer than
    // LOAD_TIMEOUT_MS aborted mid-recording. startRecording() clears it.
    let loadTimeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      loadTimeoutId = null;
      cleanup();
      reject(new Error("Export timed out waiting for video"));
    }, LOAD_TIMEOUT_MS);

    function clearLoadTimeout() {
      if (loadTimeoutId !== null) {
        clearTimeout(loadTimeoutId);
        loadTimeoutId = null;
      }
    }

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearLoadTimeout();
      cancelAnimationFrame(rafId);
      video.pause();
      // Stop the recorder and release the capture stream's tracks. Without
      // this an aborted export left MediaRecorder running and accumulating
      // chunks for the lifetime of the page.
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.onstop = null;
        mediaRecorder.onerror = null;
        try { mediaRecorder.stop(); } catch { /* already stopping */ }
      }
      if (captureStream) {
        for (const track of captureStream.getTracks()) track.stop();
        captureStream = null;
      }
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

      // Render the full recorded frame rect — x, y, w AND h.
      //
      // This used to sample a fixed OUT_W x SRC_H strip at y = 0 and derive the
      // horizontal centre from cropPath[0].w alone, so a clip framed at 2x with
      // a vertical offset and deliberate black bars exported as a tight zoom-1
      // centre crop of a different part of the pitch — nothing like the preview.
      // The frame may extend outside the source; those regions are black bars.
      const f = interpolateFrame(framePath, t);
      const sx = f.x * SRC_W;
      const sy = f.y * SRC_H;
      const sw = Math.max(1, f.w * SRC_W);
      const sh = Math.max(1, f.h * SRC_H);

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, OUT_W, OUT_H);

      // Intersect the frame with the source and map that sub-rect onto the
      // canvas ourselves, rather than relying on drawImage's out-of-bounds
      // clipping behaviour.
      const ix0 = Math.max(sx, 0);
      const iy0 = Math.max(sy, 0);
      const ix1 = Math.min(sx + sw, SRC_W);
      const iy1 = Math.min(sy + sh, SRC_H);
      if (ix1 > ix0 && iy1 > iy0) {
        const scaleX = OUT_W / sw;
        const scaleY = OUT_H / sh;
        ctx.drawImage(
          video,
          ix0, iy0, ix1 - ix0, iy1 - iy0,
          (ix0 - sx) * scaleX, (iy0 - sy) * scaleY,
          (ix1 - ix0) * scaleX, (iy1 - iy0) * scaleY,
        );
      }

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

      // The load phase is over — this timeout must not fire mid-capture.
      clearLoadTimeout();

      let stream: MediaStream;
      try {
        stream = canvas.captureStream(30);
        captureStream = stream;
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

      startSec = isFinite(startTime) ? startTime * dur : 0;
      endSec = isFinite(endTime) ? endTime * dur : dur;
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
