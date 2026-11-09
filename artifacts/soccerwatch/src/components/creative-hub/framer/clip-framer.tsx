import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Circle, Crosshair, Loader2, Maximize2, Pause, Play, Rewind, FastForward, Square, Volume2, VolumeX } from "lucide-react";
import Hls from "hls.js";
import { ballTrailAt, drawBallTrail, framingWindow, trailWidthFor, type BallTrailSample, type Framing, type SceneBranding } from "@workspace/api-zod";
import { useCreativeFramerCopy } from "@/i18n/creative-framer-strings";
import { videoUrlFor } from "../library/media";
import {
  creativePlaybackSourcesUrl,
  creativePlaybackTelemetryUrl,
  withCreativePlaybackWindow,
  type CreativePlaybackSource,
} from "@/lib/creative-hub-media";
import {
  framerPlaybackEngine,
  framerSourceKey,
  initialSeekAction,
  type FramerPlaybackEngine,
  type FramerPlaybackSourceType,
} from "./playback";
import {
  DEFAULT_BRANDING, FRAMER_SHAPES, MAX_VIDEO_MS, absPlaybackTimeMs, boxAspectOf, fetchFraming, footageBox,
  playbackSecondsAt, shapeFormat, thin, zoomRange,
  type FramedClip, type FramerShape,
} from "@/lib/creative-framing";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { canDecodeUhd } from "@/lib/uhdPlayback";

