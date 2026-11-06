import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, X } from "lucide-react";
import {
  SharedClipPlayerButtons,
  SharedClipTimeline,
  SharedClipVideo,
  useClipPlayerFullscreen,
} from "@/components/clip-player/SharedPlaybackControls";
import { apiBase, matchKey } from "@/lib/match-api";
import {
  FIRST_FRAME_TIMEOUT_MS, POLL_MS, STALL_TIMEOUT_MS,
  canDecodeHevc, earlyPlayPositionKey, initialSource, interpretProbe, loadKey, mediaMessage,
  offlineMessage, onFirstFrameTimeout, onStall, planForMediaError, pollFailedMessage, probeMessage,
  reasonMessage, savedPosition, showCard, sourceUrl, stallMessage,
  type EarlyPlayReason, type EarlyPlayStatus, type Source,
} from "./earlyPlayLogic";

export type { EarlyPlayReason, EarlyPlayState, EarlyPlayStatus } from "./earlyPlayLogic";
export { earlyPlayPositionKey } from "./earlyPlayLogic";

export function supportsEarlyHevc(): boolean {
  return canDecodeHevc(document.createElement("video"), typeof MediaSource === "undefined" ? undefined : MediaSource);
}
export const earlyReasonMessage = (code: EarlyPlayReason | undefined, locale: string) => reasonMessage(code, locale);
export const mediaErrorMessage = (errorCode: number, locale: string) => mediaMessage(errorCode, locale);

function readPosition(code: string, durationSec?: number | null): number {
  try { return savedPosition(sessionStorage.getItem(earlyPlayPositionKey(code)), durationSec); } catch { return 0; }
}
function writePosition(code: string, seconds: number | null): void {
  try {
    if (seconds === null) sessionStorage.removeItem(earlyPlayPositionKey(code));
    else sessionStorage.setItem(earlyPlayPositionKey(code), String(seconds));
  } catch { /* storage is optional */ }
}

type Props = {
  code: string;
  locale: string;
  compact?: boolean;
  previewState?: "early" | "unsupported" | "notAvailable";
  previewOpen?: boolean;
};

