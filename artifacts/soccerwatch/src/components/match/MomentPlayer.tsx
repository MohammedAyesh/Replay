import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, Expand, Loader2, Pause, Play, RotateCcw, RotateCw, Shrink, X } from "lucide-react";
import {
  ballAt,
  loadTile,
  momentStart,
  onTiles,
  pieceAt,
  pinTiles,
  prefetchMoment,
  readyTile,
  tileFocus,
  tileKey,
  tileOf,
  TILE_SECONDS,
  type BallPoint,
  type MomentFootage,
  type TileFile,
} from "@/lib/moment-footage";
import { clock } from "@/lib/match-report";
import { useMomentPlayerCopy } from "@/i18n/moment-player-strings";
import { cn } from "@/lib/utils";

/**
 * A moment from the Moments tab, playing in a popup over the match page
 * (2026-11-01, Mohammed: "I want the moment to show as a popup +- 5 sec
 * buttons ... make loading as quick as possible").
 *
 * It plays the match itself from 5 s before the moment and keeps going; -5 /
 * +5 step through it, and Previous / Next go to the tab's other moments
 * without closing. The footage is ten-second tiles downloaded from Bunny's
 * edge into memory (lib/moment-footage.ts): the tile on screen, the one before
 * and the next two are fetched while it plays, so a step or the turn into the
 * next tile is instant. The camera follows the ball across the panorama; a
 * drag looks around, and "Whole pitch" shows all of it.
 */

export type PlayableMoment = {
  id: string;
  /** booking seconds */
  at: number;
  title: ReactNode;
  sub: ReactNode | null;
  icon: ReactNode;
  /** the moment's colour, for its dot and its mark on the bar */
  accent: string;
  /** "34′", or Before / After */
  minute: ReactNode;
  /** the watch page at this moment */
  href: string | null;
};

/** how quickly the frame catches up with the ball, per animation frame */
const EASE = 0.12;
/** a drag holds the view where it was left for this long, ms */
const LOOK_MS = 3500;
/** the bar under the video spans this long either side of the moment, s */
const BAR_SPAN = 20;
const STEP = 5;

export function MomentPlayer({ code, footage, failed = false, moments, index, onIndex, onClose }: {
  code: string;
  /** null while the tab's footage is still being described */
  footage: MomentFootage | null;
  /** describing the footage failed */
  failed?: boolean;
  moments: readonly PlayableMoment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const copy = useMomentPlayerCopy();
  const moment = moments[index] ?? moments[0]!;
  const piece = footage ? pieceAt(footage.pieces, moment.at) : null;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // While the popup is open nothing behind it scrolls, takes focus or answers a key.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.hasAttribute("inert") ?? false;
    document.body.style.overflow = "hidden";
    root?.setAttribute("inert", "");
    dialogRef.current?.querySelector<HTMLElement>("[data-testid=button-moment-close]")?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (root && !wasInert) root.removeAttribute("inert");
      prevFocus?.focus?.();
    };
  }, []);

  // the moments either side are ready before a thumb reaches Previous / Next
  useEffect(() => {
    for (const m of [moments[index + 1], moments[index - 1]]) if (m) prefetchMoment(code, footage ?? undefined, m.at, true, true);
  }, [code, footage, moments, index]);

  const go = useCallback((delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < moments.length) onIndex(next);
  }, [index, moments.length, onIndex]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/65 backdrop-blur-[2px] [animation:moment-fade_.18s_ease-out] sm:items-center sm:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="moment-player-backdrop"
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={copy.title} dir={copy.locale === "ar" ? "rtl" : "ltr"}
        className="relative flex max-h-[92dvh] w-full max-w-[560px] flex-col gap-3 overflow-hidden rounded-t-[28px] border border-line bg-void px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-2.5 text-text shadow-[0_-12px_48px_rgba(0,0,0,.55)] [animation:moment-up_.24s_cubic-bezier(.2,.8,.2,1)] sm:rounded-[28px]"
        data-testid="moment-player">
        <span aria-hidden="true" className="mx-auto h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" />
        <div className="flex min-h-11 items-center gap-2.5">
          <button type="button" aria-label={copy.close} onClick={onClose} data-testid="button-moment-close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-text">
            <X className="h-5 w-5" />
          </button>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface" style={{ color: moment.accent }} aria-hidden="true">{moment.icon}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <b className="truncate text-[15px] leading-tight">{moment.title}</b>
            <span className="truncate text-xs text-muted-text">{moment.minute}{moment.sub ? <> · {moment.sub}</> : null}</span>
          </span>
          {moments.length > 1 && (
            <span className="flex shrink-0 items-center" dir="ltr">
              <button type="button" aria-label={copy.previous} disabled={index === 0} onClick={() => go(-1)} data-testid="button-moment-prev"
                className="flex h-11 w-9 items-center justify-center text-text disabled:opacity-30"><ChevronLeft className="h-5 w-5" /></button>
              <span className="font-mono text-[11px] tabular-nums text-muted-text">{copy.of(index + 1, moments.length)}</span>
              <button type="button" aria-label={copy.next} disabled={index >= moments.length - 1} onClick={() => go(1)} data-testid="button-moment-next"
                className="flex h-11 w-9 items-center justify-center text-text disabled:opacity-30"><ChevronRight className="h-5 w-5" /></button>
            </span>
          )}
        </div>
        {footage && piece ? (
          <Stage key={piece.recordingId} code={code} footage={footage} moments={moments} index={index} onPrev={() => go(-1)} onNext={() => go(1)} onClose={onClose} />
        ) : !footage && !failed ? (
          <div className="field-pattern relative flex aspect-video items-center justify-center gap-2 overflow-hidden rounded-2xl bg-surface text-xs font-semibold text-muted-text">
            <Loader2 className="h-5 w-5 animate-spin" />{copy.loading}
          </div>
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-2xl bg-surface px-6 text-center text-sm text-muted-text">{copy.failed}</div>
        )}
        {moment.href && (
          <Link href={moment.href} className="self-center py-1 text-xs font-semibold text-turf" data-testid="link-moment-full-match">{copy.fullMatch}</Link>
        )}
      </div>
      <style>{`@keyframes moment-up{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
@keyframes moment-fade{from{opacity:0}to{opacity:1}}`}</style>
    </div>,
    document.body,
  );
}

