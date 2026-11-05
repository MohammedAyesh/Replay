import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ExternalLink, Film, Image as ImageIcon, Instagram, Plus, ShieldCheck, SkipForward, Undo2, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAcademyInstagramCopy } from "@/i18n/academy-instagram-strings";
import { apiUrl } from "@/lib/academy-studio-api";
import {
  useAcademyInstagram,
  useAcademyInstagramActions,
  useAcademyInstagramToday,
  type AcademyIgAction,
  type AcademyIgItem,
  type AcademyIgPlacement,
  type AcademyIgSuggestion,
  type AcademyIgTimes,
} from "@/lib/academy-instagram-api";
import { ammanToday, clock, dayName } from "@/lib/venue-api";
import { cn } from "@/lib/utils";

/**
 * Academy console → Social → Autopilot: the switch, approve-first or automatic, the day's times
 * for posts, Reels and Stories, the suggestions (designs not on the calendar), and the calendar.
 */
export function AcademyInstagramAutopilot({ academyId }: { academyId: number }) {
  const copy = useAcademyInstagramCopy();
  const q = useAcademyInstagram(academyId);
  const act = useAcademyInstagramActions(academyId);
  if (q.isLoading) return <div className="h-48 animate-pulse rounded-2xl bg-raised" />;
  if (q.isError || !q.data) return <p className="text-sm text-red-400" role="alert">{(q.error as Error | null)?.message}</p>;
  const d = q.data;
  const s = d.settings;
  return (
    <div className="space-y-4" data-testid="academy-ig-autopilot">
      <div className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-2xl">
            <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><Instagram className="h-5 w-5 text-turf" aria-hidden="true" />{copy.title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-text">{copy.description}</p>
          </div>
          <label className="flex items-center gap-3">
            <span className="text-sm font-semibold text-text">{copy.on}</span>
            <Switch checked={s.enabled} disabled={act.settings.isPending} onCheckedChange={(v) => act.settings.mutate({ enabled: v })} data-testid="switch-academy-ig" />
          </label>
        </div>
        {!d.instagram.connected ? <p className="mt-3 rounded-xl bg-amber-200/10 p-3 text-sm text-amber-200" role="alert">{copy.notConnected}</p> : null}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <div className="grid gap-1.5">
              {(["approve", "auto"] as const).map((m) => (
                <button key={m} type="button" disabled={act.settings.isPending} onClick={() => act.settings.mutate({ publishMode: m })}
                  className={cn("min-h-10 rounded-xl border px-3 text-start text-sm font-semibold", s.publishMode === m ? "border-turf bg-turf/10 text-turf" : "border-line bg-raised text-muted-text")}
                  data-testid={`academy-ig-mode-${m}`}>
                  {m === "approve" ? copy.approve : copy.auto}
                </button>
              ))}
            </div>
            <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-text"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-turf" aria-hidden="true" />{copy.consent}</p>
          </div>
          <Times key={JSON.stringify(s.times)} times={s.times} busy={act.settings.isPending} onSave={(times) => act.settings.mutate({ times })} saved={act.settings.isSuccess} />
        </div>
        {act.settings.error ? <p className="mt-2 text-sm text-red-400" role="alert">{(act.settings.error as Error).message}</p> : null}
      </div>

      <div className="rounded-2xl border border-line bg-surface p-5" data-testid="academy-ig-suggestions">
        <h3 className="font-display text-lg font-bold text-text">{copy.suggestions}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-text">{copy.suggestionsHint}</p>
        <div className="mt-3"><Suggestions academyId={academyId} list={d.suggestions} /></div>
      </div>

      <Calendar academyId={academyId} items={d.items} auto={s.publishMode === "auto"} />
    </div>
  );
}

function Times({ times, busy, onSave, saved }: { times: AcademyIgTimes; busy: boolean; onSave: (t: AcademyIgTimes) => void; saved: boolean }) {
  const copy = useAcademyInstagramCopy();
  const [t, setT] = useState<AcademyIgTimes>(times);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setT(times); setDirty(false); }, [times]);
  const set = (k: AcademyIgPlacement, list: string[]) => { setT({ ...t, [k]: list }); setDirty(true); };
  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3" data-testid="academy-ig-times">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-text"><CalendarClock className="h-4 w-4 text-turf" aria-hidden="true" />{copy.times}</p>
      <div className="mt-2 space-y-2">
        {(["feed", "reel", "story"] as const).map((k) => (
          <div key={k} className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="w-16 text-muted-text">{copy.kinds[k]}</span>
            {t[k].map((time, i) => (
              <span key={i} className="flex items-center">
                <Input type="time" step={900} value={time} dir="ltr" aria-label={copy.kinds[k]} className="min-h-9 w-[7rem]"
                  onChange={(e) => set(k, t[k].map((x, j) => (j === i ? e.target.value : x)))} />
                <button type="button" aria-label="×" onClick={() => set(k, t[k].filter((_, j) => j !== i))} className="px-1 text-muted-text hover:text-text"><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            {t[k].length < 4 ? <button type="button" onClick={() => set(k, [...t[k], k === "story" ? "12:00" : "19:00"])} className="text-xs font-semibold text-turf">+ {copy.add}</button> : null}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy || !dirty} onClick={() => { onSave(t); setDirty(false); }} data-testid="academy-ig-times-save">{copy.save}</Button>
        {saved && !dirty ? <span className="text-xs font-semibold text-turf" role="status">{copy.saved}</span> : null}
      </div>
    </div>
  );
}

function Thumb({ item }: { item: { kind: string; renderStatus: string; outputUrl: string | null } | null }) {
  const Icon = item?.kind === "video" ? Film : ImageIcon;
  if (item?.outputUrl && item.kind === "image" && item.renderStatus === "done") return <img src={apiUrl(item.outputUrl)} alt="" className="h-14 w-11 shrink-0 rounded-lg bg-raised object-cover" />;
  return <span className="grid h-14 w-11 shrink-0 place-items-center rounded-lg bg-turf/10 text-turf"><Icon className="h-4 w-4" aria-hidden="true" /></span>;
}

export function Suggestions({ academyId, list, compact }: { academyId: number; list: AcademyIgSuggestion[]; compact?: boolean }) {
  const copy = useAcademyInstagramCopy();
  const act = useAcademyInstagramActions(academyId);
  if (!list.length) return <p className="text-sm text-muted-text">{copy.suggestionsEmpty}</p>;
  return (
    <>
      <ul className={cn("grid gap-2", !compact && "md:grid-cols-2")} data-testid="academy-ig-suggestion-list">
        {list.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-xl border border-dashed border-line bg-raised/40 p-2.5" data-testid={`academy-ig-suggestion-${p.id}`}>
            <Thumb item={p} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-text" dir="auto">{p.title || copy.fromYou}</span>
              <span className="block text-xs text-muted-text">{copy.kinds[p.placement]} · {p.origin === "auto" ? copy.fromReplay : copy.fromYou}</span>
            </span>
            <Button type="button" size="sm" variant="outline" disabled={act.add.isPending} onClick={() => act.add.mutate(p.id)} data-testid={`academy-ig-add-${p.id}`}>
              <Plus className="me-1 h-3.5 w-3.5" aria-hidden="true" />{copy.addNow}
            </Button>
          </li>
        ))}
      </ul>
      {act.add.error ? <p className="mt-2 text-sm text-red-400" role="alert">{(act.add.error as Error).message}</p> : null}
    </>
  );
}

function Calendar({ academyId, items, auto }: { academyId: number; items: AcademyIgItem[]; auto: boolean }) {
  const copy = useAcademyInstagramCopy();
  const today = ammanToday();
  const days = useMemo(() => {
    const by = new Map<string, AcademyIgItem[]>();
    for (const i of items) {
      if (i.status === "skipped" && !i.slotLocal) continue;
      const d = i.slotLocal?.slice(0, 10) ?? "waiting";
      if (d !== "waiting" && d < today && i.status !== "published") continue;
      by.set(d, [...(by.get(d) ?? []), i]);
    }
    return [...by.entries()].sort(([a], [b]) => (a === "waiting" ? 1 : b === "waiting" ? -1 : a.localeCompare(b)));
  }, [items, today]);
  return (
    <div className="rounded-2xl border border-line bg-surface p-5" data-testid="academy-ig-calendar">
      <h3 className="font-display text-lg font-bold text-text">{copy.calendar}</h3>
      {!days.length ? <p className="mt-2 text-sm text-muted-text">{copy.calendarEmpty}</p> : (
        <div className="mt-3 space-y-4">
          {days.map(([day, list]) => (
            <div key={day}>
              <p className="text-xs font-bold uppercase tracking-wide text-muted-text">{day === "waiting" ? copy.waiting : day === today ? copy.today : dayName(day, copy.locale, "long")}</p>
              <ul className="mt-2 space-y-2">{list.map((i) => <ItemRow key={i.id} academyId={academyId} item={i} auto={auto} />)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemRow({ academyId, item, auto }: { academyId: number; item: AcademyIgItem; auto: boolean }) {
  const copy = useAcademyInstagramCopy();
  const act = useAcademyInstagramActions(academyId);
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState(item.slotLocal?.replace(" ", "T") ?? "");
  const waiting = item.status === "planned" || item.status === "approved";
  const run = (action: AcademyIgAction) => act.action.mutate({ id: item.id, action });
  const actions: Array<[AcademyIgAction, typeof Check]> = item.status === "planned" ? [["approve", Check], ["now", Zap], ["skip", SkipForward]]
    : item.status === "approved" ? [["unapprove", Undo2], ["now", Zap], ["skip", SkipForward]]
    : item.status === "skipped" || item.status === "failed" ? [["restore", Undo2]] : [];
  return (
    <li className="rounded-xl border border-line bg-raised/40 p-2.5" data-testid={`academy-ig-item-${item.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Thumb item={item.project} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text" dir="auto">{item.project?.title || copy.fromYou}</span>
          <span className="block text-xs text-muted-text">
            {item.slotLocal ? <bdi>{clock(item.slotLocal, copy.locale)}</bdi> : null}{item.slotLocal ? " · " : ""}{copy.kinds[item.placement]} · {item.status === "planned" && auto ? copy.plannedAuto : copy.status[item.status]}
          </span>
          {item.error && item.status !== "published" ? <span className="block text-xs text-amber-200" dir="auto">{copy.errors[item.error] ?? item.error}</span>
            : waiting && (item.project?.renderStatus === "queued" || item.project?.renderStatus === "rendering") ? <span className="block text-xs text-muted-text">{copy.rendering}</span> : null}
        </span>
        <span className="flex flex-wrap gap-1">
          {actions.map(([a, Icon]) => (
            <button key={a} type="button" disabled={act.action.isPending} onClick={() => run(a)} data-testid={`academy-ig-${a}-${item.id}`}
              className={cn("inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold", a === "approve" ? "border-turf bg-turf/10 text-turf" : "border-line text-muted-text hover:text-text")}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />{copy.actions[a]}
            </button>
          ))}
          {waiting ? <button type="button" onClick={() => setMoving(!moving)} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line px-2.5 text-xs font-semibold text-muted-text hover:text-text">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />{copy.move}
          </button> : null}
          {item.igPermalink ? <a href={item.igPermalink} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 px-1 text-xs font-semibold text-turf"><ExternalLink className="h-3.5 w-3.5" />{copy.open}</a> : null}
        </span>
      </div>
      {moving ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input type="datetime-local" step={900} value={when} onChange={(e) => setWhen(e.target.value)} dir="ltr" className="min-h-9 w-auto" />
          <Button type="button" size="sm" disabled={!when || act.move.isPending} onClick={() => act.move.mutate({ id: item.id, slotLocal: when.replace("T", " ").slice(0, 16) }, { onSuccess: () => setMoving(false) })}>{copy.moveSave}</Button>
          {act.move.error ? <span className="text-xs text-red-400" role="alert">{(act.move.error as Error).message}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Overview → "Instagram today": what goes out today and the next suggestions. Owner only. */
export function AcademyInstagramToday({ academyId, onOpen }: { academyId: number; onOpen: () => void }) {
  const copy = useAcademyInstagramCopy();
  const q = useAcademyInstagramToday(academyId);
  const t = q.data;
  if (!t) return null;
  const needsOk = t.publishMode === "approve" ? t.items.filter((i) => i.status === "planned").length : 0;
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="academy-dashboard-instagram">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><Instagram className="h-5 w-5 text-turf" aria-hidden="true" />{copy.todayTitle}</h2>
        {!t.enabled ? <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-bold text-muted-text">{copy.todayOff}</span> : null}
      </div>
      {t.items.length === 0 ? <p className="mt-3 text-sm text-muted-text">{copy.todayNone}</p> : (
        <ol className="mt-3 space-y-1.5">
          {t.items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 text-sm">
              <span className="w-[4.5rem] shrink-0 whitespace-nowrap font-display font-bold tabular-nums text-text">{i.slotLocal ? clock(i.slotLocal, copy.locale) : "—"}</span>
              <span className="min-w-0 flex-1 truncate text-text" dir="auto">{i.project?.title || copy.fromYou}</span>
              <span className="text-xs text-muted-text">{copy.status[i.status]}</span>
            </li>
          ))}
        </ol>
      )}
      {needsOk > 0 ? <button type="button" onClick={onOpen} className="mt-3 text-sm font-semibold text-amber-200 underline-offset-2 hover:underline">{copy.needsOk(needsOk)}</button> : null}
      <p className="mt-4 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.suggestions}</p>
      <div className="mt-2"><Suggestions academyId={academyId} list={t.suggestions} compact /></div>
      <Button type="button" size="sm" variant="ghost" className="mt-3" onClick={onOpen}>{copy.openAutopilot}</Button>
    </section>
  );
}
