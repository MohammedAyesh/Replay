import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatStartTime, parseStartTime } from "@/lib/analysisStart";

/**
 * The analysis queue.
 *
 * The thing this page has to communicate, and the reason it is a page rather
 * than a button, is that pressing it queues work for a cloud runner that rents
 * a GPU for each job and deletes it afterwards. So the interface is built
 * around waiting: where the job is in the queue, what the runner is doing
 * right now, and whether the runner is available.
 */

type JobStatus = "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

interface SourceDescriptor {
  recordingId: number;
  videoGuid: string | null;
  videoUrl: string;
  title: string | null;
  durationSeconds: number | null;
}

type RosterHintTeam = {
  key: "A" | "B" | "C";
  name: string | null;
  color: string;
  shirtsHaveNumbers: "yes" | "no" | "unknown" | "yes, inferred";
  shirtNumbers: number[];
  squadSize: number;
};

type RosterHints = {
  matchCode: string;
  playersPerSide: number;
  teamCount: 2 | 3;
  substitutesPerTeam: number;
  teams: RosterHintTeam[];
  totalPlayersExpected: number;
};

type MatchRosterSummary = {
  playerCount: number;
  numberedPlayerCount: number;
  playerMinutes: number;
};

interface Job {
  id: number;
  recordingId: number;
  recordingLabel: string | null;
  rosterHints: RosterHints | null;
  matchRosterSummary: MatchRosterSummary | null;
  sourceRecordingIds: number[];
  sources: SourceDescriptor[];
  bundleRecordingIds: number[];
  matchStartSeconds: number;
  params?: { gpu?: string; gpus?: string[]; cards?: "auto" | number };
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

const SALAD_GPU_OPTIONS = [
  {
    value: "salad:RTX 3090",
    label: "Salad RTX 3090 · $0.09–0.12/h · slower card (~1.5× a 4080 Super), speed being tested",
  },
  {
    value: "salad:RTX 4090",
    label: "Salad RTX 4090 · $0.16–0.22/h · ~$0.32–0.43 per 2-hour match",
  },
  {
    value: "salad:RTX 5090",
    label: "Salad RTX 5090 · $0.25–0.33/h · ~$0.50–0.67 per 2-hour match",
  },
  {
    value: "salad",
    label: "Salad · cheapest free RTX 4090 / 5090",
  },
] as const;

type SaladFleetCardCount = "auto" | 2 | 3 | 4 | 5 | 6 | 8 | 10;

const SALAD_FLEET_CARD_OPTIONS: Array<{ value: SaladFleetCardCount; label: string }> = [
  { value: "auto", label: "Auto (finish in about an hour)" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
  { value: 6, label: "6" },
  { value: 8, label: "8" },
  { value: 10, label: "10" },
];

type SaladTier = "cheapest" | "batch" | "low";

interface GpuCardSelection {
  gpu: string;
  saladTier: SaladTier;
}

const DEFAULT_GPU_CARD: GpuCardSelection = { gpu: "auto", saladTier: "cheapest" };

const SALAD_TIER_OPTIONS: Array<{ value: SaladTier; label: string }> = [
  { value: "cheapest", label: "Cheapest free (batch, else low)" },
  { value: "batch", label: "Batch only" },
  { value: "low", label: "Low only" },
];

function GpuOptionList() {
  return (
    <>
      <option value="auto">Auto — cheapest free card (usually RTX 4080 Super)</option>
      <option value="RTX 4080 (Super)">RTX 4080 Super · $0.25/h · ~2h40 · ~$0.66 per 2-hour match (cheapest)</option>
      <option value="RTX 5090D">RTX 5090D · $0.41/h · ~2h05 · ~$0.84 per 2-hour match (fastest for the money)</option>
      <option value="RTX 5090">RTX 5090 · $0.46/h · ~2h00 · ~$0.92 per 2-hour match</option>
      <optgroup label="SaladCloud (cheaper, can be interrupted)">
        <option value="salad-fleet">Salad auto-fleet · cheapest fast mix of cards, picked live (batch first)</option>
        {SALAD_GPU_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </optgroup>
    </>
  );
}

function isSaladGpu(gpu: string): boolean {
  return SALAD_GPU_OPTIONS.some((option) => option.value === gpu);
}

function gpuValueForCard(card: GpuCardSelection): string {
  if (!isSaladGpu(card.gpu)) return card.gpu;
  if (card.saladTier === "batch") return `${card.gpu}@batch`;
  if (card.saladTier === "low") return `${card.gpu}@low`;
  return card.gpu;
}

function analysisGpuLabel(gpu?: string): string {
  switch (gpu) {
    case "auto":
    case "":
    case undefined:
      return "Auto";
    case "salad":
      return "Salad (cheapest)";
    case "salad:RTX 3090":
      return "Salad RTX 3090";
    case "salad:RTX 4090":
      return "Salad RTX 4090";
    case "salad:RTX 5090":
      return "Salad RTX 5090";
    case "salad-split-test":
      return "Salad split test (3 cards: 3090 batch, 3090 low, 5090)";
    default:
      return gpu;
  }
}

function multiGpuCardLabel(gpu: string): string {
  if (gpu === "salad-split-test") return analysisGpuLabel(gpu);
  if (!gpu.startsWith("salad")) return analysisGpuLabel(gpu);

  const suffixIndex = gpu.lastIndexOf("@");
  const baseGpu = suffixIndex === -1 ? gpu : gpu.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? undefined : gpu.slice(suffixIndex + 1);
  const tierLabel = suffix === undefined
    ? "batch→low"
    : suffix === "batch"
      ? "batch"
      : suffix === "low"
        ? "low"
        : suffix === "batch/low"
          ? "batch→low"
          : null;
  const label = analysisGpuLabel(baseGpu);
  return tierLabel ? `${label} (${tierLabel})` : analysisGpuLabel(gpu);
}

export function analysisGpuQueueLabel(params?: Job["params"]): string {
  if (params?.gpu === "salad-fleet") {
    const cardsLabel = typeof params.cards === "number" && Number.isInteger(params.cards)
      ? `${params.cards} ${params.cards === 1 ? "card" : "cards"}`
      : "auto";
    return `Salad auto-fleet (${cardsLabel})`;
  }
  if (Array.isArray(params?.gpus)) {
    return `${params.gpus.length} cards: ${params.gpus.map(multiGpuCardLabel).join(" + ")}`;
  }
  return analysisGpuLabel(params?.gpu);
}

export function buildAnalysisJobParams(
  gpuMode: "manual" | "salad-fleet",
  gpuCards: GpuCardSelection[],
  fleetCardCount: SaladFleetCardCount,
): NonNullable<Job["params"]> {
  if (gpuMode === "salad-fleet") {
    return { gpu: "salad-fleet", cards: fleetCardCount };
  }
  const gpuValues = gpuCards.map(gpuValueForCard);
  return gpuValues.length === 1
    ? { gpu: gpuValues[0] }
    : { gpu: "multi", gpus: gpuValues };
}

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

const COLOR_NAMES: Record<string, string> = {
  "#F2F4F8": "white",
  "#FF6B1A": "orange",
  "#7AA2FF": "blue",
  "#0B0F1A": "black",
  "#2FD8C4": "teal",
  "#FFD23F": "yellow",
  "#E23B3B": "red",
  "#1F8A4C": "green",
};

function rosterHintLine(hints: RosterHints | null): string {
  if (!hints) return "No match room linked";
  const teams = hints.teams.map((team) => {
    const label = team.name?.trim() || COLOR_NAMES[team.color.toUpperCase()] || team.color;
    let numbers: string;
    if (team.shirtNumbers.length) {
      numbers = team.shirtNumbers.join(", ");
      if (team.shirtsHaveNumbers === "yes, inferred") numbers += " (yes, inferred)";
    } else if (team.shirtsHaveNumbers === "no") {
      numbers = "no numbers";
    } else if (team.shirtsHaveNumbers === "yes") {
      numbers = "yes; none entered";
    } else {
      numbers = "number status unknown";
    }
    return `${team.key} ${label}: ${numbers}`;
  });
  return `${hints.playersPerSide} a side · ${hints.substitutesPerTeam} subs · ${teams.join(" · ")}`;
}

function matchRosterSummaryLine(summary: MatchRosterSummary | null): string | null {
  if (!summary) return null;
  return `${summary.playerCount} players · ${summary.numberedPlayerCount} numbered · ${Math.round(summary.playerMinutes)} player-min`;
}

export default function AnalysisTab() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [options, setOptions] = useState<RecordingOption[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [startInput, setStartInput] = useState("0:00");
  const [cardCount, setCardCount] = useState(1);
  const [gpuCards, setGpuCards] = useState<GpuCardSelection[]>([{ ...DEFAULT_GPU_CARD }]);
  const [gpuMode, setGpuMode] = useState<"manual" | "salad-fleet">("manual");
  const [fleetCardCount, setFleetCardCount] = useState<SaladFleetCardCount>("auto");
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
  const isSaladFleet = gpuMode === "salad-fleet";
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

  function changeCardCount(nextCount: number) {
    const count = Math.max(1, Math.min(6, Math.round(nextCount)));
    setCardCount(count);
    setGpuCards((current) => {
      if (count <= current.length) return current.slice(0, count);
      const firstCard = current[0] ?? DEFAULT_GPU_CARD;
      return [
        ...current,
        ...Array.from({ length: count - current.length }, () => ({ ...firstCard })),
      ];
    });
  }

  function updateGpuCard(index: number, update: Partial<GpuCardSelection>) {
    setGpuCards((current) =>
      current.map((card, cardIndex) => cardIndex === index ? { ...card, ...update } : card),
    );
  }

  function selectGpu(index: number, gpu: string) {
    if (gpu === "salad-fleet") {
      setGpuMode("salad-fleet");
      return;
    }
    setGpuMode("manual");
    updateGpuCard(index, { gpu });
  }

  function changeFleetCardCount(value: string) {
    const option = SALAD_FLEET_CARD_OPTIONS.find((item) => String(item.value) === value);
    if (option) setFleetCardCount(option.value);
  }

  async function queueJob() {
    if (!selected.length || startSeconds === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const params = buildAnalysisJobParams(gpuMode, gpuCards, fleetCardCount);
      await api("/admin/analysis-jobs", {
        method: "POST",
        body: JSON.stringify({
          recordingId: selected[0],
          sourceRecordingIds: selected,
          matchStartSeconds: startSeconds,
          params,
        }),
      });
      setSelected([]);
      setCardCount(1);
      setGpuCards([{ ...DEFAULT_GPU_CARD }]);
      setGpuMode("manual");
      setFleetCardCount("auto");
      setNotice(
        anyWorkerOnline
          ? "Queued. A GPU will be rented for it within a minute."
          : "Queued. The cloud runner is not answering right now, so the job will wait in the queue.",
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
          match becomes claimable. Runs on a GPU rented for each job and deleted afterwards. A two-hour match takes about 2–2¾ hours depending on the GPU and costs well under $1.
        </p>
      </div>

      {schemaNotice && (
        <div className="rounded border border-amber-800/60 bg-amber-950/30 px-3 py-2.5">
          <p className="text-amber-300 text-sm font-semibold">The analysis queue is not set up yet</p>
          <p className="text-amber-200/70 text-xs mt-1">{schemaNotice}</p>
        </div>
      )}

      {/* Analysis runner health. This box exists so that "nothing is happening" has
          a visible cause instead of looking like a broken queue. */}
      <div className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <p className="text-zinc-300 text-sm font-semibold">Analysis runner</p>
          <span className={cn("text-xs font-semibold", anyWorkerOnline ? "text-emerald-400" : "text-amber-400")}>
            {anyWorkerOnline ? "online" : "offline"}
          </span>
        </div>
        {workers.length === 0 ? (
          <p className="text-zinc-500 text-xs mt-1">
            The cloud runner has not checked in yet. Jobs queued here will wait until it does.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {workers.map((worker) => (
              <li key={worker.id} className="text-xs text-zinc-400 flex items-center gap-2">
                <span className={cn("h-1.5 w-1.5 rounded-full", worker.online ? "bg-emerald-400" : "bg-zinc-600")} />
                <span className="text-zinc-300 font-medium">
                  {worker.id === "cloud-gpu" ? "Cloud GPU (rented per job)" : worker.id}
                </span>
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

        <div className="flex flex-wrap items-end gap-3">
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
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <div className="w-20 shrink-0">
                <label htmlFor="analysis-card-count" className="text-zinc-500 text-[11px] uppercase tracking-wider block">Cards</label>
                <select
                  id="analysis-card-count"
                  value={isSaladFleet ? fleetCardCount : cardCount}
                  onChange={(e) => {
                    if (isSaladFleet) changeFleetCardCount(e.target.value);
                    else changeCardCount(Number(e.target.value));
                  }}
                  className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
                >
                  {isSaladFleet
                    ? SALAD_FLEET_CARD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))
                    : Array.from({ length: 6 }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>{count}</option>
                    ))}
                </select>
              </div>
              <div className="min-w-0 flex-1">
                {isSaladFleet ? (
                  <div className="max-w-sm">
                    <label htmlFor="analysis-gpu-mode" className="text-zinc-500 text-[11px] uppercase tracking-wider block">GPU mode</label>
                    <select
                      id="analysis-gpu-mode"
                      value="salad-fleet"
                      onChange={(e) => selectGpu(0, e.target.value)}
                      className="mt-1 w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
                    >
                      <GpuOptionList />
                    </select>
                  </div>
                ) : cardCount === 1 ? (
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor="analysis-gpu-1" className="text-zinc-500 text-[11px] uppercase tracking-wider block">GPU</label>
                      <select
                        id="analysis-gpu-1"
                        value={gpuCards[0]?.gpu ?? "auto"}
                        onChange={(e) => selectGpu(0, e.target.value)}
                        className="mt-1 w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
                      >
                        <GpuOptionList />
                      </select>
                    </div>
                    {isSaladGpu(gpuCards[0]?.gpu ?? "") && (
                      <div className="w-44 shrink-0">
                        <label htmlFor="analysis-salad-tier-1" className="text-zinc-500 text-[11px] uppercase tracking-wider block">Salad tier</label>
                        <select
                          id="analysis-salad-tier-1"
                          value={gpuCards[0]?.saladTier ?? "cheapest"}
                          onChange={(e) => updateGpuCard(0, { saladTier: e.target.value as SaladTier })}
                          className="mt-1 w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
                        >
                          {SALAD_TIER_OPTIONS.map((tier) => (
                            <option key={tier.value} value={tier.value}>{tier.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                    {gpuCards.map((card, index) => {
                      const gpuId = `analysis-gpu-${index + 1}`;
                      const tierId = `analysis-salad-tier-${index + 1}`;
                      return (
                        <div key={index} className="min-w-0">
                          <div className="flex items-end gap-2">
                            <div className="min-w-0 flex-1">
                              <label htmlFor={gpuId} className="text-zinc-500 text-[11px] uppercase tracking-wider block">Card {index + 1}</label>
                              <select
                                id={gpuId}
                                value={card.gpu}
                                onChange={(e) => selectGpu(index, e.target.value)}
                                className="mt-1 w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
                              >
                                <GpuOptionList />
                              </select>
                            </div>
                            {isSaladGpu(card.gpu) && (
                              <div className="w-44 shrink-0">
                                <label htmlFor={tierId} className="text-zinc-500 text-[11px] uppercase tracking-wider block">Salad tier</label>
                                <select
                                  id={tierId}
                                  value={card.saladTier}
                                  onChange={(e) => updateGpuCard(index, { saladTier: e.target.value as SaladTier })}
                                  className="mt-1 w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
                                >
                                  {SALAD_TIER_OPTIONS.map((tier) => (
                                    <option key={tier.value} value={tier.value}>{tier.label}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {isSaladFleet ? (
              <p className="text-zinc-600 text-[11px] mt-1">
                Picks the best value cards free on Salad right now, cheapest per chunk first, and skips very slow cards. A 2-hour match is usually 5–6 cards, about an hour and roughly $0.30–0.50. Cards at the batch price can be taken away mid-job; their chunks are re-run on the other cards.
              </p>
            ) : gpuCards.some((card) => card.gpu === "auto") && (
              <p className="text-zinc-600 text-[11px] mt-1">
                Auto takes the cheapest card that is free. If you pick a specific card and none is free, the job waits up to 30 minutes and then fails with a message.
              </p>
            )}
            {!isSaladFleet && cardCount > 1 && (
              <p className="text-zinc-600 text-[11px] mt-1">
                These choices are sent as one analysis with one GPU entry per card, in the order shown.
              </p>
            )}
            {!isSaladFleet && gpuCards.some((card) => isSaladGpu(card.gpu)) && (
              <p className="text-zinc-600 text-[11px] mt-1">
                Salad runs on home PCs. The tier controls whether the runner uses batch only, low only, or batch with low fallback. A machine can be taken away mid-job; that job fails and can be queued again. Setup adds 5–20 minutes before analysis starts.
              </p>
            )}
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
              {" · GPU: "}{analysisGpuQueueLabel(job.params)}
              {job.bundleRecordingIds.length > 0 &&
                ` · ${job.bundleRecordingIds.length}/${job.sources.length} bundles attached`}
            </p>
            <p className="text-zinc-400 text-xs mt-1.5">
              <span className="text-zinc-500">Roster for analysis: </span>
              {rosterHintLine(job.rosterHints)}
            </p>
            {job.matchRosterSummary && (
              <p className="text-zinc-400 text-xs mt-1.5" data-testid={`match-roster-summary-${job.id}`}>
                <span className="text-zinc-500">Tracking roster: </span>
                {matchRosterSummaryLine(job.matchRosterSummary)}
              </p>
            )}

            {job.status === "queued" && (
              <p className="text-zinc-400 text-xs mt-1.5">
                {job.queuePosition === 1
                  ? anyWorkerOnline ? "Next up." : "Next up — waiting for the cloud runner."
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
