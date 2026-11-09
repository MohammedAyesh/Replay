import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Circle, Crosshair, Loader2, Maximize2, Pause, Play, Rewind, FastForward, Square, Volume2, VolumeX } from "lucide-react";
import { ballTrailAt, drawBallTrail, framingWindow, trailWidthFor, type BallTrailSample, type Framing, type SceneBranding } from "@workspace/api-zod";
import { useCreativeFramerCopy } from "@/i18n/creative-framer-strings";
import { videoUrlFor } from "../library/media";
import {
  DEFAULT_BRANDING, FRAMER_SHAPES, MAX_VIDEO_MS, boxAspectOf, fetchFraming, footageBox, shapeFormat, thin, zoomRange,
  type FramedClip, type FramerShape,
} from "@/lib/creative-framing";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * The clip framer: a 16:9 camera on the panorama, following the ball unless
 * the owner moves it, with the clip's start and end movable 5 s at a time and
 * the venue's branding switchable. One <video> plays the footage (a cut of the
 * recording with room either side); two canvases draw from it — the framed
 * view and the whole pitch with the camera's window on it.
 *
 * Times inside are milliseconds of the recording ("abs"); for a fixed clip,
 * of the clip. The keys handed back are relative to the output's start.
 */

export type FramerStart =
  | { type: "recording"; recordingId: number; fromMs: number; toMs: number }
  | { type: "clip"; clipId: number; durationMs: number };

const MARGIN_MS = 15_000;
const STEP_MS = 5_000;
const MIN_MS = 2_000;
const RECORD_EVERY_MS = 200;
const WIDE = 16 / 9;

type Key = [number, number, number];
type Mode = "ball" | "manual" | "pitch";

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};

