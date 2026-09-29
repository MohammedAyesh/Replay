import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minimize2, Minus, Pause, Play, Plus, RotateCcw, Scan } from "lucide-react";

import { clampOrigin, frameToVideoStyle } from "@/lib/cropFrame";
import type { DemoCopy } from "./copy";
import { formatClock, withBase, type DemoMatch, type DemoMoment } from "./data";
import { claimPlayback, releasePlayback, useActivePlayback, useHlsSource, useInView } from "./playback";

type Tab = "look" | "moments" | "clip" | "var";
type View = { w: number; cx: number; cy: number };

const PLAYER_ID = "panorama";
const DEFAULT_SRC_ASPECT = 3840 / 1080;
const MIN_W = 0.07;

/** Largest frame width for an output shape: the whole pitch for wide, full height for vertical. */
function maxWidth(srcAspect: number, outAspect: number): number {
  return outAspect >= 1 ? 1 : Math.min(1, outAspect / srcAspect);
}

function frameOf(view: View, srcAspect: number, outAspect: number) {
  const w = view.w;
  const h = (w * srcAspect) / outAspect;
  return { x: clampOrigin(view.cx - w / 2, w), y: clampOrigin(view.cy - h / 2, h), w, h };
}

function clampView(view: View, srcAspect: number, outAspect: number): View {
  const w = Math.max(MIN_W, Math.min(maxWidth(srcAspect, outAspect), view.w));
  const f = frameOf({ ...view, w }, srcAspect, outAspect);
  return { w, cx: f.x + f.w / 2, cy: f.y + f.h / 2 };
}

