import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Radio, Square } from "lucide-react";
import { apiBase } from "@/lib/match-api";
import { useTranslation } from "@/i18n";

type Platform = "youtube" | "facebook" | "twitch";
type StreamState = "offline" | "starting" | "live" | "stopping" | "failed" | "unknown";

type StreamingTarget =
  | { kind: "admin"; camera: string }
  | { kind: "owner"; fieldId: number }
  | { kind: "match"; matchCode: string };

type StreamingStatus = {
  state: StreamState;
  live: boolean;
  platform: string | null;
  message: string | null;
};

const PLATFORM_OPTIONS: Array<{ value: Platform; label: string }> = [
  { value: "youtube", label: "YouTube" },
  { value: "facebook", label: "Facebook" },
  { value: "twitch", label: "Twitch" },
];

function getTargetScope(target: StreamingTarget): Record<string, string | number> {
  if (target.kind === "admin") return { camera: target.camera };
  if (target.kind === "owner") return { fieldId: target.fieldId };
  return { matchCode: target.matchCode };
}

function readPlatformPreference(key: string): Platform {
  try {
    const value = localStorage.getItem(key);
    if (PLATFORM_OPTIONS.some((option) => option.value === value)) return value as Platform;
  } catch {
    // Storage may be disabled; the preference still works for this mount.
  }
  return "youtube";
}

function responseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  for (const candidate of [record.message, record.error, record.detail]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return fallback;
}

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseMessage(body, `${fallback} (${response.status})`));
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
  const scope = useMemo(() => getTargetScope(target), [
    target.kind,
    target.kind === "admin" ? target.camera : "",
    target.kind === "owner" ? target.fieldId : 0,
    target.kind === "match" ? target.matchCode : "",
  ]);
  const stableTargetKey = preferenceKey
    ?? (target.kind === "admin" ? target.camera : target.kind === "owner" ? `field-${target.fieldId}` : `match-${target.matchCode}`);
  const platformStorageKey = `replay-stream-platform:${stableTargetKey}`;
  const [platform, setPlatform] = useState<Platform>(() => readPlatformPreference(platformStorageKey));
  const [streamKey, setStreamKey] = useState("");
  const [status, setStatus] = useState<StreamingStatus>({
    state: "unknown",
    live: false,
    platform: null,
    message: null,
  });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlatform(readPlatformPreference(platformStorageKey));
  }, [platformStorageKey]);

  useEffect(() => {
    setStreamKey("");
    setStatus({ state: "unknown", live: false, platform: null, message: null });
    setLoading(true);
    setError(null);
  }, [stableTargetKey]);

  useEffect(() => {
    try {
      localStorage.setItem(platformStorageKey, platform);
    } catch {
      // Keep the selected platform for this mount if storage is unavailable.
    }
  }, [platform, platformStorageKey]);

  const loadStatus = useCallback(async () => {
    const params = new URLSearchParams(
      Object.entries(scope).map(([key, value]) => [key, String(value)]),
    );
    try {
      const response = await fetch(`${apiBase}/streaming/status?${params.toString()}`, {
        credentials: "include",
        cache: "no-store",
      });
      const result = await readResponse<StreamingStatus>(response, isArabic ? "تعذر تحميل حالة البث" : "Could not load stream status");
      setStatus(result);
      setError(null);
      if (result.state === "failed") setStreamKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (isArabic ? "تعذر تحميل حالة البث" : "Could not load stream status"));
    } finally {
      setLoading(false);
    }
  }, [isArabic, scope]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await loadStatus();
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadStatus]);

  const start = async () => {
    const trimmedKey = streamKey.trim();
    if (!trimmedKey) {
      setError(isArabic ? "أدخل مفتاح البث أولاً" : "Enter a stream key first");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/streaming/start`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...scope, platform, streamKey: trimmedKey }),
      });
      const result = await readResponse<StreamingStatus>(response, isArabic ? "تعذر بدء البث" : "Could not start stream");
      setStatus(result);
      if (result.state === "failed") setStreamKey("");
      await loadStatus();
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
      const response = await fetch(`${apiBase}/streaming/stop`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope),
      });
      const result = await readResponse<StreamingStatus>(response, isArabic ? "تعذر إيقاف البث" : "Could not stop stream");
      setStatus(result);
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (isArabic ? "تعذر إيقاف البث" : "Could not stop stream"));
    } finally {
      setWorking(false);
    }
  };

  const stateLabel: Record<StreamState, string> = isArabic
    ? { offline: "متوقف", starting: "جارٍ البدء", live: "مباشر", stopping: "جارٍ الإيقاف", failed: "فشل", unknown: "غير معروف" }
    : { offline: "Offline", starting: "Starting", live: "Live", stopping: "Stopping", failed: "Failed", unknown: "Unknown" };
  const busyState = status.state === "starting" || status.state === "stopping";

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
              status.state === "live"
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

      {status.message && (
        <p className="mt-3 rounded-xl border border-line bg-raised/50 px-3 py-2 text-xs text-muted-text" role="status">
          {status.message}
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
            onChange={(event) => setPlatform(event.target.value as Platform)}
            className="h-11 w-full rounded-xl border border-line bg-void px-3 text-sm text-text outline-none focus:border-turf"
          >
            {PLATFORM_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="block">
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
          disabled={working || loading || busyState || status.state === "live" || streamKey.trim().length === 0}
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-floodlight px-4 text-sm font-bold text-void disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working && status.state !== "stopping" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
          {isArabic ? "بدء البث" : "Start stream"}
        </button>
        <button
          type="button"
          onClick={() => void stop()}
          disabled={working || loading || status.state === "offline"}
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line bg-raised px-4 text-sm font-semibold text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working && status.state === "stopping" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
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