export function EarlyPlay({ code, locale, compact = false, previewState, previewOpen = false }: Props) {
  const ar = locale === "ar";
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EarlyPlayStatus | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("proxy");
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && navigator.onLine === false);
  const [retryNonce, setRetryNonce] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const statusRef = useRef<EarlyPlayStatus | null>(null);
  const sourceRef = useRef<Source>("proxy");
  const gotFrame = useRef(false);
  const pendingSeek = useRef(0);
  const firstFrameTimer = useRef<number | undefined>(undefined);
  const stallTimer = useRef<number | undefined>(undefined);
  statusRef.current = status;
  sourceRef.current = source;

  const fetchStatus = useCallback(async (): Promise<EarlyPlayStatus | null> => {
    try {
      const response = await fetch(`${apiBase}/matches/${encodeURIComponent(code)}/early-play`, { credentials: "include" });
      if (!response.ok) return null;
      return await response.json() as EarlyPlayStatus;
    } catch {
      return null;
    }
  }, [code]);

  // Poll. A failed background poll never touches the player: it only shows a
  // quiet note on the card, and the last good status stays in place.
  const refresh = useCallback(async () => {
    const next = await fetchStatus();
    if (!next) { setPollFailed(true); return; }
    setPollFailed(false);
    setStatus(next);
    if (next.state === "ready") void queryClient.invalidateQueries({ queryKey: matchKey(code) });
  }, [code, fetchStatus, queryClient]);

  useEffect(() => {
    if (previewState) {
      setStatus({
        state: "early",
        ...(!previewOpen && { streamUrl: "/fixture.mp4" }),
        encodeProgress: 62,
      });
      setSupported(previewState !== "unsupported");
      setOpen(previewOpen || previewState === "notAvailable");
      setError(previewState === "notAvailable" ? probeMessage({ kind: "gone" }, locale) : "");
      return;
    }
    setSupported(supportsEarlyHevc());
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [locale, previewOpen, previewState, refresh]);

  useEffect(() => {
    const onOffline = () => { setOffline(true); videoRef.current?.pause(); };
    const onOnline = () => setOffline(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => { window.removeEventListener("offline", onOffline); window.removeEventListener("online", onOnline); };
  }, []);

  const clearTimers = () => { window.clearTimeout(firstFrameTimer.current); window.clearTimeout(stallTimer.current); };
  useEffect(() => clearTimers, []);

  const fallbackToProxy = useCallback(() => {
    clearTimers();
    pendingSeek.current = videoRef.current?.currentTime || pendingSeek.current;
    setError("");
    setSource("proxy");
  }, []);

  const armStall = useCallback(() => {
    window.clearTimeout(stallTimer.current);
    stallTimer.current = window.setTimeout(() => {
      if (onStall(sourceRef.current, statusRef.current) === "fallback") fallbackToProxy();
      else setError(stallMessage(locale));
    }, STALL_TIMEOUT_MS);
  }, [fallbackToProxy, locale]);

  // (Re)load the <video> only when loadKey changes: a new URL, a fallback or a
  // retry. Polls and timeupdates do not reload it.
  const key = loadKey(status, source, retryNonce, open && !error && previewState !== "notAvailable");
  useEffect(() => {
    const video = videoRef.current;
    const url = sourceUrl(statusRef.current, sourceRef.current);
    if (!key || !video || !url) return;
    gotFrame.current = false;
    video.src = url;
    video.load();
    void video.play().catch(() => { /* autoplay may need a tap; controls are shown */ });
    window.clearTimeout(firstFrameTimer.current);
    firstFrameTimer.current = window.setTimeout(() => {
      if (onFirstFrameTimeout(sourceRef.current, gotFrame.current, statusRef.current) === "fallback") fallbackToProxy();
    }, FIRST_FRAME_TIMEOUT_MS);
    return () => window.clearTimeout(firstFrameTimer.current);
  }, [key, fallbackToProxy]);

  const handleError = useCallback(async () => {
    clearTimers();
    const plan = planForMediaError(sourceRef.current, videoRef.current?.error?.code, statusRef.current);
    if (plan.kind === "fallback") { fallbackToProxy(); return; }
    if (plan.kind === "message") { setError(mediaMessage(plan.mediaCode, locale)); return; }
    // MediaError 4: a missing or forbidden URL looks exactly like an
    // unsupported codec. Re-read the status and probe 2 bytes before deciding.
    const latest = await fetchStatus();
    let probeStatus: number | null = null;
    let probeReason: EarlyPlayReason | undefined;
    if (latest?.state === "early" && latest.streamUrl) {
      try {
        const probe = await fetch(latest.streamUrl, { headers: { Range: "bytes=0-1" }, credentials: "include" });
        probeStatus = probe.status;
        if (probe.status === 503) probeReason = ((await probe.json().catch(() => ({}))) as { reasonCode?: EarlyPlayReason }).reasonCode;
        else await probe.body?.cancel().catch(() => {});
      } catch { probeStatus = null; }
    }
    const outcome = interpretProbe(latest, probeStatus, probeReason);
    if (latest) setStatus(latest);
    if (outcome.kind === "ready") {
      void queryClient.invalidateQueries({ queryKey: matchKey(code) });
      setOpen(false);
      return;
    }
    if (outcome.kind === "unsupported") { setSupported(false); setOpen(false); return; }
    setError(probeMessage(outcome, locale));
  }, [code, fallbackToProxy, fetchStatus, locale, queryClient]);

  if (!showCard(status)) return null;
  const current = status!;
  const retry = () => { setError(""); setRetryNonce((n) => n + 1); };
  const openPlayer = () => {
    pendingSeek.current = readPosition(code, current.durationSec);
    setSource(initialSource(current));
    setError("");
    setOpen(true);
  };
  const closePlayer = () => { clearTimers(); writePosition(code, null); setOpen(false); };

  return (
    <section className={`rounded-2xl border border-turf/30 bg-surface ${compact ? "mt-3 p-3" : "mt-4 p-4"}`} data-testid="early-play-card">
      {current.state === "waiting" && <p className="text-xs text-muted-text" data-testid="early-play-waiting">
        {ar ? `النسخة المبكرة بتتوفر بعد ما يخلص رفع الفيديو${current.phase ? ` (${current.phase})` : ""}.` : `Early version available once the upload finishes${current.phase ? ` (${current.phase})` : ""}.`}
      </p>}
      {current.state === "unavailable" && <div className="flex flex-wrap items-center gap-3 text-xs text-muted-text" role="status" data-testid={`early-play-reason-${current.reasonCode}`}>
        <span>{reasonMessage(current.reasonCode, locale)}</span>
        {(current.reasonCode === "bunny_error" || current.reasonCode === "vps_unreachable") && (
          <button type="button" onClick={() => void refresh()} className="min-h-11 rounded-lg border border-line px-3 font-semibold text-turf">
            {ar ? "جرّب مرة ثانية" : "Retry"}
          </button>
        )}
      </div>}
      {current.state === "early" && supported === false && <p className="text-xs leading-5 text-muted-text" data-testid="early-play-unsupported">
        {probeMessage({ kind: "unsupported" }, locale)}
      </p>}
      {current.state === "early" && supported && (!open ? (
        <button type="button" onClick={openPlayer}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-floodlight px-4 text-sm font-bold text-void" data-testid="early-play-open">
          <Play className="h-4 w-4 fill-current" />{ar ? "شوف هلّق — النسخة المبكرة" : "Watch now — early version"}
        </button>
      ) : (
        <EarlyPlayOverlay
          code={code}
          locale={locale}
          current={current}
          source={source}
          videoRef={videoRef}
          error={error}
          offline={offline}
          onClose={closePlayer}
          onRetry={retry}
          onError={() => void handleError()}
          onLoadedMetadata={() => {
            if (pendingSeek.current > 0 && videoRef.current) {
              videoRef.current.currentTime = pendingSeek.current;
              pendingSeek.current = 0;
            }
          }}
          onLoadedData={() => {
            gotFrame.current = true;
            window.clearTimeout(firstFrameTimer.current);
          }}
          onPlaying={armStall}
          onTimeUpdate={() => {
            gotFrame.current = true;
            writePosition(code, videoRef.current?.currentTime ?? 0);
            if (!videoRef.current?.paused) armStall();
          }}
          onPause={() => window.clearTimeout(stallTimer.current)}
          onEnded={() => {
            clearTimers();
            writePosition(code, null);
          }}
        />
      ))}
      {pollFailed && !open && <p className="mt-2 text-[11px] text-muted-text" data-testid="early-play-poll-failed">{pollFailedMessage(locale)}</p>}
    </section>
  );
}

function EarlyPlayOverlay({
  code,
  locale,
  current,
  source,
  videoRef,
  error,
  offline,
  onClose,
  onRetry,
  onError,
  onLoadedMetadata,
  onLoadedData,
  onPlaying,
  onTimeUpdate,
  onPause,
  onEnded,
}: {
  code: string;
  locale: string;
  current: EarlyPlayStatus;
  source: Source;
  videoRef: RefObject<HTMLVideoElement | null>;
  error: string;
  offline: boolean;
  onClose: () => void;
  onRetry: () => void;
  onError: () => void;
  onLoadedMetadata: () => void;
  onLoadedData: () => void;
  onPlaying: () => void;
  onTimeUpdate: () => void;
  onPause: () => void;
  onEnded: () => void;
}) {
  const ar = locale === "ar";
  const { isFullscreen, toggleFullscreen } = useClipPlayerFullscreen(videoRef);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [progressSec, setProgressSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const syncPosition = () => {
      setProgressSec(Number.isFinite(video.currentTime) ? video.currentTime : 0);
      setDurationSec(Number.isFinite(video.duration) ? video.duration : 0);
    };
    const onPlay = () => setIsPlaying(true);
    const onVideoPause = () => setIsPlaying(false);
    video.addEventListener("timeupdate", syncPosition);
    video.addEventListener("durationchange", syncPosition);
    video.addEventListener("loadedmetadata", syncPosition);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("ended", onVideoPause);
    return () => {
      video.removeEventListener("timeupdate", syncPosition);
      video.removeEventListener("durationchange", syncPosition);
      video.removeEventListener("loadedmetadata", syncPosition);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onVideoPause);
      video.removeEventListener("ended", onVideoPause);
    };
  }, [videoRef]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };
  const seek = (event: ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.currentTarget.value);
    if (!Number.isFinite(nextTime) || !videoRef.current) return;
    videoRef.current.currentTime = nextTime;
    setProgressSec(nextTime);
  };
  const toggleMuted = () => {
    const nextMuted = !muted;
    if (videoRef.current) videoRef.current.muted = nextMuted;
    setMuted(nextMuted);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6" role="dialog" aria-modal="true" aria-labelledby="early-play-title" data-testid="early-play-player">
      <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-void text-text shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p id="early-play-title" className="truncate text-sm font-bold">
              {ar ? `نسخة مبكرة · ${code}` : `Early version · ${code}`}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-text">
              {ar ? "التسجيل متاح أثناء المعالجة" : "Match footage while processing"}
            </p>
          </div>
          <span className="rounded-full bg-turf/15 px-2.5 py-1 text-[10px] font-bold text-turf">
            {ar ? `${current.encodeProgress ?? 0}٪` : `${current.encodeProgress ?? 0}%`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/15 text-white hover:bg-white/10"
            aria-label={ar ? "سكّر" : "Close"}
            data-testid="button-early-play-close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
          <SharedClipVideo
            ref={videoRef}
            controls={false}
            muted={muted}
            playsInline
            className="aspect-video max-h-[58dvh] w-full bg-black object-contain"
            data-source={source}
            data-testid="early-play-video"
            onError={onError}
            onLoadedMetadata={onLoadedMetadata}
            onLoadedData={onLoadedData}
            onPlaying={onPlaying}
            onTimeUpdate={onTimeUpdate}
            onPause={onPause}
            onEnded={onEnded}
          />
          {error && (
            <div className="absolute inset-0 flex min-h-48 w-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-white" role="alert" data-testid="early-play-error">
              <p>{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/15 px-4 font-semibold hover:bg-white/25"
                data-testid="button-early-play-retry"
              >
                <RefreshCw className="h-4 w-4" />
                {ar ? "جرّب مرة ثانية" : "Retry"}
              </button>
            </div>
          )}
        </div>

        {!error && (
          <div className="shrink-0 border-t border-white/10 bg-void/95 px-4 pb-3 pt-2">
            <SharedClipTimeline
              progressSec={progressSec}
              durationSec={durationSec}
              onChange={seek}
              labels={{ timeline: ar ? "موضع الفيديو" : "Clip position" }}
              direction="inherit"
              testId="input-early-play-position"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-text">
                {ar ? "نسخة مبكرة · الجودة كاملة" : "Early version · full quality"}
              </span>
              <SharedClipPlayerButtons
                isPlaying={isPlaying}
                isFullscreen={isFullscreen}
                onTogglePlayback={togglePlayback}
                onToggleFullscreen={() => toggleFullscreen()}
                labels={{
                  play: ar ? "تشغيل" : "Play",
                  pause: ar ? "إيقاف" : "Pause",
                  enterFullscreen: ar ? "ملء الشاشة" : "Enter fullscreen",
                  exitFullscreen: ar ? "إنهاء ملء الشاشة" : "Exit fullscreen",
                  timeline: ar ? "موضع الفيديو" : "Clip position",
                  mute: ar ? "كتم الصوت" : "Mute",
                  unmute: ar ? "تشغيل الصوت" : "Unmute",
                }}
                muted={muted}
                onToggleMuted={toggleMuted}
                direction="inherit"
                testIdPrefix="button-early-play"
              />
            </div>
          </div>
        )}

        <footer className="shrink-0 border-t border-white/10 px-4 py-3">
          {offline && (
            <p className="mb-2 text-center text-xs text-amber-200" role="status" data-testid="early-play-offline">
              {offlineMessage(locale)}
            </p>
          )}
          <p className="text-center text-xs leading-5 text-muted-text" data-testid="early-play-note">
            {ar
              ? `نسخة مبكرة: الجودة كاملة وممكن التحميل يكون أبطأ. المقاطع والإحصائيات والتنزيل بيجوا بعد ما تخلص المعالجة (${current.encodeProgress ?? 0}٪).`
              : `Early version: full quality, may load slower. Clips, stats and downloads arrive when processing finishes (${current.encodeProgress ?? 0}%).`}
          </p>
        </footer>
      </div>
    </div>
  );
}
