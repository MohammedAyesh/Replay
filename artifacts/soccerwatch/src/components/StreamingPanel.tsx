import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Radio, Square } from "lucide-react";
import { apiBase } from "@/lib/match-api";
import { useTranslation } from "@/i18n";

type Platform = "youtube" | "facebook" | "tiktok" | "twitch";
type StreamState = "off" | "running" | "starting" | "failed";

type RtmpStatus = {
  cam: string;
  state: StreamState;
  variant?: "pan" | "hevc" | null;
  rtmp_url?: string | null;
  startedAt?: number | null;
};

type StreamingTarget =
  | { kind: "admin"; camera: string }
  | { kind: "owner"; camera: string; fieldId: number }
  | { kind: "match"; camera: string; matchCode: string };

const PLATFORM_OPTIONS: Array<{ value: Platform; label: string; rtmpUrl: string }> = [
  { value: "youtube", label: "YouTube", rtmpUrl: "rtmp://a.rtmp.youtube.com/live2" },
  { value: "facebook", label: "Facebook", rtmpUrl: "rtmps://live-api-s.facebook.com:443/rtmp/" },
  { value: "tiktok", label: "TikTok", rtmpUrl: "rtmp://push.tiktokv.com/rtmp/" },
  { value: "twitch", label: "Twitch", rtmpUrl: "rtmp://live.twitch.tv/app/" },
];

function targetContext(target: StreamingTarget): Record<string, string | number> {
  if (target.kind === "owner") return { fieldId: target.fieldId };
  if (target.kind === "match") return { matchCode: target.matchCode };
  return {};
}

function readPlatformPreference(key: string): Platform {
  try {
    const value = localStorage.getItem(key);
    if (PLATFORM_OPTIONS.some((option) => option.value === value)) return value as Platform;
  } catch {
    // Storage may be disabled; keep the preference in component state instead.
  }
  return "youtube";
}

function isSafeRtmpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["rtmp:", "rtmps:"].includes(parsed.protocol)
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const message = typeof record.error === "string" ? record.error : fallback;
    throw new Error(message);
  }
  return body as T;
}

