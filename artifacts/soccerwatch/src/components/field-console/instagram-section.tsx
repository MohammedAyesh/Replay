import { useMemo, useState, type DragEvent } from "react";
import { ArrowLeftRight, CalendarClock, Check, ExternalLink, Eye, Instagram, Pin, ShieldCheck, SkipForward, Trophy, Undo2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { cn } from "@/lib/utils";
import { ammanToday, clock, dayName } from "@/lib/venue-api";
import {
  IG_OPTIONAL_KINDS,
  IG_WEEKLY_KINDS,
  useInstagram,
  useInstagramItem,
  useInstagramReport,
  useInstagramSettings,
  type IgAward,
  type IgItem,
  type IgSlots,
  type IgWeeklyKind,
  type InstagramData,
} from "@/lib/instagram-api";
import { Card, ErrorText, Pill, SectionHeader, Skeleton, ToggleRow } from "./shared";
import { SuggestionList } from "./instagram-suggestions";

/**
 * Field console → Instagram autopilot: the field's consent (read-only, Replay sets it), the
 * owner's switches and calendar times, a 7–14 day rolling calendar he can approve, skip, swap,
 * drag and preview, the weekly awards, and the month's report.
 */
export function InstagramSection({ venueId }: { venueId: number }) {
  const copy = useInstagramCopy();
  const [days, setDays] = useState<7 | 14>(7);
  const data = useInstagram(venueId, days);

  return (
    <div className="space-y-6" data-testid="field-instagram">
      <SectionHeader title={copy.title} description={copy.description} action={
        <div className="flex rounded-full border border-line bg-surface p-1">
          {([7, 14] as const).map((n) => (
            <button key={n} type="button" onClick={() => setDays(n)} className={cn("min-h-9 rounded-full px-3.5 text-xs font-bold", days === n ? "bg-turf/15 text-turf" : "text-muted-text")}>{copy.calendar.days(n)}</button>
          ))}
        </div>
      } />
      {data.isLoading ? <Skeleton rows={4} /> : data.error ? <ErrorText error={data.error} /> : data.data ? <Body venueId={venueId} data={data.data} /> : null}
    </div>
  );
}

function Body({ venueId, data }: { venueId: number; data: InstagramData }) {
  const copy = useInstagramCopy();
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <ConsentCard data={data} />
        <AccountCard data={data} />
        <SettingsCard venueId={venueId} data={data} />
      </div>
      {data.flaggedRemovals.length > 0 && <Removals venueId={venueId} data={data} />}
      <Card data-testid="instagram-suggestions">
        <h2 className="font-display text-lg font-bold text-text">{copy.suggestions.title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-text">{copy.suggestions.hint}</p>
        {data.settings.consentMode === "off" ? <p className="mt-2 text-xs font-semibold text-amber-200">{copy.suggestions.consentOff}</p>
          : !data.settings.autopilot ? <p className="mt-2 text-xs font-semibold text-amber-200">{copy.suggestions.autopilotOff}</p> : null}
        <div className="mt-3"><SuggestionList venueId={venueId} suggestions={data.suggestions ?? []} disabled={data.settings.consentMode === "off"} /></div>
      </Card>
      <Calendar venueId={venueId} data={data} />
      {data.notPosted.length > 0 && (
        <Card>
          <h2 className="font-display text-lg font-bold text-text">{copy.notPosted.title}</h2>
          <p className="mt-1 text-xs text-muted-text">{copy.notPosted.hint}</p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {data.notPosted.map((n) => (
              <li key={n.bookingId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-text"><span className="font-mono font-bold">{n.reference}</span> · {dayName(n.startLocal.slice(0, 10), copy.locale)} {clock(n.startLocal, copy.locale)}</span>
                <span className="text-xs text-muted-text">{copy.locale === "ar" ? n.reasonAr : n.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Awards venueId={venueId} data={data} />
      <Report venueId={venueId} />
    </>
  );
}

function ConsentCard({ data }: { data: InstagramData }) {
  const copy = useInstagramCopy();
  const s = data.settings;
  const [open, setOpen] = useState(false);
  const fmt = (iso: string) => new Date(iso).toLocaleString(copy.locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Amman" });
  return (
    <Card data-testid="instagram-consent">
      <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-turf" /><h2 className="font-display text-lg font-bold text-text">{copy.consent.title}</h2></div>
      <p className="mt-3"><Pill kind={s.consentMode === "off" ? "cancelled" : "confirmed"}>{copy.consent.modes[s.consentMode]}</Pill></p>
      <p className="mt-2 text-sm leading-6 text-muted-text">{copy.consent.modeHelp[s.consentMode]}</p>
      {s.consentSince && <p className="mt-1 text-xs text-muted-text">{copy.consent.since(fmt(s.consentSince))}</p>}
      {s.consentMode === "owner" && s.consentWording && (
        <blockquote className="mt-3 rounded-xl border-s-2 border-turf bg-raised p-3 text-xs leading-5 text-text" dir="auto">
          <span className="mb-1 block font-semibold text-muted-text">{copy.consent.wording}</span>{s.consentWording}
        </blockquote>
      )}
      <p className="mt-3 text-xs leading-5 text-muted-text">{copy.consent.always}</p>
      <p className="mt-2 text-[11px] font-semibold text-muted-text">{copy.consent.set}</p>
      {s.consentHistory.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setOpen(!open)} className="text-xs font-semibold text-turf underline-offset-2 hover:underline">{copy.consent.history} ({s.consentHistory.length})</button>
          {open && (
            <ul className="mt-2 space-y-1 text-xs text-muted-text">
              {s.consentHistory.map((h) => (
                <li key={h.id}>{fmt(h.at)} · {copy.consent.change(h.oldMode ? copy.consent.modes[h.oldMode] : "—", copy.consent.modes[h.newMode])}{h.by ? ` · ${h.by}` : ""}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function AccountCard({ data }: { data: InstagramData }) {
  const copy = useInstagramCopy();
  const a = data.account;
  const pct = Math.min(100, Math.round((a.limit.used / a.limit.total) * 100));
  return (
    <Card data-testid="instagram-account">
      <div className="flex items-center gap-2"><Instagram className="h-4 w-4 text-turf" /><h2 className="font-display text-lg font-bold text-text">{copy.account.title}</h2></div>
      {a.ok ? <p className="mt-3 font-semibold text-text" dir="ltr">{a.username ? copy.account.connected(a.username) : "—"}</p> : (
        <p className="mt-3 rounded-xl border border-[#FF5A3C]/40 bg-[#FF5A3C]/10 p-3 text-sm leading-6 text-[#FF8A73]" role="alert">{a.error}</p>
      )}
      <div className="mt-4">
        <p className="text-xs text-muted-text">{copy.account.limit(a.limit.used, a.limit.total)}</p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised"><div className={cn("h-full rounded-full", a.limit.paused ? "bg-[#FF5A3C]" : "bg-turf")} style={{ width: `${pct}%` }} /></div>
        {a.ok && !a.limitFromMeta && <p className="mt-2 text-[11px] text-muted-text">{copy.account.limitOurs}</p>}
        {a.limit.paused && <p className="mt-2 text-xs text-amber-200">{copy.account.paused}</p>}
      </div>
    </Card>
  );
}

function SettingsCard({ venueId, data }: { venueId: number; data: InstagramData }) {
  const copy = useInstagramCopy();
  const save = useInstagramSettings(venueId);
  const s = data.settings;
  const [slots, setSlots] = useState<IgSlots>(s.slots);
  const [savedAt, setSavedAt] = useState(0);
  const off = s.consentMode === "off";
  const set = <K extends keyof IgSlots>(k: K, v: IgSlots[K]) => setSlots({ ...slots, [k]: v });
  const timeInput = (value: string, onChange: (v: string) => void, label: string) => (
    <Input type="time" step={900} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="min-h-10 w-[7.5rem]" dir="ltr" />
  );
  const daySelect = (value: number, onChange: (v: number) => void, label: string) => (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="min-h-10 rounded-lg border border-input bg-raised px-2 text-sm text-text">
      {copy.settings.days.map((d, i) => <option key={d} value={i}>{d}</option>)}
    </select>
  );
  return (
    <Card data-testid="instagram-settings">
      <ToggleRow label={copy.settings.autopilot} hint={copy.settings.autopilotHint}>
        <Switch checked={s.autopilot} disabled={off || save.isPending} onCheckedChange={(v) => save.mutate({ autopilot: v })} data-testid="switch-ig-autopilot" />
      </ToggleRow>
      <div className="py-2">
        <p className="text-sm font-semibold text-text">{copy.settings.publish}</p>
        <div className="mt-2 grid grid-cols-1 gap-1.5">
          {(["approve", "auto"] as const).map((m) => (
            <button key={m} type="button" disabled={save.isPending} onClick={() => save.mutate({ publishMode: m })} className={cn("min-h-10 rounded-xl border px-3 text-start text-sm font-semibold", s.publishMode === m ? "border-turf bg-turf/10 text-turf" : "border-line bg-raised text-muted-text")}>
              {m === "approve" ? copy.settings.approve : copy.settings.auto}
            </button>
          ))}
        </div>
      </div>
      <details className="mt-2 rounded-xl border border-line bg-raised/40 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-text"><CalendarClock className="me-1.5 inline h-4 w-4 text-turf" />{copy.settings.times}</summary>
        <div className="mt-3 space-y-3 text-sm text-text">
          <label className="flex flex-wrap items-center gap-2">{copy.settings.storyEvery}
            <select value={slots.storyEveryHours} onChange={(e) => set("storyEveryHours", Number(e.target.value))} className="min-h-10 rounded-lg border border-input bg-raised px-2">
              {[1, 2, 3, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{copy.settings.hours(n)}</option>)}
            </select>
          </label>
          <label className="flex flex-wrap items-center gap-2">{copy.settings.storiesPerSlot}
            <select value={slots.storiesPerSlot} onChange={(e) => set("storiesPerSlot", Number(e.target.value))} className="min-h-10 rounded-lg border border-input bg-raised px-2">
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">{copy.settings.reels}
            {slots.reelTimes.map((t, i) => (
              <span key={i} className="flex items-center gap-1">
                {timeInput(t, (v) => set("reelTimes", slots.reelTimes.map((x, j) => (j === i ? v : x))), copy.settings.reels)}
                {slots.reelTimes.length > 1 && <button type="button" onClick={() => set("reelTimes", slots.reelTimes.filter((_, j) => j !== i))} className="px-1 text-muted-text" aria-label="×">×</button>}
              </span>
            ))}
            {slots.reelTimes.length < 3 && <button type="button" onClick={() => set("reelTimes", [...slots.reelTimes, "18:00"])} className="text-xs font-semibold text-turf">+ {copy.settings.addReel}</button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">{copy.settings.night} {timeInput(slots.quietFrom, (v) => set("quietFrom", v), copy.settings.night)} {copy.settings.and} {timeInput(slots.quietTo, (v) => set("quietTo", v), copy.settings.night)}</div>
          <p className="pt-1 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.settings.awards}</p>
          <div className="flex flex-wrap items-center gap-2">{copy.settings.nominees} {daySelect(slots.nomineesDay, (v) => set("nomineesDay", v), copy.settings.nominees)} {timeInput(slots.nomineesTime, (v) => set("nomineesTime", v), copy.settings.nominees)}</div>
          <div className="flex flex-wrap items-center gap-2">{copy.settings.votingEnds} {daySelect(slots.votingEndDay, (v) => set("votingEndDay", v), copy.settings.votingEnds)} {timeInput(slots.votingEndTime, (v) => set("votingEndTime", v), copy.settings.votingEnds)}</div>
          <div className="flex flex-wrap items-center gap-2">{copy.settings.winner} {daySelect(slots.winnerDay, (v) => set("winnerDay", v), copy.settings.winner)} {timeInput(slots.winnerTime, (v) => set("winnerTime", v), copy.settings.winner)}</div>
          <label className="flex flex-wrap items-center gap-2">{copy.settings.minVotes}
            <Input type="number" min={1} max={1000} value={slots.minVotes} onChange={(e) => set("minVotes", Math.max(1, Number(e.target.value) || 1))} className="min-h-10 w-20" />
          </label>
          <p className="pt-1 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.settings.posts}</p>
          <p className="text-xs text-muted-text">{copy.settings.postsHint}</p>
          <div className="space-y-2" data-testid="ig-optional-posts">
            {IG_OPTIONAL_KINDS.map((k) => {
              const on = !slots.off.includes(k);
              const weekly = (IG_WEEKLY_KINDS as readonly string[]).includes(k) ? slots.weekly[k as IgWeeklyKind] : null;
              return (
                <div key={k} className="flex flex-wrap items-center gap-2">
                  <Switch checked={on} onCheckedChange={(v) => set("off", v ? slots.off.filter((x) => x !== k) : [...slots.off, k])} aria-label={copy.settings.kinds[k]} data-testid={`ig-kind-${k}`} />
                  <span className={cn("min-w-0 flex-1", !on && "text-muted-text")}>{copy.settings.kinds[k]}</span>
                  {on && weekly && <>
                    {daySelect(weekly.day, (v) => set("weekly", { ...slots.weekly, [k]: { ...weekly, day: v } }), copy.settings.kinds[k])}
                    {timeInput(weekly.time, (v) => set("weekly", { ...slots.weekly, [k]: { ...weekly, time: v } }), copy.settings.kinds[k])}
                  </>}
                  {on && k === "open_slots" && timeInput(slots.openSlotsTime, (v) => set("openSlotsTime", v), copy.settings.kinds[k])}
                  {on && k === "leaderboard" && timeInput(slots.boardTime, (v) => set("boardTime", v), copy.settings.kinds[k])}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate({ slots }, { onSuccess: () => setSavedAt(Date.now()) })}>{copy.settings.save}</Button>
            {savedAt > 0 && !save.isPending && <span className="text-xs font-semibold text-turf" role="status">{copy.settings.saved}</span>}
          </div>
        </div>
      </details>
      <ErrorText error={save.error} />
    </Card>
  );
}

function Removals({ venueId, data }: { venueId: number; data: InstagramData }) {
  const copy = useInstagramCopy();
  const m = useInstagramItem(venueId);
  return (
    <Card className="border-[#FF5A3C]/40" data-testid="instagram-flagged">
      <h2 className="font-display text-lg font-bold text-[#FF8A73]">{copy.removals.title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-text">{copy.removals.body}</p>
      <ul className="mt-3 space-y-2">
        {data.flaggedRemovals.map((r) => {
          const item = data.items.find((i) => i.id === r.itemId);
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-raised p-3 text-sm">
              <span className="text-text">{item?.reference ? copy.calendar.booking(item.reference) : `#${r.bookingId}`}{item ? ` · ${item.placement === "reel" ? copy.calendar.reel : copy.calendar.story}` : ""}</span>
              <span className="flex gap-2">
                {item?.igPermalink && <a href={item.igPermalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-turf"><ExternalLink className="h-3.5 w-3.5" />{copy.calendar.open}</a>}
                <Button type="button" size="sm" variant="outline" disabled={m.resolved.isPending} onClick={() => m.resolved.mutate(r.id)}>{copy.removals.done}</Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ─── The calendar ────────────────────────────────────────────────────────────

type Row = { time: string; kind: "story" | "reel" | null; capacity: number; items: IgItem[] };

function Calendar({ venueId, data }: { venueId: number; data: InstagramData }) {
  const copy = useInstagramCopy();
  const m = useInstagramItem(venueId);
  const [swapFrom, setSwapFrom] = useState<number | null>(null);
  const [preview, setPreview] = useState<IgItem | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const today = ammanToday();

  const days = useMemo(() => {
    const byDay = new Map<string, Map<string, Row>>();
    const rowOf = (local: string, kind: "story" | "reel" | null, capacity = 1) => {
      const day = local.slice(0, 10);
      const time = local.slice(11, 16);
      if (!byDay.has(day)) byDay.set(day, new Map());
      const rows = byDay.get(day)!;
      const key = `${time}:${kind ?? "any"}`;
      if (!rows.has(key)) rows.set(key, { time, kind, capacity, items: [] });
      return rows.get(key)!;
    };
    for (const s of data.slots) rowOf(s.at, s.kind, s.capacity);
    for (const i of data.items) {
      if (!i.slotLocal) continue;
      const day = i.slotLocal.slice(0, 10);
      const exact = byDay.get(day)?.get(`${i.slotLocal.slice(11, 16)}:${i.placement}`);
      // A carousel goes in the feed like a Reel.
      (exact ?? rowOf(i.slotLocal, i.placement === "carousel" ? "reel" : i.placement)).items.push(i);
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).filter(([d]) => d >= today || [...(byDay.get(d)?.values() ?? [])].some((r) => r.items.length))
      .map(([day, rows]) => ({ day, rows: [...rows.values()].sort((a, b) => a.time.localeCompare(b.time) || (a.kind === "reel" ? -1 : 1)) }));
  }, [data, today]);
  const waiting = data.items.filter((i) => !i.slotLocal && (i.status === "planned" || i.status === "approved"));
  const movable = (i: IgItem) => i.status === "planned" || i.status === "approved";

  const onDropRow = (e: DragEvent, day: string, row: Row) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/plain")) || dragId;
    setDragId(null);
    if (!id) return;
    const target = row.items.find((x) => movable(x) && x.id !== id);
    if (target && row.items.length >= row.capacity) m.swap.mutate({ a: id, b: target.id });
    else m.move.mutate({ id, slotLocal: `${day} ${row.time}`, placement: row.kind ?? undefined });
  };

  return (
    <Card data-testid="instagram-calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-text">{copy.calendar.title}</h2>
        {swapFrom && <span className="flex items-center gap-2 text-xs font-semibold text-amber-200">{copy.calendar.swapPick}<button type="button" className="underline" onClick={() => setSwapFrom(null)}>{copy.calendar.cancel}</button></span>}
      </div>
      <ErrorText error={m.action.error ?? m.move.error ?? m.swap.error} />
      {!data.items.length && <p className="mt-3 text-sm text-muted-text">{copy.calendar.empty}</p>}
      {waiting.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-text">{copy.calendar.waiting}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">{waiting.map((i) => <ItemCard key={i.id} venueId={venueId} item={i} data={data} swapFrom={swapFrom} setSwapFrom={setSwapFrom} onPreview={setPreview} onDrag={setDragId} />)}</div>
        </div>
      )}
      <div className="mt-4 space-y-5">
        {days.map(({ day, rows }) => (
          <section key={day}>
            <h3 className="sticky top-16 z-10 bg-surface/95 py-1 text-sm font-bold text-text backdrop-blur">{dayName(day, copy.locale, "long")}</h3>
            <ol className="mt-2 space-y-2">
              {rows.filter((row) => row.items.length).map((row) => (
                <li key={`${row.time}:${row.kind}`} className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:gap-3"
                  onDragOver={(e) => { if (dragId) e.preventDefault(); }} onDrop={(e) => onDropRow(e, day, row)}>
                  <div className="flex items-center gap-2 text-xs font-semibold tabular-nums text-muted-text sm:block sm:pt-2">
                    {clock(`${day} ${row.time}`, copy.locale)}
                    {row.kind && <span className={cn("block text-[10px] font-bold uppercase sm:mt-1", row.kind === "reel" ? "text-[#C9BCFF]" : "text-turf")}>{row.kind === "reel" ? copy.calendar.reel : copy.calendar.story}</span>}
                  </div>
                  <div className="space-y-2">
                    {row.items.map((i) => <ItemCard key={i.id} venueId={venueId} item={i} data={data} swapFrom={swapFrom} setSwapFrom={setSwapFrom} onPreview={setPreview} onDrag={setDragId} />)}
                  </div>
                </li>
              ))}
            </ol>
            {/* Free slots of the day as one line of chips: drop a post on one to move it there. */}
            {rows.some((row) => row.kind && row.items.length < row.capacity) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted-text">{copy.calendar.free}:</span>
                {rows.filter((row) => row.kind && row.items.length < row.capacity).map((row) => (
                  <span key={`free:${row.time}:${row.kind}`} onDragOver={(e) => { if (dragId) e.preventDefault(); }} onDrop={(e) => onDropRow(e, day, row)}
                    className={cn("inline-flex min-h-8 items-center gap-1 rounded-full border border-dashed px-2.5 text-[11px] tabular-nums", dragId ? "border-turf text-turf" : "border-line text-muted-text")}>
                    {clock(`${day} ${row.time}`, copy.locale)}
                    <span className={cn("font-bold uppercase", row.kind === "reel" ? "text-[#C9BCFF]" : "text-turf")}>{row.kind === "reel" ? copy.calendar.reel : copy.calendar.story}</span>
                  </span>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
    </Card>
  );
}

function ItemCard({ venueId, item, data, swapFrom, setSwapFrom, onPreview, onDrag }: {
  venueId: number; item: IgItem; data: InstagramData; swapFrom: number | null; setSwapFrom: (id: number | null) => void; onPreview: (i: IgItem) => void; onDrag: (id: number | null) => void;
}) {
  const copy = useInstagramCopy();
  const m = useInstagramItem(venueId);
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState(item.slotLocal?.replace(" ", "T") ?? `${ammanToday()}T18:00`);
  const movable = item.status === "planned" || item.status === "approved";
  const auto = data.settings.publishMode === "auto";
  const title = item.kind === "booking_clip" ? (item.reference ? copy.calendar.booking(item.reference) : copy.calendar.sources[item.source])
    : item.kind === "award_nominees" || item.kind === "award_winner"
      ? `${item.kind === "award_nominees" ? copy.calendar.nominees : copy.calendar.winner}${item.category ? ` · ${copy.awards.categories[item.category] ?? item.category}` : ""}`
      : copy.calendar.kinds[item.kind] ?? item.kind;
  const statusText = item.status === "planned" && auto ? copy.calendar.plannedAuto : copy.calendar.status[item.status];
  const tone = item.status === "published" ? "paid" : item.status === "approved" ? "confirmed" : item.status === "planned" ? "held" : item.status === "removal_flagged" || item.status === "failed" ? "no_show" : "cancelled";
  const pickForSwap = () => {
    if (swapFrom && swapFrom !== item.id) { m.swap.mutate({ a: swapFrom, b: item.id }); setSwapFrom(null); }
    else setSwapFrom(swapFrom === item.id ? null : item.id);
  };
  return (
    <article draggable={movable} onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(item.id)); onDrag(item.id); }} onDragEnd={() => onDrag(null)}
      className={cn("flex gap-3 rounded-xl border bg-raised p-2.5", swapFrom === item.id ? "border-amber-300" : "border-line", movable && "cursor-grab")} data-testid={`ig-item-${item.id}`}>
      <div className="relative h-24 w-[3.4rem] shrink-0 overflow-hidden rounded-lg bg-void">
        {item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
        <span className={cn("absolute bottom-1 start-1 rounded px-1 text-[9px] font-bold uppercase", item.placement === "reel" ? "bg-[#7B5CFF] text-white" : item.placement === "carousel" ? "bg-amber-300 text-void" : "bg-turf text-void")}>{item.placement === "reel" ? copy.calendar.reel : item.placement === "carousel" ? copy.calendar.carousel : copy.calendar.story}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-bold text-text">{title}</p>
          <Pill kind={tone}>{statusText}</Pill>
          {item.pinned && <span title={copy.calendar.pinned}><Pin className="h-3.5 w-3.5 text-muted-text" /></span>}
        </div>
        <p className="mt-0.5 text-xs text-muted-text">
          {copy.calendar.sources[item.source] ?? item.source}
          {item.bookingStartLocal ? ` · ${dayName(item.bookingStartLocal.slice(0, 10), copy.locale)} ${clock(item.bookingStartLocal, copy.locale)}` : ""}
          {item.consentMode ? ` · ${copy.calendar.consentOn(copy.consent.modes[item.consentMode] ?? item.consentMode)}` : ""}
        </p>
        {item.error && item.status !== "published" && <p className="mt-1 text-xs text-amber-200">{item.error}</p>}
        {item.votes && <p className="mt-1 text-xs font-semibold text-turf" data-testid={`ig-ab-votes-${item.id}`}>{copy.calendar.abVotes(item.votes.a, item.votes.b)}</p>}
        {item.insights && (item.insights.views != null || item.insights.reach != null) && (
          <p className="mt-1 text-xs text-muted-text">{copy.report.plays}: {item.insights.views ?? "—"} · {copy.report.reach}: {item.insights.reach ?? "—"}</p>
        )}
        {moving && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-9 w-auto" dir="ltr" aria-label={copy.calendar.moveTo} />
            <Button type="button" size="sm" disabled={m.move.isPending} onClick={() => m.move.mutate({ id: item.id, slotLocal: when.replace("T", " ").slice(0, 16) }, { onSuccess: () => setMoving(false) })}>{copy.calendar.move}</Button>
            <button type="button" className="text-xs text-muted-text" onClick={() => setMoving(false)}>{copy.calendar.cancel}</button>
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.status === "planned" && !auto && <Small onClick={() => m.action.mutate({ id: item.id, action: "approve" })} icon={<Check className="h-3.5 w-3.5" />} label={copy.calendar.approve} primary testId={`ig-approve-${item.id}`} />}
          {item.status === "approved" && <Small onClick={() => m.action.mutate({ id: item.id, action: "unapprove" })} icon={<Undo2 className="h-3.5 w-3.5" />} label={copy.calendar.unapprove} />}
          {movable && <Small onClick={() => setMoving(!moving)} icon={<CalendarClock className="h-3.5 w-3.5" />} label={copy.calendar.move} />}
          {movable && <Small onClick={pickForSwap} icon={<ArrowLeftRight className="h-3.5 w-3.5" />} label={copy.calendar.swap} />}
          {movable && <Small onClick={() => m.action.mutate({ id: item.id, action: "now" })} icon={<Zap className="h-3.5 w-3.5" />} label={copy.calendar.now} />}
          {(movable || item.render) && (
            <Small onClick={() => { if (item.render?.status === "done") onPreview(item); else m.action.mutate({ id: item.id, action: "preview" }, { onSuccess: (r) => { if (r.item.render?.status === "done") onPreview({ ...item, render: r.item.render }); } }); }}
              icon={<Eye className="h-3.5 w-3.5" />} label={item.render && item.render.status !== "done" && item.render.status !== "failed" ? copy.calendar.rendering : copy.calendar.preview} />
          )}
          {movable && <Small onClick={() => m.action.mutate({ id: item.id, action: "skip" })} icon={<SkipForward className="h-3.5 w-3.5" />} label={copy.calendar.skip} />}
          {(item.status === "skipped" || item.status === "failed") && <Small onClick={() => m.action.mutate({ id: item.id, action: "restore" })} icon={<Undo2 className="h-3.5 w-3.5" />} label={copy.calendar.restore} />}
          {item.igPermalink && <a href={item.igPermalink} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line px-2.5 text-xs font-semibold text-turf"><ExternalLink className="h-3.5 w-3.5" />{copy.calendar.open}</a>}
        </div>
      </div>
    </article>
  );
}

function Small({ onClick, icon, label, primary, testId }: { onClick: () => void; icon: React.ReactNode; label: string; primary?: boolean; testId?: string }) {
  // On a phone the secondary actions are icons (named for screen readers and on hover); the main one keeps its word.
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-label={label} title={label} className={cn("inline-flex min-h-9 min-w-9 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-semibold", primary ? "bg-floodlight text-void" : "border border-line text-muted-text hover:text-text")}>
      {icon}<span className={primary ? "" : "hidden sm:inline"}>{label}</span>
    </button>
  );
}

function Preview({ item, onClose }: { item: IgItem; onClose: () => void }) {
  const copy = useInstagramCopy();
  const url = item.render?.outputUrl ?? null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text sm:max-w-sm">
        <DialogHeader className="text-start"><DialogTitle>{copy.calendar.preview}</DialogTitle><DialogDescription className="text-start text-muted-text">{item.reference ? copy.calendar.booking(item.reference) : ""}</DialogDescription></DialogHeader>
        {url ? (item.render?.kind === "video"
          ? <video src={url} controls autoPlay playsInline className={cn("mx-auto max-h-[70dvh] rounded-xl bg-black", item.placement === "carousel" ? "aspect-[4/5]" : "aspect-[9/16]")} />
          : <img src={url} alt="" className={cn("mx-auto max-h-[70dvh] rounded-xl object-contain", item.placement === "carousel" ? "aspect-[4/5]" : "aspect-[9/16]")} />) : <p className="text-sm text-muted-text">{copy.calendar.rendering}</p>}
      </DialogContent>
    </Dialog>
  );
}

// ─── Awards ──────────────────────────────────────────────────────────────────

function Awards({ venueId, data }: { venueId: number; data: InstagramData }) {
  const copy = useInstagramCopy();
  const m = useInstagramItem(venueId);
  const weeks = useMemo(() => {
    const map = new Map<string, IgAward[]>();
    for (const a of data.awards) map.set(a.weekStart, [...(map.get(a.weekStart) ?? []), a]);
    return [...map.entries()];
  }, [data.awards]);
  return (
    <Card data-testid="instagram-awards">
      <div className="flex items-center gap-2"><Trophy className="h-4 w-4 text-floodlight" /><h2 className="font-display text-lg font-bold text-text">{copy.awards.title}</h2></div>
      <p className="mt-1 text-sm leading-6 text-muted-text">{copy.awards.hint} {copy.awards.levelOnly}</p>
      {!weeks.length && <p className="mt-3 text-sm text-muted-text">{copy.awards.none}</p>}
      {weeks.map(([week, awards]) => (
        <div key={week} className="mt-4">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-text">{copy.awards.week(dayName(week, copy.locale, "long"))}</p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {awards.map((a) => (
              <div key={a.id} className="rounded-xl border border-line bg-raised p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-bold text-text">{copy.awards.categories[a.category] ?? a.category}</p>
                  <Pill kind={a.status === "owner_pick" ? "held" : a.status === "posted" ? "paid" : a.status === "decided" ? "confirmed" : a.status === "skipped" ? "cancelled" : "receipt"}>{copy.awards.status[a.status] ?? a.status}</Pill>
                </div>
                {a.totalVotes != null && a.status !== "skipped" && <p className="mt-0.5 text-xs text-muted-text">{copy.awards.votes(a.totalVotes)}</p>}
                <ul className="mt-2 space-y-1.5">
                  {a.nominees.map((n) => (
                    <li key={n.key} className={cn("flex items-center gap-2 rounded-lg p-1.5", a.winnerKey === n.key && "bg-floodlight/10")}>
                      <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-void">{n.thumbnailUrl && <img src={n.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}</div>
                      <span className="min-w-0 flex-1 truncate text-xs text-text">{copy.locale === "ar" ? n.labelAr : n.label}{n.value != null ? ` · ${n.value} ${copy.locale === "ar" ? "كم/س" : "km/h"}` : ""}</span>
                      {n.votes != null && <span className="text-xs tabular-nums text-muted-text">{n.votes}</span>}
                      {a.winnerKey === n.key ? <span className="text-xs font-bold text-floodlight">{copy.awards.winner}</span>
                        : ["owner_pick", "voting", "decided"].includes(a.status) && (
                          <button type="button" onClick={() => m.winner.mutate({ awardId: a.id, key: n.key })} className="rounded-full border border-line px-2 py-1 text-[11px] font-semibold text-muted-text hover:text-text">{copy.awards.pick}</button>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="mt-5">
        <p className="text-sm font-bold text-text">{copy.awards.nominations}</p>
        <p className="mt-0.5 text-xs text-muted-text">{copy.awards.nominationsHint}</p>
        {!data.nominations.length ? <p className="mt-2 text-xs text-muted-text">{copy.awards.noNominations}</p> : (
          <ul className="mt-2 space-y-2">
            {data.nominations.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-raised p-2">
                <div className="h-12 w-20 shrink-0 overflow-hidden rounded bg-void">{n.thumbnailUrl && <img src={n.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}</div>
                <span className="min-w-0 flex-1 text-xs text-text">
                  {n.source === "player" ? copy.awards.fromPlayer : copy.awards.fromShot}
                  {n.reference ? ` · ${copy.calendar.booking(n.reference)}` : ""} · {copy.match.at(Math.floor(n.atSeconds / 60) + 1)}
                </span>
                <Button type="button" size="sm" disabled={m.nomination.isPending} onClick={() => m.nomination.mutate({ id: n.id, status: "approved" })}>{copy.awards.approveNom}</Button>
                <Button type="button" size="sm" variant="outline" disabled={m.nomination.isPending} onClick={() => m.nomination.mutate({ id: n.id, status: "rejected" })}>{copy.awards.reject}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ErrorText error={m.winner.error ?? m.nomination.error} />
    </Card>
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────

function Report({ venueId }: { venueId: number }) {
  const copy = useInstagramCopy();
  const [month, setMonth] = useState(ammanToday().slice(0, 7));
  const report = useInstagramReport(venueId, month);
  const r = report.data;
  const num = (v: number | null | undefined) => (v == null ? "—" : new Intl.NumberFormat(copy.locale === "ar" ? "ar-JO" : "en-GB").format(v));
  const rows = r ? ([["story", copy.report.stories], ["reel", copy.report.reels], ["nominees", copy.report.nominees], ["award", copy.report.awards], ["field", copy.report.field]] as const).filter(([k]) => r.posts.byType[k]) : [];
  return (
    <Card data-testid="instagram-report">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-text">{copy.report.title}</h2>
        <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="min-h-10 w-auto" dir="ltr" aria-label={copy.report.title} />
      </div>
      {report.isLoading ? <Skeleton rows={1} /> : r && (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[20rem] text-sm">
              <thead className="text-xs text-muted-text"><tr><th className="py-1 text-start font-semibold">{copy.report.posts}</th><th className="py-1 text-end font-semibold">#</th><th className="py-1 text-end font-semibold">{copy.report.reach}</th><th className="py-1 text-end font-semibold">{copy.report.plays}</th></tr></thead>
              <tbody className="divide-y divide-line text-text">
                {rows.map(([k, label]) => (
                  <tr key={k}><td className="py-2">{label}</td><td className="py-2 text-end tabular-nums">{num(r.posts.byType[k].posts)}</td><td className="py-2 text-end tabular-nums">{num(r.posts.byType[k].reach)}</td><td className="py-2 text-end tabular-nums">{num(r.posts.byType[k].views)}</td></tr>
                ))}
              </tbody>
            </table>
            {!r.insightsAvailable && r.posts.total > 0 && <p className="mt-2 text-xs text-muted-text">{copy.report.noInsights}</p>}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Mini label={`${copy.report.bookings} · ${copy.report.website}`} value={num(r.bookings.website)} />
            <Mini label={`${copy.report.bookings} · ${copy.report.whatsapp}`} value={num(r.bookings.whatsapp)} />
            <Mini label={copy.report.removed} value={num(r.removals.total)} />
          </div>
        </>
      )}
    </Card>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-raised p-3"><p className="text-[11px] text-muted-text">{label}</p><p className="mt-1 font-display text-2xl font-bold tabular-nums text-text">{value}</p></div>;
}
