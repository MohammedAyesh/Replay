import { useEffect, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { useCoachCopy } from "@/i18n/coach-strings";
import { type CoachLiveTag, type CoachTagPreset, useCoachTagActions, useCoachTags } from "@/lib/academy-coach-api";
import { QUICK_PRESETS } from "@/lib/coach-board";
import { cn } from "@/lib/utils";

/**
 * Tag moments from the touchline: one big button marks "now" during the session. The coach can
 * then say who it was and how it went, or leave it for later. Each tag waits in Coach view as a
 * staff-only moment with the 10 seconds before the tap, to be finished and sent once the video is in.
 */

type Row = CoachLiveTag & { pending?: boolean; failed?: boolean };

const ammanTime = (iso: string | null, seconds = true) => {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false }).format(new Date(iso));
};

export function LiveTagger({ academyId, sessionId, onClose }: { academyId: number; sessionId: number; onClose: () => void }) {
  const copy = useCoachCopy();
  const q = useCoachTags(academyId, sessionId);
  const actions = useCoachTagActions(academyId, sessionId);
  const [now, setNow] = useState(() => new Date());
  const [rows, setRows] = useState<Row[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const tempId = useRef(-1);
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(id); }, []);
  // Server rows, with any not yet saved on top.
  useEffect(() => {
    if (!q.data) return;
    setRows((old) => [...old.filter((r) => r.pending || r.failed), ...q.data.tags]);
  }, [q.data]);

  const lineup = q.data?.lineup ?? [];
  const nameOf = (playerId: number | null) => lineup.find((l) => l.playerId === playerId)?.name ?? null;
  const titleFor = (preset: CoachTagPreset | null, playerId: number | null) => {
    const name = nameOf(playerId);
    const head = preset ? `${copy.quick.presets[preset]} ${copy.quick.emoji[preset]}` : copy.quick.moment;
    return name ? `${head} · ${name}` : head;
  };

  const save = async (row: Row) => {
    try {
      const tag = await actions.create({ at: row.at!, title: row.title });
      setRows((rs) => rs.map((r) => (r.id === row.id ? tag : r)));
      setCurrentId((c) => (c === row.id ? tag.id : c));
      actions.put(tag, row.id);
      // A choice made while the tag was still saving.
      const latest = rowsRef.current.find((r) => r.id === row.id);
      if (latest && (latest.playerId !== null || latest.preset !== null)) {
        const title = titleFor(latest.preset, latest.playerId);
        setRows((rs) => rs.map((r) => (r.id === tag.id ? { ...tag, playerId: latest.playerId, preset: latest.preset, title } : r)));
        await actions.change(tag.id, { playerId: latest.playerId, preset: latest.preset, title });
      }
    } catch {
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, pending: false, failed: true } : r)));
    }
  };
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const tag = () => {
    const at = new Date().toISOString();
    navigator.vibrate?.(40);
    const row: Row = { id: tempId.current--, at, title: copy.quick.moment, playerId: null, preset: null, mine: true, pending: true };
    setRows((rs) => [row, ...rs]);
    setCurrentId(row.id);
    void save(row);
  };

  const change = async (id: number, patch: { playerId?: number | null; preset?: CoachTagPreset | null }) => {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row) return;
    const next = { ...row, ...patch };
    next.title = titleFor(next.preset, next.playerId);
    setRows((rs) => rs.map((r) => (r.id === id ? next : r)));
    if (id < 0) return; // sent with the save
    try {
      await actions.change(id, { playerId: next.playerId, preset: next.preset, title: next.title });
    } catch {
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, failed: true } : r)));
    }
  };

  const remove = async (id: number) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    if (currentId === id) setCurrentId(null);
    if (id > 0) await actions.remove(id).catch(() => q.refetch());
  };

  const current = rows.find((r) => r.id === currentId) ?? null;
  const session = q.data?.session;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-void text-text" data-testid="live-tagger" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button type="button" onClick={onClose} aria-label={copy.close} className="grid h-10 w-10 place-items-center rounded-full text-muted-text hover:bg-raised hover:text-text"><X className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-bold leading-tight">{copy.tag.title}</p>
          <p className="truncate text-xs text-muted-text">{[session?.squadName, session ? ammanTime(session.startsAt, false) : null].filter(Boolean).join(" · ")}</p>
        </div>
        <span className="font-mono text-lg tabular-nums text-muted-text" dir="ltr" data-testid="live-tagger-clock">{ammanTime(now.toISOString())}</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <div className="flex flex-col items-center py-6">
          <button type="button" onClick={tag} disabled={q.isLoading}
            className="grid h-44 w-44 place-items-center rounded-full bg-floodlight text-void shadow-[0_0_0_10px_rgba(212,255,79,0.12)] transition-transform active:scale-95 disabled:opacity-50"
            data-testid="live-tagger-moment">
            <span className="text-center"><span className="block font-display text-3xl font-bold">{copy.tag.button}</span><span className="mx-auto mt-1 block max-w-[8.5rem] text-[11px] font-semibold leading-tight opacity-70">{copy.tag.buttonHint}</span></span>
          </button>
        </div>

        {current && (
          <section className="mx-auto max-w-md rounded-2xl border border-line bg-surface p-3" data-testid="live-tagger-current">
            <p className="text-xs font-semibold text-muted-text"><span className="font-mono" dir="ltr">{ammanTime(current.at)}</span> · {copy.tag.whoAndHow}</p>
            {lineup.length > 0 && (
              <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto" data-testid="live-tagger-who">
                {lineup.map((p) => (
                  <button key={p.playerId} type="button" onClick={() => void change(current.id, { playerId: current.playerId === p.playerId ? null : p.playerId })}
                    aria-pressed={current.playerId === p.playerId} dir="auto"
                    className={cn("h-9 rounded-full px-3 text-sm font-semibold", current.playerId === p.playerId ? "bg-floodlight text-void" : "bg-raised text-muted-text")}>
                    {p.shirtNumber !== null ? `#${p.shirtNumber} ` : ""}{p.name}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 grid grid-cols-3 gap-2">
              {QUICK_PRESETS.map((k) => (
                <button key={k} type="button" onClick={() => void change(current.id, { preset: current.preset === k ? null : k })} aria-pressed={current.preset === k}
                  className={cn("flex flex-col items-center gap-1 rounded-2xl border px-2 py-2.5 text-sm font-bold", current.preset === k ? "border-floodlight bg-floodlight text-void" : "border-line bg-raised text-text")}
                  data-testid={`live-tagger-${k}`}>
                  <span className="text-xl leading-none" aria-hidden>{copy.quick.emoji[k]}</span>{copy.quick.presets[k]}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setCurrentId(null)} className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-muted-text hover:text-text"><Check className="h-4 w-4" />{copy.tag.done}</button>
          </section>
        )}

        <section className="mx-auto mt-5 max-w-md">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.tag.list(rows.length)}</h2>
          {q.isError && <p className="text-sm text-live">{copy.tag.loadFailed}</p>}
          {!rows.length && !q.isLoading && <p className="text-sm text-muted-text">{copy.tag.empty}</p>}
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.id} className={cn("flex items-center gap-2 rounded-xl border px-3 py-2", r.id === currentId ? "border-floodlight/60 bg-floodlight/5" : "border-line")} data-testid="live-tagger-row">
                <button type="button" onClick={() => setCurrentId(r.id)} className="flex min-w-0 flex-1 items-center gap-2 text-start">
                  <span className="font-mono text-xs tabular-nums text-floodlight" dir="ltr">{ammanTime(r.at)}</span>
                  <span className="truncate text-sm font-semibold" dir="auto">{r.title || copy.quick.moment}</span>
                </button>
                {r.pending && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-text" aria-label={copy.quick.sending} />}
                {r.failed && (
                  <button type="button" onClick={() => { setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, failed: false, pending: r.id < 0 } : x))); if (r.id < 0) void save(r); else void change(r.id, {}); }}
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-live"><RotateCcw className="h-3.5 w-3.5" />{copy.tag.retry}</button>
                )}
                <button type="button" onClick={() => void remove(r.id)} aria-label={copy.delete} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-text hover:bg-raised hover:text-live"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-5 text-muted-text">{copy.tag.later}</p>
        </section>
      </div>
    </div>
  );
}