export function Panorama({
  match,
  moments,
  momentsState,
  copy,
}: {
  match: DemoMatch;
  moments: DemoMoment[];
  momentsState: "loading" | "ready" | "none";
  copy: DemoCopy["sections"]["tryIt"];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const active = useActivePlayback();
  const { ref: viewRef, inView } = useInView<HTMLDivElement>("120px", 0.2);

  const [started, setStarted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hlsState = useHlsSource(videoRef, withBase(match.src), started, attempt);

  const [tab, setTab] = useState<Tab>("look");
  const [srcAspect, setSrcAspect] = useState(DEFAULT_SRC_ASPECT);
  const [vertical, setVertical] = useState(false);
  const outAspect = vertical ? 9 / 16 : 16 / 9;
  const [view, setView] = useState<View>({ w: 1, cx: 0.5, cy: 0.5 });
  const viewRefLatest = useRef(view);
  viewRefLatest.current = view;

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [verdict, setVerdict] = useState<"goal" | "noGoal" | null>(null);
  const [clipStart, setClipStart] = useState<number | null>(null);
  const [clipEnd, setClipEnd] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== "undefined" && Boolean(document.fullscreenEnabled);
  const pendingSeek = useRef<number | null>(null);

  const frame = frameOf(view, srcAspect, outAspect);
  const wMax = maxWidth(srcAspect, outAspect);
  const zoomedIn = view.w < wMax - 1e-3;

  const setClampedView = useCallback((next: View) => {
    setView(clampView(next, srcAspect, outAspect));
  }, [srcAspect, outAspect]);

  // Re-fit when the output shape changes (wide <-> vertical).
  useEffect(() => {
    setView((current) => clampView(current, srcAspect, outAspect));
  }, [srcAspect, outAspect]);

  // Someone else started playing, or the player scrolled away.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if ((active !== null && active !== PLAYER_ID) || !inView) {
      if (!video.paused && !fullscreen) video.pause();
    }
  }, [active, inView, fullscreen]);

  useEffect(() => () => releasePlayback(PLAYER_ID), []);

  // Video element events.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) setSrcAspect(video.videoWidth / video.videoHeight);
      if (Number.isFinite(video.duration)) setDuration(video.duration);
      if (pendingSeek.current !== null) {
        video.currentTime = Math.max(0, Math.min(pendingSeek.current, (video.duration || pendingSeek.current + 1) - 1));
        pendingSeek.current = null;
      }
    };
    const onTime = () => setTime(video.currentTime);
    const onPlay = () => {
      setPlaying(true);
      claimPlayback(PLAYER_ID);
    };
    const onPause = () => {
      setPlaying(false);
      releasePlayback(PLAYER_ID);
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, []);

  // Start playing as soon as the stream is attached, and again once metadata
  // is in: some browsers will not fetch anything for a paused element, so
  // waiting for metadata before calling play() can wait forever.
  const autoplayDone = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (hlsState === "failed") autoplayDone.current = false;
    if (!video || !started || autoplayDone.current) return;
    if (hlsState !== "loading" && hlsState !== "ready") return;
    claimPlayback(PLAYER_ID);
    void video.play().then(() => {
      autoplayDone.current = true;
    }).catch(() => undefined);
  }, [hlsState, started]);

  // Loop the viewer's own clip while previewing it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !previewing || clipStart === null || clipEnd === null) return;
    if (time >= clipEnd || time < clipStart - 0.5) video.currentTime = clipStart;
  }, [time, previewing, clipStart, clipEnd]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
  }, [rate, hlsState]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const begin = (at?: number) => {
    if (at !== undefined) pendingSeek.current = at;
    setStarted(true);
    claimPlayback(PLAYER_ID);
  };

  const seek = (seconds: number, play = true) => {
    const video = videoRef.current;
    if (!started || !video || hlsState !== "ready") {
      begin(seconds);
      return;
    }
    video.currentTime = Math.max(0, Math.min(seconds, (duration || seconds + 1) - 0.5));
    if (play) {
      claimPlayback(PLAYER_ID);
      void video.play().catch(() => undefined);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!started) {
      begin(moments[0] ? Math.max(0, moments[0].t - 8) : undefined);
      return;
    }
    if (!video) return;
    if (video.paused) {
      claimPlayback(PLAYER_ID);
      void video.play().catch(() => undefined);
    } else video.pause();
  };

  const zoomBy = (factor: number, anchorX = 0.5, anchorY = 0.5) => {
    const current = viewRefLatest.current;
    const f = frameOf(current, srcAspect, outAspect);
    const px = f.x + anchorX * f.w;
    const py = f.y + anchorY * f.h;
    const w = Math.max(MIN_W, Math.min(wMax, current.w * factor));
    const h = (w * srcAspect) / outAspect;
    setClampedView({ w, cx: px - anchorX * w + w / 2, cy: py - anchorY * h + h / 2 });
  };

  // ── Gestures: one finger pans, two fingers pinch, ctrl+wheel zooms ──────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; x: number; y: number; dist: number; mx: number; my: number } | null>(null);

  const resetGesture = () => {
    const pts = [...pointers.current.values()];
    if (!pts.length) {
      gesture.current = null;
      return;
    }
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { view: viewRefLatest.current, x: mx, y: my, dist, mx, my };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Capturing the pointer would swallow the click on the play and retry
    // buttons that sit on top of the picture.
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    resetGesture();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current || !stageRef.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = stageRef.current.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    const start = frameOf(g.view, srcAspect, outAspect);
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let w = g.view.w;
    if (pts.length > 1 && g.dist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      w = Math.max(MIN_W, Math.min(wMax, g.view.w * (g.dist / Math.max(dist, 1))));
    }
    const h = (w * srcAspect) / outAspect;
    // Keep the source point that was under the fingers under the fingers.
    const ax0 = (g.mx - rect.left) / rect.width;
    const ay0 = (g.my - rect.top) / rect.height;
    const ax1 = (mx - rect.left) / rect.width;
    const ay1 = (my - rect.top) / rect.height;
    const sx = start.x + ax0 * start.w;
    const sy = start.y + ay0 * start.h;
    setClampedView({ w, cx: sx - ax1 * w + w / 2, cy: sy - ay1 * h + h / 2 });
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released by the browser.
    }
    resetGesture();
  };

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomBy(Math.exp(event.deltaY * 0.01), (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  });

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ax = (event.clientX - rect.left) / rect.width;
    const ay = (event.clientY - rect.top) / rect.height;
    if (zoomedIn) setClampedView({ w: wMax, cx: 0.5, cy: 0.5 });
    else zoomBy(0.35 / wMax, ax, ay);
  };

  const toggleFullscreen = () => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void shell.requestFullscreen().catch(() => undefined);
  };

  const touchAction = !zoomedIn ? "pan-y" : frame.h < 1 - 1e-3 ? "none" : "pan-y";
  const clipLength = clipStart !== null && clipEnd !== null ? clipEnd - clipStart : null;
  const momentButtons = useMemo(() => moments.slice(0, 12), [moments]);

  const tabs: Array<[Tab, string]> = [
    ["look", copy.tabs.look],
    ["moments", copy.tabs.moments],
    ["clip", copy.tabs.clip],
    ["var", copy.tabs.var],
  ];

  return (
    <div ref={viewRef} className="dm-pano">
      <div ref={shellRef} className={`dm-pano-shell ${fullscreen ? "is-fullscreen" : ""}`}>
        <div
          ref={stageRef}
          className={`dm-pano-stage ${vertical ? "dm-pano-stage--vertical" : ""}`}
          style={{ touchAction }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={onDoubleClick}
          data-testid="demo-panorama-stage"
        >
          <video
            ref={videoRef}
            className="dm-pano-video"
            style={frameToVideoStyle(frame)}
            poster={withBase(match.poster)}
            muted
            playsInline
            preload={started ? "auto" : "none"}
          />
          {!started && (
            <button type="button" className="dm-pano-start" onClick={togglePlay}>
              <span className="dm-play-disc dm-play-disc--big" aria-hidden="true"><Play className="dm-icon" fill="currentColor" /></span>
              <span>{copy.start}</span>
            </button>
          )}
          {started && hlsState === "loading" && <div className="dm-pano-status" role="status">{copy.loading}</div>}
          {hlsState === "failed" && (
            <div className="dm-pano-status" role="alert">
              <span>{copy.failed}</span>
              <button type="button" className="dm-btn dm-btn--ghost" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCcw className="dm-icon" aria-hidden="true" /> {copy.retry}
              </button>
            </div>
          )}
          {started && hlsState === "ready" && !zoomedIn && tab === "look" && (
            <div className="dm-pano-hint" aria-hidden="true">{copy.dragHint}</div>
          )}
          {verdict && tab === "var" && (
            <div className="dm-pano-verdict" role="status">{copy.varTab.decision(verdict === "goal" ? copy.varTab.goal : copy.varTab.noGoal)}</div>
          )}
          <div className="dm-minimap" aria-hidden="true">
            <span style={{ left: `${Math.max(0, frame.x) * 100}%`, width: `${Math.min(1, frame.w) * 100}%` }} />
          </div>
        </div>

        <div className="dm-pano-bar" dir="ltr">
          <button type="button" className="dm-icon-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="dm-icon" /> : <Play className="dm-icon" />}
          </button>
          <span className="dm-tc">{formatClock(time)}</span>
          <div className="dm-scrub">
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(time, duration || 1)}
              onChange={(event) => seek(Number(event.target.value), playing)}
              aria-label="Seek"
              disabled={!started || hlsState !== "ready"}
            />
            {duration > 0 && moments.map((moment) => (
              <span
                key={`${moment.type}-${moment.t}`}
                className={`dm-tick dm-tick--${moment.type}`}
                style={{ left: `${(moment.t / duration) * 100}%` }}
                aria-hidden="true"
              />
            ))}
          </div>
          <span className="dm-tc dm-tc--dim">{formatClock(duration)}</span>
          <button type="button" className="dm-icon-btn" onClick={() => zoomBy(1 / 1.5)} aria-label={copy.zoomIn}><Plus className="dm-icon" /></button>
          <button type="button" className="dm-icon-btn" onClick={() => zoomBy(1.5)} aria-label={copy.zoomOut}><Minus className="dm-icon" /></button>
          <button type="button" className="dm-icon-btn" onClick={() => setClampedView({ w: wMax, cx: 0.5, cy: 0.5 })} aria-label={copy.whole}><Scan className="dm-icon" /></button>
          {canFullscreen && (
            <button type="button" className="dm-icon-btn" onClick={toggleFullscreen} aria-label={fullscreen ? copy.exitFullscreen : copy.fullscreen}>
              {fullscreen ? <Minimize2 className="dm-icon" /> : <Maximize2 className="dm-icon" />}
            </button>
          )}
        </div>
      </div>

      <div className="dm-tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`dm-tab ${tab === key ? "is-on" : ""}`}
            onClick={() => {
              setTab(key);
              if (key !== "clip") {
                setPreviewing(false);
                setVertical(false);
              }
              if (key !== "var") setRate(1);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="dm-tab-panel">
        {tab === "look" && (
          <div className="dm-row">
            <button type="button" className="dm-btn" onClick={() => setClampedView({ w: wMax, cx: 0.5, cy: 0.5 })}>{copy.whole}</button>
            <button type="button" className="dm-btn" onClick={() => zoomBy(0.35 / Math.max(view.w, 0.01))}>{copy.zoomIn}</button>
            <p className="dm-small">{copy.dragHint}</p>
          </div>
        )}

        {tab === "moments" && (
          <div>
            {momentsState === "loading" && <p className="dm-small">{copy.momentsLoading}</p>}
            {momentsState === "none" && <p className="dm-small">{copy.momentsNone}</p>}
            {momentsState === "ready" && (
              <>
                <div className="dm-row dm-row--wrap">
                  {momentButtons.map((moment) => (
                    <button
                      key={`${moment.type}-${moment.t}`}
                      type="button"
                      className={`dm-chip dm-chip--${moment.type}`}
                      onClick={() => {
                        setClampedView({ w: wMax, cx: 0.5, cy: 0.5 });
                        seek(Math.max(0, moment.t - 6));
                      }}
                    >
                      <span className="dm-chip-dot" aria-hidden="true" />
                      {moment.type === "goal" ? copy.goal : copy.shot}
                      <span className="dm-tc">{formatClock(moment.t)}</span>
                    </button>
                  ))}
                </div>
                <p className="dm-small">{copy.momentsNote}</p>
              </>
            )}
          </div>
        )}

        {tab === "clip" && (
          <div className="dm-stack">
            <div className="dm-seg" role="group">
              <button type="button" className={`dm-seg-btn ${!vertical ? "is-on" : ""}`} onClick={() => setVertical(false)}>{copy.clip.horizontal}</button>
              <button type="button" className={`dm-seg-btn ${vertical ? "is-on" : ""}`} onClick={() => setVertical(true)}>{copy.clip.vertical}</button>
            </div>
            <div className="dm-row dm-row--wrap">
              <button type="button" className="dm-btn" disabled={!started || hlsState !== "ready"} onClick={() => { setClipStart(time); setClipEnd(null); setPreviewing(false); }}>
                {copy.clip.markStart}{clipStart !== null ? ` · ${formatClock(clipStart)}` : ""}
              </button>
              <button type="button" className="dm-btn" disabled={clipStart === null || time <= (clipStart ?? 0) + 1} onClick={() => setClipEnd(time)}>
                {copy.clip.markEnd}{clipEnd !== null ? ` · ${formatClock(clipEnd)}` : ""}
              </button>
              <button
                type="button"
                className="dm-btn dm-btn--primary"
                disabled={clipLength === null}
                onClick={() => {
                  setPreviewing(true);
                  seek(clipStart ?? 0);
                }}
              >
                {copy.clip.play}
              </button>
              {(clipStart !== null || previewing) && (
                <button type="button" className="dm-btn dm-btn--ghost" onClick={() => { setClipStart(null); setClipEnd(null); setPreviewing(false); }}>{copy.clip.again}</button>
              )}
            </div>
            <p className="dm-small">
              {clipStart === null
                ? copy.clip.needStart
                : clipEnd === null
                  ? copy.clip.needEnd
                  : `${copy.clip.length(formatClock(clipLength ?? 0))}. ${copy.clip.done}`}
            </p>
          </div>
        )}

        {tab === "var" && (
          <div className="dm-stack">
            <div className="dm-row dm-row--wrap">
              <button type="button" className="dm-btn" onClick={() => seek(Math.max(0, time - 10))}>{copy.varTab.back}</button>
              <button type="button" className={`dm-btn ${rate === 0.5 ? "is-on" : ""}`} onClick={() => setRate(0.5)}>{copy.varTab.slow} 0.5×</button>
              <button type="button" className={`dm-btn ${rate === 1 ? "is-on" : ""}`} onClick={() => setRate(1)}>{copy.varTab.normal}</button>
            </div>
            <div className="dm-row dm-row--wrap">
              <button type="button" className={`dm-btn ${verdict === "goal" ? "dm-btn--primary" : ""}`} onClick={() => setVerdict("goal")}>{copy.varTab.goal}</button>
              <button type="button" className={`dm-btn ${verdict === "noGoal" ? "dm-btn--primary" : ""}`} onClick={() => setVerdict("noGoal")}>{copy.varTab.noGoal}</button>
            </div>
            <p className="dm-small">{copy.varTab.note}</p>
          </div>
        )}
      </div>
    </div>
  );
}
