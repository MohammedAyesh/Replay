import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, Check, Clock, Loader2, Radio, RefreshCw, Square, Trash2 } from "lucide-react";
import { VarPlayer } from "@/components/var-player/VarPlayer";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const CAMERAS = ["camera1", "camera2", "camera3"] as const;
type Camera = typeof CAMERAS[number];

interface VarState {
  supported?: boolean;
  on?: boolean;
  live?: boolean;
  since?: unknown;
  startedAt?: unknown;
  start?: unknown;
  until?: unknown;
  endsAt?: unknown;
  end?: unknown;
  [key: string]: unknown;
}

interface VarWindow {
  id?: string | number;
  start?: unknown;
  startLocal?: unknown;
  end?: unknown;
  endLocal?: unknown;
  status?: unknown;
  title?: unknown;
  name?: unknown;
  fieldName?: unknown;
  [key: string]: unknown;
}

interface VarWindows {
  adminWindows?: VarWindow[];
  bookings?: VarWindow[];
  [key: string]: unknown;
}

interface StopResult {
  stillOnFor?: unknown;
  [key: string]: unknown;
}

const DURATION_OPTIONS = [
  { value: 30, label: "duration30m" },
  { value: 60, label: "duration1h" },
  { value: 120, label: "duration2h" },
  { value: 240, label: "duration4h" },
] as const;

function cameraNumber(camera: Camera): number {
  return Number(camera.replace("camera", ""));
}

function formatDateForAmman(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function firstValue(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = displayValue(record[key]);
    if (value) return value;
  }
  return "";
}

function describeStillOnFor(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return firstValue(record, ["until", "end", "endLocal", "title", "name", "fieldName"]);
}

export function hasActiveOwnerHold(stillOnFor: unknown): boolean {
  return Array.isArray(stillOnFor) && stillOnFor.length > 0;
}

export function shouldShowAdminVarPlayer(on: boolean | undefined, live: boolean | undefined): boolean {
  return on === true && live === true;
}

function windowStart(window: VarWindow): string {
  return firstValue(window, ["startLocal", "start", "from", "startsAt"]);
}

function windowEnd(window: VarWindow): string {
  return firstValue(window, ["endLocal", "end", "to", "endsAt"]);
}

function windowLabel(window: VarWindow, fallback: string): string {
  return firstValue(window, ["title", "name", "fieldName"]) || fallback;
}

function windowKey(window: VarWindow, index: number): string {
  return displayValue(window.id) || `${windowStart(window)}-${windowEnd(window)}-${index}`;
}

function buildTimeOptions(): string[] {
  return Array.from({ length: 96 }, (_, index) => {
    const minutes = index * 15;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });
}

const TIME_OPTIONS = buildTimeOptions();

