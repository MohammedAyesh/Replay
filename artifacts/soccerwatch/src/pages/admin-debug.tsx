import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Activity, AlertTriangle, ArrowLeft, Camera, Clock3, Crosshair, Film, LoaderCircle, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";

const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
type Zoom = "frame" | "ball" | "claimant";
type Params = { rec: string; t: string; win: string; step: string; vo: string; zoom: Zoom; zw: string; ball: boolean; claims: boolean; clip: string; who: string };
type Ball = [number, number, number, boolean];
type Touch = [number, number, number, number, number, number, number, number];
type Claim = { identityId: string | number; userId: number; userName: string; color: string; parts: Array<{ trackId: string; fromFrame: number; toFrame: number }> };
type Box = { identityId: string | number; userName: string; color: string; trackId: string; boxes: Array<[number, number, number, number, number]> };
type DebugWindow = { manifest?: { width?: number; height?: number; duration?: number }; ball?: Ball[]; touches?: Touch[]; claims?: Claim[]; boxes?: Box[] };
type Clip = { id: number; title?: string; recordingId?: number; startTime: number; endTime: number };
type Tile = { seconds: number; key: string; src: string };
type TileResult = { status: "loading" | "ready" | "error"; url?: string };

const defaults: Params = { rec: "", t: "0", win: "10", step: "0.5", vo: "0", zoom: "frame", zw: "800", ball: true, claims: true, clip: "", who: "" };
function readParams(): Params {
  const q = new URLSearchParams(window.location.search);
  return {
    rec: q.get("rec") ?? defaults.rec, t: q.get("t") ?? defaults.t, win: q.get("win") ?? defaults.win,
    step: q.get("step") ?? defaults.step, vo: q.get("vo") ?? defaults.vo,
    zoom: (["frame", "ball", "claimant"].includes(q.get("zoom") ?? "") ? q.get("zoom") : defaults.zoom) as Zoom,
    zw: q.get("zw") ?? defaults.zw, ball: q.get("ball") !== "0", claims: q.get("claims") !== "0", clip: q.get("clip") ?? "", who: q.get("who") ?? "",
  };
}
function parseSeconds(value: string): number {
  const trimmed = value.trim();
  if (trimmed.includes(":")) {
    const [minutes, seconds] = trimmed.split(":");
    return Number(minutes) * 60 + Number(seconds);
  }
  return Number(trimmed);
}
function timeLabel(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toFixed(2).padStart(5, "0")}`;
}
function numberParam(params: Params, key: "t" | "win" | "step" | "vo" | "zw", fallback: number) {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
}

export default function AdminDebug() {
  const { user, isLoading, isAdmin } = useAuth();
  const [, setLocation] = useLocation();
  const [params, setParams] = useState<Params>(readParams);
  const [windowData, setWindowData] = useState<DebugWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [windowError, setWindowError] = useState("");
  const [clipBusy, setClipBusy] = useState(false);
  const [clipError, setClipError] = useState("");
  const [clipMessage, setClipMessage] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [tileRetries, setTileRetries] = useState<Record<string, number>>({});
  const firstUrlSync = useRef(true);

  useEffect(() => {
    if (!isLoading && (!user || !isAdmin)) setLocation("/home");
  }, [isLoading, user, isAdmin, setLocation]);

  useEffect(() => {
    if (firstUrlSync.current) { firstUrlSync.current = false; return; }
    const q = new URLSearchParams();
    (Object.keys(params) as Array<keyof Params>).forEach((key) => q.set(key, String(params[key])));
    window.history.replaceState(null, "", `${window.location.pathname}?${q.toString()}`);
  }, [params]);

  const recId = Number(params.rec);
  const time = parseSeconds(params.t);
  const win = Math.min(60, Math.max(0.25, numberParam(params, "win", 10)));
  const step = [0.25, 0.5, 1].includes(numberParam(params, "step", 0.5)) ? numberParam(params, "step", 0.5) : 0.5;
  const videoOffset = numberParam(params, "vo", 0);

  const loadWindow = useCallback(async () => {
    if (!Number.isInteger(recId) || recId < 1 || !Number.isFinite(time) || time < 0) {
      setWindowData(null);
      setWindowError(params.rec ? "Enter a valid recording ID and time." : "");
      return;
    }
    setLoading(true);
    setWindowError("");
    try {
      const from = Math.max(0, time - win / 2);
      const to = time + win / 2;
      const query = new URLSearchParams({ from: String(from), to: String(to) });
      const response = await fetch(`${API_BASE}/admin/recordings/${recId}/debug/window?${query}`, { credentials: "include" });
      if (!response.ok) throw new Error(response.status === 403 ? "Admin access is required." : `Could not load tracking window (${response.status}).`);
      setWindowData(await response.json() as DebugWindow);
    } catch (error) {
      setWindowData(null);
      setWindowError(error instanceof Error ? error.message : "Could not load tracking window.");
    } finally { setLoading(false); }
  }, [recId, time, win, params.rec]);

  useEffect(() => { if (params.rec) void loadWindow(); }, [loadWindow, params.rec, retryNonce]);

  const update = <K extends keyof Params,>(key: K, value: Params[K]) => setParams((current) => ({ ...current, [key]: value }));

  const lookupClip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setClipBusy(true); setClipError(""); setClipMessage("");
    try {
      const response = await fetch(`${API_BASE}/admin/clips`, { credentials: "include" });
      if (!response.ok) throw new Error(`Clip lookup failed (${response.status}).`);
      const clips = await response.json() as Clip[];
      const clip = clips.find((item) => String(item.id) === params.clip.trim());
      if (!clip) throw new Error(`Clip ${params.clip.trim()} was not found.`);
      if (!clip.recordingId) throw new Error("This clip is missing its recording ID.");
      const clipStart = Math.max(0, Number(clip.startTime) || 0);
      const clipEnd = Math.max(clipStart, Number(clip.endTime) || clipStart);
      setParams((current) => ({
        ...current,
        rec: String(clip.recordingId),
        t: String((clipStart + clipEnd) / 2),
        win: String(Math.max(0.25, clipEnd - clipStart)),
      }));
      setClipMessage(`${clip.title || `Clip ${clip.id}`} · ${timeLabel(clip.startTime)}–${timeLabel(clip.endTime)}`);
    } catch (error) { setClipError(error instanceof Error ? error.message : "Clip lookup failed."); }
    finally { setClipBusy(false); }
  };

  const dimensions = windowData?.manifest;
  const nativeW = dimensions?.width && dimensions.width > 0 ? dimensions.width : 1600;
  const nativeH = dimensions?.height && dimensions.height > 0 ? dimensions.height : 900;
  const tiles = useMemo<Tile[]>(() => {
    const count = Math.max(1, Math.floor(win / step) + 1);
    const start = time - win / 2;
    const results: Tile[] = [];
    for (let i = 0; i < count && i < 241; i++) {
      const seconds = Math.max(0, start + i * step);
      let cx = nativeW / 2; let cy = nativeH / 2; let width = nativeW; let height = nativeH;
      if (params.zoom !== "frame") {
        width = Math.min(nativeW, numberParam(params, "zw", 800));
        height = Math.round(width * nativeH / nativeW);
        const nearestBall = (windowData?.ball ?? []).reduce<Ball | null>((best, item) => !best || Math.abs(item[0] - seconds) < Math.abs(best[0] - seconds) ? item : best, null);
        if (params.zoom === "ball" && nearestBall) { cx = nearestBall[1]; cy = nearestBall[2]; }
        if (params.zoom === "claimant") {
          const selectedClaim = params.who || String(windowData?.claims?.[0]?.identityId ?? "");
          const nearestBox = (windowData?.boxes ?? []).filter((group) => String(group.identityId) === selectedClaim).flatMap((group) => group.boxes.map((box) => ({ group, box })))
            .reduce<{ box: [number, number, number, number, number] } | null>((best, item) => !best || Math.abs(item.box[0] - seconds) < Math.abs(best.box[0] - seconds) ? item : best, null);
          if (nearestBox) { cx = nearestBox.box[1] + nearestBox.box[3] / 2; cy = nearestBox.box[2] + nearestBox.box[4] / 2; }
        }
      }
      const query = new URLSearchParams({ t: String(seconds), vo: String(videoOffset), cx: String(cx), cy: String(cy), w: String(width), h: String(height), ball: params.ball ? "1" : "0", claims: params.claims ? "1" : "0" });
      const tileId = seconds.toFixed(3);
      results.push({ seconds, key: `${tileId}-${tileRetries[tileId] ?? 0}`, src: `${API_BASE}/admin/recordings/${recId}/debug/frame?${query}` });
    }
    return results;
  }, [win, step, time, nativeW, nativeH, params.zoom, params.zw, params.who, params.ball, params.claims, videoOffset, windowData, recId, tileRetries]);

  const ballNearest = useMemo(() => [...(windowData?.ball ?? [])].sort((a, b) => Math.abs(a[0] - time) - Math.abs(b[0] - time)).slice(0, 24), [windowData, time]);
  const claims = windowData?.claims ?? [];
  const tilesState = useTileImages(tiles);

  if (isLoading || !user || !isAdmin) return null;

  return (
    <main className="admin-debug min-h-[100dvh] flex-1 overflow-y-auto bg-background text-text" data-testid="page-admin-debug">
      <header className="border-b border-line bg-void px-4 py-5 sm:px-8">
        <div className="mx-auto flex max-w-[1500px] items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-turf"><ShieldCheck className="h-4 w-4" /> Replay operations / English</div>
            <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">Tracking debug</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-text">Inspect player tracks against source footage, one synchronized frame at a time.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setLocation("/admin")} data-testid="link-back-admin" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-xs font-bold text-text hover:bg-raised"><ArrowLeft className="h-4 w-4" /> Admin console</button>
            <div className="hidden items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 text-xs font-medium text-muted-text sm:flex"><Activity className="h-4 w-4 text-turf" /> Admin only</div>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-[1500px] space-y-5 px-4 py-5 sm:px-8">
        <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5" aria-label="Debug controls">
          <form onSubmit={(event) => { event.preventDefault(); void loadWindow(); }} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field label="Recording ID" testId="input-recording-id"><input id="debug-rec" value={params.rec} onChange={(e) => update("rec", e.target.value)} inputMode="numeric" placeholder="e.g. 1842" data-testid="input-recording-id" className={inputClass} /></Field>
            <Field label="Time (mm:ss or seconds)" testId="input-time"><input id="debug-time" value={params.t} onChange={(e) => update("t", e.target.value)} placeholder="02:14.5" data-testid="input-time" className={inputClass} /></Field>
            <Field label="Window (seconds, max 60)" testId="input-window"><input id="debug-window-size" type="number" min="0.25" max="60" step="0.25" value={params.win} onChange={(e) => update("win", e.target.value === "" ? "" : String(Math.min(60, Math.max(0.25, Number(e.target.value)))))} data-testid="input-window" className={inputClass} /></Field>
            <Field label="Frame step" testId="select-step"><select id="debug-step" value={params.step} onChange={(e) => update("step", e.target.value)} data-testid="select-step" className={inputClass}><option value="0.25">0.25 sec</option><option value="0.5">0.5 sec</option><option value="1">1 sec</option></select></Field>
            <Field label="Video offset (seconds)" testId="input-video-offset"><input id="debug-offset" type="number" min="-5" max="5" step="0.01" value={params.vo} onChange={(e) => update("vo", e.target.value === "" ? "" : String(Math.min(5, Math.max(-5, Number(e.target.value)))))} data-testid="input-video-offset" className={inputClass} /></Field>
            <div className="flex items-end"><button type="submit" data-testid="button-load-window" className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-turf px-4 text-sm font-bold text-void transition hover:brightness-105"><Search className="h-4 w-4" /> Load window</button></div>
          </form>
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Zoom center" testId="select-zoom"><select id="debug-zoom" value={params.zoom} onChange={(e) => update("zoom", e.target.value as Zoom)} data-testid="select-zoom" className={inputClass}><option value="frame">Whole frame</option><option value="ball">Ball</option><option value="claimant">Claimant</option></select></Field>
            <Field label="Crop width" testId="select-zoom-width"><select id="debug-width" value={params.zw} onChange={(e) => update("zw", e.target.value)} data-testid="select-zoom-width" disabled={params.zoom === "frame"} className={inputClass}><option value="400">400 px</option><option value="800">800 px</option><option value="1600">1600 px</option></select></Field>
            <div className="flex flex-wrap items-end gap-2">
              <Toggle checked={params.ball} onChange={(v) => update("ball", v)} label="Ball overlay" testId="toggle-ball" />
              <Toggle checked={params.claims} onChange={(v) => update("claims", v)} label="Claim overlays" testId="toggle-claims" />
            </div>
            <form onSubmit={lookupClip} className="flex items-end gap-2">
              <label className="min-w-0 flex-1 text-xs font-semibold text-muted-text">Clip ID<input aria-label="Clip ID" value={params.clip} onChange={(e) => update("clip", e.target.value)} inputMode="numeric" data-testid="input-clip-id" className={`${inputClass} mt-1`} /></label>
              <button type="submit" disabled={clipBusy || !params.clip.trim()} data-testid="button-lookup-clip" className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-line bg-raised px-3 text-xs font-bold text-text disabled:opacity-50"><Film className="h-4 w-4" />{clipBusy ? "Finding…" : "Find clip"}</button>
            </form>
          </div>
          {(clipError || clipMessage) && <p className={`mt-3 text-sm ${clipError ? "text-red-400" : "text-turf"}`} role={clipError ? "alert" : "status"} data-testid={clipError ? "status-clip-error" : "status-clip-result"}>{clipError || clipMessage}</p>}
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-w-0" aria-label="Frame grid">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-text">Frame sequence</p><h2 className="mt-1 font-display text-xl font-bold">{Number.isFinite(time) ? timeLabel(time) : "Waiting for time"} <span className="font-sans text-sm font-medium text-muted-text">± {win / 2}s · every {step}s</span></h2></div>
              <span className="rounded-full border border-line bg-surface px-3 py-1.5 font-mono text-xs text-muted-text">{tiles.length} frames</span>
            </div>
            {loading && <div className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted-text" role="status" data-testid="status-window-loading"><LoaderCircle className="h-4 w-4 animate-spin text-turf" /> Loading tracking window and claimant data…</div>}
            {windowError && <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200" role="alert" data-testid="status-window-error"><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />{windowError}</span><button type="button" onClick={() => setRetryNonce((value) => value + 1)} data-testid="button-retry-window" className="inline-flex items-center gap-1 rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs font-bold"><RefreshCw className="h-3.5 w-3.5" /> Retry</button></div>}
            {!params.rec && <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-line bg-surface/60 p-8 text-center"><div><Camera className="mx-auto h-8 w-8 text-turf/70" /><p className="mt-3 font-semibold">Choose a recording to inspect</p><p className="mt-1 text-sm text-muted-text">Frame tiles and tracking signals will appear here.</p></div></div>}
            {!!params.rec && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3" data-testid="grid-debug-frames">
                {tiles.map((tile, index) => {
                  const state = tilesState[tile.key] ?? { status: "loading" as const };
                  return <FrameTile key={tile.key} tile={tile} index={index} state={state} onRetry={() => setTileRetries((current) => ({ ...current, [tile.seconds.toFixed(3)]: (current[tile.seconds.toFixed(3)] ?? 0) + 1 }))} />;
                })}
              </div>
            )}
          </section>
          <aside className="space-y-4">
            <section className="overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="border-b border-line px-4 py-3"><h2 className="flex items-center gap-2 text-sm font-bold"><Crosshair className="h-4 w-4 text-turf" /> Touch events</h2><p className="mt-1 text-xs text-muted-text">Nearest events in the loaded window</p></div>
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-raised text-[10px] uppercase tracking-wider text-muted-text"><tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Claimant box</th><th className="px-3 py-2">Ball position</th><th className="px-3 py-2 text-right">Speed</th></tr></thead>
                  <tbody>{(windowData?.touches ?? []).map((touch, index) => {
                    const claimant = (windowData?.boxes ?? []).find((group) => group.boxes.some((box) => {
                      if (Math.abs(box[0] - touch[0]) > Math.max(0.25, step)) return false;
                      return touch[5] >= box[1] && touch[5] <= box[1] + box[3] && touch[6] >= box[2] && touch[6] <= box[2] + box[4];
                    }));
                    return <tr key={`${touch[0]}-${index}`} data-testid={`row-touch-${index}`} className="border-t border-line/70"><td className="whitespace-nowrap px-3 py-2 font-mono text-text">{timeLabel(touch[0])}</td><td className="px-3 py-2 text-muted-text">{claimant?.userName ?? "—"}</td><td className="whitespace-nowrap px-3 py-2 font-mono text-muted-text">{touch[5].toFixed(0)}, {touch[6].toFixed(0)}</td><td className="whitespace-nowrap px-3 py-2 text-right font-mono">{touch[7].toFixed(2)} m/s</td></tr>;
                  })}</tbody>
                </table>
                {!loading && !windowError && !(windowData?.touches?.length) && <p className="px-4 py-8 text-center text-sm text-muted-text" data-testid="empty-touch-events">No touch events in this window.</p>}
              </div>
            </section>
            <section className="overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="border-b border-line px-4 py-3"><h2 className="text-sm font-bold">Claimant legend</h2><p className="mt-1 text-xs text-muted-text">{claims.length} identities · box and track metadata</p></div>
              <div className="max-h-64 space-y-2 overflow-auto p-3">
                {claims.map((claim, index) => {
                  const boxCount = (windowData?.boxes ?? []).find((entry) => String(entry.identityId) === String(claim.identityId))?.boxes.length ?? 0;
                  return <div key={claim.identityId} data-testid={`legend-claim-${claim.identityId}`} className="flex items-center gap-3 rounded-xl bg-raised/70 p-3"><span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: claim.color }} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{claim.userName}</p><p className="truncate text-[11px] text-muted-text">ID {claim.identityId}{claim.userId ? ` · user ${claim.userId}` : ""} · {boxCount} boxes</p></div><span className="font-mono text-xs text-muted-text">{claim.parts.length} parts</span></div>;
                })}
                {!loading && claims.length === 0 && <p className="px-2 py-5 text-center text-sm text-muted-text">No claimant identities in this window.</p>}
              </div>
            </section>
            {params.zoom === "claimant" && (
              <Field label="Choose claimant" testId="select-claimant">
                <select id="debug-claimant" value={params.who || String(claims[0]?.identityId ?? "")} onChange={(event) => update("who", event.target.value)} data-testid="select-claimant" className={inputClass}>
                  {claims.map((claim) => <option key={claim.identityId} value={String(claim.identityId)}>{claim.userName}</option>)}
                </select>
              </Field>
            )}
            <section className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-center gap-2 text-sm font-bold"><Clock3 className="h-4 w-4 text-turf" /> Ball samples</div>
              <p className="mt-1 text-xs text-muted-text">Closest samples to the selected time</p>
              <div className="mt-3 flex flex-wrap gap-1.5">{ballNearest.map((point, index) => <span key={`${point[0]}-${index}`} data-testid={`sample-ball-${index}`} className="rounded-md bg-raised px-2 py-1 font-mono text-[10px] text-muted-text">{timeLabel(point[0])} · {point[1].toFixed(2)},{point[2].toFixed(2)}</span>)}</div>
              {!ballNearest.length && <p className="mt-3 text-xs text-muted-text">No ball samples available.</p>}
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

const inputClass = "min-h-11 w-full rounded-xl border border-line bg-raised px-3 text-sm text-text outline-none transition focus:border-turf focus:ring-2 focus:ring-turf/20 disabled:opacity-50";
const legendColors = ["bg-turf", "bg-amber-400", "bg-sky-400", "bg-fuchsia-400", "bg-orange-400", "bg-lime-400", "bg-rose-400", "bg-cyan-400"];
function Field({ label, children }: { label: string; testId: string; children: ReactNode }) {
  return <label className="block text-xs font-semibold text-muted-text">{label}{children}</label>;
}
function Toggle({ checked, onChange, label, testId }: { checked: boolean; onChange: (value: boolean) => void; label: string; testId: string }) {
  return <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line bg-raised px-3 text-xs font-semibold text-text"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid={testId} className="h-4 w-4 accent-[hsl(var(--turf))]" />{label}</label>;
}
function FrameTile({ tile, index, state, onRetry }: { tile: Tile; index: number; state: TileResult; onRetry: () => void }) {
  return <article className="overflow-hidden rounded-xl border border-line bg-surface" data-testid={`tile-frame-${index}`}>
    <div className="flex items-center justify-between border-b border-line px-3 py-2"><span className="font-mono text-xs font-bold">{timeLabel(tile.seconds)}</span><span className="text-[10px] uppercase tracking-wider text-muted-text">Frame {String(index + 1).padStart(2, "0")}</span></div>
    <div className="relative grid aspect-video place-items-center overflow-hidden bg-void">
      {state.status === "ready" && state.url ? <img src={state.url} alt={`Tracking frame at ${timeLabel(tile.seconds)}`} className="h-full w-full object-contain" data-testid={`img-frame-${index}`} /> : state.status === "error" ? <div className="p-4 text-center"><AlertTriangle className="mx-auto h-5 w-5 text-amber-300" /><p className="mt-2 text-xs text-muted-text">Frame failed to load.</p><button onClick={onRetry} className="mt-2 inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold" data-testid={`button-retry-frame-${index}`}><RefreshCw className="h-3 w-3" /> Retry</button></div> : <div className="flex flex-col items-center gap-2 text-xs text-muted-text" role="status"><LoaderCircle className="h-5 w-5 animate-spin text-turf" />Loading frame</div>}
    </div>
  </article>;
}
function useTileImages(tiles: Tile[]) {
  const [results, setResults] = useState<Record<string, TileResult>>({});
  const urls = useRef<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const controllers: AbortController[] = [];
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
    setResults(Object.fromEntries(tiles.map((tile) => [tile.key, { status: "loading" as const }])));
    let next = 0;
    const worker = async () => {
      while (!cancelled) {
        const tile = tiles[next++];
        if (!tile) return;
        const controller = new AbortController(); controllers.push(controller);
        try {
          const response = await fetch(tile.src, { credentials: "include", signal: controller.signal });
          if (!response.ok) throw new Error(`Frame request failed (${response.status})`);
          const url = URL.createObjectURL(await response.blob());
          urls.current.push(url);
          if (!cancelled) setResults((current) => ({ ...current, [tile.key]: { status: "ready", url } }));
          else URL.revokeObjectURL(url);
        } catch {
          if (!cancelled) setResults((current) => ({ ...current, [tile.key]: { status: "error" } }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, tiles.length) }, () => worker()));
    return () => { cancelled = true; controllers.forEach((controller) => controller.abort()); urls.current.forEach((url) => URL.revokeObjectURL(url)); urls.current = []; };
  }, [tiles]);
  return results;
}