export function StreamingPanel({
  target,
  preferenceKey,
}: {
  target: StreamingTarget;
  preferenceKey?: string;
}) {
  const { locale } = useTranslation();
  const isArabic = locale === "ar";
  const context = useMemo(() => targetContext(target), [
    target.kind,
    target.kind === "owner" ? target.fieldId : 0,
    target.kind === "match" ? target.matchCode : "",
  ]);
  const targetKey = preferenceKey ?? target.camera;
  const preferenceStorageKey = `replay-rtmp-platform:${targetKey}`;
  const [platform, setPlatform] = useState<Platform>(() => readPlatformPreference(preferenceStorageKey));
  const [rtmpUrl, setRtmpUrl] = useState(() => (
    PLATFORM_OPTIONS.find((option) => option.value === readPlatformPreference(preferenceStorageKey))?.rtmpUrl
      ?? PLATFORM_OPTIONS[0].rtmpUrl
  ));
  const [streamKey, setStreamKey] = useState("");
  const [status, setStatus] = useState<RtmpStatus>({ cam: target.camera, state: "off" });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const preferredPlatform = readPlatformPreference(preferenceStorageKey);
    setPlatform(preferredPlatform);
    setRtmpUrl(PLATFORM_OPTIONS.find((option) => option.value === preferredPlatform)?.rtmpUrl ?? PLATFORM_OPTIONS[0].rtmpUrl);
  }, [preferenceStorageKey]);

  useEffect(() => {
    setStreamKey("");
    setStatus({ cam: target.camera, state: "off" });
    setLoading(true);
    setError(null);
  }, [target.camera, targetKey]);

  const loadStatus = useCallback(async (): Promise<RtmpStatus | null> => {
    try {
      const response = await fetch(
        `${apiBase}/live/rtmp/status/${encodeURIComponent(target.camera)}`,
        { credentials: "include", cache: "no-store" },
      );
      const result = await readResponse<RtmpStatus>(
        response,
        isArabic ? "تعذر تحميل حالة البث" : "Could not load stream status",
      );
      setStatus(result);
      setError(null);
      if (result.state === "failed") setStreamKey("");
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (isArabic ? "تعذر تحميل حالة البث" : "Could not load stream status"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [isArabic, target.camera]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (status.state !== "starting") return;
    const timer = window.setInterval(() => { void loadStatus(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadStatus, status.state]);

  const start = async () => {
    if (!isSafeRtmpUrl(rtmpUrl)) {
      setError(isArabic
        ? "أدخل رابط RTMP أو RTMPS صالحاً من دون مفتاح البث"
        : "Enter a valid RTMP/RTMPS base URL without a stream key");
      return;
    }
    if (!streamKey) {
      setError(isArabic ? "أدخل مفتاح البث أولاً" : "Enter a stream key first");
      return;
    }

    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/live/rtmp/start/${encodeURIComponent(target.camera)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, platform, rtmpUrl, streamKey }),
      });
      const result = await readResponse<RtmpStatus>(
        response,
        isArabic ? "تعذر بدء البث" : "Could not start stream",
      );
      setStatus(result);
      setStreamKey("");
    } catch (cause) {
      setStreamKey("");
      setError(cause instanceof Error ? cause.message : (isArabic ? "تعذر بدء البث" : "Could not start stream"));
    } finally {
      setWorking(false);
    }
  };

  const stop = async () => {
    setStreamKey("");
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/live/rtmp/stop/${encodeURIComponent(target.camera)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
      });
      const result = await readResponse<RtmpStatus>(
        response,
        isArabic ? "تعذر إيقاف البث" : "Could not stop stream",
      );
      setStatus(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (isArabic ? "تعذر إيقاف البث" : "Could not stop stream"));
    } finally {
      setWorking(false);
    }
  };

  const stateLabel: Record<StreamState, string> = isArabic
    ? { off: "متوقف", running: "مباشر", starting: "جارٍ البدء", failed: "فشل" }
    : { off: "Off", running: "Running", starting: "Starting", failed: "Failed" };
  const busyState = status.state === "starting";

  return (
    <section className="rounded-2xl border border-line bg-surface p-4" aria-label={isArabic ? "البث الاجتماعي" : "Social streaming"}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-raised text-turf">
          <Radio className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold text-text">{isArabic ? "البث إلى المنصات" : "Social stream"}</h2>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              status.state === "running"
                ? "border-live/50 bg-live/10 text-live"
                : status.state === "failed"
                  ? "border-line bg-raised text-muted-text"
                  : "border-turf/30 bg-turf/10 text-turf"
            }`}>
              {stateLabel[status.state]}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-text">
            {isArabic ? "أرسل بث الكاميرا إلى YouTube أو منصة اجتماعية أخرى." : "Send this camera feed to YouTube or another social platform."}
          </p>
        </div>
      </div>

      {status.rtmp_url && (
        <p className="mt-3 truncate rounded-xl border border-line bg-raised/50 px-3 py-2 text-xs text-muted-text" title={status.rtmp_url}>
          {status.rtmp_url}
        </p>
      )}
      {status.variant && (
        <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-text">
          {isArabic ? "المسار" : "Feed"}: {status.variant}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-xl border border-line bg-raised px-3 py-2 text-xs text-text" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-muted-text">{isArabic ? "المنصة" : "Platform"}</span>
          <select
            value={platform}
            onChange={(event) => {
              const next = event.target.value as Platform;
              setPlatform(next);
              try {
                localStorage.setItem(preferenceStorageKey, next);
              } catch {
                // Keep the platform selected for this mount.
              }
              setRtmpUrl(PLATFORM_OPTIONS.find((option) => option.value === next)?.rtmpUrl ?? "");
            }}
            className="h-11 w-full rounded-xl border border-line bg-void px-3 text-sm text-text outline-none focus:border-turf"
          >
            {PLATFORM_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-muted-text">{isArabic ? "رابط RTMP الأساسي" : "RTMP ingest URL"}</span>
          <input
            type="text"
            inputMode="url"
            autoComplete="url"
            value={rtmpUrl}
            onChange={(event) => setRtmpUrl(event.target.value)}
            maxLength={512}
            spellCheck={false}
            className="h-11 w-full rounded-xl border border-line bg-void px-3 text-sm text-text outline-none focus:border-turf"
            aria-label={isArabic ? "رابط RTMP الأساسي" : "RTMP ingest URL"}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-xs font-semibold text-muted-text">{isArabic ? "مفتاح البث" : "Stream key"}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={streamKey}
            onChange={(event) => setStreamKey(event.target.value)}
            maxLength={1024}
            spellCheck={false}
            className="h-11 w-full rounded-xl border border-line bg-void px-3 text-sm text-text outline-none focus:border-turf"
            aria-label={isArabic ? "مفتاح البث" : "Stream key"}
          />
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={working || loading || busyState || status.state === "running" || streamKey.length === 0}
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-turf px-4 text-sm font-bold text-void disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working && status.state !== "starting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
          {isArabic ? "بدء البث" : "Start stream"}
        </button>
        <button
          type="button"
          onClick={() => void stop()}
          disabled={working || loading || status.state === "off"}
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line bg-raised px-4 text-sm font-semibold text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working && status.state === "starting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
          {isArabic ? "إيقاف البث" : "Stop stream"}
        </button>
      </div>
      {loading && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-text">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />{isArabic ? "جارٍ التحقق من الحالة…" : "Checking stream status…"}
        </p>
      )}
    </section>
  );
}