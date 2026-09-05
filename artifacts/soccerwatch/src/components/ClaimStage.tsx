/**
 * ClaimStage - the Claim Your Match player.
 *
 * Built on the same model as the recordings player in field-detail.tsx
 * (VideoPlayer): a full-bleed 16:9 frame box, a crop frame in source fractions
 * from cropFrame.makeFrame, the <video> positioned by frameToVideoStyle,
 * drag-to-pan with pointer capture and an 8px tap threshold, a frame-size
 * slider, controls that hide themselves after 4 s, double-tap to skip, and a
 * seek bar that ignores timeupdate while it is being dragged.
 *
 * Two things are different here:
 *
 *  1. The tracking boxes live on an overlay LAYER that gets exactly the same
 *     style as the <video>. Boxes are positioned inside that layer in source
 *     fractions, so whatever the frame does, a box stays on its pixel. The tap
 *     hit-test reads the layer's rect and inverts the same numbers.
 *
 *  2. The frame follows the tracked player on its own. Each animation frame
 *     eases the frame towards the followed box (or, while choosing, towards a
 *     view that fits every candidate). The frame is written straight to the
 *     DOM - applyFrameToVideo on the video and the layer - so following never
 *     re-renders React. A drag takes over; "Re-centre" hands control back.
 *
 * Playback is Bunny Stream HLS through the app's /api/hls-proxy (which only
 * adds the Referer Bunny's pull zone requires). hls.js everywhere except
 * Safari, which plays HLS natively.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { capPlaybackQuality } from "../lib/hlsQuality";
import {
  Expand,
  Gauge,
  LocateFixed,
  Pause,
  Play,
  Shrink,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { baseWidth, makeFrame, OUT_ASPECT } from "@/lib/cropFrame";
import type { ClaimBox, ClaimBundle } from "@/lib/claim-match-engine";
import { useSkipTap } from "@/hooks/use-skip-tap";
import { SkipFlash } from "@/components/skip-flash";
import {
  prepareVideoCache,
  subscribeToVideoCache,
  type VideoCacheUpdate,
} from "@/lib/video-cache";

export type StageCandidate = {
  id: string;
  label: string;
  box: ClaimBox;
  overlap?: boolean;
  /** position interpolated across a gap in the track - drawn dashed */
  coasting?: boolean;
  /** source fragment has been vouched for by another claimant */
  taken?: boolean;
};

export type ClaimOffPitchStageSpan = {
  fromSeconds: number;
  toSeconds: number;
};

type Frame = { x: number; y: number; w: number; h: number };

/** cropFrame.applyFrameToVideo, for any element that must share the video's transform. */
function applyFrame(el: HTMLElement, f: Frame) {
  const w = f.w > 0 ? f.w : 1;
  const h = f.h > 0 ? f.h : 1;
  el.style.position = "absolute";
  el.style.maxWidth = "none";
  el.style.width = `${100 / w}%`;
  el.style.height = `${100 / h}%`;
  el.style.left = `${(-f.x * 100) / w}%`;
  el.style.top = `${(-f.y * 100) / h}%`;
}

const OUT = OUT_ASPECT["16:9"];
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1;
/** 1280x720 out of a 3840x1080 panorama: a 180px player renders ~3x taller. */
const FOLLOW_ZOOM = 0.667;
const EASE = 0.14;
const CONTROLS_HIDE_MS = 4000;

function frameContaining(
  boxes: ClaimBox[],
  bundle: ClaimBundle,
  srcAspect: number,
  minZoom: number,
): { cx: number; cy: number; zoom: number } {
  const xs = boxes.map((b) => b.x / bundle.width);
  const ys = boxes.map((b) => b.y / bundle.height);
  const xe = boxes.map((b) => (b.x + b.w) / bundle.width);
  const ye = boxes.map((b) => (b.y + b.h) / bundle.height);
  const x0 = Math.min(...xs), x1 = Math.max(...xe);
  const y0 = Math.min(...ys), y1 = Math.max(...ye);
  const bw = baseWidth(srcAspect, OUT);
  const bh = (bw * srcAspect) / OUT;
  // pad so boxes are not glued to the frame edge, then fit the larger axis
  const needW = ((x1 - x0) * 1.6 + 0.04) / bw;
  const needH = ((y1 - y0) * 1.6 + 0.08) / bh;
  const zoom = Math.max(minZoom, Math.min(MAX_ZOOM, Math.max(needW, needH)));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom };
}