/** The video, the bar and the buttons, for one recording (remounted when a moment is on another). */
function Stage({ code, footage, moments, index, onPrev, onNext, onClose }: {
  code: string;
  footage: MomentFootage;
  moments: readonly PlayableMoment[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const copy = useMomentPlayerCopy();
  const moment = moments[index]!;
  const piece = pieceAt(footage.pieces, moment.at)!;
  const rid = piece.recordingId;
  const vMin = piece.from + piece.shift;
  const vMax = piece.to + piece.shift;
  const momentV = moment.at + piece.shift;
  const startV = momentStart(piece, moment.at, footage.lead);
  const srcAspect = piece.srcW > 0 && piece.srcH > 0 ? piece.srcW / piece.srcH : 3840 / 1080;

  const boxRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const files = useRef(new Map<string, TileFile>());
  const activeRef = useRef<string | null>(null);
  const pendingRef = useRef<number | null>(null);
  const posRef = useRef(startV);
  const playingRef = useRef(true);
  const lookRef = useRef<{ x: number; until: number } | null>(null);
  const focusRef = useRef<BallPoint[]>([]);

  const [posTick, setPosTick] = useState(() => Math.floor(startV * 2));
  const [playing, setPlaying] = useState(true);
  const [waiting, setWaiting] = useState(true);
  const [failed, setFailed] = useState(false);
  const [wide, setWide] = useState(false);
  const [, setArrivals] = useState(0);
  const wideRef = useRef(wide);
  wideRef.current = wide;

  // a re-render when a tile this stage may want has arrived
  useEffect(() => onTiles(() => setArrivals((n) => n + 1)), []);
  // closed: the tiles may be released again (they stay for a reopen until newer ones push them out)
  useEffect(() => () => pinTiles([]), []);

  const pos = posTick / 2;
  const kNow = tileOf(pos);
  const kPending = pendingRef.current !== null ? tileOf(pendingRef.current) : null;
  // the tiles on the page: the one playing, either side, and one a step is waiting for
  const mounted = [...new Set([kNow - 1, kNow, kNow + 1, ...(kPending !== null ? [kPending] : [])])]
    .filter((k) => k >= 0)
    .map((k) => tileKey(rid, k))
    .filter((id) => {
      const file = files.current.get(id) ?? readyTile(id);
      if (file) files.current.set(id, file);
      return Boolean(file);
    });

  // the ball through the tiles around the one playing (a few dozen points)
  {
    const points: BallPoint[] = [];
    for (const k of [kNow - 1, kNow, kNow + 1, kNow + 2]) points.push(...(tileFocus(tileKey(rid, k)) ?? []));
    focusRef.current = points.sort((a, b) => a[0] - b[0]);
  }

  const show = useCallback((id: string) => {
    activeRef.current = id;
    for (const [key, el] of videos.current) {
      el.style.opacity = key === id ? "1" : "0";
      if (key !== id && !el.paused) el.pause();
    }
  }, []);

  /** Put the picture at video second v, if its tile is on the page. */
  const apply = useCallback((v: number): boolean => {
    const id = tileKey(rid, tileOf(v));
    const file = files.current.get(id);
    const el = videos.current.get(id);
    if (!file || !el || el.readyState < 1) return false;
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : TILE_SECONDS;
    el.currentTime = Math.max(0, Math.min(dur - 0.05, v - file.offset));
    show(id);
    if (playingRef.current) void el.play().catch(() => { /* still on screen, paused */ });
    pendingRef.current = null;
    setWaiting(false);
    return true;
  }, [rid, show]);

  const goTo = useCallback((target: number) => {
    const v = Math.max(vMin, Math.min(vMax - 0.05, target));
    posRef.current = v;
    setPosTick(Math.floor(v * 2));
    if (apply(v)) return;
    pendingRef.current = v;
    setWaiting(true);
    setFailed(false);
    const k = tileOf(v);
    loadTile(code, rid, k, true)
      .then((file) => {
        files.current.set(tileKey(rid, k), file);
        setArrivals((n) => n + 1);
        // already on the page (its video only needed the file): place it now
        if (pendingRef.current !== null && tileOf(pendingRef.current) === k) apply(pendingRef.current);
      })
      .catch(() => { if (pendingRef.current !== null && tileOf(pendingRef.current) === k) setFailed(true); });
  }, [apply, code, rid, vMin, vMax]);

  const setPlay = useCallback((on: boolean) => {
    playingRef.current = on;
    setPlaying(on);
    const el = activeRef.current ? videos.current.get(activeRef.current) : null;
    if (!el) return;
    if (on) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (!playingRef.current && posRef.current >= vMax - 0.2) {
      playingRef.current = true;
      setPlaying(true);
      goTo(startV);
      return;
    }
    setPlay(!playingRef.current);
  }, [goTo, setPlay, startV, vMax]);

  const step = useCallback((delta: number) => {
    lookRef.current = null;
    goTo(posRef.current + delta);
  }, [goTo]);

  // a new moment opens playing, 5 s before it
  useEffect(() => {
    playingRef.current = true;
    setPlaying(true);
    lookRef.current = null;
    goTo(startV);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moment.id]);

  // keep the tiles around the picture coming: this one, 5 s back, and the next two
  useEffect(() => {
    const want = [...new Set([tileOf(pos - STEP), kNow, tileOf(pos + STEP), kNow + 1, kNow + 2])]
      .filter((k) => k >= 0 && k * TILE_SECONDS < vMax && (k + 1) * TILE_SECONDS > vMin);
    pinTiles([...want.map((k) => tileKey(rid, k)), ...files.current.keys()]);
    for (const k of want) {
      const id = tileKey(rid, k);
      if (files.current.has(id)) continue;
      loadTile(code, rid, k, k === kNow).then((file) => { files.current.set(id, file); }).catch(() => { /* asked again when needed */ });
    }
    // drop what is out of reach, so the map does not grow through a long watch
    for (const id of [...files.current.keys()]) {
      const k = Number(id.split(":")[1]);
      if (Math.abs(k - kNow) > 3) files.current.delete(id);
    }
  }, [code, rid, pos, kNow, vMin, vMax]);

  // keys: arrows step, space plays, up / down change moment, Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-STEP); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(STEP); }
      else if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); onNext(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNext, onPrev, step, togglePlay]);

  // a tile's video is ready: place the picture if it was waiting for it, else hold its first frame
  const onMeta = useCallback((id: string) => {
    const el = videos.current.get(id);
    if (!el) return;
    if (pendingRef.current !== null && tileKey(rid, tileOf(pendingRef.current)) === id) {
      apply(pendingRef.current);
      return;
    }
    if (activeRef.current === id) return;
    // iPhone Safari draws nothing until a video has played: start it and stop it at once
    el.currentTime = 0;
    const p = el.play();
    if (p) p.then(() => { if (activeRef.current !== id) { el.pause(); el.currentTime = 0; } }).catch(() => {});
  }, [apply, rid]);

  // the picture's clock, the turn into the next tile, the bar and the camera: one loop, no React
  useEffect(() => {
    let raf = 0;
    let cam: { x: number; y: number } | null = null;
    let lastTick = -1;
    const loop = () => {
      const id = activeRef.current;
      const el = id ? videos.current.get(id) : null;
      const file = id ? files.current.get(id) : null;
      if (el && file && pendingRef.current === null) {
        const v = file.offset + el.currentTime;
        posRef.current = v;
        if (playingRef.current) {
          const dur = el.duration;
          if (v >= vMax - 0.06) {
            playingRef.current = false;
            setPlaying(false);
            el.pause();
          } else if (Number.isFinite(dur) && dur > 0 && (el.ended || el.currentTime >= dur - 0.04)) {
            goTo(file.offset + dur + 0.001);
          }
        }
      }
      const v = pendingRef.current ?? posRef.current;
      const t2 = Math.floor(v * 2);
      if (t2 !== lastTick) { lastTick = t2; setPosTick(t2); }
      // the bar and the clock
      const lo = Math.max(vMin, momentV - BAR_SPAN), hi = Math.min(vMax, momentV + BAR_SPAN);
      if (thumbRef.current) thumbRef.current.style.left = `${Math.max(0, Math.min(100, ((v - lo) / Math.max(1, hi - lo)) * 100))}%`;
      if (clockRef.current) clockRef.current.textContent = clock(v - piece.shift);
      // the camera
      const box = boxRef.current, stage = stageRef.current;
      if (box && stage) {
        const W = box.clientWidth, H = box.clientHeight;
        if (W > 0 && H > 0) {
          let vw: number, vh: number, tx: number, ty: number;
          if (wideRef.current) {
            vw = W; vh = W / srcAspect; tx = 0; ty = (H - vh) / 2;
          } else {
            vh = H; vw = H * srcAspect; ty = 0;
            const look = lookRef.current;
            if (look && performance.now() < look.until) {
              tx = look.x;
            } else {
              lookRef.current = null;
              const ball = ballAt(focusRef.current, v);
              tx = W / 2 - (ball ? ball[0] : 0.5) * vw;
            }
            tx = Math.min(0, Math.max(W - vw, tx));
          }
          cam = cam && !wideRef.current && !lookRef.current ? { x: cam.x + (tx - cam.x) * EASE, y: ty } : { x: tx, y: ty };
          stage.style.width = `${vw}px`;
          stage.style.height = `${vh}px`;
          stage.style.transform = `translate3d(${cam.x}px, ${cam.y}px, 0)`;
          if (frameRef.current) {
            frameRef.current.style.left = `${(-cam.x / vw) * 100}%`;
            frameRef.current.style.width = `${Math.min(1, W / vw) * 100}%`;
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [goTo, momentV, piece.shift, srcAspect, vMax, vMin]);

  // drag to look around the panorama; a tap plays / pauses
  const drag = useRef<{ x: number; from: number; moved: boolean; id: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    const stage = stageRef.current;
    if (!stage) return;
    const m = /translate3d\((-?[\d.]+)px/.exec(stage.style.transform);
    drag.current = { x: e.clientX, from: m ? Number(m[1]) : 0, moved: false, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still drags */ }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 6) d.moved = true;
    if (d.moved && !wideRef.current) lookRef.current = { x: d.from + dx, until: performance.now() + LOOK_MS };
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) togglePlay();
  };

  const lo = Math.max(vMin, momentV - BAR_SPAN), hi = Math.min(vMax, momentV + BAR_SPAN);
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / Math.max(1, hi - lo)) * 100))}%`;
  // the tab's other moments on this stretch of this recording, as ticks on the bar
  const nearby = moments
    .map((m, k) => ({ m, k, v: m.at + piece.shift }))
    .filter(({ m, v }) => pieceAt(footage.pieces, m.at)?.recordingId === rid && v >= lo && v <= hi);
  const shownNothing = mounted.length === 0;

  return (
    <div className="flex flex-col gap-3" dir="ltr">
      <div
        ref={boxRef}
        className={cn("relative aspect-video w-full touch-none select-none overflow-hidden rounded-2xl bg-surface", !wide && "cursor-grab active:cursor-grabbing")}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { drag.current = null; }}
        data-testid="moment-stage"
      >
        <div ref={stageRef} className="absolute left-0 top-0 will-change-transform">
          {mounted.map((id) => {
            const file = files.current.get(id)!;
            return (
              <video
                key={id}
                ref={(el) => { if (el) videos.current.set(id, el); else videos.current.delete(id); }}
                src={file.url}
                muted
                playsInline
                preload="auto"
                disablePictureInPicture
                disableRemotePlayback
                onLoadedMetadata={() => onMeta(id)}
                onEnded={() => { if (activeRef.current === id && playingRef.current) goTo(file.offset + TILE_SECONDS + 0.001); }}
                className="pointer-events-none absolute inset-0 h-full w-full"
                style={{ opacity: 0 }}
                data-tile={id}
                aria-hidden="true"
              />
            );
          })}
        </div>
        {shownNothing && !failed && (
          <div className="field-pattern absolute inset-0"><div className="absolute inset-0 animate-pulse bg-white/[.03]" /></div>
        )}
        {waiting && !failed && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/20 text-xs font-semibold text-white">
            <Loader2 className="h-5 w-5 animate-spin" />{shownNothing && <span>{copy.loading}</span>}
          </div>
        )}
        {failed && (
          <div className="absolute inset-x-6 top-1/2 flex -translate-y-1/2 flex-col items-center gap-2 rounded-xl bg-black/70 p-3 text-center text-xs text-white">
            {copy.failed}
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={() => goTo(pendingRef.current ?? posRef.current)}
              className="min-h-9 rounded-full border border-white/40 px-4 font-semibold">{copy.retry}</button>
          </div>
        )}
        {!wide && (
          <div className="pointer-events-none absolute right-2.5 top-2.5 h-7 w-24 overflow-hidden rounded-md border border-white/30 bg-black/55">
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
            <div ref={frameRef} className="absolute inset-y-0 rounded-[2px] border-2 border-floodlight" />
          </div>
        )}
        {!playing && !waiting && !failed && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white"><Play className="ms-0.5 h-6 w-6 fill-current" /></span>
          </span>
        )}
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={() => setWide((w) => !w)}
          aria-label={wide ? copy.follow : copy.wide} title={wide ? copy.follow : copy.wide} data-testid="button-moment-wide"
          className="absolute bottom-2.5 right-2.5 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white">
          {wide ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
        </button>
      </div>

      {/* 20 s either side of the moment: where the picture is, the moment, and the tab's other moments nearby */}
      <div className="flex items-center gap-3">
        <span ref={clockRef} className="w-11 shrink-0 font-mono text-xs tabular-nums text-muted-text" data-testid="moment-clock">{clock(pos - piece.shift)}</span>
        <button
          type="button"
          aria-label={copy.moment}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            goTo(lo + ((e.clientX - box.left) / Math.max(1, box.width)) * (hi - lo));
          }}
          className="relative h-8 flex-1"
          data-testid="moment-bar"
        >
          <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line" />
          {nearby.filter(({ k }) => k !== index).map(({ m, v }) => (
            <span key={m.id} className="absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70" style={{ left: pct(v), background: m.accent }} />
          ))}
          <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-void" style={{ left: pct(momentV), background: moment.accent }} />
          <span ref={thumbRef} className="absolute top-0 h-full w-0.5 -translate-x-1/2 rounded-full bg-floodlight" style={{ left: pct(pos) }} />
        </button>
      </div>

      <div className="flex items-center justify-center gap-5">
        <button type="button" aria-label={copy.back5} onClick={() => step(-STEP)} data-testid="button-moment-back5"
          className="relative flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface/60 text-text active:scale-95">
          <RotateCcw className="h-6 w-6" strokeWidth={1.8} />
          <span className="absolute text-[10px] font-bold">5</span>
        </button>
        <button type="button" aria-label={playing ? copy.pause : copy.play} onClick={togglePlay} data-testid="button-moment-play"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-floodlight text-void active:scale-95">
          {playing ? <Pause className="h-7 w-7 fill-current" /> : <Play className="ms-0.5 h-7 w-7 fill-current" />}
        </button>
        <button type="button" aria-label={copy.fwd5} onClick={() => step(STEP)} data-testid="button-moment-fwd5"
          className="relative flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface/60 text-text active:scale-95">
          <RotateCw className="h-6 w-6" strokeWidth={1.8} />
          <span className="absolute text-[10px] font-bold">5</span>
        </button>
      </div>
    </div>
  );
}
