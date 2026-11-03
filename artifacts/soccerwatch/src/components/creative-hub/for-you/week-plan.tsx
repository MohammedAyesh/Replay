import { useMemo, useState } from "react";
import { CalendarDays, Check, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMarketingCopy } from "@/i18n/marketing-strings";
import { CALENDAR_KINDS, ammanToday, planWeek, useContentCalendar, useSaveContentCalendar, type CalendarKind, type CalendarSlot } from "@/lib/academy-trials-api";
import type { ForYouDraft } from "@/lib/creative-hub-foryou-api";
import { cn } from "@/lib/utils";

/**
 * Creative hub → For you → "This week": the owner's posting calendar for the
 * next seven days, each slot filled from the drafts Replay prepared. Editable:
 * one kind per day (or nothing).
 */
export function WeekPlan({ academyId, drafts, onOpen, today = ammanToday() }: { academyId: number; drafts: ForYouDraft[]; onOpen: (id: number) => void; today?: string }) {
  const c = useMarketingCopy().calendar;
  const locale = useMarketingCopy().locale;
  const calendar = useContentCalendar(academyId);
  const save = useSaveContentCalendar(academyId);
  const [editing, setEditing] = useState(false);
  const slots = calendar.data?.slots ?? [];
  const week = useMemo(
    () => planWeek(slots, drafts.map((d) => ({ id: d.id, kind: d.reason.kind, startsAt: d.reason.startsAt, title: d.title })), today),
    [slots, drafts, today],
  );
  if (calendar.isLoading || calendar.isError) return null;
  const dateLabel = (iso: string) => new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  const kindOn = (day: number) => slots.find((s) => s.day === day)?.kind ?? "";
  const setDay = (day: number, kind: CalendarKind | "") => {
    const next: CalendarSlot[] = [...slots.filter((s) => s.day !== day), ...(kind ? [{ day, kind }] : [])];
    save.mutate(next);
  };

  return (
    <section className="rounded-2xl border border-line bg-surface p-4" data-testid="week-plan">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-display text-lg font-bold text-text"><CalendarDays className="h-5 w-5 text-turf" aria-hidden />{c.title}</h2>
          <p className="mt-0.5 text-xs text-muted-text">{c.hint}</p>
        </div>
        <div className="flex gap-1">
          {editing && !calendar.data?.isDefault && (
            <Button type="button" size="sm" variant="ghost" className="h-8" disabled={save.isPending} onClick={() => save.mutate(null)} data-testid="week-plan-reset"><RotateCcw className="h-4 w-4" aria-hidden />{c.reset}</Button>
          )}
          <Button type="button" size="sm" variant="outline" className="h-8 rounded-xl" onClick={() => setEditing(!editing)} data-testid="week-plan-edit">
            {editing ? <Check className="h-4 w-4" aria-hidden /> : <Pencil className="h-4 w-4" aria-hidden />}{editing ? c.done : c.edit}
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="week-plan-editor">
          {c.days.map((name, day) => (
            <label key={day} className="flex items-center justify-between gap-2 rounded-xl bg-raised px-3 py-2 text-sm">
              <span className="font-semibold text-text">{name}</span>
              <select value={kindOn(day)} disabled={save.isPending} onChange={(e) => setDay(day, e.target.value as CalendarKind | "")} className="h-8 rounded-lg border border-input bg-surface px-2 text-xs text-text" data-testid={`week-plan-day-${day}`}>
                <option value="">{c.none}</option>
                {CALENDAR_KINDS.map((k) => <option key={k} value={k}>{c.kinds[k]}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : (
        <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {week.map((d) => (
            <li key={d.date} className={cn("min-h-24 rounded-xl border p-2.5", d.slots.length ? "border-line bg-raised" : "border-dashed border-line/60")} data-testid={`week-plan-${d.date}`}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-text">{c.days[d.day]} · <bdi>{dateLabel(d.date)}</bdi></p>
              {d.slots.map((s) => (
                <div key={s.kind} className="mt-1.5">
                  <p className="text-xs font-semibold text-turf">{c.kinds[s.kind]}</p>
                  {s.draft ? (
                    <button type="button" onClick={() => onOpen(s.draft!.id)} className="mt-0.5 line-clamp-2 text-start text-xs text-text underline-offset-4 hover:underline" dir="auto">{s.draft.title}</button>
                  ) : <p className="mt-0.5 text-xs text-muted-text">{c.nothing}</p>}
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
