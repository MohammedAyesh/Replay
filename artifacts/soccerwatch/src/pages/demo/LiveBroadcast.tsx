import { useEffect, useMemo, useRef, useState } from "react";

import { ReplayMark } from "@/components/ReplayMark";
import { applyFrameToVideo, clampOrigin } from "@/lib/cropFrame";
import type { DemoCopy } from "./copy";
import { formatClock, withBase, type DemoMatch, type DemoMoment, type DemoReport } from "./data";
import { claimPlayback, releasePlayback, useActivePlayback, useHlsSource, useInView } from "./playback";

const PLAYER_ID = "broadcast";
const OUT_ASPECT = 16 / 9;
/** Width of the broadcast frame as a share of the panorama: a tight TV shot. */
const FRAME_W = 0.32;
/** A ball that jumps further than this in a quarter second is a detector error. */
const MAX_JUMP = 0.09;

type Path = Array<[number, number, number]>;

/** Drop detector jumps so the camera never whips to a head or a shoe. */
export function cleanPath(path: Path): Path {
  const out: Path = [];
  let rejected = 0;
  for (const point of path) {
    const last = out[out.length - 1];
    if (last) {
      const dt = Math.max(0.05, point[0] - last[0]);
      // Six rejections in a row means the ball really is over there.
      if (Math.abs(point[1] - last[1]) > MAX_JUMP * (dt / 0.25) + 0.02 && rejected < 6) {
        rejected += 1;
        continue;
      }
    }
    rejected = 0;
    out.push(point);
  }
  return out;
}

/** The ball at time t (linear between samples), or null outside the path. */
export function ballAtTime(path: Path, t: number): { x: number; y: number } | null {
  if (!path.length) return null;
  if (t <= path[0][0]) return { x: path[0][1], y: path[0][2] };
  if (t >= path[path.length - 1][0]) return { x: path[path.length - 1][1], y: path[path.length - 1][2] };
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid][0] <= t) lo = mid; else hi = mid;
  }
  const a = path[lo];
  const b = path[hi];
  const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  return { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f };
}

/** Goals per side scored before time t. */
export function scoreAt(moments: DemoMoment[], t: number): [number, number] {
  const score: [number, number] = [0, 0];
  for (const moment of moments) {
    if (moment.type !== "goal" || moment.t > t || moment.side === null) continue;
    score[moment.side] += 1;
  }
  return score;
}

/**
 * What live looks like with auto-pan on: a 16:9 shot that follows the ball,
 * a scoreboard and clock top-left and the Replay bug bottom-right.
 *
 * Built from a few busy minutes of a recorded match and the ball path the
 * analysis found, because the real camera is usually off when a prospect is
 * looking. The page says so under the picture.
 */
export function LiveBroadcast({ match, report, copy }: {
  match: DemoMatch;
  report: DemoReport;
  copy: DemoCopy["sections"]["live"];
}) {
  const broadcast = report.broadcast!;
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useActivePlayback();
  const { ref, inView } = useInView<HTMLDivElement>("0px", 0.5);
  const [started, setStarted] = useState(false);
  const hls = useHlsSource(videoRef, withBase(match.src), started);
  const path = useMemo(() => cleanPath(broadcast.path), [broadcast.path]);
  const [clock, setClock] = useState(broadcast.start);
  const view = useRef({ x: 0.5, y: 0.5 });

  // Start once it has been seen; after that, play only while on screen and
  // while nothing else is playing.
  useEffect(() => {
    if (inView) setStarted(true);
  }, [inView]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !started) return;
    if (inView && (active === null || active === PLAYER_ID) && (hls === "ready" || hls === "loading")) {
      claimPlayback(PLAYER_ID);
      void video.play().catch(() => undefined);
    } else if (!video.paused) {
      video.pause();
      if (!inView) releasePlayback(PLAYER_ID);
    }
  }, [inView, active, hls, started]);

  useEffect(() => () => releasePlayback(PLAYER_ID), []);

  // Keep inside the busy window, looping back to its start.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => {
      if (video.currentTime < broadcast.start - 1 || video.currentTime > broadcast.end) video.currentTime = broadcast.start;
    };
    const onTime = () => {
      if (video.currentTime >= broadcast.end || video.currentTime < broadcast.start - 5) video.currentTime = broadcast.start;
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("timeupdate", onTime);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("timeupdate", onTime);
    };
  }, [broadcast.start, broadcast.end]);

  // The pan: every animation frame, ease the frame toward where the ball
  // will be a moment from now.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    let last = performance.now();
    let lastClock = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const srcAspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 3840 / 1080;
      const w = FRAME_W;
      const h = (w * srcAspect) / OUT_ASPECT;
      const target = ballAtTime(path, video.currentTime + 0.6);
      if (target) {
        const k = 1 - Math.exp(-dt * 2.2);
        view.current.x += (target.x - view.current.x) * k;
        view.current.y += (Math.min(0.75, Math.max(0.3, target.y)) - view.current.y) * k * 0.6;
      }
      applyFrameToVideo(video, {
        x: clampOrigin(view.current.x - w / 2, w),
        y: clampOrigin(view.current.y - h / 2, h),
        w,
        h,
      });
      if (now - lastClock > 250) {
        lastClock = now;
        setClock(video.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [path]);

  const [a, b] = scoreAt(report.moments, clock);
  const colours = report.team?.colours ?? ["#EEF1F6", "#2FD8C4"];

  return (
    <div ref={ref} className="dm-cast">
      <div className="dm-cast-stage" dir="ltr">
        <video ref={videoRef} className="dm-cast-video" poster={withBase(match.poster)} muted playsInline preload="none" />
        <div className="dm-cast-sb" aria-label={`${a} – ${b}`}>
          <span className="dm-sb-team"><i style={{ background: colours[0] }} />{copy.teamA}</span>
          <span className="dm-sb-score">{a}</span>
          <span className="dm-sb-score">{b}</span>
          <span className="dm-sb-team">{copy.teamB}<i style={{ background: colours[1] }} /></span>
          <span className="dm-sb-clock">{formatClock(clock)}</span>
        </div>
        <span className="dm-cast-live"><span className="dm-live-dot" aria-hidden="true" />{copy.liveBadge}</span>
        <span className="dm-cast-brand">
          <ReplayMark className="dm-cast-mark" />
          <b>REPLAY</b>
          <em>LIVE</em>
        </span>
        {hls === "loading" && <span className="dm-cast-status" role="status">…</span>}
      </div>
    </div>
  );
}
