import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatStartTime, parseStartTime } from "@/lib/analysisStart";

/**
 * The analysis queue.
 *
 * The thing this page has to communicate, and the reason it is a page rather
 * than a button, is that pressing it starts something that takes about six
 * hours on a computer in somebody's flat. So the interface is built around
 * waiting: where the job is in the queue, what the workstation is doing right
 * now, and - the state that would otherwise look like a bug - whether the
 * workstation is even switched on. A queued job with the PC asleep is normal,
 * and the page says so in words rather than leaving a spinner turning.
 */

type JobStatus = "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

interface SourceDescriptor {
  recordingId: number;
  videoGuid: string | null;
  videoUrl: string;
  title: string | null;
  durationSeconds: number | null;
}

interface Job {
  id: number;
  recordingId: number;
  recordingLabel: string | null;
  sourceRecordingIds: number[];
  sources: SourceDescriptor[];
  bundleRecordingIds: number[];
  matchStartSeconds: number;
  status: JobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  error: string | null;
  workerId: string | null;
  queuePosition: number | null;
  createdAt: string;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

interface Worker {
  id: string;
  lastSeenAt: string;
  status: string;
  currentJobId: number | null;
  version: string | null;
  online: boolean;
}

interface RecordingOption {
  id: number;
  fieldName: string | null;
  court: string;
  date: string;
  timeSlot: string;
  duration: string;
}

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${basePath}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

const STATUS_STYLE: Record<JobStatus, string> = {
  queued: "bg-zinc-800 text-zinc-300",
  claimed: "bg-sky-900/50 text-sky-300",
  running: "bg-sky-900/50 text-sky-300",
  succeeded: "bg-emerald-900/40 text-emerald-300",
  failed: "bg-red-900/40 text-red-300",
  cancelled: "bg-zinc-800 text-zinc-500",
};

function recordingLabel(option: RecordingOption): string {
  return [option.fieldName, option.court, option.date, option.timeSlot]
    .filter(Boolean)
    .join(" · ");
}

export default function AnalysisTab() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [options, setOptions] = useState<RecordingOption[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [startInput, setStartInput] = useState("0:00");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [schemaNotice, setSchemaNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const queue = await api("/admin/analysis-jobs");
      setJobs(queue.jobs ?? []);
      setWorkers(queue.workers ?? []);
      setSchemaNotice(queue.schemaReady === false ? (queue.message ?? "The analysis tables are missing.") : null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    api("/admin/analysis-jobs/recordings").then(setOptions).catch(() => undefined);
  }, [load]);

  // A job's whole life is measured in hours, so this is deliberately slow. It
  // is here so an operator who leaves the tab open sees the stage change.
  useEffect(() => {
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const startSeconds = parseStartTime(startInput);
  const orderedSelection = useMemo(
    () => selected.map((id) => options.find((option) => option.id === id)).filter(Boolean) as RecordingOption[],
    [selected, options],
  );
  const anyWorkerOnline = workers.some((worker) => worker.online);

  const visibleOptions = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options.slice(0, 60);
    return options.filter((option) => recordingLabel(option).toLowerCase().includes(needle)).slice(0, 60);
  }, [options, filter]);

  function toggle(id: number) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function move(index: number, delta: number) {
    setSelected((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function queueJob() {
    if (!selected.length || startSeconds === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/admin/analysis-jobs", {
        method: "POST",
        body: JSON.stringify({
          recordingId: selected[0],
          sourceRecordingIds: selected,
          matchStartSeconds: startSeconds,
        }),
      });
      setSelected([]);
      setNotice(
        anyWorkerOnline
          ? "Queued. The workstation will pick it up within a minute."
          : "Queued. Nothing is listening right now, so it will start when the analysis PC is next switched on.",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(id: number, action: "cancel" | "retry") {
    setBusy(true);
    try {
      await api(`/admin/analysis-jobs/${id}/${action}`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-white font-display font-black text-xl uppercase tracking-tight">Analysis</h2>
        <p className="text-zinc-500 text-xs mt-1">
          Runs the tracking pipeline over one or more recordings and attaches the result, so the
          match becomes claimable. A football hour takes about six hours of GPU time.
        </p>
      </div>

      {schemaNotice && (
        <div className="rounded border border-amber-800/60 bg-amber-950/30 px-3 py-2.5">
          <p className="text-amber-300 text-sm font-semibold">The analysis queue is not set up yet</p>
          <p className="text-amber-200/70 text-xs mt-1">{schemaNotice}</p>
        </div>
      )}

      {/* Workstation health. This box exists so that "nothing is happening" has
          a visible cause instead of looking like a broken queue. */}
      <div className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <p className="text-zinc-300 text-sm font-semibold">Analysis workstation</p>
          <span className={cn("text-xs font-semibold", anyWorkerOnline ? "text-emerald-400" : "text-amber-400")}>
            {anyWorkerOnline ? "online" : "offline"}
          </span>
        </div>
        {workers.length === 0 ? (
          <p className="text-zinc-500 text-xs mt-1">
            No workstation has ever checked in. Start the worker on the analysis PC — jobs queued
            here will wait until it does.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {workers.map((worker) => (
              <li key={worker.id} className="text-xs text-zinc-400 flex items-center gap-2">
                <span className={cn("h-1.5 w-1.5 rounded-full", worker.online ? "bg-emerald-400" : "bg-zinc-600")} />
                <span className="text-zinc-300 font-medium">{worker.id}</span>
                <span>last seen {ago(worker.lastSeenAt)}</span>
                {worker.currentJobId && <span>· on job #{worker.currentJobId}</span>}
                {worker.version && <span className="text-zinc-600">· {worker.version}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* New job */}
      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
        <p className="text-zinc-300 text-sm font-semibold">Start an analysis</p>

        <div>
          <label className="text-zinc-500 text-[11px] uppercase tracking-wider">Recordings, in playing order</label>
          {orderedSelection.length === 0 ? (
            <p className="text-zinc-600 text-xs mt-1">
              Pick one recording, or several when the match was recorded as separate hours.
            </p>
          ) : (
            <ol className="mt-1.5 space-y-1">
              {orderedSelection.map((option, index) => (
                <li key={option.id} className="flex items-center gap-2 text-xs text-zinc-300">
                  <span className="text-zinc-600 w-4">{index + 1}.</span>
                  <span className="flex-1 truncate">{recordingLabel(option)}</span>
                  {index === 0 && (
                    <span className="text-[10px] text-sky-400 uppercase tracking-wide">bundle attaches here</span>
                  )}
                  <button
                    className="px-1.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >↑</button>
                  <button
                    className="px-1.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                    disabled={index === orderedSelection.length - 1}
                    onClick={() => move(index, 1)}
                  >↓</button>
                  <button className="px-1.5 text-zinc-500 hover:text-red-400" onClick={() => toggle(option.id)}>×</button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter recordings by field, camera or date"
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
        <div className="max-h-56 overflow-y-auto rounded border border-zinc-800 divide-y divide-zinc-800/70">
          {visibleOptions.map((option) => (
            <button
              key={option.id}
              onClick={() => toggle(option.id)}
              className={cn(
                "w-full text-left px-2.5 py-1.5 text-xs flex items-center justify-between",
                selected.includes(option.id) ? "bg-sky-950/40 text-sky-200" : "text-zinc-400 hover:bg-zinc-900",
              )}
            >
              <span className="truncate">{recordingLabel(option)}</span>
              <span className="text-zinc-600 ml-2 flex-shrink-0">{option.duration}</span>
            </button>
          ))}
          {visibleOptions.length === 0 && (
            <p className="text-zinc-600 text-xs px-2.5 py-3">No recordings match that.</p>
          )}
        </div>

        <div className="flex items-end gap-3">
          <div>
            <label className="text-zinc-500 text-[11px] uppercase tracking-wider block">Match starts at</label>
            <input
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              placeholder="18:30"
              className={cn(
                "mt-1 w-28 bg-zinc-950 border rounded px-2 py-1.5 text-sm text-zinc-200",
                startSeconds === null ? "border-red-800" : "border-zinc-800",
              )}
            />
            <p className="text-zinc-600 text-[11px] mt-1">
              {startSeconds === null
                ? "Use m:ss, h:mm:ss, or a number of seconds."
                : `${formatStartTime(startSeconds)} into the first recording`}
            </p>
          </div>
          <button
            onClick={queueJob}
            disabled={busy || !selected.length || startSeconds === null}
            className="ml-auto px-4 py-2 rounded bg-primary text-black font-semibold text-sm disabled:opacity-40"
          >
            Queue analysis
          </button>
        </div>
      </div>

      {notice && (
        <div className="rounded border border-sky-900/60 bg-sky-950/30 text-sky-200 text-sm px-3 py-2">{notice}</div>
      )}
      {error && (
        <div className="rounded border border-red-900/60 bg-red-950/40 text-red-300 text-sm px-3 py-2">{error}</div>
      )}

      {/* Queue */}
      <div className="space-y-2">
        <p className="text-zinc-300 text-sm font-semibold">Queue</p>
        {jobs.length === 0 && <p className="text-zinc-600 text-xs">Nothing has been queued yet.</p>}
        {jobs.map((job) => (
          <div key={job.id} className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={cn("text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded", STATUS_STYLE[job.status])}>
                {job.status}
              </span>
              <span className="text-zinc-300 text-sm font-medium">#{job.id}</span>
              <span className="text-zinc-500 text-xs truncate">{job.recordingLabel ?? `recording ${job.recordingId}`}</span>
              <span className="ml-auto text-zinc-600 text-xs">{ago(job.createdAt)}</span>
            </div>

            <p className="text-zinc-500 text-xs mt-1.5">
              {job.sources.length > 1 ? `${job.sources.length} recordings` : "1 recording"}
              {" · kick-off "}{formatStartTime(job.matchStartSeconds)}
              {job.bundleRecordingIds.length > 0 &&
                ` · ${job.bundleRecordingIds.length}/${job.sources.length} bundles attached`}
            </p>

            {job.status === "queued" && (
              <p className="text-zinc-400 text-xs mt-1.5">
                {job.queuePosition === 1
                  ? anyWorkerOnline ? "Next up." : "Next up — waiting for the workstation to come online."
                  : `Position ${job.queuePosition} in the queue.`}
              </p>
            )}

            {(job.status === "running" || job.status === "claimed") && (
              <div className="mt-1.5">
                <div className="h-1 rounded bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-sky-500" style={{ width: `${Math.round(job.progress)}%` }} />
                </div>
                <p className="text-zinc-400 text-xs mt-1">
                  {job.stage ?? "starting"} · {Math.round(job.progress)}% · heartbeat {ago(job.heartbeatAt)}
                  {job.workerId && ` · ${job.workerId}`}
                </p>
              </div>
            )}

            {job.error && (
              <p className={cn("text-xs mt-1.5", job.status === "failed" ? "text-red-400" : "text-amber-400")}>
                {job.error}
              </p>
            )}

            <div className="flex gap-2 mt-2">
              {(job.status === "queued" || job.status === "claimed" || job.status === "running") && (
                <button
                  onClick={() => act(job.id, "cancel")}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              )}
              {(job.status === "failed" || job.status === "cancelled") && (
                <button
                  onClick={() => act(job.id, "retry")}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
                >
                  Queue again
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
