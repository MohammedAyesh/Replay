import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, X } from "lucide-react";
import { apiBase, matchKey } from "@/lib/match-api";

export type EarlyPlayState = "waiting" | "early" | "ready" | "unavailable";
export type EarlyPlayReason =
  | "early_play_off" | "bunny_failed" | "bunny_not_found" | "bunny_error"
  | "vps_unreachable" | "disabled" | "request_cancelled";
export type EarlyPlayStatus = {
  state: EarlyPlayState;
  reason?: string;
  reasonCode?: EarlyPlayReason;
  phase?: string | null;
  encodeProgress?: number | null;
  streamUrl?: string;
  directUrl?: string;
  durationSec?: number | null;
};
export const earlyPlayPositionKey = (code: string) => `replay:early-play-position:${code.toUpperCase()}`;

const HEVC = 'video/mp4; codecs="hvc1.1.6.L150.B0"';
export function supportsEarlyHevc(): boolean {
  const video = document.createElement("video");
  return video.canPlayType(HEVC) !== ""
    || (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(HEVC));
}

const messages: Record<string, { en: string; ar: string }> = {
  early_play_off: { en: "Early playback is unavailable for this video.", ar: "التشغيل المبكر غير متاح لهذا الفيديو." },
  bunny_failed: { en: "Video processing failed. The footage may need to be requested again.", ar: "فشلت معالجة الفيديو. قد تحتاج لإعادة طلب التسجيل." },
  bunny_not_found: { en: "The video is no longer available.", ar: "الفيديو لم يعد متاحاً." },
  bunny_error: { en: "We couldn't check the video right now.", ar: "تعذّر التحقق من الفيديو حالياً." },
  vps_unreachable: { en: "The camera status is temporarily unavailable.", ar: "حالة الكاميرا غير متاحة مؤقتاً." },
  request_cancelled: { en: "This footage request was cancelled.", ar: "تم إلغاء طلب التسجيل." },
};

export function earlyReasonMessage(code: EarlyPlayReason | undefined, locale: string): string {
  const copy = code ? messages[code] : undefined;
  return copy?.[locale === "ar" ? "ar" : "en"] ?? (locale === "ar" ? "تعذّر تشغيل النسخة المبكرة." : "The early version couldn't be played.");
}

export function mediaErrorMessage(errorCode: number, locale: string): string {
  const ar = locale === "ar";
  const map: Record<number, [string, string]> = {
    1: ["Playback was stopped.", "تم إيقاف التشغيل."],
    2: ["A network error interrupted playback.", "أوقف خطأ في الشبكة تشغيل الفيديو."],
    3: ["The video couldn't be decoded.", "تعذّر فك ترميز الفيديو."],
    4: ["The video source isn't available.", "مصدر الفيديو غير متاح."],
  };
  const pair = map[errorCode] ?? [map[2][0], map[2][1]];
  return pair[ar ? 1 : 0];
}

