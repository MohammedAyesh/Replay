import { useEffect, useRef, type RefObject } from "react";
import { ballTrailAt, drawBallTrail, trailWidthFor, type BallTrailSample } from "@workspace/api-zod";

/**
 * The red ball trail over the player's <video>.
 *
 * The canvas covers the frame box. The video is the box's absolutely placed
 * child (frameToVideoStyle / applyFrameToVideo, also moved every frame by
 * Follow the ball), so the panorama's on-screen rectangle is read from the
 * video's own offset box on each frame: the trail stays on the ball through
 * pans, zoom, 16:9 / 9:16 and fullscreen without knowing how it got there.
 */
export function BallTrailOverlay({
  videoRef,
  samples,
  fit,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  samples: ReadonlyArray<BallTrailSample>;
  /** The video fills its own box by object-fit (not placed as the panorama): where the picture sits inside it. */
  fit?: "cover" | "contain";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const video = videoRef.current;
      const box = canvas.parentElement;
      if (!video || !box) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.round(box.clientWidth * dpr);
      const ch = Math.round(box.clientHeight * dpr);
      let left = video.offsetLeft;
      let top = video.offsetTop;
      let w = video.offsetWidth;
      let h = video.offsetHeight;
      if (fit && video.videoWidth && video.videoHeight) {
        const s = fit === "cover"
          ? Math.max(w / video.videoWidth, h / video.videoHeight)
          : Math.min(w / video.videoWidth, h / video.videoHeight);
        const dw = video.videoWidth * s;
        const dh = video.videoHeight * s;
        left += (w - dw) / 2;
        top += (h - dh) / 2;
        w = dw;
        h = dh;
      }
      const time = video.currentTime;
      const key = `${cw}x${ch}|${left},${top},${w},${h}|${time.toFixed(3)}`;
      if (key === last) return;
      last = key;
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.clearRect(0, 0, cw, ch);
      if (!(w > 0) || !(h > 0)) return;
      const points = ballTrailAt(samples, time);
      if (!points) return;
      drawBallTrail(
        ctx,
        points,
        (x, y) => [(left + x * w) * dpr, (top + y * h) * dpr],
        trailWidthFor(h * dpr),
      );
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [samples, videoRef, fit]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="ball-trail-overlay"
      className="pointer-events-none absolute inset-0 z-[5] h-full w-full"
    />
  );
}
