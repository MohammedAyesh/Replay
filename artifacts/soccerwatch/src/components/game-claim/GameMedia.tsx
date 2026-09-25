import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Hls from "hls.js";
import { capPlaybackQuality } from "@/lib/hlsQuality";
import type { Chunk, Game, Point } from "@/lib/game-claim/model";
import { chunkAt, G2L, mmss } from "@/lib/game-claim/model";
import type { GameStrings } from "@/i18n/game-strings";

/**
 * The prototype's one video, reused as a picture on every screen.
 *
 * The whole panorama at a chosen height, scrolled sideways; every tracked
 * player's box drawn over it, yours in Turf; ▶ plays it as video with the boxes
 * following; −2 s / +2 s, a scrubber and zoom. On a screen that asks you to
 * find yourself, a tap on a box (or on the grass) is handed to the screen.
 *
 * Times given to it are TRACKING seconds; it adds videoStartSeconds itself.
 */

export type TapHit = { k: number; lt: number; box: { id: string } | null; pt: Point };

export type MediaView = {
  t: number;
  lo?: number;
  hi?: number;
  k: number;
  hl?: Set<string>;
  focus?: Point | null;
  label?: string;
  loop?: boolean;
  onTap?: ((hit: TapHit) => void) | null;
};

export type MediaHandle = {
  show: (view: MediaView) => void;
  /** tracking seconds at the playhead */
  now: () => number;
  pause: () => void;
  element: () => HTMLDivElement | null;
};

type Box = { id: string; x: number; y: number; w: number; h: number; guess: boolean };

export function boxesAt(chunks: Record<number, Chunk>, k: number, lt: number): Box[] {
  const d = chunks[k];
  if (!d) return [];
  const out: Box[] = [];
  for (const id in d.ov) {
    const b = d.ovb[id];
    if (lt < b[0] - 0.3 || lt > b[1] + 0.3) continue;
    const a = d.ov[id];
    let i = 0;
    while (i < a.length - 1 && a[i + 1][0] < lt) i++;
    const p = a[i];
    const q = a[Math.min(i + 1, a.length - 1)];
    const f = q[0] > p[0] ? Math.max(0, Math.min(1, (lt - p[0]) / (q[0] - p[0]))) : 0;
    const gap = q[0] - p[0];
    const inGap = f > 0 && f < 1;
    if (gap > 1.2 && inGap) continue; // detector lost them: don't invent a box that drifts off the player
    out.push({
      guess: gap > 0.6 && inGap,
      id,
      x: p[1] + (q[1] - p[1]) * f,
      y: p[2] + (q[2] - p[2]) * f,
      w: p[3] + (q[3] - p[3]) * f,
      h: p[4] + (q[4] - p[4]) * f,
    });
  }
  return out;
}

function browserSafeVideoUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/api/hls-proxy/")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".b-cdn.net") && parsed.pathname.endsWith(".m3u8")) {
      return `/api/hls-proxy/manifest?url=${encodeURIComponent(url)}`;
    }
  } catch {
    // relative sources play as they are
  }
  return url;
}

type Props = {
  game: Game;
  chunks: Record<number, Chunk>;
  videoUrl: string | null | undefined;
  copy: GameStrings["media"];
  /** called on every drawn frame with the tracking time, for maps that follow the video */
  onFrame?: (t: number) => void;
};

