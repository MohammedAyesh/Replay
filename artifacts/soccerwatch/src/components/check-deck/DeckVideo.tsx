import { memo, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { DeckCard, FocusPoint } from "@/lib/check-deck";

/**
 * One card's moment, playing in a loop and following the player (or the
 * ball) across the panorama.
 *
 * Fast by construction:
 *   - nothing is rendered: each card is the match recording itself, seeked to
 *     its few seconds, so a card costs only the 2-3 HLS fragments it covers;
 *   - the deck mounts the next two cards while you look at this one, and each
 *     loads only its first seconds then stops, so the next card is already
 *     decoded when you swipe; the rest of a card loads while its first
 *     seconds play;
 *   - one card loads at a time, the active one first: the card behind it
 *     starts only when the whole moment in front is in (or after a grace),
 *     so a preload never takes bandwidth from the card you are watching;
 *   - the follow-crop and the ring are moved by one requestAnimationFrame loop
 *     writing transforms straight to the elements, never through React.
 */

/**
 * how much of the panorama's height a card shows. A player card shows him
 * big enough to recognise with a few metres of pitch round him; a goal card
 * shows the whole depth, so the goal mouth and who is near it are in view.
 */
const VIEW_HEIGHT = { you: 0.75, goal: 1 } as const;
/**
 * a card waiting behind loads this many seconds past its start: its first
 * frame plus enough to play straight away when it comes on top (one 4 s
 * fragment is not always enough: a card that starts 3 s into one has 1 s)
 */
const WAITING_AHEAD = 3;
/** the smallest rendition worth showing: below this a far-side player is a smudge, px */
const MIN_LEVEL_HEIGHT = 600;
/** how quickly the frame catches up with the player, per animation frame */
const EASE = 0.18;

function focusAt(focus: FocusPoint[], t: number): FocusPoint | null {
  if (!focus.length) return null;
  if (t <= focus[0][0]) return focus[0];
  const last = focus[focus.length - 1];
  if (t >= last[0]) return last;
  let lo = 0, hi = focus.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (focus[mid][0] <= t) lo = mid; else hi = mid; }
  const a = focus[lo], b = focus[hi], f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return [t, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f];
}

/** loading -> ready (a frame to show) -> buffered (the whole moment is in) ; or failed */
export type DeckVideoState = "loading" | "ready" | "buffered" | "failed";

