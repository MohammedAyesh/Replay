import { useEffect, useMemo, useState } from "react";
import {
  MUSIC_MOODS,
  TEMPLATE_MUSIC_MAX_FADE_MS,
  TEMPLATE_MUSIC_MAX_START_MS,
  TEMPLATE_MUSIC_MAX_TRACKS,
  type MusicMood,
  type TemplateMusicRecommendation,
} from "@workspace/api-zod";
import type { MusicTrack } from "@/lib/creative-hub-music-api";

/**
 * Admin → Creative music → Template music: the music each of the 31
 * templates recommends. The first track is the one a video from the template
 * starts with (and a still design gets when it becomes a video); all of them
 * show as "Recommended for …" in the editor's Music panel. Replay ships a pick
 * for every template (TEMPLATE_RECOMMENDED_MUSIC); saving here replaces it,
 * "Reset" goes back to it. Hidden tracks are skipped wherever they are listed.
 * API: GET /admin/creative/music/templates, PUT|DELETE …/templates/:key.
 */

export type TemplateMusicRow = {
  key: string;
  title: { en: string; ar: string };
  category: string;
  kind: "image" | "video";
  formats: string[];
  effective: TemplateMusicRecommendation & { customised: boolean; fallback: boolean };
  builtIn: TemplateMusicRecommendation & { keys: string[] };
  saved: TemplateMusicRecommendation | null;
  updatedAt: string | null;
};

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;
type Draft = { trackIds: number[]; volume: number; duck: boolean; fadeIn: string; fadeOut: string; start: string };

const field = "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white";
const small = "rounded-md border border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-30";
const length = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const seconds = (ms: number) => String(Math.round(ms / 100) / 10);
const toMs = (s: string) => Math.round(Number(s) * 1000);

/** What a row's form starts from: the saved list (else Replay's), active tracks only. */
function draftOf(row: TemplateMusicRow, active: Set<number>): Draft {
  const base = row.saved ?? row.builtIn;
  return {
    trackIds: base.trackIds.filter((id) => active.has(id)),
    volume: base.volume, duck: base.duck, fadeIn: seconds(base.fadeInMs), fadeOut: seconds(base.fadeOutMs), start: seconds(base.startMs),
  };
}

/** The form as the API wants it, or the first thing wrong with it. */
function draftBody(d: Draft): { body: TemplateMusicRecommendation } | { error: string } {
  const fadeInMs = toMs(d.fadeIn);
  const fadeOutMs = toMs(d.fadeOut);
  const startMs = toMs(d.start);
  const maxFade = TEMPLATE_MUSIC_MAX_FADE_MS / 1000;
  if (!Number.isFinite(fadeInMs) || fadeInMs < 0 || fadeInMs > TEMPLATE_MUSIC_MAX_FADE_MS) return { error: `Fade in is 0–${maxFade} s.` };
  if (!Number.isFinite(fadeOutMs) || fadeOutMs < 0 || fadeOutMs > TEMPLATE_MUSIC_MAX_FADE_MS) return { error: `Fade out is 0–${maxFade} s.` };
  if (!Number.isFinite(startMs) || startMs < 0 || startMs > TEMPLATE_MUSIC_MAX_START_MS) return { error: `Start is 0–${TEMPLATE_MUSIC_MAX_START_MS / 1000} s.` };
  return { body: { trackIds: d.trackIds, volume: d.volume, duck: d.duck, fadeInMs, fadeOutMs, startMs } };
}

export function TemplateMusicSection({ call, tracks, playing, onPlay }: {
  call: Call; tracks: MusicTrack[] | null; playing: number | null; onPlay: (t: MusicTrack) => void;
}) {
  const [rows, setRows] = useState<TemplateMusicRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    call<{ templates: TemplateMusicRow[] }>("/admin/creative/music/templates").then((r) => setRows(r.templates)).catch((e: Error) => setError(e.message));
  }, [call]);

  const active = useMemo(() => (tracks ?? []).filter((t) => t.scope === "replay" && t.status === "active"), [tracks]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || r.title.en.toLowerCase().includes(q) || r.key.includes(q) || r.category.includes(q) || r.title.ar.includes(filter.trim()));
  }, [rows, filter]);
  const saved = (row: TemplateMusicRow) => setRows((cur) => (cur ?? []).map((r) => (r.key === row.key ? row : r)));
  const customised = (rows ?? []).filter((r) => r.effective.customised).length;

  return (
    <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3" data-testid="admin-template-music">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">Template music</p>
          <p className="text-xs text-zinc-400">
            The music each template recommends. The first track is what a video from the template starts with; academies see all of them
            under &quot;Recommended&quot; in the editor.{rows ? ` ${customised} of ${rows.length} customised.` : ""}
          </p>
        </div>
        <input className={`${field} w-full sm:w-56`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a template" aria-label="Find a template" />
      </div>
      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
      {!rows || !tracks ? <p className="text-sm text-zinc-500">Loading…</p> : (
        <ul className="space-y-2">
          {shown.map((r) => (
            <TemplateRow key={r.key} row={r} call={call} active={active} all={tracks} playing={playing} onPlay={onPlay} onSaved={saved} />
          ))}
          {shown.length === 0 ? <li className="text-sm text-zinc-500">No template matches.</li> : null}
        </ul>
      )}
    </section>
  );
}