export const GameMedia = forwardRef<MediaHandle, Props>(function GameMedia(
  { game, chunks, videoUrl, copy, onFrame },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<Required<Omit<MediaView, "onTap">> & { onTap: MediaView["onTap"] }>({
    t: 0, lo: 0, hi: game.total, k: game.chunks[0]?.k ?? 0, hl: new Set(), focus: null, label: "", loop: false, onTap: null,
  });
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const [mh, setMh] = useState(240);
  const mhRef = useRef(240);
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, game.total]);
  const [label, setLabel] = useState("");
  const [videoError, setVideoError] = useState(false);
  const vs = game.videoStartSeconds || 0;

  const trackingTime = useCallback(() => {
    const v = videoRef.current;
    return v ? v.currentTime - vs : 0;
  }, [vs]);

  const vgeo = useCallback(() => {
    const inner = innerRef.current;
    const v = videoRef.current;
    const W = inner?.clientWidth ?? 1;
    const H = inner?.clientHeight ?? 1;
    const vw = v?.videoWidth || game.srcW;
    const vh = v?.videoHeight || game.srcH;
    const f = Math.min(W / vw, H / vh);
    return { s: (vw * f) / game.srcW, ox: (W - vw * f) / 2, oy: (H - vh * f) / 2, W, H };
  }, [game.srcH, game.srcW]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const g = vgeo();
    const X = (x: number) => g.ox + x * g.s;
    const Yp = (y: number) => g.oy + y * g.s;
    const gt = trackingTime();
    ctx.clearRect(0, 0, g.W, g.H);
    setClock(gt);
    const k = chunkAt(game, gt);
    const lt = G2L(game, k, gt);
    const vw = view.current;
    for (const b of boxesAt(chunksRef.current, k, lt)) {
      const you = vw.hl.has(b.id) && k === vw.k;
      ctx.lineWidth = you ? 3 : 1.3;
      ctx.strokeStyle = you ? "#2FD8C4" : "rgba(255,255,255,.7)";
      ctx.setLineDash(b.guess ? [6, 5] : []);
      ctx.strokeRect(X(b.x), Yp(b.y), b.w * g.s, b.h * g.s);
      ctx.setLineDash([]);
      if (you) {
        ctx.fillStyle = "rgba(47,216,196,.16)";
        ctx.fillRect(X(b.x), Yp(b.y), b.w * g.s, b.h * g.s);
      }
    }
    if (vw.focus && videoRef.current?.paused) {
      ctx.fillStyle = "#2FD8C4";
      ctx.beginPath();
      ctx.arc(X(vw.focus[0]), Yp(vw.focus[1]), 5, 0, 7);
      ctx.fill();
    }
    onFrameRef.current?.(gt);
  }, [game, trackingTime, vgeo]);

  const layout = useCallback(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    const v = videoRef.current;
    const cv = canvasRef.current;
    if (!wrap || !inner || !v || !cv) return;
    const h = mhRef.current;
    wrap.style.setProperty("--mh", `${h}px`);
    const vh = v.videoHeight || game.srcH;
    const vw = v.videoWidth || game.srcW;
    const hh = inner.clientHeight || h;
    const w = Math.round((hh * vw) / vh);
    inner.style.width = `${w}px`;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = hh * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${hh}px`;
    cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }, [draw, game.srcH, game.srcW]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const vw = view.current;
    const clamped = Math.max(vw.lo, Math.min(vw.hi, t));
    v.currentTime = clamped + vs;
  }, [vs]);

  const loop = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.paused) return;
    const vw = view.current;
    const t = trackingTime();
    if (t >= vw.hi) {
      if (vw.loop) v.currentTime = vw.lo + vs;
      else { v.pause(); v.currentTime = vw.hi + vs; }
    }
    draw();
    requestAnimationFrame(loop);
  }, [draw, trackingTime, vs]);

  const show = useCallback((o: MediaView) => {
    const v = videoRef.current;
    view.current = {
      t: o.t,
      k: o.k,
      hl: o.hl ?? new Set(),
      lo: o.lo ?? Math.max(0, o.t - 10),
      hi: o.hi ?? o.t + 10,
      focus: o.focus ?? null,
      label: o.label ?? "",
      loop: !!o.loop,
      onTap: o.onTap ?? null,
    };
    setRange([view.current.lo, view.current.hi]);
    setLabel(view.current.label);
    if (v) {
      v.pause();
      v.currentTime = o.t + vs;
    }
    draw();
    requestAnimationFrame(() => {
      const f = view.current.focus;
      const wrap = wrapRef.current;
      if (f && wrap) {
        const g = vgeo();
        wrap.scrollLeft = g.ox + f[0] * g.s - wrap.clientWidth / 2;
      }
    });
  }, [draw, vgeo, vs]);

  useImperativeHandle(ref, () => ({
    show,
    now: trackingTime,
    pause: () => videoRef.current?.pause(),
    element: () => rootRef.current,
  }), [show, trackingTime]);

  // Attach the video once.
  useEffect(() => {
    const v = videoRef.current;
    const url = browserSafeVideoUrl(videoUrl);
    if (!v || !url) return;
    let hls: Hls | null = null;
    setVideoError(false);
    const isHls = url.includes(".m3u8") || url.includes("/hls-proxy/");
    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, maxBufferLength: 20, backBufferLength: 30 });
      capPlaybackQuality(hls);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(url));
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setVideoError(true); });
      hls.attachMedia(v);
    } else {
      v.src = url;
    }
    return () => { hls?.destroy(); };
  }, [videoUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => { setPlaying(true); loop(); };
    const onPause = () => { setPlaying(false); draw(); };
    const onMeta = () => layout();
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", draw);
    v.addEventListener("loadeddata", draw);
    v.addEventListener("loadedmetadata", onMeta);
    window.addEventListener("resize", layout);
    layout();
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", draw);
      v.removeEventListener("loadeddata", draw);
      v.removeEventListener("loadedmetadata", onMeta);
      window.removeEventListener("resize", layout);
    };
  }, [draw, layout, loop]);

  // Redraw when chunks arrive.
  useEffect(() => { draw(); }, [chunks, draw]);

  const zoom = (f: number) => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const c = (wrap.scrollLeft + wrap.clientWidth / 2) / Math.max(1, inner.clientWidth);
    mhRef.current = Math.max(150, Math.min(720, mhRef.current * f));
    setMh(mhRef.current);
    requestAnimationFrame(() => {
      layout();
      wrap.scrollLeft = c * inner.clientWidth - wrap.clientWidth / 2;
    });
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const tapHandler = view.current.onTap;
    if (!tapHandler) return;
    const inner = innerRef.current;
    if (!inner) return;
    const r = inner.getBoundingClientRect();
    const g = vgeo();
    const sx = (e.clientX - r.left - g.ox) / g.s;
    const sy = (e.clientY - r.top - g.oy) / g.s;
    const gt = trackingTime();
    const k = chunkAt(game, gt);
    const lt = G2L(game, k, gt);
    let hit: Box | null = null;
    for (const b of boxesAt(chunksRef.current, k, lt)) {
      const m = 8;
      if (sx >= b.x - m && sx <= b.x + b.w + m && sy >= b.y - m && sy <= b.y + b.h + m && (!hit || b.w * b.h < hit.w * hit.h)) hit = b;
    }
    videoRef.current?.pause();
    tapHandler({ k, lt, box: hit ? { id: hit.id } : null, pt: [sx, sy] });
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (trackingTime() >= view.current.hi - 0.05) v.currentTime = view.current.lo + vs;
      void v.play().catch(() => undefined);
    } else v.pause();
  };

  return (
    <div ref={rootRef} className="overflow-hidden rounded-2xl border border-line bg-black">
      <div className="relative">
        <div
          ref={wrapRef}
          dir="ltr"
          className="overflow-x-auto overflow-y-hidden [scrollbar-color:rgba(255,255,255,.25)_transparent] [scrollbar-width:thin]"
          style={{ height: mh + 12 }}
        >
          <div ref={innerRef} className="relative" style={{ height: mh }} onClick={onClick}>
            <video ref={videoRef} playsInline muted preload="auto" className="absolute inset-0 h-full w-full object-contain" />
            <canvas ref={canvasRef} className="absolute inset-0" />
          </div>
        </div>
        {label && (
          <span className="pointer-events-none absolute start-2 top-2 rounded-md bg-black/60 px-2 py-0.5 font-display text-[11px] font-bold text-white">
            {label}
          </span>
        )}
      </div>
      {videoError && <p className="px-3 pt-2 text-xs text-muted-text">{copy.videoError}</p>}
      <div dir="ltr" className="flex items-center gap-2 bg-surface px-3 py-2">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? copy.pause : copy.play}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-floodlight font-bold text-void"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" onClick={() => seek(trackingTime() - 2)} className="rounded-full border border-line px-2.5 py-1 text-xs text-text">{copy.back2}</button>
        <button type="button" onClick={() => seek(trackingTime() + 2)} className="rounded-full border border-line px-2.5 py-1 text-xs text-text">{copy.fwd2}</button>
        <span className="w-14 shrink-0 font-display text-xs tabular-nums text-text">{mmss(clock + (game.matchOffset || 0))}</span>
        <input
          type="range"
          aria-label={copy.scrub}
          min={range[0]}
          max={range[1]}
          step={0.05}
          value={Math.max(range[0], Math.min(range[1], clock))}
          onChange={(e) => seek(Number(e.target.value))}
          className="min-w-0 flex-1 accent-[#D4FF4F]"
        />
        <button type="button" aria-label={copy.zoomOut} onClick={() => zoom(1 / 1.35)} className="rounded-full border border-line px-2.5 py-1 text-xs text-text">−</button>
        <button type="button" aria-label={copy.zoomIn} onClick={() => zoom(1.35)} className="rounded-full border border-line px-2.5 py-1 text-xs text-text">+</button>
      </div>
    </div>
  );
});
