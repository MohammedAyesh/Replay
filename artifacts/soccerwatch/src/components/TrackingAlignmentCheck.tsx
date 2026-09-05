import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

/**
 * admin.tsx keeps its apiFetch private, and this component is only ever mounted
 * from there, so it carries the same two lines rather than forcing that helper
 * out into a shared module for one caller.
 */
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${basePath}/api${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Do the boxes land on people?
 *
 * The upload validator checks that segment frame ranges are contiguous and that
 * every crossing names a track in its own segment. Both are real checks and they
 * caught a genuinely malformed bundle. Neither can check the one thing that
 * decides whether the feature works at all: whether the tracking is aligned to
 * the video it is drawn over.
 *
 * That alignment is a single number - where the tracked window starts inside the
 * recording - and getting it wrong fails silently. It does not error. It draws
 * every box against footage from another part of the match, which reads as
 * broken tracking rather than as a wrong offset. The 2026-08-24 hour starts 18
 * minutes into a two-hour recording; it was uploaded as 0 and every overlay
 * landed on empty grass.
 *
 * So: pull one frame from the middle of each segment, draw the boxes for that
 * frame on top, and show them. A person settles in two seconds what no schema
 * check can express. Cropped in tight, because at full panorama width a player
 * is thirty pixels tall and you cannot tell a hit from a miss.
 */

type Box = { frame: number; x: number; y: number; w: number; h: number };
type Track = { id: string; startFrame: number; endFrame: number; boxes: Box[] };
type Segment = { segmentIndex: number; name: string; startFrame: number; endFrame: number; tracks: Track[] };
type Manifest = {
  width: number; height: number; frameRate: number; duration: number;
  videoStartSeconds?: number;
  segments: Array<{ index: number; name: string; startFrame: number; endFrame: number }>;
};

const SHOT_W = 460;          // css px per thumbnail
const CROP_W = 1280;         // source px shown - a 3x zoom on a 3840-wide frame
const CROP_H = 720;

function boxAt(track: Track, frame: number): Box | null {
  let best: Box | null = null;
  for (const box of track.boxes) {
    if (!best || Math.abs(box.frame - frame) < Math.abs(best.frame - frame)) best = box;
  }
  return best && Math.abs(best.frame - frame) <= 4 ? best : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function TrackingAlignmentCheck({ recordingId }: { recordingId: number }) {
  const [status, setStatus] = useState("Loading the recording…");
  const [shots, setShots] = useState<Array<{ name: string; seconds: number; drawn: number }>>([]);
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    // Only ever drawImage from this element, never getImageData, so a tainted
    // canvas does not matter here and no CORS header is required.
    let hls: Hls | null = null;

    const waitForPresentedFrame = () => new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(ok);
      };
      const timeout = window.setTimeout(() => finish(false), 8000);
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => finish(true));
      } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        // Older browsers do not expose requestVideoFrameCallback. Give the
        // decoder one paint turn before drawing from the paused element.
        window.requestAnimationFrame(() => finish(true));
      } else {
        video.addEventListener("loadeddata", () => finish(true), { once: true });
      }
    });

    const seekTo = (seconds: number) => new Promise<boolean>((resolve) => {
      if (!Number.isFinite(video.duration) || seconds < 0 || seconds > video.duration + 0.5) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        resolve(ok);
      };
      const onError = () => finish(false);
      const onSeeked = () => {
        void waitForPresentedFrame().then(finish);
      };
      const timeout = window.setTimeout(() => finish(false), 8000);
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.currentTime = seconds;
    });

    const run = async () => {
      try {
        const claim = await get<{
          recording: { videoUrl: string };
          manifest: Manifest;
        }>(`/recordings/${recordingId}/claim-match`);
        if (cancelled) return;
        const { manifest } = claim;
        const videoStart = manifest.videoStartSeconds ?? 0;
        const url = claim.recording.videoUrl;

        setStatus(`Loading video · tracking starts ${videoStart}s in`);
        await new Promise<void>((resolve, reject) => {
          const ok = () => resolve();
          video.addEventListener("loadedmetadata", ok, { once: true });
          video.addEventListener("error", () => reject(new Error("video failed to load")), { once: true });
          if (url.includes(".m3u8") && Hls.isSupported()) {
            hls = new Hls({ enableWorker: false });
            // Intentional omission: tracking alignment measures source pixels.
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) reject(new Error("HLS load failed")); });
          } else {
            video.src = url;
          }
        });
        if (cancelled) return;

        const results: Array<{ name: string; seconds: number; drawn: number }> = [];
        for (const entry of manifest.segments) {
          if (cancelled) return;
          setStatus(`Checking ${entry.name}…`);
          const segment = await get<Segment>(
            `/recordings/${recordingId}/claim-match/segments/${entry.index}`,
          );

          const midFrame = Math.round((entry.startFrame + entry.endFrame) / 2);
          const trackingSeconds = midFrame / manifest.frameRate;
          const boxes = segment.tracks
            .map((track) => boxAt(track, midFrame))
            .filter((box): box is Box => Boolean(box));

          const ok = await seekTo(trackingSeconds + videoStart);
          if (cancelled) return;
          const canvas = canvasRefs.current[entry.index];
          if (!canvas || !ok) {
            results.push({ name: entry.name, seconds: trackingSeconds, drawn: -1 });
            setShots([...results]);
            continue;
          }

          // centre the crop on the players, not on the frame - at a 3x zoom an
          // empty corner would prove nothing either way
          const cx = boxes.length ? median(boxes.map((b) => b.x + b.w / 2)) : manifest.width / 2;
          const cy = boxes.length ? median(boxes.map((b) => b.y + b.h / 2)) : manifest.height / 2;
          const sx = Math.max(0, Math.min(manifest.width - CROP_W, cx - CROP_W / 2));
          const sy = Math.max(0, Math.min(manifest.height - CROP_H, cy - CROP_H / 2));
          const scale = SHOT_W / CROP_W;
          canvas.width = SHOT_W;
          canvas.height = Math.round(CROP_H * scale);

          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.drawImage(video, sx, sy, CROP_W, CROP_H, 0, 0, canvas.width, canvas.height);
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#c7f24a";
          ctx.font = "11px ui-monospace, monospace";
          let drawn = 0;
          for (const box of boxes) {
            const bx = (box.x - sx) * scale;
            const by = (box.y - sy) * scale;
            const bw = box.w * scale;
            const bh = box.h * scale;
            if (bx + bw < 0 || by + bh < 0 || bx > canvas.width || by > canvas.height) continue;
            ctx.strokeRect(bx, by, bw, bh);
            drawn++;
          }
          results.push({ name: entry.name, seconds: trackingSeconds, drawn });
          setShots([...results]);
        }
        setStatus(results.some((r) => r.drawn === 0)
          ? "Some segments drew no boxes at all — that usually means the offset is wrong."
          : "Every box you see should be sitting on a person. If they are on grass, the offset is wrong.");
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Could not run the check");
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (hls) hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [recordingId]);

  return (
    <div className="mt-3 w-full rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <p className="mb-2 text-[11px] text-zinc-400" data-testid="text-alignment-status">{status}</p>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {[0, 1, 2, 3, 4, 5].map((index) => {
          const shot = shots.find((_, i) => i === index);
          return (
            <figure key={index} className="m-0 flex-none">
              <canvas
                ref={(node) => { canvasRefs.current[index] = node; }}
                className="block rounded border border-zinc-800 bg-black"
                style={{ width: SHOT_W / 2, height: (CROP_H * (SHOT_W / CROP_W)) / 2 }}
                data-testid={`canvas-alignment-${index}`}
              />
              <figcaption className="mt-1 font-mono text-[10px] text-zinc-500">
                {shot
                  ? `${shot.name} · ${Math.floor(shot.seconds / 60)}:${String(Math.floor(shot.seconds % 60)).padStart(2, "0")} · ${shot.drawn < 0 ? "seek failed" : `${shot.drawn} boxes`}`
                  : "…"}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

export default TrackingAlignmentCheck;
