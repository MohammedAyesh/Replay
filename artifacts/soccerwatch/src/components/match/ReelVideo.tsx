import { memo, useEffect, useRef, useState } from "react";
import { focusAt } from "@/components/check-deck/DeckVideo";
import type { FocusPoint } from "@/lib/check-deck";

/** what a reel card needs to play: its id, its stretch (video seconds) and who or what to follow */
export type PlayableCard = { id: string; start: number; end: number; focus: FocusPoint[] };

/**
 * One reel card (a goal chance, or one of his own moments) playing from its own small MP4, already downloaded into
 * the phone's memory (lib/goal-reel.ts useReelClips). It loops the card's few
 * seconds and follows the ball across the panorama.
 *
 * iPhone Safari loads nothing for a video until it is asked to play, so the
 * card on top plays as soon as it has its file, and the card behind it is
 * started and paused straight away to have its first frame ready. Both are
 * muted and inline, which Safari allows without a tap.
 */

/** how quickly the frame catches up with the ball, per animation frame */
const EASE = 0.18;

export type ReelVideoState = "loading" | "ready" | "failed";

export const ReelVideo = memo(function ReelVideo({
  card, src, offset, srcAspect, active, ringColor, tag, fieldViewLabel, onState,
}: {
  card: PlayableCard;
  /** the card's MP4 (a blob URL), or null while it downloads */
  src: string | null;
  /** where the file starts on the video's clock, seconds */
  offset: number;
  srcAspect: number;
  active: boolean;
  ringColor: string;
  tag: string;
  fieldViewLabel: string;
  onState?: (id: string, state: ReelVideoState) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const tagRef = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const report = useRef(onState);
  report.current = onState;
  // the card's stretch on the file's own clock
  const from = Math.max(0, card.start - offset);
  const to = Math.max(from + 0.5, card.end - offset);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let gone = false;
    const onFrame = () => {
      if (gone) return;
      setShown(true);
      report.current?.(card.id, "ready");
    };
    const onError = () => { if (!gone) report.current?.(card.id, "failed"); };
    const onMeta = () => { if (Math.abs(video.currentTime - from) > 0.2) video.currentTime = from; };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("loadeddata", onFrame);
    video.addEventListener("playing", onFrame);
    video.addEventListener("error", onError);
    video.src = src;
    // Safari only loads a video it is asked to play: the top card plays, the
    // one behind plays for a moment and pauses on its first frame.
    const p = video.play();
    if (p) {
      p.then(() => { if (!gone && !activeRef.current) video.pause(); })
        .catch(() => { /* autoplay refused: the tap on Goal/No goal will start the next one */ });
    }
    return () => {
      gone = true;
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("loadeddata", onFrame);
      video.removeEventListener("playing", onFrame);
      video.removeEventListener("error", onError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    // a mounted card's file never changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // the card on top plays from its start; the others rest
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (active) {
      if (video.currentTime < from - 0.3 || video.currentTime > to) video.currentTime = from;
      void video.play().catch(() => { /* refused: the still stays */ });
    } else {
      video.pause();
    }
  }, [active, src, from, to]);

  // follow the ball, loop the stretch, move the ring: one rAF loop, no React
  useEffect(() => {
    const box = boxRef.current, video = videoRef.current;
    if (!box || !video) return;
    let raf = 0;
    let pos: { x: number; y: number } | null = null;
    const tick = () => {
      const W = box.clientWidth, H = box.clientHeight;
      if (W > 0 && H > 0) {
        if (active && video.currentTime >= to - 0.05) video.currentTime = from;
        const local = video.currentTime > 0 ? video.currentTime : from;
        const f = focusAt(card.focus, local + offset);
        const vh = H, vw = vh * srcAspect;
        const cx = f ? f[1] : 0.5, cy = f ? f[2] : 0.5;
        const tx = Math.min(0, Math.max(W - vw, W / 2 - cx * vw));
        const ty = Math.min(0, Math.max(H - vh, H / 2 - cy * vh));
        pos = pos ? { x: pos.x + (tx - pos.x) * EASE, y: pos.y + (ty - pos.y) * EASE } : { x: tx, y: ty };
        video.style.width = `${vw}px`;
        video.style.height = `${vh}px`;
        video.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        if (frameRef.current) {
          frameRef.current.style.left = `${(-pos.x / vw) * 100}%`;
          frameRef.current.style.width = `${(W / vw) * 100}%`;
          frameRef.current.style.top = `${(-pos.y / vh) * 100}%`;
          frameRef.current.style.height = `${(H / vh) * 100}%`;
        }
        if (barRef.current) {
          const p = (local - from) / Math.max(0.1, to - from);
          barRef.current.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`;
        }
        if (f && ringRef.current && tagRef.current) {
          const px = pos.x + f[1] * vw, py = pos.y + f[2] * vh;
          const size = Math.max(44, Math.min(120, 1.25 * Math.max(f[3] * vw, f[4] * vh)));
          ringRef.current.style.transform = `translate3d(${px - size / 2}px, ${py - size / 2}px, 0)`;
          ringRef.current.style.width = ringRef.current.style.height = `${size}px`;
          tagRef.current.style.transform = `translate3d(${px}px, ${py - size / 2 - 26}px, 0) translateX(-50%)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, card, srcAspect, offset, from, to]);

  return (
    <div ref={boxRef} className="absolute inset-0 overflow-hidden bg-surface" aria-hidden="true">
      <video
        ref={videoRef}
        muted
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        preload="auto"
        className="absolute left-0 top-0 max-w-none origin-top-left will-change-transform"
        style={{ opacity: shown ? 1 : 0, transition: "opacity .15s" }}
      />
      {!shown && (
        <div className="field-pattern absolute inset-0">
          <div className="absolute inset-0 animate-pulse bg-white/[.03]" />
        </div>
      )}
      <div ref={ringRef} className="pointer-events-none absolute left-0 top-0 rounded-full border-[2.5px]" style={{ borderColor: ringColor, opacity: shown ? 1 : 0 }}>
        <div className="absolute inset-0 animate-ping rounded-full border-2" style={{ borderColor: ringColor, animationDuration: "1.4s" }} />
      </div>
      <div className="pointer-events-none absolute right-3 top-3 h-9 w-32 overflow-hidden rounded-md border border-white/30 bg-black/55" dir="ltr">
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
        <div ref={frameRef} className="absolute rounded-[2px] border-2 border-floodlight" />
        <span className="absolute inset-x-0 bottom-px text-center text-[8px] font-medium uppercase tracking-wide text-white/50 rtl:tracking-normal">{fieldViewLabel}</span>
      </div>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 h-1 overflow-hidden rounded-full bg-white/20" dir="ltr">
        <div ref={barRef} className="h-full origin-left bg-floodlight" style={{ transform: "scaleX(0)" }} />
      </div>
      <span ref={tagRef} className="pointer-events-none absolute left-0 top-0 rounded-md px-2 py-px font-display text-[13px] font-bold text-void"
        style={{ background: ringColor, opacity: shown ? 1 : 0 }}>
        {tag}
      </span>
    </div>
  );
});