type Props = { code: string; locale: string; compact?: boolean; previewState?: "early" | "unsupported" | "notAvailable" };
export function EarlyPlay({ code, locale, compact = false, previewState }: Props) {
  const [status, setStatus] = useState<EarlyPlayStatus | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<"direct" | "proxy">("proxy");
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const [currentTime, setCurrentTime] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const firstFrameTimer = useRef<number | undefined>(undefined);
  const stallTimer = useRef<number | undefined>(undefined);
  const didFrame = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/matches/${encodeURIComponent(code)}/early-play`, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as EarlyPlayStatus;
      setStatus(next);
      if (next.state === "ready") {
        void queryClient.invalidateQueries({ queryKey: matchKey(code) });
      }
    } catch {
      setError(locale === "ar" ? "تعذّر الاتصال. تحقق من الإنترنت ثم أعد المحاولة." : "Connection failed. Check your internet and retry.");
    }
  }, [code, locale, queryClient]);

  useEffect(() => {
    if (previewState) {
      setStatus({ state: "early", streamUrl: "/fixture.mp4", directUrl: undefined, encodeProgress: 62 });
      setSupported(previewState !== "unsupported");
      setOpen(previewState === "notAvailable");
      setError(previewState === "notAvailable"
        ? (locale === "ar" ? "الفيديو غير متاح." : "The video is not available.")
        : "");
      setSource("proxy");
      return;
    }
    setSupported(supportsEarlyHevc());
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [locale, previewState, refresh, retryNonce]);

  useEffect(() => {
    const onOffline = () => { setOffline(true); videoRef.current?.pause(); };
    const onOnline = () => setOffline(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => () => {
    window.clearTimeout(firstFrameTimer.current);
    window.clearTimeout(stallTimer.current);
  }, []);

  const useProxy = useCallback(() => {
    window.clearTimeout(firstFrameTimer.current);
    if (source === "direct" && status?.streamUrl) {
      setSource("proxy");
      setError("");
      didFrame.current = false;
    }
  }, [source, status?.streamUrl]);

  const probeProxyError4 = useCallback(async () => {
    const url = status?.streamUrl;
    if (!url) return earlyReasonMessage("bunny_error", locale);
    try {
      const refreshed = await fetch(`${apiBase}/matches/${encodeURIComponent(code)}/early-play`, { credentials: "include" });
      const latest = await refreshed.json() as EarlyPlayStatus;
      if (latest.state === "ready") {
        setStatus(latest);
        void queryClient.invalidateQueries({ queryKey: matchKey(code) });
        return locale === "ar" ? "أصبح الماتش جاهزاً الآن." : "The match is ready now.";
      }
      if (latest.state !== "early") return earlyReasonMessage(latest.reasonCode, locale);
      const probe = await fetch(url, { headers: { Range: "bytes=0-1" }, credentials: "include" });
      if (probe.status === 206) {
        setSupported(false);
        setOpen(false);
        return locale === "ar"
          ? "موبايلك ما بقدر يشغّل النسخة المبكرة."
          : "Your phone can't play the early version.";
      }
      if (probe.status === 404) return locale === "ar" ? "الفيديو غير متاح." : "The video is not available.";
      if (probe.status === 409) return locale === "ar" ? "أصبح الماتش جاهزاً الآن." : "The match is ready now.";
      if (probe.status === 503) return earlyReasonMessage((await probe.json().catch(() => ({}))).reasonCode, locale);
      return locale === "ar" ? "تعذّر الاتصال بالفيديو." : "The video could not be reached.";
    } catch {
      return locale === "ar" ? "تعذّر الاتصال بالفيديو." : "The video could not be reached.";
    }
  }, [code, locale, queryClient, status?.streamUrl]);

  const handleError = useCallback(async () => {
    const mediaCode = videoRef.current?.error?.code ?? 2;
    if (source === "direct") {
      useProxy();
      return;
    }
    if (mediaCode === 4) {
      setError(await probeProxyError4());
      return;
    }
    setError(mediaErrorMessage(mediaCode, locale));
  }, [locale, probeProxyError4, source, useProxy]);

  useEffect(() => {
    if (previewState === "notAvailable" || !open || status?.state !== "early" || !status.streamUrl || !videoRef.current) return;
    const video = videoRef.current;
    const url = source === "direct" && status.directUrl ? status.directUrl : status.streamUrl;
    video.src = url;
    if (currentTime > 0) video.currentTime = currentTime;
    didFrame.current = false;
    window.clearTimeout(firstFrameTimer.current);
    firstFrameTimer.current = window.setTimeout(() => {
      if (!didFrame.current && source === "direct") useProxy();
    }, 8_000);
    return () => window.clearTimeout(firstFrameTimer.current);
  }, [currentTime, open, previewState, retryNonce, source, status, useProxy]);

  if (status?.state === "unavailable" && status.reasonCode === "disabled") return null;
  if (!status || status.state === "ready") return null;
  const ar = locale === "ar";
  const retry = () => { setError(""); setRetryNonce((n) => n + 1); };
  const onTimeUpdate = () => {
    didFrame.current = true;
    const position = videoRef.current?.currentTime ?? 0;
    setCurrentTime(position);
    try { sessionStorage.setItem(earlyPlayPositionKey(code), String(position)); } catch { /* Storage is optional. */ }
    window.clearTimeout(stallTimer.current);
    if (!videoRef.current?.paused) stallTimer.current = window.setTimeout(() => {
      setError(ar ? "توقف الفيديو عن التحميل." : "The video stopped loading.");
      if (source === "direct") useProxy();
    }, 15_000);
  };

  return (
    <section className={`rounded-2xl border border-turf/30 bg-surface ${compact ? "mt-3 p-3" : "mt-4 p-4"}`} data-testid="early-play-card">
      {status.state === "waiting" && <p className="text-xs text-muted-text" data-testid="early-play-waiting">
        {ar ? `النسخة المبكرة بتتوفر بعد ما يخلص رفع الفيديو${status.phase ? ` (${status.phase})` : ""}.` : `Early version available once the upload finishes${status.phase ? ` (${status.phase})` : ""}.`}
      </p>}
      {status.state === "unavailable" && <div className="flex flex-wrap items-center gap-3 text-xs text-muted-text" role="status" data-testid={`early-play-reason-${status.reasonCode}`}>
        <span>{earlyReasonMessage(status.reasonCode, locale)}</span>
        {(status.reasonCode === "bunny_error" || status.reasonCode === "vps_unreachable") && (
          <button type="button" onClick={retry} className="min-h-11 rounded-lg border border-line px-3 font-semibold text-turf">
            {ar ? "إعادة المحاولة" : "Retry"}
          </button>
        )}
      </div>}
      {status.state === "early" && supported === false && <p className="text-xs leading-5 text-muted-text" data-testid="early-play-unsupported">
        {ar ? "موبايلك ما بقدر يشغّل النسخة المبكرة. الماتش بيكون جاهز بعد كم دقيقة." : "Your phone can't play the early version. The match will be ready in a few minutes."}
      </p>}
      {status.state === "early" && supported && <>
        {!open ? <button type="button" onClick={() => { setSource(status.directUrl ? "direct" : "proxy"); setOpen(true); setError(""); }}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-floodlight px-4 text-sm font-bold text-void" data-testid="early-play-open">
          <Play className="h-4 w-4 fill-current" />{ar ? "شاهد الآن — النسخة المبكرة" : "Watch now — early version"}
        </button> : (
          <div className="fixed inset-0 z-[100] flex flex-col justify-center bg-black p-3" role="dialog" aria-modal="true" data-testid="early-play-player">
            <button type="button" onClick={() => {
              try { sessionStorage.removeItem(earlyPlayPositionKey(code)); } catch { /* Storage is optional. */ }
              setOpen(false);
            }} className="mb-2 ms-auto flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white" aria-label={ar ? "إغلاق" : "Close"}><X /></button>
            {!error && <video ref={videoRef} controls playsInline autoPlay className="max-h-[78vh] w-full bg-black" onError={() => void handleError()} onTimeUpdate={onTimeUpdate}
              onLoadedData={() => { didFrame.current = true; window.clearTimeout(firstFrameTimer.current); }}
              onPlay={() => { window.clearTimeout(stallTimer.current); stallTimer.current = window.setTimeout(() => { setError(ar ? "توقف الفيديو عن التحميل." : "The video stopped loading."); if (source === "direct") useProxy(); }, 15_000); }}
              onPause={() => window.clearTimeout(stallTimer.current)} />}
            <p className="mt-3 text-center text-xs leading-5 text-white/75" data-testid="early-play-note">
              {ar ? `نسخة مبكرة: الجودة كاملة وقد يكون التحميل أبطأ. المقاطع والإحصائيات والتنزيلات بتتوفر بعد انتهاء المعالجة (${status.encodeProgress ?? 0}٪).` : `Early version: full quality, may load slower. Clips, stats and downloads arrive when processing finishes (${status.encodeProgress ?? 0}%).`}
            </p>
            {offline && <p className="mt-2 text-center text-sm text-amber-200" role="status">{ar ? "أنت غير متصل. ارجع أونلاين واضغط إعادة المحاولة." : "You're offline. Reconnect and retry."}</p>}
            {error && <div className="mt-3 flex items-center justify-center gap-3 text-sm text-white" role="alert">{error}<button type="button" onClick={retry} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-white/15 px-3"><RefreshCw className="h-4 w-4" />{ar ? "إعادة المحاولة" : "Retry"}</button></div>}
          </div>
        )}
      </>}
    </section>
  );
}