function useBunnyHls(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  url: string | undefined,
  startVideoTime: number,
  onCacheUpdate: (update: VideoCacheUpdate) => void,
) {
  const [videoError, setVideoError] = useState("");
  const startVideoTimeRef = useRef(startVideoTime);
  startVideoTimeRef.current = startVideoTime;
  useEffect(() => {
    const video = videoRef.current;
    setVideoError("");
    if (!video || !url) return;
    let hls: Hls | null = null;
    let retryTimer: number | null = null;
    let decodeTimer: number | null = null;
    let networkRetries = 0;
    let mediaRecoveryAttempted = false;
    let nativeMetadataHandler: (() => void) | null = null;
    const unsubscribeCache = subscribeToVideoCache(onCacheUpdate);
    const clearDecodeTimer = () => {
      if (decodeTimer) window.clearTimeout(decodeTimer);
      decodeTimer = null;
    };
    const confirmDecodedFrame = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return false;
      clearDecodeTimer();
      mediaRecoveryAttempted = false;
      setVideoError("");
      return true;
    };
    const watchForDecodedFrame = () => {
      clearDecodeTimer();
      decodeTimer = window.setTimeout(() => {
        if (confirmDecodedFrame() || !hls) return;
        if (!mediaRecoveryAttempted) {
          mediaRecoveryAttempted = true;
          setVideoError("Recovering the video picture…");
          hls.recoverMediaError();
          hls.startLoad(video.currentTime || startVideoTimeRef.current);
          watchForDecodedFrame();
          return;
        }
        setVideoError("Video data loaded, but this browser could not decode the picture. Reload the page to try again.");
      }, 4_000);
    };
    const startPlayback = () => {
      if (url.includes(".m3u8") && Hls.isSupported()) {
        hls = new Hls({
          enableWorker: false,
          maxBufferLength: 30,
          backBufferLength: 60,
          startPosition: Math.max(0, startVideoTimeRef.current),
        });
        capPlaybackQuality(hls);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(url));
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          const target = Math.max(0, startVideoTimeRef.current);
          // startPosition is used by hls.js when it first starts loading, but
          // explicitly restarting here also covers an instance that attached
          // while the element was paused or had already requested fragment 0.
          hls?.startLoad(target);
          if (Math.abs(video.currentTime - target) > 0.25) video.currentTime = target;
        });
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          networkRetries = 0;
          if (!confirmDecodedFrame()) watchForDecodedFrame();
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || !hls) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            networkRetries += 1;
            if (networkRetries > 5) { setVideoError("The recording could not be loaded. Check your connection and try again."); return; }
            setVideoError("Reconnecting…");
            retryTimer = window.setTimeout(() => hls?.startLoad(), 1000 * networkRetries);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setVideoError("The recording could not be played.");
          }
        });
      } else {
        video.src = url;
        nativeMetadataHandler = () => {
          video.currentTime = Math.max(0, startVideoTimeRef.current);
        };
        video.addEventListener("loadedmetadata", nativeMetadataHandler, { once: true });
        video.onerror = () => setVideoError("The recording could not be played.");
      }
    };
    startPlayback();
    return () => {
      unsubscribeCache();
      if (retryTimer) window.clearTimeout(retryTimer);
      clearDecodeTimer();
      if (nativeMetadataHandler) video.removeEventListener("loadedmetadata", nativeMetadataHandler);
      video.onerror = null;
      if (hls) hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [onCacheUpdate, url, videoRef]);
  return videoError;
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function browserSafeVideoUrl(url: string | undefined) {
  if (!url) return undefined;
  if (url.startsWith("/api/hls-proxy/")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".b-cdn.net") && parsed.pathname.endsWith(".m3u8")) {
      return `/api/hls-proxy/manifest?url=${encodeURIComponent(url)}`;
    }
  } catch {
    // Relative and non-URL sources are already handled by the existing player.
  }
  return url;
}