function VarCameraCard({ camera }: { camera: Camera }) {
  const { t, locale } = useTranslation();
  const copy = t.adminVar;
  const [state, setState] = useState<VarState | null>(null);
  const [windows, setWindows] = useState<VarWindows>({ adminWindows: [], bookings: [] });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<"start" | "stop" | "schedule" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [duration, setDuration] = useState(60);
  const [date, setDate] = useState(() => formatDateForAmman(new Date()));
  const [from, setFrom] = useState("18:00");
  const [to, setTo] = useState("19:00");

  const apiFetch = useCallback(async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`${basePath}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
        ? String((body as Record<string, unknown>).error)
        : copy.actionFailed;
      throw new Error(message);
    }
    return body;
  }, [copy.actionFailed]);

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const [nextState, nextWindows] = await Promise.all([
        apiFetch(`/api/admin/var/${camera}/state`),
        apiFetch(`/api/admin/var/${camera}/windows`),
      ]);
      setState(nextState as VarState);
      setWindows((nextWindows as VarWindows) ?? { adminWindows: [], bookings: [] });
      setError(null);
    } catch (err) {
      // Background polling can briefly fail while the control server is
      // restarting. Keep the last good state and avoid turning that transient
      // refresh failure into a persistent user-facing error.
      if (initial) setError(err instanceof Error ? err.message : copy.actionFailed);
    } finally {
      if (initial) setLoading(false);
    }
  }, [apiFetch, camera, copy.actionFailed]);

  const pollMs = state?.on === true && state.live !== true ? 5_000 : 15_000;
  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(interval);
  }, [pollMs, refresh]);

  const callAction = async (action: string, path: string, init?: RequestInit) => {
    setWorking(action);
    setError(null);
    try {
      const result = await apiFetch(path, init);
      if (action === "stop") {
        const stillOnFor = (result as StopResult | null)?.stillOnFor;
        const hasOwnerHold = hasActiveOwnerHold(stillOnFor);
        const details = Array.isArray(stillOnFor)
          ? stillOnFor.map(describeStillOnFor).filter(Boolean).join(", ")
          : describeStillOnFor(stillOnFor);
        setStopNotice(hasOwnerHold ? copy.ownerStillOnFor(details) : copy.stopped);
        if (!hasOwnerHold) {
          setState((current) => current ? { ...current, on: false } : current);
        }
        setStopConfirm(false);
      }
      if (action === "start") {
        setState((current) => current ? { ...current, on: true, live: false } : current);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.actionFailed);
    } finally {
      setWorking(null);
    }
  };

  const start = () => void callAction("start", `/api/admin/var/${camera}/start?minutes=${duration}`, { method: "POST" });
  const stop = () => void callAction("stop", `/api/admin/var/${camera}/stop`, { method: "POST" });

  const schedule = (event: React.FormEvent) => {
    event.preventDefault();
    if (!date || timeToMinutes(to) <= timeToMinutes(from)) {
      setError(copy.invalidSchedule);
      return;
    }
    void callAction("schedule", `/api/admin/var/${camera}/schedule`, {
      method: "POST",
      body: JSON.stringify({ start: `${date} ${from}`, end: `${date} ${to}` }),
    });
  };

  const cancelWindow = (id: string | number | undefined) => {
    if (id == null) return;
    void callAction(String(id), `/api/admin/var/${camera}/windows/${encodeURIComponent(String(id))}`, { method: "DELETE" });
  };

  const isSupported = state?.supported !== false;
  const isLive = state?.live === true;
  const isOn = state?.on === true;
  const showPlayer = shouldShowAdminVarPlayer(state?.on, state?.live);
  const since = state ? firstValue(state, ["since", "startedAt", "start"]) : "";
  const until = state ? firstValue(state, ["until", "endsAt", "end"]) : "";
  const adminWindows = Array.isArray(windows.adminWindows) ? windows.adminWindows : [];
  const bookings = Array.isArray(windows.bookings) ? windows.bookings : [];
  const upcoming = useMemo(() => [
    ...adminWindows.map((window) => ({ ...window, kind: "admin" as const })),
    ...bookings.map((window) => ({ ...window, kind: "owner" as const })),
  ].sort((a, b) => windowStart(a).localeCompare(windowStart(b))), [adminWindows, bookings]);

  return (
    <section className={cn(
      "rounded-2xl border overflow-hidden",
      showPlayer ? "border-red-600/60 bg-zinc-900" : "border-zinc-800 bg-zinc-900/60",
    )}>
      <header className="flex items-center gap-3 border-b border-zinc-800/70 px-4 py-3">
        <span className={cn(
          "h-2.5 w-2.5 rounded-full",
          loading ? "bg-zinc-600 animate-pulse" : showPlayer ? "bg-red-500 animate-pulse" : isOn ? "bg-amber-400" : "bg-zinc-600",
        )} />
        <h2 className="text-sm font-semibold text-white">{copy.camera(cameraNumber(camera))}</h2>
        {!loading && isSupported && (
          <span className={cn(
            "ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            showPlayer ? "border-red-600/40 bg-red-600/10 text-red-300" : isOn ? "border-amber-600/40 bg-amber-600/10 text-amber-300" : "border-zinc-700 text-zinc-500",
          )}>
            {!isOn ? copy.off : isLive ? copy.live : state?.live === false ? copy.starting : copy.on}
          </span>
        )}
      </header>

      <div className="space-y-4 p-4">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />{copy.checking}</div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
        {stopNotice && (
          <div className="flex items-start gap-2 rounded-xl border border-blue-700/40 bg-blue-900/20 px-3 py-2 text-xs text-blue-200">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{stopNotice}</span>
          </div>
        )}

        {!loading && !isSupported && (
          <p className="text-sm text-zinc-500">{copy.unavailable}</p>
        )}

        {!loading && isSupported && (
          <>
            {since && <p className="flex items-center gap-1.5 text-xs text-zinc-400"><Clock className="h-3.5 w-3.5" />{copy.startedAt(since)}</p>}
            {until && <p className="flex items-center gap-1.5 text-xs text-zinc-400"><Clock className="h-3.5 w-3.5" />{copy.until(until)}</p>}

            {showPlayer ? (
              <VarPlayer
                src={`${basePath}/api/admin/var/${camera}/hls/playlist.m3u8`}
                title={`${copy.camera(cameraNumber(camera))} · VAR`}
              />
            ) : (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-5 text-center text-xs text-zinc-500">
                {isOn ? copy.connectingMessage : copy.offMessage}
              </div>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[150px] flex-1 text-[11px] text-zinc-500">
                <span className="mb-1 block">{copy.duration}</span>
                <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={working !== null || isOn} className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-xs text-white">
                  {DURATION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{copy[option.label]}</option>)}
                </select>
              </label>
              <button type="button" onClick={start} disabled={working !== null || isOn} className="flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40">
                {working === "start" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
                {working === "start" ? copy.startingAction : copy.start}
              </button>
              {!stopConfirm ? (
                <button type="button" onClick={() => setStopConfirm(true)} disabled={working !== null || !isOn} className="flex items-center justify-center gap-1.5 rounded-xl bg-zinc-800 px-3 py-2.5 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40">
                  <Square className="h-3.5 w-3.5" />{copy.stop}
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-700/50 bg-amber-950/30 px-3 py-2">
                  <span className="text-xs text-amber-200">{copy.stopConfirm}</span>
                  <button type="button" onClick={stop} disabled={working !== null} className="rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-black disabled:opacity-50">{working === "stop" ? copy.stopping : copy.confirmStop}</button>
                  <button type="button" onClick={() => setStopConfirm(false)} className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300">{copy.keepRunning}</button>
                </div>
              )}
              <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-xl bg-zinc-800 p-2.5 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-300" title={copy.refresh} aria-label={copy.refresh}>
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </button>
            </div>

            <form onSubmit={schedule} className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-white"><CalendarDays className="h-3.5 w-3.5 text-primary" />{copy.scheduleTitle}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="text-[11px] text-zinc-500"><span className="mb-1 block">{copy.date}</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} min={formatDateForAmman(new Date())} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white" /></label>
                <label className="text-[11px] text-zinc-500"><span className="mb-1 block">{copy.from}</span><select value={from} onChange={(event) => setFrom(event.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white">{TIME_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
                <label className="text-[11px] text-zinc-500"><span className="mb-1 block">{copy.to}</span><select value={to} onChange={(event) => setTo(event.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white">{TIME_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] text-zinc-600">{copy.scheduleHint}</span>
                <button type="submit" disabled={working !== null} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">
                  {working === "schedule" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarDays className="h-3.5 w-3.5" />}
                  {working === "schedule" ? copy.scheduling : copy.schedule}
                </button>
              </div>
            </form>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{copy.upcoming}</h3>
              {upcoming.length === 0 ? <p className="text-xs text-zinc-600">{copy.noWindows}</p> : upcoming.map((window, index) => {
                const cancelKey = windowKey(window, index);
                const isCanceling = working === String(window.id);
                return (
                  <div key={`${window.kind}-${cancelKey}`} className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-white">{window.kind === "admin" ? copy.adminWindow : copy.ownerBooking}{windowLabel(window, "") ? ` · ${windowLabel(window, "")}` : ""}</p>
                      <p className="text-[11px] text-zinc-500">{windowStart(window)} → {windowEnd(window)}{displayValue(window.status) ? ` · ${displayValue(window.status)}` : ""}</p>
                    </div>
                    {window.kind === "admin" && window.id != null && (
                      <button type="button" onClick={() => cancelWindow(window.id)} disabled={working !== null} className="flex shrink-0 items-center gap-1 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50" aria-label={copy.cancel}>
                        {isCanceling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default function AdminVarTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 outline-none" aria-label={t.adminVar.title}>
      <div>
        <p className="text-lg font-semibold text-white">{t.adminVar.title}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{t.adminVar.subtitle}</p>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {CAMERAS.map((camera) => <VarCameraCard key={camera} camera={camera} />)}
      </div>
    </div>
  );
}