/**
 * The clip framer: a 16:9 camera on the panorama, following the ball unless
 * the owner moves it, with the clip's start and end movable 5 s at a time and
 * the venue's branding switchable. One <video> plays a clip or streams the
 * recording directly at its absolute timeline position; two canvases draw from it — the framed
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
type PlaybackTelemetryEvent =
  | "opened" | "capability" | "source-load" | "source-clear" | "window-offset" | "loadstart"
  | "seek" | "seeking" | "seeked" | "loadedmetadata" | "playing" | "waiting" | "stalled"
  | "error" | "hls-error" | "sample";
type PlaybackTelemetryDetail = {
  fromMs?: number;
  toMs?: number;
  offsetMs?: number;
  targetSec?: number;
  currentTime?: number;
  duration?: number;
  readyState?: number;
  networkState?: number;
  paused?: boolean;
  seeking?: boolean;
  buffered?: Array<[number, number]>;
  loadOrdinal?: number;
  reason?: "window-start" | "window-loop" | "play-from-start" | "nudge" | "record-start" | "clip-start";
  errorType?: string;
  errorDetail?: string;
  fatal?: boolean;
  responseCode?: number;
};

function newPlaybackSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function parsePlaybackSources(value: unknown): CreativePlaybackSource[] {
  if (!value || typeof value !== "object" || !("sources" in value) || !Array.isArray(value.sources)) return [];
  return value.sources.flatMap((item): CreativePlaybackSource[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    if (
      (source.kind !== "camera-4k" && source.kind !== "stream")
      || typeof source.url !== "string"
      || !source.url.startsWith("/api/hls-proxy/")
    ) return [];
    return [{
      kind: source.kind,
      url: source.url,
      ...(typeof source.fullUrl === "string" && source.fullUrl.startsWith("/api/hls-proxy/uhd/")
        ? { fullUrl: source.fullUrl }
        : {}),
    }];
  });
}

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
  const [playbackSources, setPlaybackSources] = useState<CreativePlaybackSource[]>([]);
  const [playbackSourceIndex, setPlaybackSourceIndex] = useState(0);
  const [sourceChoiceReady, setSourceChoiceReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [recording, setRecording] = useState(false);
  const [nowAbs, setNowAbs] = useState(win.from);

  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hlsMediaAttachedRef = useRef(false);
  const loadedSourceKeyRef = useRef<string | null>(null);
  const initialPlaySourceKeyRef = useRef<string | null>(null);
  const pendingSourceRef = useRef<{
    source: CreativePlaybackSource;
    url: string;
    engine: FramerPlaybackEngine;
    sourceType: FramerPlaybackSourceType;
    key: string;
  } | null>(null);
  const playbackOffsetMs = useRef(0);
  const activeSourceKeyRef = useRef<string | null>(null);
  const initialSeekSourceKeyRef = useRef<string | null>(null);
  const sourceLoadOrdinalRef = useRef(0);
  const mediaEngineRef = useRef<FramerPlaybackEngine | "unknown">("unknown");
  const sourceTypeRef = useRef<FramerPlaybackSourceType | "none">("none");
  const telemetrySessionRef = useRef<string | null>(null);
  const openedAtRef = useRef(Date.now());
  const openedTelemetrySentRef = useRef(false);
  if (!telemetrySessionRef.current) telemetrySessionRef.current = newPlaybackSessionId();
  const playbackSourcesRef = useRef(playbackSources);
  playbackSourcesRef.current = playbackSources;
  const playbackSourceIndexRef = useRef(playbackSourceIndex);
  playbackSourceIndexRef.current = playbackSourceIndex;
  const uhdCapabilityRef = useRef<boolean | null>(null);
  const failureHandledRef = useRef(false);
  const failSourceRef = useRef<() => void>(() => {});
  const viewRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<{ x: number; y: number; down: boolean } | null>(null);
  const recBuf = useRef<Key[]>([]);
  const recLast = useRef(0);
  // Steering by hand while it plays (without Record): the path is kept while the finger is down.
  const steerBuf = useRef<Key[]>([]);
  const steering = useRef(false);
  const loopSeekPendingRef = useRef(false);
  const framed = mode !== "pitch";
  const outAspect = lockedAspect ?? boxAspectOf(shape, framed);
  const range = zoomRange(outAspect);
  const zoom = round3(range.max - closeness * (range.max - range.min));
  const live = useRef({ keys, zoom, mode, win, loaded, recording, outAspect, shape, trail, ball });
  live.current = { keys, zoom, mode, win, loaded, recording, outAspect, shape, trail, ball };
  const emitPlaybackTelemetry = useCallback((event: PlaybackTelemetryEvent, detail?: PlaybackTelemetryDetail) => {
    if (!isRec) return;
    const payload = {
      sessionId: telemetrySessionRef.current!,
      event,
      elapsedMs: Math.max(0, Date.now() - openedAtRef.current),
      engine: mediaEngineRef.current,
      sourceType: sourceTypeRef.current,
      hevcSupported: uhdCapabilityRef.current,
      ...(detail ? { detail } : {}),
    };
    void fetch(creativePlaybackTelemetryUrl(academyId), {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => { /* diagnostics must never interrupt playback */ });
  }, [academyId, isRec]);
  const mediaStateDetail = useCallback((): PlaybackTelemetryDetail => {
    const video = videoRef.current;
    if (!video) return {};
    const buffered: Array<[number, number]> = [];
    for (let i = 0; i < Math.min(video.buffered.length, 8); i++) {
      buffered.push([video.buffered.start(i), video.buffered.end(i)]);
    }
    return {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      seeking: video.seeking,
      buffered,
    };
  }, []);

  useEffect(() => {
    if (!isRec || openedTelemetrySentRef.current) return;
    openedTelemetrySentRef.current = true;
    emitPlaybackTelemetry("opened", { fromMs: win.from, toMs: win.to });
  }, [emitPlaybackTelemetry, isRec, win.from, win.to]);

  // ── Footage ───────────────────────────────────────────────────────────────
  const sourcesUrl = start.type === "recording" ? creativePlaybackSourcesUrl(academyId, start) : null;
  const clipId = start.type === "clip" ? start.clipId : null;
  const url = useMemo(
    () => clipId === null ? null : videoUrlFor(academyId, { type: "clip", clipId }),
    [academyId, clipId],
  );
  const absAt = (v: HTMLVideoElement) => absPlaybackTimeMs(v.currentTime, isRec ? playbackOffsetMs.current : live.current.loaded.from);
  const seekAbs = (ms: number, reason: NonNullable<PlaybackTelemetryDetail["reason"]>) => {
    const v = videoRef.current;
    if (!v) return;
    const targetSec = playbackSecondsAt(ms, isRec ? playbackOffsetMs.current : live.current.loaded.from);
    emitPlaybackTelemetry("seek", { targetSec, reason, ...mediaStateDetail() });
    v.currentTime = targetSec;
  };

  // Ask the owner-scoped endpoint for HLS URLs only. Recording moments receive
  // a bounded 4K playlist window, not a second cut or download.
  useEffect(() => {
    if (!isRec) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    setReady(false);
    setFailed(false);
    setSourceChoiceReady(false);
    setPlaying(false);
    videoRef.current?.pause();
    hlsRef.current?.stopLoad();
    if (!sourcesUrl) {
      window.clearTimeout(timeout);
      setFailed(true);
      return () => { cancelled = true; controller.abort(); };
    }
    void fetch(sourcesUrl, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load recording sources");
        return parsePlaybackSources(await response.json());
      })
      .then((sources) => {
        if (cancelled) return;
        if (!sources.length) throw new Error("No playable recording sources");
        setPlaybackSources(sources.map((source) => source.kind === "camera-4k"
          ? { ...source, url: withCreativePlaybackWindow(source.url, live.current.win.from, live.current.win.to) }
          : source));
      })
      .catch(() => {
        if (!cancelled) {
          setReady(false);
          setFailed(true);
        }
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [isRec, sourcesUrl, loadAttempt]);

  // Keep the 4K source URL aligned with clip-edge changes without another
  // owner-scoped source-list request. Stream playback uses the full recording.
  useEffect(() => {
    if (!isRec || playbackSources[playbackSourceIndex]?.kind !== "camera-4k") return;
    const source = playbackSources[playbackSourceIndex]!;
    const url = withCreativePlaybackWindow(source.url, Math.round(win.from), Math.round(win.to));
    if (url === source.url) return;
    hlsRef.current?.stopLoad();
    videoRef.current?.pause();
    setPlaying(false);
    setReady(false);
    setSourceChoiceReady(false);
    setPlaybackSources((current) => current.map((item, index) =>
      index === playbackSourceIndex ? { ...item, url } : item));
  }, [isRec, playbackSources, playbackSourceIndex, win.from, win.to]);

  // HEVC must pass MediaCapabilities before it is even requested. A browser
  // without smooth 4096×1152 support starts on the Stream rendition.
  useEffect(() => {
    if (!isRec || !playbackSources.length) return;
    let cancelled = false;
    setSourceChoiceReady(false);
    const video = videoRef.current;
    void (async () => {
      let supportsUhd = false;
      if (playbackSources.some((source) => source.kind === "camera-4k")) {
        if (uhdCapabilityRef.current === null) {
          uhdCapabilityRef.current = video ? await canDecodeUhd(video) : false;
        }
        supportsUhd = uhdCapabilityRef.current;
      }
      if (cancelled) return;
      mediaEngineRef.current = framerPlaybackEngine(
        Hls.isSupported(),
        typeof window !== "undefined" && "ManagedMediaSource" in window,
      );
      if (playbackSources.some((source) => source.kind === "camera-4k")) {
        emitPlaybackTelemetry("capability");
      }
      const preferredKind = supportsUhd ? "camera-4k" : "stream";
      let index = playbackSources.findIndex((source) => source.kind === preferredKind);
      if (index < 0 && supportsUhd) {
        index = playbackSources.findIndex((source) => source.kind === "stream");
      }
      if (index < 0 && !supportsUhd) {
        setFailed(true);
        return;
      }
      setPlaybackSourceIndex(index);
      setSourceChoiceReady(true);
    })();
    return () => { cancelled = true; };
  }, [emitPlaybackTelemetry, isRec, playbackSources]);

  // Keep one HLS instance for the lifetime of this open framer. Fatal errors
  // may switch its source to Stream, but playhead, drag, trail, and resize
  // updates never tear it down.
  useEffect(() => {
    if (!isRec) return;
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    const failSource = () => {
      if (disposed || failureHandledRef.current) return;
      failureHandledRef.current = true;
      video.pause();
      setPlaying(false);
      setReady(false);
      const currentIndex = playbackSourceIndexRef.current;
      const current = playbackSourcesRef.current[currentIndex];
      const nextStream = current?.kind === "camera-4k"
        ? playbackSourcesRef.current.findIndex((item, index) => index > currentIndex && item.kind === "stream")
        : -1;
      if (nextStream >= 0) {
        setFailed(false);
        setPlaybackSourceIndex(nextStream);
      } else {
        setFailed(true);
      }
    };
    const seekToWindow = (): boolean => {
      if (!isRec) {
        seekAbs(live.current.win.from, "clip-start");
        return true;
      }
      const sourceKey = activeSourceKeyRef.current;
      const duration = video.duration;
      const target = Math.min(
        Math.max(0, playbackSecondsAt(live.current.win.from, playbackOffsetMs.current)),
        Math.max(0, duration - 0.1),
      );
      const action = initialSeekAction({
        sourceKey,
        completedSourceKey: initialSeekSourceKeyRef.current,
        duration,
        target,
        currentTime: video.currentTime,
        seeking: video.seeking,
      });
      if (action === "wait") return false;
      try {
        if (action === "seek") {
          emitPlaybackTelemetry("seek", {
            targetSec: target,
            reason: "window-start",
            offsetMs: playbackOffsetMs.current,
            ...mediaStateDetail(),
          });
          video.currentTime = target;
          initialSeekSourceKeyRef.current = sourceKey;
          return false;
        }
        initialSeekSourceKeyRef.current = sourceKey;
        return !video.seeking;
      } catch {
        return false;
      }
    };
    const onLoadedData = () => {
      if (disposed || !seekToWindow() || video.readyState < 2) return;
      setFailed(false);
      setReady(true);
      const sourceKey = activeSourceKeyRef.current;
      if (sourceKey && initialPlaySourceKeyRef.current !== sourceKey) {
        initialPlaySourceKeyRef.current = sourceKey;
        void video.play().catch(() => undefined);
      }
    };
    const onMetadata = () => { if (!disposed) seekToWindow(); };
    const onVideoError = () => {
      emitPlaybackTelemetry("error", {
        errorType: String(video.error?.code ?? "media").slice(0, 60),
        errorDetail: String(video.error?.message ?? "video element error").slice(0, 100),
        ...mediaStateDetail(),
      });
      failSource();
    };
    const onLoadStart = () => emitPlaybackTelemetry("loadstart", mediaStateDetail());
    const onSeeking = () => emitPlaybackTelemetry("seeking", mediaStateDetail());
    const onSeeked = () => emitPlaybackTelemetry("seeked", mediaStateDetail());
    const onLoopSeeked = () => {
      if (absAt(video) < live.current.win.to) loopSeekPendingRef.current = false;
    };
    const onLoadedMetadata = () => emitPlaybackTelemetry("loadedmetadata", mediaStateDetail());
    const onPlaying = () => emitPlaybackTelemetry("playing", mediaStateDetail());
    const onWaiting = () => emitPlaybackTelemetry("waiting", mediaStateDetail());
    const onStalled = () => emitPlaybackTelemetry("stalled", mediaStateDetail());
    const sampleTimer = window.setInterval(() => {
      emitPlaybackTelemetry("sample", mediaStateDetail());
    }, 4_000);

    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("durationchange", onMetadata);
    video.addEventListener("seeked", onLoadedData);
    video.addEventListener("error", onVideoError);
    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("seeked", onLoopSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    failSourceRef.current = failSource;
    video.crossOrigin = "anonymous";
    video.muted = mutedRef.current;
    setReady(false);
    setFailed(false);
    loadedSourceKeyRef.current = null;
    activeSourceKeyRef.current = null;
    initialSeekSourceKeyRef.current = null;
    initialPlaySourceKeyRef.current = null;
    video.removeAttribute("src");
    hlsMediaAttachedRef.current = false;
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        autoStartLoad: false,
        maxBufferLength: 30,
        backBufferLength: 120,
        startPosition: -1,
        xhrSetup: (xhr, requestUrl) => {
          if (!requestUrl.includes("/api/hls-proxy/uhd/")) return;
          xhr.addEventListener("load", () => {
            const offset = xhr.getResponseHeader("X-Replay-Window-Start-Ms");
            if (offset && /^\d+$/.test(offset)) {
              playbackOffsetMs.current = Number(offset);
              emitPlaybackTelemetry("window-offset", { offsetMs: playbackOffsetMs.current });
            }
          }, { once: true });
        },
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (disposed) return;
        hlsMediaAttachedRef.current = true;
        const pending = pendingSourceRef.current;
        if (pending) {
          pendingSourceRef.current = null;
          if (activeSourceKeyRef.current === pending.key && loadedSourceKeyRef.current !== pending.key) {
            loadedSourceKeyRef.current = pending.key;
            hls.loadSource(pending.url);
            emitPlaybackTelemetry("source-load", {
              loadOrdinal: ++sourceLoadOrdinalRef.current,
              fromMs: live.current.win.from,
              toMs: live.current.win.to,
            });
          }
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (disposed) return;
        hls.startLoad(playbackSecondsAt(live.current.win.from, playbackOffsetMs.current));
        seekToWindow();
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (!disposed && video.readyState >= 2) onLoadedData();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const responseCode = data.response?.code;
        emitPlaybackTelemetry("hls-error", {
          errorType: String(data.type ?? "unknown").slice(0, 60),
          errorDetail: String(data.details ?? "unknown").slice(0, 100),
          fatal: Boolean(data.fatal),
          responseCode: Number.isInteger(responseCode) ? responseCode : undefined,
          ...mediaStateDetail(),
        });
        if (data.fatal) failSource();
      });
      hls.attachMedia(video);
    } else {
      hlsRef.current = null;
    }

    return () => {
      disposed = true;
      window.clearInterval(sampleTimer);
      if (failSourceRef.current === failSource) failSourceRef.current = () => {};
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("durationchange", onMetadata);
      video.removeEventListener("seeked", onLoadedData);
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("loadstart", onLoadStart);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("seeked", onLoopSeeked);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      pendingSourceRef.current = null;
      hlsMediaAttachedRef.current = false;
      video.pause();
      if (loadedSourceKeyRef.current) {
        emitPlaybackTelemetry("source-clear", mediaStateDetail());
      }
      loadedSourceKeyRef.current = null;
      activeSourceKeyRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [emitPlaybackTelemetry, isRec, loadAttempt, mediaStateDetail]);

  // Load a new source into the existing HLS instance.
  useEffect(() => {
    if (!isRec || !sourceChoiceReady) return;
    const source = playbackSources[playbackSourceIndex];
    const video = videoRef.current;
    if (!source || !video) return;

    const engine = mediaEngineRef.current === "unknown"
      ? framerPlaybackEngine(Hls.isSupported(), typeof window !== "undefined" && "ManagedMediaSource" in window)
      : mediaEngineRef.current;
    const useHls = Hls.isSupported();
    const url = !useHls && source.kind === "camera-4k"
      ? source.fullUrl ?? source.url
      : source.url;
    const sourceType: FramerPlaybackSourceType = source.kind;
    const sourceKey = framerSourceKey(engine, sourceType, url);
    if (activeSourceKeyRef.current === sourceKey) return;
    activeSourceKeyRef.current = sourceKey;
    initialSeekSourceKeyRef.current = null;
    initialPlaySourceKeyRef.current = null;
    sourceTypeRef.current = sourceType;
    mediaEngineRef.current = engine;
    pendingSourceRef.current = { source, url, engine, sourceType, key: sourceKey };
    playbackOffsetMs.current = 0;
    failureHandledRef.current = false;
    video.pause();
    setPlaying(false);
    setReady(false);
    setFailed(false);

    if (useHls) {
      const hls = hlsRef.current;
      if (!hls) {
        failSourceRef.current();
        return;
      }
      if (hlsMediaAttachedRef.current) {
        pendingSourceRef.current = null;
        if (loadedSourceKeyRef.current !== sourceKey) {
          loadedSourceKeyRef.current = sourceKey;
          hls.stopLoad();
          hls.loadSource(url);
          emitPlaybackTelemetry("source-load", {
            loadOrdinal: ++sourceLoadOrdinalRef.current,
            fromMs: live.current.win.from,
            toMs: live.current.win.to,
          });
        }
      }
      return;
    }
    if (!video.canPlayType("application/vnd.apple.mpegurl")) {
      failSourceRef.current();
      return;
    }
    pendingSourceRef.current = null;
    loadedSourceKeyRef.current = sourceKey;
    video.src = url;
    video.load();
    emitPlaybackTelemetry("source-load", {
      loadOrdinal: ++sourceLoadOrdinalRef.current,
      fromMs: live.current.win.from,
      toMs: live.current.win.to,
    });
  }, [emitPlaybackTelemetry, isRec, sourceChoiceReady, playbackSources, playbackSourceIndex]);

  // Saved clips are already short MP4 files; keep their native playback path.
  useEffect(() => {
    if (isRec) return;
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    const seekToWindow = () => {
      try {
        const target = Math.min(Math.max(0, live.current.win.from / 1000), Math.max(0, video.duration - 0.1));
        if (Math.abs(video.currentTime - target) > 0.5) {
          video.currentTime = target;
          return false;
        }
        return !video.seeking;
      } catch {
        return false;
      }
    };
    const onLoadedData = () => {
      if (disposed || !seekToWindow() || video.readyState < 2) return;
      setFailed(false);
      setReady(true);
      void video.play().catch(() => undefined);
    };
    const onMetadata = () => { if (!disposed) seekToWindow(); };
    const onVideoError = () => { setReady(false); setFailed(true); };
    const timeout = window.setTimeout(() => {
      if (!disposed && !video.readyState) setFailed(true);
    }, 12_000);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("durationchange", onMetadata);
    video.addEventListener("seeked", onLoadedData);
    video.addEventListener("error", onVideoError);
    video.crossOrigin = "anonymous";
    video.muted = mutedRef.current;
    setReady(false);
    setFailed(false);
    if (!url) {
      setFailed(true);
    } else {
      video.src = url;
      video.load();
    }
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("durationchange", onMetadata);
      video.removeEventListener("seeked", onLoadedData);
      video.removeEventListener("error", onVideoError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [isRec, url, loadAttempt]);

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
      if (!v.paused && abs >= s.win.to && !loopSeekPendingRef.current) {
        loopSeekPendingRef.current = true;
        if (s.recording) stopRecording();
        seekAbs(s.win.from, "window-loop");
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
    if (abs < win.from || abs >= win.to - 100) seekAbs(win.from, "play-from-start");
    v.muted = muted;
    void v.play().then(() => setPlaying(true)).catch(() => { v.muted = true; setMuted(true); void v.play().then(() => setPlaying(true)); });
  };
  const pause = () => { videoRef.current?.pause(); setPlaying(false); };
  const nudge = (d: number) => {
    const v = videoRef.current;
    if (!v) return;
    seekAbs(Math.min(win.to - 50, Math.max(win.from, absAt(v) + d)), "nudge");
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
    seekAbs(win.from, "record-start");
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

  // Moving an edge can extend tracking data and loads the matching HLS window.
  const moveEdge = (edge: "from" | "to", d: number) => {
    setWin((w) => {
      let from = w.from, to = w.to;
      if (edge === "from") from = Math.max(0, Math.min(to - MIN_MS, from + d));
      else to = Math.max(from + MIN_MS, to + d);
      if (to - from > MAX_VIDEO_MS) return w;
      if (from < loaded.from || to > loaded.to) {
        setLoaded({ from: Math.max(0, from - MARGIN_MS), to: to + MARGIN_MS });
      }
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
      <video ref={videoRef} className="hidden" playsInline preload="auto" muted={muted} crossOrigin="anonymous"
        onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />

      <div className={cn("relative mx-auto overflow-hidden rounded-xl bg-black", viewTall ? "h-[min(62dvh,560px)]" : "w-full")}
        style={{ aspectRatio: `${viewW} / ${viewH}` }}>
        <canvas ref={viewRef} width={viewW} height={viewH} className="h-full w-full" data-testid="framer-view" />
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/70">
            {failed ? (
              <div role="alert" data-testid="status-framer-load-error" className="flex flex-col items-center gap-3 px-5 text-center">
                <span>{copy.failed}</span>
                <button
                  type="button"
                  data-testid="button-framer-retry"
                  onClick={() => {
                    setReady(false);
                    setFailed(false);
                    setPlaybackSources([]);
                    setPlaybackSourceIndex(0);
                    setLoadAttempt((attempt) => attempt + 1);
                  }}
                  className="rounded-full border border-white/30 px-4 py-2"
                >{copy.retry}</button>
              </div>
            ) : <span role="status" data-testid="status-framer-loading" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{copy.loading}</span>}
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