export const DeckVideo = memo(function DeckVideo({
  card, url, srcAspect, active, load, onState, ringColor, tag,
}: {
  card: DeckCard;
  url: string;
  srcAspect: number;
  /** the card on top: it plays; the ones behind sit on their first frame */
  active: boolean;
  /** may this card fetch its video yet (the active card first, then the next ones) */
  load: boolean;
  onState?: (id: string, state: DeckVideoState) => void;
  ringColor: string;
  tag: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const tagRef = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<DeckVideoState>("loading");
  const hlsRef = useRef<Hls | null>(null);
  const activeRef = useRef(active);
  const loadRef = useRef(load);
  loadRef.current = load;
  const report = useRef(onState);
  report.current = onState;
  const set = (s: DeckVideoState) => { setState(s); report.current?.(card.id, s); };

  // Created the first time it may load; never reloaded.
  const [started, setStarted] = useState(load);
  useEffect(() => { if (load) setStarted(true); }, [load]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !started) return;
    let hls: Hls | null = null;
    let done = false;
    const start = Math.max(0, card.start);
    let whole = false;
    const ready = () => {
      if (!done && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { done = true; set("ready"); }
      if (done && !whole) {
        // the whole moment is in: the next card may start loading
        for (let k = 0; k < video.buffered.length; k++) {
          if (video.buffered.start(k) <= start + 0.3 && video.buffered.end(k) >= card.end - 0.3) { whole = true; set("buffered"); break; }
        }
      }
    };
    const failTimer = window.setTimeout(() => { if (!done) set("failed"); }, 20_000);
    video.addEventListener("loadeddata", ready);
    video.addEventListener("seeked", ready);
    video.addEventListener("canplay", ready);
    video.addEventListener("progress", ready);
    const length = Math.max(4, card.end - card.start);
    if (url.includes(".m3u8") || url.includes("/hls-proxy/")) {
      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          startPosition: start,
          // A card waiting behind fetches only its first seconds: an instant
          // first frame and enough to start playing. The rest comes while
          // that plays, once it is on top (see the effect below).
          maxBufferLength: activeRef.current ? length + 2 : loadRef.current ? WAITING_AHEAD : 0,
          maxMaxBufferLength: length + 4,
          backBufferLength: 0,
          startFragPrefetch: true,
          // a deck card is never worth a minute of retries
          fragLoadingMaxRetry: 2,
          manifestLoadingMaxRetry: 2,
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || !hls) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else if (!done) set("failed");
        });
        hls.on(Hls.Events.FRAG_BUFFERED, ready);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!hls) return;
          // The lightest rendition is plenty for a phone-sized crop: recordings
          // carry a 2560x720 rung at ~4.3 Mbit/s beside the 3840x1080 one at
          // ~7.5 (recording 401, 2026-10-25), so a card costs ~4 MB, not ~7.
          const levels = hls.levels ?? [];
          if (levels.length > 1) {
            let pick = 0;
            levels.forEach((level, index) => {
              const h = level.height || 0, best = levels[pick].height || 0;
              if ((h >= MIN_LEVEL_HEIGHT && (best < MIN_LEVEL_HEIGHT || h < best)) || (best < MIN_LEVEL_HEIGHT && h > best)) pick = index;
            });
            hls.startLevel = pick;
            hls.loadLevel = pick;
          }
          hls.startLoad(start);
          if (Math.abs(video.currentTime - start) > 0.25) video.currentTime = start;
        });
        hls.attachMedia(video);
        hls.loadSource(url);
        hlsRef.current = hls;
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // iPhone Safari: its own HLS; seek once the metadata is in
        video.preload = "auto";
        video.src = url;
        video.addEventListener("loadedmetadata", () => { video.currentTime = start; }, { once: true });
      } else {
        set("failed");
      }
    } else {
      video.preload = "auto";
      video.src = url;
      video.addEventListener("loadedmetadata", () => { video.currentTime = start; }, { once: true });
    }
    return () => {
      window.clearTimeout(failTimer);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("seeked", ready);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("progress", ready);
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
    // the card and its url never change for one mounted card
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // On top, a card fetches the rest of its moment; behind, just its first
  // seconds; and while the deck says wait (the card in front still needs the
  // bandwidth), nothing new. Only the target moves: hls.js picks it up on its
  // next tick, and a fragment already on its way is never thrown away
  // (startLoad/stopLoad would abort it).
  useEffect(() => {
    activeRef.current = active;
    const hls = hlsRef.current;
    if (!hls) return;
    hls.config.maxBufferLength = active ? Math.max(4, card.end - card.start) + 2 : load ? WAITING_AHEAD : 0;
  }, [active, load, card.start, card.end, started]);

  // Play the top card, rest the others on their first frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || (state !== "ready" && state !== "buffered")) return;
    if (active) {
      if (video.currentTime < card.start - 0.3 || video.currentTime > card.end) video.currentTime = card.start;
      void video.play().catch(() => { /* autoplay refused: the still stays */ });
    } else {
      video.pause();
    }
  }, [active, state, card.start, card.end]);

  // Follow the player, loop the moment, move the ring: one rAF loop, no React.
  useEffect(() => {
    const box = boxRef.current, video = videoRef.current;
    if (!box || !video) return;
    let raf = 0;
    let pos: { x: number; y: number } | null = null;
    const tick = () => {
      const W = box.clientWidth, H = box.clientHeight;
      if (W > 0 && H > 0) {
        if (active && video.currentTime >= card.end - 0.05) video.currentTime = card.start;
        const t = video.currentTime > 0 ? video.currentTime : card.start;
        const f = focusAt(card.focus, t);
        const vh = H / VIEW_HEIGHT[card.kind], vw = vh * srcAspect;
        const cx = f ? f[1] : 0.5, cy = f ? f[2] : 0.5;
        const tx = Math.min(0, Math.max(W - vw, W / 2 - cx * vw));
        const ty = Math.min(0, Math.max(H - vh, H / 2 - cy * vh));
        pos = pos ? { x: pos.x + (tx - pos.x) * EASE, y: pos.y + (ty - pos.y) * EASE } : { x: tx, y: ty };
        video.style.width = `${vw}px`;
        video.style.height = `${vh}px`;
        video.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        // the minimap's frame and the loop's progress
        if (frameRef.current) {
          const fx = -pos.x / vw, fw = W / vw, fy = -pos.y / vh, fh = H / vh;
          frameRef.current.style.left = `${fx * 100}%`;
          frameRef.current.style.width = `${fw * 100}%`;
          frameRef.current.style.top = `${fy * 100}%`;
          frameRef.current.style.height = `${fh * 100}%`;
        }
        if (barRef.current) {
          const p = (t - card.start) / Math.max(0.1, card.end - card.start);
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
  }, [active, card, srcAspect]);

  const shown = state === "ready" || state === "buffered";
  return (
    <div ref={boxRef} className="absolute inset-0 overflow-hidden bg-surface" aria-hidden="true">
      <video
        ref={videoRef}
        muted
        playsInline
        disablePictureInPicture
        preload="auto"
        className="absolute left-0 top-0 max-w-none origin-top-left will-change-transform"
        style={{ opacity: shown ? 1 : 0, transition: "opacity .2s" }}
      />
      {!shown && (
        <div className="field-pattern absolute inset-0">
          <div className="absolute inset-0 animate-pulse bg-white/[.03]" />
        </div>
      )}
      <div ref={ringRef} className="pointer-events-none absolute left-0 top-0 rounded-full border-[2.5px]" style={{ borderColor: ringColor, opacity: shown ? 1 : 0 }}>
        <div className="absolute inset-0 animate-ping rounded-full border-2" style={{ borderColor: ringColor, animationDuration: "1.4s" }} />
      </div>
      {/* the field view: where this crop sits on the whole panorama */}
      <div className="pointer-events-none absolute right-3 top-3 h-9 w-32 overflow-hidden rounded-md border border-white/30 bg-black/55" dir="ltr">
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
        <div ref={frameRef} className="absolute rounded-[2px] border-2 border-floodlight" />
        <span className="absolute inset-x-0 bottom-px text-center text-[8px] font-medium uppercase tracking-wide text-white/50">field view</span>
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