export function ClipFramer({ academyId, start, framing: initialFraming, branding: initialBranding, shape: initialShape, lockedAspect, ballTrail: initialTrail, actions }: {
  academyId: number;
  start: FramerStart;
  /** The video's shape; offered as a choice unless lockedAspect is set. */
  shape?: FramerShape;
  /** The camera's box is fixed (a layer in the editor): its width / height. */
  lockedAspect?: number;
  /** Keys relative to the start's beginning. Absent: follow the ball. */
  framing?: Framing | null;
  branding?: SceneBranding | null;
  /** The red ball trail starts on. */
  ballTrail?: boolean;
  /** The buttons under the framer, given what it would hand back now. */
  actions: (value: FramedClip) => ReactNode;
}) {
  const copy = useCreativeFramerCopy();
  const isRec = start.type === "recording";
  const [win, setWin] = useState(() => isRec ? { from: start.fromMs, to: start.toMs } : { from: 0, to: start.durationMs });
  const [loaded, setLoaded] = useState(() => isRec
    ? { from: Math.max(0, start.fromMs - MARGIN_MS), to: start.toMs + MARGIN_MS }
    : { from: 0, to: start.durationMs });
  const [mode, setMode] = useState<Mode>(initialFraming === null ? "pitch" : initialFraming?.mode === "manual" ? "manual" : "ball");
  const [shape, setShape] = useState<FramerShape>(initialShape ?? "wide");
  // How close the camera is, 0 (the widest window that fills the frame) to 1
  // (twice as close): kept when the shape changes, the zoom follows.
  const [closeness, setCloseness] = useState(() => closenessOf(initialFraming?.zoom ?? 0.45, lockedAspect ?? (initialShape && initialShape !== "wide" ? 9 / 16 : WIDE)));
  const [keys, setKeys] = useState<Key[]>(() => (initialFraming?.keys ?? []).map((k) => [k[0] + (isRec ? start.fromMs : 0), k[1], k[2]]));
  const [ballKeys, setBallKeys] = useState<Key[] | null>(null);
  const [ballSource, setBallSource] = useState<"ball" | "clip" | "centre" | null>(null);
  const [branding, setBranding] = useState<SceneBranding>(initialBranding ?? DEFAULT_BRANDING);
  const [trail, setTrail] = useState(!!initialTrail);
  // The ball path through the loaded stretch, on the framer's own clock (seconds of "abs").
  const [ball, setBall] = useState<BallTrailSample[]>([]);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [nowAbs, setNowAbs] = useState(win.from);

  const videoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<{ x: number; y: number; down: boolean } | null>(null);
  const recBuf = useRef<Key[]>([]);
  const recLast = useRef(0);
  // Steering by hand while it plays (without Record): the path is kept while the finger is down.
  const steerBuf = useRef<Key[]>([]);
  const steering = useRef(false);
  const framed = mode !== "pitch";
  const outAspect = lockedAspect ?? boxAspectOf(shape, framed);
  const range = zoomRange(outAspect);
  const zoom = round3(range.max - closeness * (range.max - range.min));
  const live = useRef({ keys, zoom, mode, win, loaded, recording, outAspect, shape, trail, ball });
  live.current = { keys, zoom, mode, win, loaded, recording, outAspect, shape, trail, ball };

  // ── Footage ───────────────────────────────────────────────────────────────
  const url = useMemo(() => isRec
    ? videoUrlFor(academyId, { type: "recording", recordingId: start.recordingId, fromMs: Math.round(loaded.from), toMs: Math.round(loaded.to) })
    : videoUrlFor(academyId, { type: "clip", clipId: start.clipId }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [academyId, isRec, loaded.from, loaded.to]);
  const absAt = (v: HTMLVideoElement) => live.current.loaded.from + v.currentTime * 1000;
  const seekAbs = (ms: number) => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, (ms - live.current.loaded.from) / 1000); };

  useEffect(() => { setReady(false); setFailed(false); }, [url]);

  // The ball through the loaded stretch (or the clip): the camera's default.
  useEffect(() => {
    let cancelled = false;
    const src = isRec
      ? { type: "recording" as const, recordingId: start.recordingId, fromMs: Math.round(loaded.from), toMs: Math.round(loaded.to) }
      : { type: "clip" as const, clipId: start.clipId };
    fetchFraming(academyId, src).then((a) => {
      if (cancelled) return;
      const base = isRec ? loaded.from : 0;
      const abs = a.framing.keys.map((k) => [k[0] + base, k[1], k[2]] as Key);
      setBallKeys(abs);
      setBallSource(a.source);
      // Only on a recording: a fixed clip may play as its saved file, already framed.
      setBall(!isRec ? [] : (a.ball ?? []).map(([sec, x, y]) => [(sec * 1000 + base) / 1000, x, y] as BallTrailSample));
      if (!initialFraming) setCloseness(closenessOf(a.framing.zoom, WIDE));
      // Following the ball (or nothing chosen yet): take the new keys.
      if (live.current.mode === "ball" || !live.current.keys.length) setKeys(abs);
    }).catch(() => { if (!cancelled) setBallSource("centre"); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academyId, isRec, loaded.from, loaded.to]);

  // ── Drawing ───────────────────────────────────────────────────────────────
  const framingNow = useCallback((): Framing | null => {
    const s = live.current;
    if (s.mode === "pitch" || !s.keys.length) return null;
    return { zoom: s.zoom, keys: s.keys };
  }, []);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      const s = live.current;
      const abs = absAt(v);
      // Stay inside the clip: loop back to its start.
      if (!v.paused && abs >= s.win.to) {
        if (s.recording) stopRecording();
        seekAbs(s.win.from);
      }
      setNowAbs((prev) => (Math.abs(prev - abs) > 80 ? abs : prev));
      const srcAspect = v.videoWidth / v.videoHeight;
      // While a finger steers (recording, or dragging as it plays) the window sits under it at
      // once; the path becomes keys when the finger lifts or recording stops.
      const held = pointer.current?.down && !v.paused && (s.recording || steering.current) ? pointer.current : null;
      const f = held ? { zoom: s.zoom, keys: [[Math.round(abs), held.x, held.y]] as Key[] } : framingNow();
      const view = viewRef.current;
      if (view) {
        const ctx = view.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, view.width, view.height);
          // The footage's box in the frame (a band with bars), scaled to the canvas.
          let box = { x: 0, y: 0, w: view.width, h: view.height };
          if (!lockedAspect) {
            const out = shapeFormat(s.shape);
            const b = footageBox(s.shape, !!f, srcAspect);
            const k = view.width / out.w;
            box = { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
          } else if (!f) {
            const h = view.width / srcAspect;
            box = { x: 0, y: (view.height - h) / 2, w: view.width, h };
          }
          const w = f ? framingWindow(f, abs, srcAspect, s.outAspect) : { x: 0, y: 0, w: 1, h: 1 };
          if (f) {
            ctx.drawImage(v, w.x * v.videoWidth, w.y * v.videoHeight, w.w * v.videoWidth, w.h * v.videoHeight, box.x, box.y, box.w, box.h);
          } else {
            ctx.drawImage(v, box.x, box.y, box.w, box.h);
          }
          // The red ball trail, as the export draws it.
          const points = s.trail && s.ball.length ? ballTrailAt(s.ball, abs / 1000) : null;
          if (points) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(box.x, box.y, box.w, box.h);
            ctx.clip();
            drawBallTrail(ctx, points,
              (x, y) => [box.x + ((x - w.x) / w.w) * box.w, box.y + ((y - w.y) / w.h) * box.h],
              trailWidthFor(box.h / w.h));
            ctx.restore();
          }
        }
      }
      const strip = stripRef.current;
      if (strip) {
        const ctx = strip.getContext("2d");
        if (ctx) {
          ctx.drawImage(v, 0, 0, strip.width, strip.height);
          if (f) {
            const w = framingWindow(f, abs, srcAspect, s.outAspect);
            ctx.fillStyle = "rgba(11,15,26,0.55)";
            ctx.fillRect(0, 0, strip.width, strip.height);
            ctx.drawImage(v, w.x * v.videoWidth, w.y * v.videoHeight, w.w * v.videoWidth, w.h * v.videoHeight,
              w.x * strip.width, w.y * strip.height, w.w * strip.width, w.h * strip.height);
            ctx.strokeStyle = s.recording ? "#FF5A3C" : "#D4FF4F";
            ctx.lineWidth = 3;
            ctx.strokeRect(w.x * strip.width + 1.5, w.y * strip.height + 1.5, w.w * strip.width - 3, w.h * strip.height - 3);
          }
        }
      }
      if (steering.current && held && performance.now() - recLast.current >= RECORD_EVERY_MS) {
        recLast.current = performance.now();
        steerBuf.current.push([Math.round(abs), held.x, held.y]);
      }
      // Re-recording: the camera goes where the pointer is held.
      if (s.recording && !v.paused && performance.now() - recLast.current >= RECORD_EVERY_MS) {
        recLast.current = performance.now();
        const p = pointer.current;
        const cur = f ? currentCentre(f, abs) : [0.5, 0.52];
        recBuf.current.push([Math.round(abs), p?.down ? p.x : cur[0], p?.down ? p.y : cur[1]]);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framingNow]);

  // ── Controls ──────────────────────────────────────────────────────────────
  const play = () => {
    const v = videoRef.current;
    if (!v) return;
    const abs = absAt(v);
    if (abs < win.from || abs >= win.to - 100) seekAbs(win.from);
    v.muted = muted;
    void v.play().then(() => setPlaying(true)).catch(() => { v.muted = true; setMuted(true); void v.play().then(() => setPlaying(true)); });
  };
  const pause = () => { videoRef.current?.pause(); setPlaying(false); };
  const nudge = (d: number) => {
    const v = videoRef.current;
    if (!v) return;
    seekAbs(Math.min(win.to - 50, Math.max(win.from, absAt(v) + d)));
  };

  const setKeyAt = (abs: number, x: number, y: number) => {
    setKeys((ks) => [...ks.filter((k) => Math.abs(k[0] - abs) > 250), [Math.round(abs), x, y] as Key].sort((a, b) => a[0] - b[0]));
    setMode("manual");
  };

  const startRecording = () => {
    if (!ready) return;
    recBuf.current = [];
    recLast.current = 0;
    if (mode === "pitch") setMode("manual");
    seekAbs(win.from);
    setRecording(true);
    play();
  };
  function stopRecording() {
    const buf = recBuf.current;
    recBuf.current = [];
    setRecording(false);
    pause();
    if (buf.length < 2) return;
    const a = buf[0][0], b = buf[buf.length - 1][0];
    setKeys((ks) => [...ks.filter((k) => k[0] < a || k[0] > b), ...smooth(buf)].sort((x, y) => x[0] - y[0]));
    setMode("manual");
  }

  const toPitch = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toPitch(e);
    pointer.current = { ...p, down: true };
    const v = videoRef.current;
    if (recording || !v) return;
    if (v.paused) { setKeyAt(absAt(v), p.x, p.y); return; }
    // Playing: steer by hand from here until the finger lifts.
    steering.current = true;
    recLast.current = 0;
    steerBuf.current = [[Math.round(absAt(v)), p.x, p.y]];
    setMode("manual");
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointer.current?.down) return;
    const p = toPitch(e);
    pointer.current = { ...p, down: true };
    if (!recording && videoRef.current && videoRef.current.paused) setKeyAt(absAt(videoRef.current), p.x, p.y);
  };
  const onUp = () => {
    if (pointer.current) pointer.current.down = false;
    if (!steering.current) return;
    steering.current = false;
    const buf = steerBuf.current;
    steerBuf.current = [];
    if (buf.length === 1) { setKeyAt(buf[0][0], buf[0][1], buf[0][2]); return; }
    if (buf.length < 2) return;
    const a = buf[0][0], b = buf[buf.length - 1][0];
    setKeys((ks) => [...ks.filter((k) => k[0] < a || k[0] > b), ...smooth(buf)].sort((x, y) => x[0] - y[0]));
    setMode("manual");
  };

  const followBall = () => {
    setMode("ball");
    if (ballKeys?.length) setKeys(ballKeys);
  };

  // Moving the start or the end: a new cut is fetched when it leaves the loaded stretch.
  const moveEdge = (edge: "from" | "to", d: number) => {
    setWin((w) => {
      let from = w.from, to = w.to;
      if (edge === "from") from = Math.max(0, Math.min(to - MIN_MS, from + d));
      else to = Math.max(from + MIN_MS, to + d);
      if (to - from > MAX_VIDEO_MS) return w;
      if (from < loaded.from || to > loaded.to) setLoaded({ from: Math.max(0, from - MARGIN_MS), to: to + MARGIN_MS });
      return { from, to };
    });
  };
  const len = win.to - win.from;

  // ── What goes out ─────────────────────────────────────────────────────────
  const value: FramedClip = useMemo(() => {
    const base = isRec ? win.from : 0;
    let framing: Framing | null = null;
    if (mode !== "pitch" && keys.length) {
      const inside = keys.filter((k) => k[0] >= win.from - 1000 && k[0] <= win.to + 1000);
      const ks = (inside.length ? inside : [[win.from, ...currentCentre({ zoom, keys }, win.from)] as Key])
        .map((k) => [Math.max(0, Math.round(k[0] - base)), round3(k[1]), round3(k[2])] as Key);
      framing = { zoom: round3(zoom), keys: thin(ks, 600), mode: mode === "ball" ? "ball" : "manual" };
    }
    const src = isRec
      ? { type: "recording" as const, recordingId: start.recordingId, fromMs: Math.round(win.from), toMs: Math.round(win.to) }
      : { type: "clip" as const, clipId: start.clipId };
    return { src, durationMs: len, framing, branding, shape, ...(trail && ball.length ? { ballTrail: true } : {}) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRec, win.from, win.to, mode, keys, zoom, branding, len, shape, trail, ball.length]);

  // The preview's own shape: the video's frame, or the editor layer's box.
  const viewAspect = lockedAspect ?? (shape === "wide" ? WIDE : 9 / 16);
  const viewTall = viewAspect < 1;
  const viewW = viewTall ? Math.round(720 * viewAspect) : 960;
  const viewH = viewTall ? 720 : Math.round(960 / viewAspect);
  const pickShape = (next: FramerShape) => {
    setShape(next);
    // Vertical and full-screen leaves no room for the whole pitch: follow the ball.
    if (next === "tall" && mode === "pitch") followBall();
  };

  const pct = (ms: number) => `${((ms - loaded.from) / Math.max(1, loaded.to - loaded.from)) * 100}%`;

  return (
    <div className="flex flex-col gap-3" data-testid="clip-framer">
      <video ref={videoRef} src={url ?? undefined} className="hidden" playsInline preload="auto" muted={muted} crossOrigin="anonymous"
        onLoadedData={() => { setReady(true); seekAbs(win.from); }}
        onError={() => setFailed(true)}
        onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />

      <div className={cn("relative mx-auto overflow-hidden rounded-xl bg-black", viewTall ? "h-[min(62dvh,560px)]" : "w-full")}
        style={{ aspectRatio: `${viewW} / ${viewH}` }}>
        <canvas ref={viewRef} width={viewW} height={viewH} className="h-full w-full" data-testid="framer-view" />
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/70">
            {failed ? (
              <button type="button" onClick={() => { setFailed(false); setLoaded((l) => ({ ...l })); }} className="rounded-full border border-white/30 px-4 py-2">{copy.retry}</button>
            ) : <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{copy.loading}</span>}
          </div>
        )}
        {recording && <span className="absolute start-2 top-2 flex items-center gap-1 rounded-md bg-[#FF5A3C] px-2 py-0.5 text-[11px] font-bold text-white"><Circle className="h-2.5 w-2.5 fill-current" aria-hidden />REC</span>}
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => nudge(-5000)} aria-label={copy.back5} className="grid h-10 w-10 place-items-center rounded-full border border-line text-text"><Rewind className="h-4 w-4" /></button>
        <button type="button" onClick={playing ? pause : play} disabled={!ready} aria-label={playing ? copy.pause : copy.play} data-testid="framer-play"
          className="grid h-11 w-11 place-items-center rounded-full bg-floodlight text-void disabled:opacity-50">{playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}</button>
        <button type="button" onClick={() => nudge(5000)} aria-label={copy.forward5} className="grid h-10 w-10 place-items-center rounded-full border border-line text-text"><FastForward className="h-4 w-4" /></button>
        <span className="ms-1 font-mono text-xs text-muted-text" dir="ltr">{clock(nowAbs - win.from)} / {clock(len)}</span>
        <button type="button" onClick={() => { setMuted((m) => !m); if (videoRef.current) videoRef.current.muted = !muted; }} aria-label={copy.sound}
          className="ms-auto grid h-10 w-10 place-items-center rounded-full border border-line text-muted-text">{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button>
      </div>

      {/* The whole pitch, with the camera on it. Drag to move it. */}
      <div>
        <canvas ref={stripRef} width={960} height={270} data-testid="framer-pitch"
          className={cn("w-full touch-none rounded-lg bg-black", recording ? "cursor-grabbing ring-2 ring-[#FF5A3C]" : "cursor-crosshair")}
          style={{ aspectRatio: "32 / 9" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        <p className="mt-1 text-[11px] text-muted-text">{recording ? copy.recordingHint : copy.dragHint}</p>
      </div>

      {/* The clip inside what's loaded; the playhead. */}
      <div className="relative h-2 rounded-full bg-raised" aria-hidden>
        <span className="absolute inset-y-0 rounded-full bg-turf/60" style={{ left: pct(win.from), width: `calc(${pct(win.to)} - ${pct(win.from)})` }} />
        <span className="absolute -top-1 h-4 w-0.5 bg-floodlight" style={{ left: pct(nowAbs) }} />
      </div>

      {!lockedAspect && (
        <section className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-text">{copy.shape}</p>
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={copy.shape}>
            {FRAMER_SHAPES.map((sh) => (
              <button key={sh} type="button" role="radio" aria-checked={shape === sh} onClick={() => pickShape(sh)} data-testid={`framer-shape-${sh}`}
                className={cn("flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-semibold",
                  shape === sh ? "border-floodlight bg-floodlight/10 text-text" : "border-line text-muted-text hover:text-text")}>
                <ShapeIcon shape={sh} active={shape === sh} />
                <span dir="auto">{sh === "wide" ? copy.shapeWide : sh === "tall" ? copy.shapeTall : copy.shapeBars}</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-text">{shape === "wide" ? copy.shapeWideHint : shape === "tall" ? copy.shapeTallHint : copy.shapeBarsHint}</p>
        </section>
      )}

      <section className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-text">{copy.camera}</p>
        <div className="flex flex-wrap gap-1.5">
          <Pill active={mode === "ball"} onClick={followBall} testId="framer-follow-ball"><Crosshair className="h-3.5 w-3.5" />{copy.followBall}</Pill>
          <Pill active={mode === "manual"} onClick={() => setMode("manual")} testId="framer-manual">{copy.byHand}</Pill>
          {(lockedAspect || shape !== "tall") && (
            <Pill active={mode === "pitch"} onClick={() => setMode("pitch")} testId="framer-pitch-mode"><Maximize2 className="h-3.5 w-3.5" />{copy.wholePitch}</Pill>
          )}
          {recording
            ? <Pill active onClick={stopRecording} testId="framer-stop"><Square className="h-3.5 w-3.5" />{copy.stopRecording}</Pill>
            : <Pill active={false} onClick={startRecording} disabled={!ready} testId="framer-rerecord"><Circle className="h-3.5 w-3.5 text-[#FF5A3C]" />{copy.rerecord}</Pill>}
        </div>
        {ballSource && ballSource !== "ball" && mode === "ball" && <p className="text-[11px] text-muted-text">{copy.noBall}</p>}
        {ball.length > 0 && (
          <label className="flex items-center justify-between gap-3 py-1 text-sm text-text">
            <span>
              <span className="block">{copy.ballTrail}</span>
              <span className="block text-[11px] text-muted-text">{copy.ballTrailHint}</span>
            </span>
            <Switch checked={trail} onCheckedChange={setTrail} data-testid="framer-ball-trail" />
          </label>
        )}
        {mode !== "pitch" && (
          <label className="flex items-center gap-3 text-xs text-muted-text">
            <span className="w-14 shrink-0 font-semibold">{copy.zoom}</span>
            <span>{copy.wider}</span>
            {/* Right is closer: a smaller share of the pitch. */}
            <input type="range" min={0} max={100} value={Math.round(closeness * 100)} aria-label={copy.zoom}
              onChange={(e) => setCloseness(Number(e.target.value) / 100)} className="flex-1 accent-[#D4FF4F]" data-testid="framer-zoom" />
            <span>{copy.closer}</span>
          </label>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-text">{copy.length} · <span className="normal-case tracking-normal">{copy.seconds(Math.round(len / 1000))}</span></p>
        {isRec ? (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl border border-line p-2">
              <p className="mb-1.5 font-semibold text-text">{copy.start} <span className="font-mono text-muted-text" dir="ltr">{clock(win.from)}</span></p>
              <div className="flex gap-1.5">
                <SmallButton onClick={() => moveEdge("from", -STEP_MS)} testId="framer-start-earlier">{copy.earlier}</SmallButton>
                <SmallButton onClick={() => moveEdge("from", STEP_MS)} disabled={len - STEP_MS < MIN_MS} testId="framer-start-later">{copy.later}</SmallButton>
              </div>
            </div>
            <div className="rounded-xl border border-line p-2">
              <p className="mb-1.5 font-semibold text-text">{copy.end} <span className="font-mono text-muted-text" dir="ltr">{clock(win.to)}</span></p>
              <div className="flex gap-1.5">
                <SmallButton onClick={() => moveEdge("to", -STEP_MS)} disabled={len - STEP_MS < MIN_MS} testId="framer-end-earlier">{copy.earlier}</SmallButton>
                <SmallButton onClick={() => moveEdge("to", STEP_MS)} disabled={len + STEP_MS > MAX_VIDEO_MS} testId="framer-end-later">{copy.later}</SmallButton>
              </div>
            </div>
          </div>
        ) : <p className="text-[11px] text-muted-text">{copy.fixedLength}</p>}
      </section>

      <section className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-text">{copy.branding}</p>
        <label className="flex items-center justify-between gap-3 py-1 text-sm text-text">
          {copy.logo}<Switch checked={branding.overlay} onCheckedChange={(v) => setBranding((b) => ({ ...b, overlay: v }))} data-testid="framer-logo" />
        </label>
        <label className="flex items-center justify-between gap-3 py-1 text-sm text-text">
          {copy.endCard}<Switch checked={branding.endCard} onCheckedChange={(v) => setBranding((b) => ({ ...b, endCard: v }))} data-testid="framer-end-card" />
        </label>
      </section>

      <div className="pt-1">{actions(value)}</div>
    </div>
  );
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A zoom (window width share) as closeness 0–1 within the box's range. */
function closenessOf(zoom: number, boxAspect: number): number {
  const r = zoomRange(boxAspect);
  return Math.min(1, Math.max(0, (r.max - zoom) / (r.max - r.min)));
}

/** A small picture of the shape: the frame, and the footage in it. */
function ShapeIcon({ shape, active }: { shape: FramerShape; active: boolean }) {
  const stroke = active ? "#D4FF4F" : "currentColor";
  return shape === "wide" ? (
    <svg width="32" height="20" viewBox="0 0 32 20" aria-hidden><rect x="1" y="1" width="30" height="18" rx="2.5" fill={stroke} fillOpacity="0.25" stroke={stroke} strokeWidth="1.5" /></svg>
  ) : shape === "tall" ? (
    <svg width="14" height="24" viewBox="0 0 14 24" aria-hidden><rect x="1" y="1" width="12" height="22" rx="2" fill={stroke} fillOpacity="0.25" stroke={stroke} strokeWidth="1.5" /></svg>
  ) : (
    <svg width="14" height="24" viewBox="0 0 14 24" aria-hidden>
      <rect x="1" y="1" width="12" height="22" rx="2" fill="#000" stroke={stroke} strokeWidth="1.5" />
      <rect x="1.75" y="8.5" width="10.5" height="7" fill={stroke} fillOpacity="0.45" />
    </svg>
  );
}

function currentCentre(f: Pick<Framing, "zoom" | "keys">, abs: number): [number, number] {
  const ks = f.keys;
  if (!ks.length) return [0.5, 0.52];
  if (abs <= ks[0][0]) return [ks[0][1], ks[0][2]];
  const last = ks[ks.length - 1];
  if (abs >= last[0]) return [last[1], last[2]];
  for (let i = 1; i < ks.length; i++) {
    if (ks[i][0] >= abs) {
      const a = ks[i - 1], b = ks[i];
      const t = b[0] > a[0] ? (abs - a[0]) / (b[0] - a[0]) : 0;
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return [last[1], last[2]];
}

/** A recorded camera path, eased so a shaky hand doesn't shake the video. */
function smooth(buf: Key[]): Key[] {
  const ease = (xs: number[], a: number) => {
    const f = [...xs];
    for (let i = 1; i < f.length; i++) f[i] = f[i - 1] + a * (f[i] - f[i - 1]);
    for (let i = f.length - 2; i >= 0; i--) f[i] = f[i + 1] + a * (f[i] - f[i + 1]);
    return f;
  };
  const xs = ease(buf.map((k) => k[1]), 0.45);
  const ys = ease(buf.map((k) => k[2]), 0.3);
  return buf.map((k, i) => [k[0], round3(xs[i]), round3(ys[i])] as Key);
}

function Pill({ active, onClick, children, testId, disabled }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} disabled={disabled} data-testid={testId}
      className={cn("flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors disabled:opacity-50",
        active ? "border-floodlight bg-floodlight text-void" : "border-line text-muted-text hover:text-text")}>
      {children}
    </button>
  );
}

function SmallButton({ onClick, children, disabled, testId }: { onClick: () => void; children: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-testid={testId}
      className="min-h-9 flex-1 rounded-lg border border-line bg-raised px-2 text-xs font-semibold text-text disabled:opacity-40">{children}</button>
  );
}
