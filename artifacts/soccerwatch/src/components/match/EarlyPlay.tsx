import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, X } from "lucide-react";
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

type Props = { code: string; locale: string; compact?: boolean; previewState?: "early" | "unsupported" | "notAvailable" };

export function EarlyPlay({ code, locale, compact = false, previewState }: Props) {
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
      setStatus({ state: "early", streamUrl: "/fixture.mp4", encodeProgress: 62 });
      setSupported(previewState !== "unsupported");
      setOpen(previewState === "notAvailable");
      setError(previewState === "notAvailable" ? probeMessage({ kind: "gone" }, locale) : "");
      return;
    }
    setSupported(supportsEarlyHevc());
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [locale, previewState, refresh]);

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
        <div className="fixed inset-0 z-[100] flex flex-col justify-center bg-black p-3" role="dialog" aria-modal="true" data-testid="early-play-player">
          <button type="button" onClick={closePlayer} className="mb-2 ms-auto flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white" aria-label={ar ? "سكّر" : "Close"}><X /></button>
          {!error && <video ref={videoRef} controls playsInline className="max-h-[78vh] w-full bg-black" data-source={source}
            onError={() => void handleError()}
            onLoadedMetadata={() => { if (pendingSeek.current > 0 && videoRef.current) { videoRef.current.currentTime = pendingSeek.current; pendingSeek.current = 0; } }}
            onLoadedData={() => { gotFrame.current = true; window.clearTimeout(firstFrameTimer.current); }}
            onPlaying={armStall}
            onTimeUpdate={() => { gotFrame.current = true; writePosition(code, videoRef.current?.currentTime ?? 0); if (!videoRef.current?.paused) armStall(); }}
            onPause={() => window.clearTimeout(stallTimer.current)}
            onEnded={() => { clearTimers(); writePosition(code, null); }} />}
          <p className="mt-3 text-center text-xs leading-5 text-white/75" data-testid="early-play-note">
            {ar ? `نسخة مبكرة: الجودة كاملة وممكن التحميل يكون أبطأ. المقاطع والإحصائيات والتنزيل بيجوا بعد ما تخلص المعالجة (${current.encodeProgress ?? 0}٪).` : `Early version: full quality, may load slower. Clips, stats and downloads arrive when processing finishes (${current.encodeProgress ?? 0}%).`}
          </p>
          {offline && <p className="mt-2 text-center text-sm text-amber-200" role="status" data-testid="early-play-offline">{offlineMessage(locale)}</p>}
          {error && <div className="mt-3 flex items-center justify-center gap-3 text-sm text-white" role="alert" data-testid="early-play-error">{error}<button type="button" onClick={retry} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-white/15 px-3"><RefreshCw className="h-4 w-4" />{ar ? "جرّب مرة ثانية" : "Retry"}</button></div>}
        </div>
      ))}
      {pollFailed && !open && <p className="mt-2 text-[11px] text-muted-text" data-testid="early-play-poll-failed">{pollFailedMessage(locale)}</p>}
    </section>
  );
}
