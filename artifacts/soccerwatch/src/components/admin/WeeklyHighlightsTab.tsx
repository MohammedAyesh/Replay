import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Loader2, Send } from "lucide-react";
import { useTranslation } from "@/i18n";
import {
  getWeeklyHighlightCandidates, listWeeklyHighlightNotices,
  markWeeklyHighlightNoticeCopied, publishWeeklyHighlights, saveWeeklyHighlightPicks,
  type WeeklyHighlightCandidates, type WeeklyHighlightCandidateClip,
  type WeeklyHighlightNotice,
} from "@workspace/api-client-react";

type Pick = { clipId: number; eventType: "goal" | "assist" | "save" | "tackle"; minute: number | null; youX: number | null; youY: number | null };
type Clip = WeeklyHighlightCandidateClip;
type Candidates = WeeklyHighlightCandidates;
type Notice = WeeklyHighlightNotice;
const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const saturday = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const day = new Date(`${map.year}-${map.month}-${map.day}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 1) % 7));
  return day.toISOString().slice(0, 10);
};
const initialPick = (clip: Clip): Pick => {
  const title = clip.title.toLowerCase();
  const eventType = title.includes("assist") ? "assist" : title.includes("save") ? "save" : title.includes("tackle") ? "tackle" : "goal";
  const minute = Number(clip.title.match(/\b(\d{1,3})\s*['’′]/)?.[1]);
  return { clipId: clip.id, eventType, minute: Number.isFinite(minute) ? minute : null, youX: null, youY: null };
};

export function WeeklyHighlightsTab() {
  const { t, locale } = useTranslation();
  const copy = t.weeklyHighlights;
  const [weekStart, setWeekStart] = useState(() => saturday(new Date()));
  const [data, setData] = useState<Candidates | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selected, setSelected] = useState<Record<number, Pick[]>>({});
  const [goals, setGoals] = useState<Record<number, Pick | null>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Asia/Amman" }), [locale]);
  const dateLabel = fmt.format(new Date(`${weekStart}T12:00:00Z`));

  const load = async () => {
    setError("");
    setMessage("");
    try {
      const [candidates, queued] = await Promise.all([
        getWeeklyHighlightCandidates({ weekStart }),
        listWeeklyHighlightNotices(),
      ]);
      setData(candidates);
      setNotices(queued);
      setSelected(Object.fromEntries(candidates.saved.filter((x) => x.userId != null).map((x) => [x.userId!, x.clips.map((p) => ({ ...p, minute: p.minute ?? null, youX: p.youX ?? null, youY: p.youY ?? null }))])));
      setGoals(Object.fromEntries(candidates.saved.filter((x) => x.userId == null).map((x) => [x.fieldId, x.clips[0] ? { ...x.clips[0], minute: x.clips[0].minute ?? null, youX: x.clips[0].youX ?? null, youY: x.clips[0].youY ?? null } : null])));
    } catch { setError(copy.error); }
  };
  useEffect(() => { void load(); }, [weekStart]);

  const toggle = (userId: number, clip: Clip) => setSelected((prev) => {
    const current = prev[userId] ?? [];
    const existing = current.find((p) => p.clipId === clip.id);
    return { ...prev, [userId]: existing ? current.filter((p) => p.clipId !== clip.id) : current.length >= 3 ? current : [...current, initialPick(clip)] };
  });
  const submitPicks = async (publish: boolean) => {
    if (!data) return;
    if (publish && data.players.some((player) => player.clips.length > 0 && !(selected[player.userId]?.length))) {
      setError(copy.players); return;
    }
    if (publish && data.fields.some((field) => !goals[field.id])) {
      setError(copy.goalOfWeek); return;
    }
    setBusy(true); setError("");
    try {
      const personal = Object.entries(selected).filter(([, clips]) => clips.length).map(([userId, clips]) => ({
        userId: Number(userId), fieldId: data.players.find((p) => p.userId === Number(userId))?.clips.find((c) => clips.some((pick) => pick.clipId === c.id))?.fieldId ?? 0, clips,
      }));
      const fields = Object.entries(goals).filter((entry): entry is [string, Pick] => entry[1] != null).map(([fieldId, pick]) => ({ fieldId: Number(fieldId), clips: [pick] }));
      if (personal.some((group) => group.fieldId <= 0)) throw new Error(copy.error);
      const payload = { weekStart, personal, fields };
      if (publish) await publishWeeklyHighlights(payload);
      else await saveWeeklyHighlightPicks(payload);
      setMessage(publish ? copy.published : copy.saved);
      if (publish) await load();
    } catch (e) { setError(e instanceof Error ? e.message : copy.error); }
    setBusy(false);
  };
  const savePicks = () => submitPicks(false);
  const publish = () => submitPicks(true);
  const copyNotice = async (notice: Notice) => {
    const link = `${window.location.origin}${base}${notice.url}`;
    await navigator.clipboard.writeText(`${notice.message}\n${link}`);
    await markWeeklyHighlightNoticeCopied(notice.id);
    setNotices((items) => items.map((item) => item.id === notice.id ? { ...item, status: "copied" } : item));
  };
  const eventOptions = ["goal", "assist", "save", "tackle"] as const;
  const editPick = (userId: number, clipId: number, key: keyof Pick, value: string) =>
    setSelected((prev) => ({ ...prev, [userId]: (prev[userId] ?? []).map((p) => p.clipId === clipId ? { ...p, [key]: key === "eventType" ? value : value === "" ? null : Number(value) } as Pick : p) }));

  return <div className="space-y-5 text-text" dir={locale === "ar" ? "rtl" : "ltr"}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-display text-2xl font-black">{copy.title}</h2>
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2">
        <button onClick={() => setWeekStart((d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 7); return x.toISOString().slice(0, 10); })} aria-label={copy.previous} className="rounded-lg p-2 hover:bg-raised"><ChevronLeft /></button>
        <span className="text-sm">{copy.week}: {dateLabel}</span>
        <button onClick={() => setWeekStart((d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 7); return x.toISOString().slice(0, 10); })} aria-label={copy.next} className="rounded-lg p-2 hover:bg-raised"><ChevronRight /></button>
      </div>
    </header>
    {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>}
    {message && <p role="status" aria-live="polite" className="rounded-xl border border-turf/30 bg-turf/10 p-3 text-sm">{message}</p>}
    {!data ? <Loader2 className="animate-spin text-turf" /> : <>
      <section className="space-y-3">
        <h3 className="font-semibold">{copy.players}</h3>
        {data.players.map((player) => <article key={player.userId} className="rounded-2xl border border-line bg-surface p-4">
          <h4 className="font-semibold">{player.name}</h4>
          <div className="mt-3 grid gap-2">
            {player.clips.map((clip) => {
              const selectedClip = (selected[player.userId] ?? []).some((p) => p.clipId === clip.id);
              const pick = (selected[player.userId] ?? []).find((p) => p.clipId === clip.id);
              const selectionNumber = (selected[player.userId] ?? []).findIndex((p) => p.clipId === clip.id) + 1;
              return <div key={clip.id} className="rounded-xl bg-raised p-3">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedClip} onChange={() => toggle(player.userId, clip)} />{selectedClip && <span className="grid size-6 place-items-center rounded-full bg-floodlight text-xs font-black text-void">{selectionNumber}</span>}{clip.title} · {clip.durationSec}s</label>
                {pick && <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <select aria-label={copy.event} value={pick.eventType} onChange={(e) => editPick(player.userId, clip.id, "eventType", e.target.value)} className="rounded-lg border border-line bg-surface p-2 text-xs">{eventOptions.map((event) => <option key={event} value={event}>{copy[event]}</option>)}</select>
                  <input aria-label={copy.minute} type="number" min="0" value={pick.minute ?? ""} placeholder={copy.minute} onChange={(e) => editPick(player.userId, clip.id, "minute", e.target.value)} className="rounded-lg border border-line bg-surface p-2 text-xs" />
                  <input aria-label={copy.youX} type="number" min="0" max="1" step="0.01" placeholder={copy.youX} value={pick.youX ?? ""} onChange={(e) => editPick(player.userId, clip.id, "youX", e.target.value)} className="rounded-lg border border-line bg-surface p-2 text-xs" />
                  <input aria-label={copy.youY} type="number" min="0" max="1" step="0.01" placeholder={copy.youY} value={pick.youY ?? ""} onChange={(e) => editPick(player.userId, clip.id, "youY", e.target.value)} className="rounded-lg border border-line bg-surface p-2 text-xs" />
                </div>}
              </div>;
            })}
            {!player.clips.length && <p className="text-sm text-muted-text">{copy.empty}</p>}
          </div>
        </article>)}
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">{copy.goalOfWeek}</h3>
        {data.fields.map((field) => <label key={field.id} className="grid gap-2 rounded-2xl border border-line bg-surface p-4 text-sm">
          <span>{field.name}</span>
          <select value={goals[field.id]?.clipId ?? ""} onChange={(e) => setGoals((g) => ({ ...g, [field.id]: field.clips.find((c) => c.id === Number(e.target.value)) ? initialPick(field.clips.find((c) => c.id === Number(e.target.value))!) : null }))} className="rounded-lg border border-line bg-raised p-2">
            <option value="">{copy.selectClip}</option>{field.clips.map((clip) => <option key={clip.id} value={clip.id}>{clip.title} · {clip.durationSec}s</option>)}
          </select>
        </label>)}
      </section>
      <div className="flex flex-wrap gap-2"><button disabled={busy} onClick={savePicks} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-5 font-bold disabled:opacity-50">{copy.savePicks}</button><button disabled={busy} onClick={publish} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-floodlight px-5 font-bold text-void disabled:opacity-50">{busy ? <Loader2 className="animate-spin" /> : <Send className="size-4" />}{copy.publish}</button></div>
      <section className="space-y-2">
        <h3 className="font-semibold">{copy.notice}</h3>
        {notices.map((notice) => <div key={notice.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3 text-sm"><span>{notice.userName} · {notice.message}</span><button onClick={() => void copyNotice(notice)} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2"><Copy className="size-4" />{notice.status === "copied" ? copy.copied : copy.copy}</button></div>)}
      </section>
    </>}
  </div>;
}
