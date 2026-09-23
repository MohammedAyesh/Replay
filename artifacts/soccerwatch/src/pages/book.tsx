import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { BarChart3, Check, ChevronRight, Clock, Loader2, MapPin, Share2, Timer, Users } from "lucide-react";
import { PaymentPanel } from "@/components/match/PaymentPanel";
import { useToast } from "@/hooks/use-toast";
import { useMatchCopy } from "@/i18n/match-strings";
import { useAuth } from "@/lib/auth";
import {
  MatchApiError,
  formatJod,
  useBookingFields,
  useCreateBooking,
  useOwnerBooking,
  useTakenSlots,
  type BookingResult,
} from "@/lib/match-api";
import { cn } from "@/lib/utils";

const DURATIONS = [60, 90, 120, 180];
const FIRST_SLOT = 7 * 60; // 07:00
const LAST_SLOT = 23 * 60 + 30; // 23:30
const WHY_ICONS = [Timer, BarChart3, Users, Share2];

/** Amman wall clock for an instant, as "YYYY-MM-DD" and minutes since midnight. */
function ammanParts(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function localToMinutes(local: string): { date: string; minutes: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(local);
  return m ? { date: m[1], minutes: Number(m[2]) * 60 + Number(m[3]) } : null;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Start and end as the API wants them; an end past midnight rolls to the next day. */
function windowFor(date: string, start: number, duration: number) {
  const end = start + duration;
  return {
    startLocal: `${date} ${hhmm(start)}`,
    endLocal: `${end >= 24 * 60 ? addDays(date, 1) : date} ${hhmm(end)}`,
  };
}

export default function BookPage() {
  const copy = useMatchCopy();
  const b = copy.book;
  const ar = copy.locale === "ar";
  const { toast } = useToast();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { user, isGuest, isAdmin, isLoading } = useAuth();
  const fieldsQuery = useBookingFields();
  const create = useCreateBooking();
  const ownerBook = useOwnerBooking();

  const today = ammanParts(Date.now()).date;
  const [fieldId, setFieldId] = useState<number | null>(() => {
    const v = Number.parseInt(new URLSearchParams(search).get("field") ?? "", 10);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  });
  const [date, setDate] = useState(today);
  const [start, setStart] = useState<number | null>(null);
  const [duration, setDuration] = useState(60);
  const [title, setTitle] = useState("");
  const [billOwner, setBillOwner] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);

  const fields = fieldsQuery.data?.fields ?? [];
  useEffect(() => {
    if (fieldId == null && fields.length === 1) setFieldId(fields[0].id);
  }, [fieldId, fields]);

  const ownedIds = (user?.ownedFieldIds ?? []) as number[];
  const canBillOwner = Boolean(fieldId && (isAdmin || ownedIds.includes(fieldId)));
  useEffect(() => {
    setBillOwner(Boolean(fieldId && ownedIds.includes(fieldId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldId]);

  const taken = useTakenSlots(fieldId, date);
  const nowParts = useMemo(() => {
    const n = taken.data?.now ? localToMinutes(taken.data.now) : null;
    return n ?? ammanParts(Date.now());
  }, [taken.data?.now]);

  const days = useMemo(() => Array.from({ length: fieldsQuery.data?.maxDaysAhead ?? 14 }, (_, i) => addDays(today, i)), [today, fieldsQuery.data?.maxDaysAhead]);

  // Minute ranges already booked on this day (including a booking that spills over from yesterday).
  const busy = useMemo(() => (taken.data?.taken ?? []).map((t) => {
    const s = localToMinutes(t.startLocal);
    const e = localToMinutes(t.endLocal);
    if (!s || !e) return null;
    const from = s.date === date ? s.minutes : s.date < date ? 0 : 24 * 60;
    const to = e.date === date ? e.minutes : e.date > date ? 24 * 60 + 24 * 60 : 0;
    return [from, to] as const;
  }).filter((x): x is readonly [number, number] => Boolean(x)), [taken.data?.taken, date]);

  const slotState = (slot: number, len = duration): "free" | "past" | "taken" => {
    if (date === nowParts.date && slot < nowParts.minutes - 15) return "past";
    if (date < nowParts.date) return "past";
    if (busy.some(([from, to]) => slot < to && from < slot + len)) return "taken";
    return "free";
  };
  const slots = useMemo(() => {
    const out: number[] = [];
    for (let m = FIRST_SLOT; m <= LAST_SLOT; m += 30) out.push(m);
    return out;
  }, []);

  useEffect(() => {
    if (start != null && slotState(start) !== "free") setStart(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, duration, fieldId, taken.data]);

  const pricePerHour = billOwner ? fieldsQuery.data?.ownerPricePerHourFils ?? 1000 : fieldsQuery.data?.pricePerHourFils ?? 2000;
  const priceFils = Math.max(1, Math.ceil(duration / 60)) * pricePerHour;
  const field = fields.find((f) => f.id === fieldId) ?? null;
  const ready = Boolean(field && start != null);
  const busyNow = create.isPending || ownerBook.isPending;

  const dayLabel = (d: string) => {
    if (d === today) return copy.today;
    if (d === addDays(today, 1)) return copy.tomorrow;
    const [y, m, dd] = d.split("-").map(Number);
    return new Intl.DateTimeFormat(ar ? "ar-JO" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(y, m - 1, dd)));
  };

  const submit = async () => {
    if (!field || start == null) return;
    if (!user || isGuest) {
      setLocation(`/sign-up?redirect_url=${encodeURIComponent(`/book?field=${field.id}`)}`);
      return;
    }
    const win = windowFor(date, start, duration);
    try {
      if (billOwner && canBillOwner) {
        const r = await ownerBook.mutateAsync({ fieldId: field.id, ...win });
        toast({ title: b.paid });
        setLocation(r.match?.code ? `/m/${r.match.code}` : "/owner?tab=footage");
        return;
      }
      const r = await create.mutateAsync({ fieldId: field.id, ...win, title: title.trim() || null });
      setResult(r);
      window.scrollTo?.({ top: 0 });
    } catch (error) {
      toast({ title: error instanceof MatchApiError ? error.message : copy.error, variant: "destructive" });
    }
  };

  // ---------------------------------------------------------------- after booking: pay
  if (result) {
    return (
      <Page ar={ar}>
        <div className="flex items-center gap-2 text-turf"><Check className="h-5 w-5" /><span className="text-sm font-bold">{b.summary}</span></div>
        <h1 className="mt-1 font-display text-3xl font-bold">{b.payTitle}</h1>
        <p className="mt-1 text-sm text-muted-text">
          {result.fieldName} · {dayLabel(result.startLocal.slice(0, 10))} · {result.startLocal.slice(11)}–{result.endLocal.slice(11)}
        </p>
        <div className="mt-5 rounded-3xl border border-line bg-surface p-4">
          <PaymentPanel amountFils={result.amountFils} cliqAlias={result.cliqAlias} reference={result.reference} />
        </div>
        <Link href={`/m/${result.code}`} className="mt-5 flex min-h-12 items-center justify-center gap-2 rounded-full bg-floodlight text-base font-bold text-void">
          {b.openMatch}<ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </Link>
        <p className="mt-2 text-center text-xs text-muted-text">{b.payLater}</p>
      </Page>
    );
  }

  // ---------------------------------------------------------------- the booking form
  return (
    <Page ar={ar}>
      <h1 className="font-display text-3xl font-bold">{b.title}</h1>
      <p className="mt-1 text-sm text-muted-text">{b.subtitle}</p>

      <section className="mt-5 rounded-3xl border border-turf/25 p-4" style={{ background: "radial-gradient(120% 120% at 100% 0%, rgba(47,216,196,.12), transparent 60%), #141B2C" }}>
        <p className="text-sm font-bold">{b.whyTitle}</p>
        <ul className="mt-3 flex flex-col gap-3">
          {b.why.map((w, i) => {
            const Icon = WHY_ICONS[i] ?? Clock;
            return (
              <li key={i} className="flex gap-3">
                <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", i === 0 ? "bg-floodlight text-void" : "bg-raised text-turf")}>
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{w.title}</span>
                  <span className="block text-xs leading-5 text-muted-text">{w.body}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 1. field */}
      <Step n={1} label={b.field}>
        {fieldsQuery.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-text" /> : fields.length === 0 ? (
          <p className="text-sm text-muted-text">{b.noFields}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {fields.map((f) => (
              <button key={f.id} type="button" onClick={() => setFieldId(f.id)} className={cn(
                "flex items-center gap-3 rounded-2xl border p-3 text-start transition-colors",
                fieldId === f.id ? "border-turf bg-turf/10" : "border-line bg-surface",
              )}>
                <span className="h-12 w-16 shrink-0 overflow-hidden rounded-xl bg-raised">
                  {f.imageUrl && <img src={f.imageUrl} alt="" className="h-full w-full object-cover" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{f.name}</span>
                  {f.location && <span className="flex items-center gap-1 truncate text-xs text-muted-text"><MapPin className="h-3 w-3" />{f.location}</span>}
                </span>
                {fieldId === f.id && <Check className="h-5 w-5 text-turf" />}
              </button>
            ))}
          </div>
        )}
      </Step>

      {/* 2. day */}
      <Step n={2} label={b.day}>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {days.map((d) => (
            <button key={d} type="button" onClick={() => setDate(d)} className={cn(
              "shrink-0 rounded-2xl border px-4 py-2.5 text-sm font-semibold",
              date === d ? "border-turf bg-turf text-void" : "border-line bg-surface text-text",
            )}>
              {dayLabel(d)}
            </button>
          ))}
        </div>
      </Step>

      {/* 3. time and length */}
      <Step n={3} label={b.length}>
        <div className="grid grid-cols-4 gap-2">
          {DURATIONS.map((m) => (
            <button key={m} type="button" onClick={() => setDuration(m)} className={cn(
              "min-h-11 rounded-xl border text-sm font-semibold",
              duration === m ? "border-turf bg-turf/15 text-turf" : "border-line bg-surface",
            )}>{b.minutes(m)}</button>
          ))}
        </div>
      </Step>
      <Step n={4} label={b.start}>
        {!fieldId ? <p className="text-xs text-muted-text">{b.pickAll}</p> : (
          <div className="grid grid-cols-4 gap-2" dir="ltr">
            {slots.map((m) => {
              const state = slotState(m);
              const selected = start === m;
              return (
                <button key={m} type="button" disabled={state !== "free"} onClick={() => setStart(m)} className={cn(
                  "min-h-11 rounded-xl border font-mono text-base font-bold transition-colors",
                  selected ? "border-floodlight bg-floodlight text-void"
                    : state === "taken" ? "border-line bg-void text-muted-text/40 line-through"
                    : state === "past" ? "border-transparent text-muted-text/30"
                    : "border-line bg-surface text-text",
                )} aria-label={state === "taken" ? `${hhmm(m)} ${b.taken}` : hhmm(m)}>
                  {hhmm(m)}
                </button>
              );
            })}
          </div>
        )}
      </Step>

      <label className="mt-5 block text-xs text-muted-text">{b.name}
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder={b.namePlaceholder} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-text outline-none focus:border-turf" />
      </label>

      {canBillOwner && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-surface p-3">
          <input type="checkbox" checked={billOwner} onChange={(e) => setBillOwner(e.target.checked)} className="mt-1 h-4 w-4 accent-[#2FD8C4]" />
          <span>
            <span className="block text-sm font-semibold">{b.ownerBill}</span>
            <span className="block text-xs text-muted-text">{b.ownerBillDesc(formatJod(fieldsQuery.data?.ownerPricePerHourFils ?? 1000))}</span>
          </span>
        </label>
      )}

      {/* summary + pay */}
      <section className="sticky bottom-24 z-10 mt-5 rounded-3xl border border-line bg-surface/95 p-4 backdrop-blur">
        {ready ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{field?.name}</p>
              <p className="text-xs text-muted-text">{dayLabel(date)} · <span dir="ltr">{hhmm(start!)}–{hhmm(start! + duration)}</span></p>
              <p className="mt-0.5 text-[11px] text-muted-text">{b.perHour(formatJod(pricePerHour))}</p>
            </div>
            <span className="font-mono text-2xl font-bold" dir="ltr">{formatJod(priceFils)} JOD</span>
          </div>
        ) : (
          <p className="text-sm text-muted-text">{b.pickAll}</p>
        )}
        <button type="button" disabled={!ready || busyNow || isLoading} onClick={() => void submit()} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-floodlight text-base font-bold text-void disabled:opacity-40">
          {busyNow ? <><Loader2 className="h-4 w-4 animate-spin" />{b.booking}</> : billOwner && canBillOwner ? b.bookOwner : b.bookAndPay(formatJod(priceFils))}
        </button>
      </section>

      {(ownedIds.length > 0 || isAdmin) && (
        <Link href="/owner" className="mt-4 flex items-center gap-3 rounded-2xl border border-line p-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{b.ownerTools}</span>
            <span className="block text-xs text-muted-text">{b.ownerToolsDesc}</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-text rtl:rotate-180" />
        </Link>
      )}
    </Page>
  );
}

function Page({ ar, children }: { ar: boolean; children: React.ReactNode }) {
  return (
    <div dir={ar ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto no-scrollbar px-4 pb-32 pt-3 text-text">
      {children}
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <p className="mb-2 flex items-center gap-2 text-sm font-bold">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-raised font-mono text-xs">{n}</span>
        {label}
      </p>
      {children}
    </section>
  );
}