export function ClaimStage({
  videoUrl,
  bundle,
  candidates,
  showBoxes,
  viewKey,
  currentTime,
  duration,
  playing,
  muted,
  slow,
  playbackRate,
  goalTimes,
   offPitchSpans,
  videoRef,
  onToggle,
  onSeek,
  onSkip,
  onToggleSlow,
  onCyclePlaybackRate,
  onToggleMute,
  onTap,
  onTimeUpdate,
  onVideoReady,
  topLeft,
  topRight,
  panel,
}: {
  videoUrl?: string;
  bundle: ClaimBundle;
  candidates: StageCandidate[];
  showBoxes: boolean;
  /** changes when the selected review view changes; resets a manual pan */
  viewKey: string;
  currentTime: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  slow: boolean;
  playbackRate: number;
  goalTimes: number[];
  offPitchSpans?: ClaimOffPitchStageSpan[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onToggle: (forcePlaying?: boolean) => void;
  onSeek: (trackingSeconds: number) => void;
  onSkip: (delta: number) => void;
  onToggleSlow: () => void;
  onCyclePlaybackRate: () => void;
  onToggleMute: () => void;
  /** a tap on the picture, in source pixels */
  onTap: (x: number, y: number) => void;
  onTimeUpdate: (videoSeconds: number) => void;
  onVideoReady: () => void;
  topLeft?: React.ReactNode;
  topRight?: React.ReactNode;
  panel?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameBoxRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const minimapFrameRef = useRef<HTMLDivElement | null>(null);

  const playbackUrl = browserSafeVideoUrl(videoUrl);
  const startVideoTime = Math.max(0, currentTime + (bundle.videoStartSeconds || 0));
  const [videoCachePhase, setVideoCachePhase] = useState<"idle" | "preparing" | "ready" | "caching" | "cached" | "unavailable">(
    playbackUrl?.includes(".m3u8") ? "idle" : "ready",
  );
  const [cachedResourceCount, setCachedResourceCount] = useState(0);
  const [cacheError, setCacheError] = useState("");
  const cacheStartedForRef = useRef<string | null>(null);
  const handleCacheUpdate = useCallback((update: VideoCacheUpdate) => {
    if (typeof update.cachedCount === "number") setCachedResourceCount(update.cachedCount);
    if (update.kind === "ready") setVideoCachePhase("ready");
    if (update.kind === "stored") setVideoCachePhase("caching");
    if (update.kind === "hit") setVideoCachePhase("cached");
    if (update.kind === "error") {
      setVideoCachePhase("unavailable");
      if (update.detail) setCacheError(update.detail);
    }
  }, []);
  const videoError = useBunnyHls(videoRef, playbackUrl, startVideoTime, handleCacheUpdate);
  useEffect(() => {
    cacheStartedForRef.current = null;
    setCachedResourceCount(0);
    setCacheError("");
    setVideoCachePhase(playbackUrl?.includes(".m3u8") ? "idle" : "ready");
  }, [playbackUrl]);
  const beginVideoCache = useCallback(() => {
    if (!playbackUrl?.includes(".m3u8")) return;
    if (cacheStartedForRef.current === playbackUrl) return;
    cacheStartedForRef.current = playbackUrl;
    setVideoCachePhase("preparing");
    setCacheError("");
    void prepareVideoCache(playbackUrl)
      .then((available) => {
        if (!available) {
          cacheStartedForRef.current = null;
          handleCacheUpdate({ kind: "error", detail: "Browser cache is unavailable" });
        }
        else setVideoCachePhase((phase) => phase === "preparing" ? "ready" : phase);
      })
      .catch(() => {
        cacheStartedForRef.current = null;
        handleCacheUpdate({ kind: "error", detail: "Browser cache could not be started" });
      });
  }, [handleCacheUpdate, playbackUrl]);
  const videoCacheLabel = videoCachePhase === "preparing"
    ? "Preparing video cache"
    : videoCachePhase === "caching"
      ? `Caching video · ${cachedResourceCount} part${cachedResourceCount === 1 ? "" : "s"}`
      : videoCachePhase === "cached"
        ? `Video cache active · ${cachedResourceCount} part${cachedResourceCount === 1 ? "" : "s"}`
        : videoCachePhase === "idle"
          ? "Cache starts when you play"
        : videoCachePhase === "unavailable"
          ? "Video cache unavailable"
          : "Video cache ready";

  // ── frame model (refs: read by the rAF loop, never per-frame React state) ──
  const srcAspectRef = useRef(bundle.width / bundle.height);
  const zoomRef = useRef(FOLLOW_ZOOM);
  const originRef = useRef({ x: (1 - baseWidth(srcAspectRef.current, OUT) * FOLLOW_ZOOM) / 2, y: 0 });
  const appliedRef = useRef<Frame | null>(null);
  const targetRef = useRef<{ cx: number; cy: number; zoom: number } | null>(null);
  const manualRef = useRef(false);
  const [manual, setManual] = useState(false);
  const [zoom, setZoom] = useState(FOLLOW_ZOOM);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const lastReportedFrameRef = useRef(-1);

  const seekDraggingRef = useRef(false);

  const readFrame = useCallback((): Frame => makeFrame(
    originRef.current.x, originRef.current.y, zoomRef.current, srcAspectRef.current, OUT,
  ), []);

  const setManualPan = useCallback((value: boolean) => {
    manualRef.current = value;
    setManual(value);
  }, []);

  /** Where the frame wants to be, from the tracking data, when nobody is dragging. */
  const computeTarget = useCallback((): { cx: number; cy: number; zoom: number } | null => {
    const boxes = candidatesRef.current.map((c) => c.box);
    if (boxes.length) return frameContaining(boxes, bundle, srcAspectRef.current, MIN_ZOOM);
    return null;
  }, [bundle]);

  useEffect(() => { setManualPan(false); }, [viewKey, setManualPan]);

  // The follow loop. Eases origin/zoom towards the target and writes the frame
  // to the video and the overlay layer only when it actually changed.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      const video = videoRef.current;
      const layer = layerRef.current;
      if (!video || !layer) return;
      // Time comes from here, every animation frame, not from timeupdate (~4 Hz):
      // report once per tracking frame so the boxes move with the picture.
      if (!seekDraggingRef.current && !video.seeking) {
        const frame = Math.round(video.currentTime * bundle.frameRate);
        if (frame !== lastReportedFrameRef.current) {
          lastReportedFrameRef.current = frame;
          onTimeUpdateRef.current(video.currentTime);
        }
      }
      if (!manualRef.current) {
        const target = computeTarget();
        if (target) {
          targetRef.current = target;
          const sized = makeFrame(0, 0, target.zoom, srcAspectRef.current, OUT);
          const wantX = target.cx - sized.w / 2;
          const wantY = target.cy - sized.h / 2;
          const want = makeFrame(wantX, wantY, target.zoom, srcAspectRef.current, OUT);
          const cur = readFrame();
          const nx = cur.x + (want.x - cur.x) * EASE;
          const ny = cur.y + (want.y - cur.y) * EASE;
          const nz = zoomRef.current + (target.zoom - zoomRef.current) * EASE;
          if (Math.abs(nz - zoomRef.current) > 1e-4) {
            zoomRef.current = nz;
            // keep the slider in step without a per-frame render
            if (Math.abs(nz - zoom) > 0.01) setZoom(Number(nz.toFixed(2)));
          }
          const f = makeFrame(nx, ny, zoomRef.current, srcAspectRef.current, OUT);
          originRef.current = { x: f.x, y: f.y };
        }
      }
      const f = readFrame();
      const a = appliedRef.current;
      if (!a || Math.abs(a.x - f.x) > 1e-5 || Math.abs(a.y - f.y) > 1e-5 || Math.abs(a.w - f.w) > 1e-5) {
        applyFrame(video, f);
        applyFrame(layer, f);
        appliedRef.current = f;
        const mm = minimapFrameRef.current;
        if (mm) {
          mm.style.left = `${f.x * 100}%`;
          mm.style.top = `${f.y * 100}%`;
          mm.style.width = `${f.w * 100}%`;
          mm.style.height = `${f.h * 100}%`;
        }
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [bundle, computeTarget, readFrame, videoRef, zoom]);

  // ── drag to pan (same as VideoPlayer) ─────────────────────────────────────
  const dragRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const draggedRef = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggedRef.current = false;
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, originX: originRef.current.x, originY: originRef.current.y };
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const box = frameBoxRef.current;
    if (!box || !(box.clientWidth > 0) || !(box.clientHeight > 0)) return;
    const rawX = e.clientX - dragRef.current.startX;
    const rawY = e.clientY - dragRef.current.startY;
    if (!draggedRef.current && Math.hypot(rawX, rawY) > 8) {
      draggedRef.current = true;
      setManualPan(true);
    }
    if (!draggedRef.current) return;
    const f = readFrame();
    const next = makeFrame(
      dragRef.current.originX - (rawX / box.clientWidth) * f.w,
      dragRef.current.originY - (rawY / box.clientHeight) * f.h,
      zoomRef.current, srcAspectRef.current, OUT,
    );
    originRef.current = { x: next.x, y: next.y };
  }, [readFrame, setManualPan]);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.active) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    }
    dragRef.current.active = false;
  }, []);

  const setZoomManual = useCallback((z: number) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const prev = readFrame();
    const cx = prev.x + prev.w / 2;
    const cy = prev.y + prev.h / 2;
    const sized = makeFrame(0, 0, next, srcAspectRef.current, OUT);
    const f = makeFrame(cx - sized.w / 2, cy - sized.h / 2, next, srcAspectRef.current, OUT);
    zoomRef.current = next;
    originRef.current = { x: f.x, y: f.y };
    setZoom(next);
    // zooming by hand keeps following unless the user also dragged
  }, [readFrame]);

  const recentre = useCallback(() => {
    zoomRef.current = FOLLOW_ZOOM;
    setZoom(FOLLOW_ZOOM);
    setManualPan(false);
  }, [setManualPan]);

  // ── controls visibility ───────────────────────────────────────────────────
  const [showControls, setShowControls] = useState(true);
  const controlsTimer = useRef<number | null>(null);
  const pokeControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) window.clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_MS);
  }, []);
  useEffect(() => {
    pokeControls();
    return () => { if (controlsTimer.current) window.clearTimeout(controlsTimer.current); };
  }, [pokeControls]);
  // paused = controls stay
  useEffect(() => { if (!playing) setShowControls(true); else pokeControls(); }, [playing, pokeControls]);

  const { flash: skipFlash, onTouchEnd: skipOnTouchEnd } = useSkipTap({
    onSkip: (delta) => { onSkip(delta); pokeControls(); },
    onSingleTap: pokeControls,
  });

  // ── tap on the picture: select a box, else toggle controls ────────────────
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (draggedRef.current) { draggedRef.current = false; return; }
    const layer = layerRef.current;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) { pokeControls(); return; }
    onTap(fx * bundle.width, fy * bundle.height);
    pokeControls();
  }, [bundle.height, bundle.width, onTap, pokeControls]);

  // ── fullscreen on the container so overlays survive ───────────────────────
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.().catch(() => undefined);
  }, []);

  // ── seek bar drag guard (VideoPlayer) ─────────────────────────────────────
  const [scrub, setScrub] = useState<number | null>(null);
  const shownTime = scrub ?? currentTime;

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = slow ? 0.5 : playbackRate;
  }, [playbackRate, slow, videoRef]);

  const onLoadedMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) {
      const ar = v.videoWidth / v.videoHeight;
      if (ar > 0 && Math.abs(ar - srcAspectRef.current) > 1e-6) srcAspectRef.current = ar;
    }
    onVideoReady();
  }, [onVideoReady]);

  const minimapW = 128;
  const minimapH = Math.max(24, Math.round(minimapW / srcAspectRef.current));

  return (
    <div ref={containerRef} className="claim-stage" data-testid="video-claim-match">
      <div className="claim-stage-centre">
        <div
          ref={frameBoxRef}
          className="claim-frame-box"
          style={{ width: "min(100%, calc(100dvh * 16 / 9))", aspectRatio: "16 / 9" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onTouchEnd={(e) => { if (!draggedRef.current) skipOnTouchEnd(e); }}
          onClick={handleClick}
        >
          {videoUrl ? (
            <video
              ref={videoRef}
              className="claim-video"
              crossOrigin="anonymous"
              muted={muted}
              playsInline
              preload="auto"
              onLoadedMetadata={onLoadedMetadata}
              onLoadedData={onVideoReady}
              onSeeked={onVideoReady}
              onPlay={() => { beginVideoCache(); onToggle(true); }}
              onPause={() => onToggle(false)}
              onEnded={() => onToggle(false)}
              aria-label="Match recording"
            />
          ) : (
            <div className="claim-fallback-video" role="img" aria-label="Match recording preview">
              <div className="fallback-field-lines" />
              <div className="fallback-camera-stamp">MATCH VIDEO UNAVAILABLE · TRACKING DATA STILL LOADED</div>
            </div>
          )}
          {/* Same transform as the video; boxes are source fractions inside it. */}
          <div ref={layerRef} className="claim-overlay-layer" aria-hidden="true">
            {showBoxes && candidates.map((candidate, index) => (
              <div
                key={candidate.id}
                 className={`claim-track-box ${candidate.overlap ? "is-overlap" : ""} ${candidate.coasting ? "is-coasting" : ""} ${candidate.taken ? "is-taken" : ""}`}
                style={{
                  left: `${(candidate.box.x / bundle.width) * 100}%`,
                  top: `${(candidate.box.y / bundle.height) * 100}%`,
                  width: `${(candidate.box.w / bundle.width) * 100}%`,
                  height: `${(candidate.box.h / bundle.height) * 100}%`,
                }}
                data-testid={`overlay-track-${candidate.id}`}
              >
                <span>{index + 1} / {candidate.label}</span>
              </div>
            ))}
          </div>
          {videoError && <div className="claim-video-error" role="alert">{videoError}</div>}
          <SkipFlash flash={skipFlash} />
        </div>
      </div>

      {/* Top bar */}
      <div className={`claim-stage-top ${showControls ? "" : "is-hidden"}`}>
        <div className="claim-stage-top-left">{topLeft}</div>
        <div className="claim-stage-top-right">
          {topRight}
          {playbackUrl?.includes(".m3u8") && (
            <div
              className={`claim-video-cache-status is-${videoCachePhase}`}
              role="status"
              title={cacheError || "Previously fetched HLS resources are replayed from this device when available."}
            >
              <span className="claim-video-cache-dot" />
              {videoCacheLabel}
            </div>
          )}
          <div className="claim-minimap" style={{ width: minimapW, height: minimapH }} aria-hidden="true">
            <div ref={minimapFrameRef} className="claim-minimap-frame" />
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className={`claim-stage-bottom ${showControls ? "" : "is-hidden"}`} onClick={(e) => e.stopPropagation()}>
        <div className="claim-seek-row">
          <span className="claim-clock">{formatClock(shownTime)}</span>
          <div className="claim-seek-track">
            {(offPitchSpans ?? []).map((span) => (
              <span
                key={`${span.fromSeconds}-${span.toSeconds}`}
                className="claim-seek-offpitch"
                style={{
                  left: `${(span.fromSeconds / Math.max(duration, 0.001)) * 100}%`,
                  width: `${((span.toSeconds - span.fromSeconds) / Math.max(duration, 0.001)) * 100}%`,
                }}
                title="Declared off-pitch period"
              />
            ))}
            {goalTimes.map((t) => <span key={t} className="claim-seek-goal" style={{ left: `${(t / duration) * 100}%` }} />)}
            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={Math.min(duration, shownTime)}
              onPointerDown={() => { seekDraggingRef.current = true; }}
              onPointerUp={() => { seekDraggingRef.current = false; setScrub(null); }}
              onChange={(e) => {
                const v = Number(e.target.value);
                setScrub(v);
                onSeek(v);
              }}
              aria-label="Match position"
              data-testid="input-match-position"
            />
          </div>
          <span className="claim-clock">{formatClock(duration)}</span>
        </div>
        <div className="claim-tools-row">
          <button type="button" className="claim-tool" onClick={() => { onSkip(-10); pokeControls(); }} aria-label="Back 10 seconds"><SkipBack size={15} /></button>
          <button type="button" className="claim-tool claim-tool-play" data-testid="button-video-play" onClick={() => { onToggle(); pokeControls(); }} aria-label={playing ? "Pause match" : "Play match"}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
          <button type="button" className="claim-tool" onClick={() => { onSkip(10); pokeControls(); }} aria-label="Forward 10 seconds"><SkipForward size={15} /></button>
          <div className="claim-zoom">
            <span>Frame</span>
            <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.02} value={zoom} onChange={(e) => setZoomManual(Number(e.target.value))} aria-label="Frame size" />
            <span>{zoom.toFixed(2)}x</span>
          </div>
          <button type="button" className={`claim-tool ${manual ? "is-on" : ""}`} onClick={recentre} aria-label="Follow the player"><LocateFixed size={15} /> {manual ? "Re-centre" : "Following"}</button>
          <button type="button" className={`claim-tool ${slow ? "is-on" : ""}`} data-testid="button-slow-motion" onClick={onToggleSlow} aria-label="Toggle slow motion"><Gauge size={15} /> Slow</button>
           <button type="button" className={`claim-tool ${playbackRate > 1 && !slow ? "is-on" : ""}`} data-testid="button-video-speed" onClick={onCyclePlaybackRate} aria-label={`Playback speed ${playbackRate} times. Increase playback speed`}> <SkipForward size={15} /> {playbackRate}x</button>
          <button type="button" className="claim-tool" data-testid="button-video-mute" onClick={onToggleMute} aria-label={muted ? "Unmute match" : "Mute match"}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
          <button type="button" className="claim-tool" data-testid="button-video-fullscreen" onClick={toggleFullscreen} aria-label="Fullscreen video">{isFullscreen ? <Shrink size={15} /> : <Expand size={15} />}</button>
        </div>
      </div>

      {/* Stage panel: find / following / still / picker / look / done */}
      {panel && <div className="claim-stage-panel" onClick={(e) => e.stopPropagation()}>{panel}</div>}
    </div>
  );
}