function TemplateRow({ row, call, active, all, playing, onPlay, onSaved }: {
  row: TemplateMusicRow; call: Call; active: MusicTrack[]; all: MusicTrack[]; playing: number | null;
  onPlay: (t: MusicTrack) => void; onSaved: (r: TemplateMusicRow) => void;
}) {
  const activeIds = useMemo(() => new Set(active.map((t) => t.trackId)), [active]);
  const byId = useMemo(() => new Map(all.map((t) => [t.trackId, t])), [all]);
  const initial = useMemo(() => draftOf(row, activeIds), [row, activeIds]);
  const [draft, setDraft] = useState<Draft>(initial);
  useEffect(() => setDraft(initial), [initial]);
  const [mood, setMood] = useState<MusicMood | "">("");
  const [adding, setAdding] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const custom = row.effective.customised;
  const savedList = row.saved ?? row.builtIn;
  const skipped = savedList.trackIds.filter((id) => !activeIds.has(id)).length;
  const missingKeys = row.saved ? 0 : row.builtIn.keys.length - row.builtIn.trackIds.length;
  const first = byId.get(row.effective.trackIds[0] ?? -1);
  const options = active.filter((t) => !draft.trackIds.includes(t.trackId) && (!mood || t.mood === mood));

  const move = (i: number, by: -1 | 1) => setDraft((d) => {
    const ids = [...d.trackIds];
    const j = i + by;
    if (j < 0 || j >= ids.length) return d;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    return { ...d, trackIds: ids };
  });
  const add = () => {
    const id = Number(adding);
    if (!id || draft.trackIds.length >= TEMPLATE_MUSIC_MAX_TRACKS) return;
    setDraft((d) => ({ ...d, trackIds: [...d.trackIds, id] }));
    setAdding("");
  };
  const send = async (method: "PUT" | "DELETE") => {
    setError(null);
    setNote(null);
    let body: string | undefined;
    if (method === "PUT") {
      const out = draftBody(draft);
      if ("error" in out) { setError(out.error); return; }
      body = JSON.stringify(out.body);
    }
    setBusy(true);
    try {
      const r = await call<{ template: TemplateMusicRow }>(`/admin/creative/music/templates/${row.key}`, { method, body });
      onSaved(r.template);
      setNote(method === "PUT" ? "Saved." : "Back to Replay's recommendation.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-950/60" data-testid={`admin-template-music-${row.key}`}>
      <details>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 p-3">
          <span className="font-semibold text-white">{row.title.en}</span>
          <span className="text-xs text-zinc-500">{row.category} · {row.formats.join(", ")}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${row.kind === "video" ? "bg-violet-500/20 text-violet-300" : "bg-zinc-800 text-zinc-400"}`}>
            {row.kind === "video" ? "Video" : "Still"}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${custom ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/15 text-emerald-300"}`}
            data-testid={`admin-template-music-badge-${row.key}`}>
            {custom ? "Customised" : "Replay's pick"}
          </span>
          <span className="ms-auto max-w-full truncate text-xs text-zinc-400">
            {first ? `▶ ${first.title}` : "No music"}{row.effective.trackIds.length > 1 ? ` +${row.effective.trackIds.length - 1}` : ""}
          </span>
        </summary>

        <div className="space-y-3 border-t border-zinc-800 p-3">
          {row.kind === "image" ? (
            <p className="text-[11px] text-zinc-500">A still: the music is used when a design from it becomes a video.</p>
          ) : null}
          {row.effective.fallback && first ? (
            <p className="text-xs text-amber-400">None of these tracks is available, so videos get “{first.title}” ({first.mood}) instead.</p>
          ) : null}
          {skipped + missingKeys > 0 ? (
            <p className="text-xs text-amber-400">{skipped + missingKeys} track{skipped + missingKeys === 1 ? " is" : "s are"} hidden or missing and skipped.</p>
          ) : null}

          {draft.trackIds.length === 0 ? (
            <p className="text-sm text-zinc-400">No music: videos from this template start without a soundtrack.</p>
          ) : (
            <ol className="space-y-1.5">
              {draft.trackIds.map((id, i) => {
                const t = byId.get(id);
                return (
                  <li key={id} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
                    <span className="w-5 text-center font-mono text-xs text-zinc-500">{i + 1}</span>
                    <button type="button" className={small} disabled={!t} onClick={() => t && onPlay(t)}>{playing === id ? "Pause" : "Play"}</button>
                    <span className="min-w-0 flex-1 truncate text-sm text-white">
                      {t?.title ?? `Track ${id}`}
                      <span className="ms-2 text-xs text-zinc-500">{t ? `${t.mood} · ${length(t.durationMs)}` : ""}{i === 0 ? " · plays first" : ""}</span>
                    </span>
                    <div className="flex gap-1">
                      <button type="button" className={small} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                      <button type="button" className={small} disabled={i === draft.trackIds.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                      <button type="button" className={`${small} hover:text-red-300`} onClick={() => setDraft((d) => ({ ...d, trackIds: d.trackIds.filter((x) => x !== id) }))}
                        aria-label="Remove" data-testid={`admin-template-music-remove-${row.key}-${id}`}>✕</button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <select className={field} value={mood} onChange={(e) => setMood(e.target.value as MusicMood | "")} aria-label="Mood filter">
              <option value="">All moods</option>
              {MUSIC_MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select className={`${field} min-w-0 flex-1`} value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Track to add"
              disabled={draft.trackIds.length >= TEMPLATE_MUSIC_MAX_TRACKS}>
              <option value="">{draft.trackIds.length >= TEMPLATE_MUSIC_MAX_TRACKS ? `At most ${TEMPLATE_MUSIC_MAX_TRACKS} tracks` : "Add a track…"}</option>
              {options.map((t) => <option key={t.trackId} value={t.trackId}>{t.title} ({t.mood}, {length(t.durationMs)})</option>)}
            </select>
            <button type="button" className={small} disabled={!adding} onClick={add} data-testid={`admin-template-music-add-${row.key}`}>Add</button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="col-span-2 flex flex-col gap-1 text-xs text-zinc-400">
              <span>Volume {Math.round(draft.volume * 100)}%</span>
              <input type="range" min={0} max={100} value={Math.round(draft.volume * 100)} onChange={(e) => setDraft({ ...draft, volume: Number(e.target.value) / 100 })} aria-label="Volume" />
            </label>
            <label className="col-span-2 flex items-center gap-2 text-sm text-zinc-200">
              <input type="checkbox" checked={draft.duck} onChange={(e) => setDraft({ ...draft, duck: e.target.checked })} />
              Lower under voices
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">Fade in (s)
              <input className={field} inputMode="decimal" value={draft.fadeIn} onChange={(e) => setDraft({ ...draft, fadeIn: e.target.value })} aria-label="Fade in seconds" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">Fade out (s)
              <input className={field} inputMode="decimal" value={draft.fadeOut} onChange={(e) => setDraft({ ...draft, fadeOut: e.target.value })} aria-label="Fade out seconds" />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-xs text-zinc-400">Start point (s into the track)
              <input className={field} inputMode="decimal" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} aria-label="Start point seconds" />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!dirty || busy} onClick={() => void send("PUT")}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" data-testid={`admin-template-music-save-${row.key}`}>
              Save
            </button>
            {custom ? (
              <button type="button" disabled={busy} onClick={() => void send("DELETE")} className={`${small} px-3 py-1.5`} data-testid={`admin-template-music-reset-${row.key}`}>
                Reset to Replay&apos;s recommendation
              </button>
            ) : null}
            {dirty ? <button type="button" disabled={busy} onClick={() => setDraft(initial)} className={`${small} px-3 py-1.5`}>Undo changes</button> : null}
            {row.updatedAt && custom ? <span className="text-[11px] text-zinc-500">Saved {new Date(row.updatedAt).toLocaleString()}</span> : null}
          </div>
          {note ? <p className="text-xs text-emerald-400">{note}</p> : null}
          {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
        </div>
      </details>
    </li>
  );
}
