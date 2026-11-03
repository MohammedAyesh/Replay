import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, MessageCircle, Repeat, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useVenueCopy } from "@/i18n/venue-strings";
import { cn } from "@/lib/utils";
import {
  ApiError,
  addDays,
  ammanToday,
  clock,
  dayName,
  jod,
  minutesOf,
  useAttention,
  useAvailability,
  useBookingAction,
  useBookings,
  useCreateBooking,
  useEditBooking,
  type Booking,
  type BookingAction,
  type Pitch,
} from "@/lib/venue-api";
import { Card, ErrorText, Pill, SectionHeader, Skeleton, filsFromJod } from "./shared";

const SLOT = 30; // minutes per row
const ROW_PX = 28;

type Draft = { pitchId: number; date: string; time: string; minutes: number; name?: string; phone?: string };

export function BookingsSection({ venueId, onOpenChat, initial }: { venueId: number; onOpenChat: (phone: string) => void; initial?: Partial<Draft> | null }) {
  const [pending, setPending] = useState(initial && !initial.pitchId ? initial : null);
  const copy = useVenueCopy();
  const [date, setDate] = useState(ammanToday());
  const [view, setView] = useState<"grid" | "list">("grid");
  const [draft, setDraft] = useState<Draft | null>(initial?.pitchId ? { pitchId: initial.pitchId, date: initial.date ?? ammanToday(), time: initial.time ?? "20:00", minutes: initial.minutes ?? 60, name: initial.name, phone: initial.phone } : null);
  const [openId, setOpenId] = useState<number | null>(null);
  const bookings = useBookings(venueId, date, date);
  const attention = useAttention(venueId);
  const availability = useAvailability(venueId, date);
  const pitches = (bookings.data?.pitches ?? []).filter((p) => p.active);
  const rows = bookings.data?.bookings ?? [];
  const open = [...rows, ...(attention.data?.bookings ?? [])].find((b) => b.id === openId) ?? null;
  // "Book" from Customers: open the form on the first pitch once pitches are known.
  useEffect(() => {
    if (!pending || pitches.length === 0) return;
    setDraft({ pitchId: pitches[0].id, date, time: "20:00", minutes: 60, name: pending.name, phone: pending.phone });
    setPending(null);
  }, [pending, pitches, date]);

  // The business day's window, from the slots the server offers (or 16:00–24:00 when closed/empty).
  const window = useMemo(() => {
    const starts = (availability.data?.pitches ?? []).flatMap((p) => p.slots.map((s) => s.startLocal));
    const ends = (availability.data?.pitches ?? []).flatMap((p) => p.slots.map((s) => s.endsByLocal));
    const bookingStarts = rows.map((b) => b.startLocal);
    const bookingEnds = rows.map((b) => b.endLocal);
    const toMin = (local: string) => (local.slice(0, 10) > date ? 1440 : 0) + minutesOf(local);
    const allStarts = [...starts, ...bookingStarts].map(toMin);
    const allEnds = [...ends, ...bookingEnds].map(toMin);
    if (!allStarts.length) return { from: 16 * 60, to: 24 * 60 };
    const from = Math.floor(Math.min(...allStarts) / 60) * 60;
    const to = Math.ceil(Math.max(...allEnds, from + 60) / 60) * 60;
    return { from: Math.min(from, 23 * 60), to: Math.max(to, from + 60) };
  }, [availability.data, rows, date]);

  const nowMin = (() => {
    if (date !== ammanToday()) return null;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":").map(Number);
    return parts[0] * 60 + parts[1];
  })();

  const rowCount = Math.max(1, (window.to - window.from) / SLOT);

  return (
    <section className="space-y-5" data-testid="field-bookings">
      <SectionHeader
        title={copy.bookings.title}
        description={copy.bookings.description}
        action={pitches.length > 0 && (
          <Button type="button" onClick={() => setDraft({ pitchId: pitches[0].id, date, time: "20:00", minutes: 60 })} className="min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void" data-testid="button-new-booking">
            <CalendarPlus className="me-2 h-4 w-4" aria-hidden="true" />{copy.bookings.new}
          </Button>
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface p-1">
          <Button type="button" size="icon" variant="ghost" onClick={() => setDate(addDays(date, -1))} aria-label={copy.bookings.prev}><ChevronLeft className="h-4 w-4 rtl:rotate-180" /></Button>
          <Button type="button" variant="ghost" onClick={() => setDate(ammanToday())} className="font-semibold">{copy.bookings.today}</Button>
          <Button type="button" size="icon" variant="ghost" onClick={() => setDate(addDays(date, 1))} aria-label={copy.bookings.next}><ChevronRight className="h-4 w-4 rtl:rotate-180" /></Button>
        </div>
        <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="min-h-11 w-auto" data-testid="input-bookings-date" />
        <span className="font-display text-lg font-bold text-text">{dayName(date, copy.locale, "long")}</span>
        <div className="ms-auto flex rounded-xl border border-line bg-surface p-1">
          {(["grid", "list"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={cn("min-h-9 rounded-lg px-3 text-sm font-semibold", view === v ? "bg-turf/15 text-turf" : "text-muted-text")}>
              {v === "grid" ? copy.bookings.grid : copy.bookings.list}
              {v === "list" && (attention.data?.bookings.length ?? 0) > 0 && <span className="ms-1.5 rounded-full bg-amber-300/20 px-1.5 text-[11px] text-amber-200">{attention.data?.bookings.length}</span>}
            </button>
          ))}
        </div>
      </div>

      {bookings.isLoading ? <Skeleton rows={4} /> : bookings.isError ? <ErrorText error={bookings.error} /> : pitches.length === 0 ? (
        <Card><p className="text-sm text-muted-text">{copy.bookings.empty}</p></Card>
      ) : view === "list" ? (
        <WaitingList bookings={attention.data?.bookings ?? []} onOpen={setOpenId} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface" data-testid="bookings-grid">
          <div className="grid min-w-[560px]" style={{ gridTemplateColumns: `56px repeat(${pitches.length}, minmax(140px, 1fr))` }}>
            <div className="sticky top-0 z-10 border-b border-line bg-surface" />
            {pitches.map((p) => (
              <div key={p.id} className="sticky top-0 z-10 border-b border-s border-line bg-surface px-3 py-2.5">
                <p className="truncate text-sm font-bold text-text">{copy.locale === "ar" ? p.nameAr || p.name : p.name}</p>
                <p className="text-[11px] text-muted-text">{p.size}×{p.size}{p.hasCamera ? " · 🎥" : ""}</p>
              </div>
            ))}
            <div className="relative" style={{ height: rowCount * ROW_PX }}>
              {Array.from({ length: rowCount }, (_, i) => {
                const m = window.from + i * SLOT;
                return m % 60 === 0 ? (
                  <span key={i} className="absolute end-2 text-[10px] tabular-nums text-muted-text" style={{ top: i * ROW_PX + 2 }}>
                    {clock(`2000-01-01 ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:00`, copy.locale).replace(":00", "")}
                  </span>
                ) : null;
              })}
            </div>
            {pitches.map((p) => (
              <PitchColumn
                key={p.id}
                pitch={p}
                date={date}
                window={window}
                rowCount={rowCount}
                nowMin={nowMin}
                bookings={rows.filter((b) => b.pitchId === p.id && b.status !== "cancelled")}
                freeStarts={new Set((availability.data?.pitches.find((x) => x.pitchId === p.id)?.slots ?? []).filter((s) => s.available).map((s) => s.startLocal))}
                onBook={(time) => setDraft({ pitchId: p.id, date, time, minutes: 60 })}
                onOpen={setOpenId}
              />
            ))}
          </div>
        </div>
      )}

      {rows.some((b) => b.status === "cancelled") && view === "grid" && (
        <details className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">
          <summary className="cursor-pointer font-semibold">{copy.status.cancelled} · {rows.filter((b) => b.status === "cancelled").length}</summary>
          <div className="mt-3 space-y-2">{rows.filter((b) => b.status === "cancelled").map((b) => <BookingRow key={b.id} booking={b} onOpen={setOpenId} />)}</div>
        </details>
      )}

      {draft && <NewBookingDialog venueId={venueId} pitches={pitches} draft={draft} onClose={() => setDraft(null)} onCreated={(d) => { setDate(d); setDraft(null); }} />}
      {open && <BookingSheet venueId={venueId} booking={open} pitches={pitches} onClose={() => setOpenId(null)} onOpenChat={onOpenChat} />}
    </section>
  );
}

function PitchColumn({ pitch, date, window, rowCount, nowMin, bookings, freeStarts, onBook, onOpen }: {
  pitch: Pitch; date: string; window: { from: number; to: number }; rowCount: number; nowMin: number | null;
  bookings: Booking[]; freeStarts: Set<string>; onBook: (time: string) => void; onOpen: (id: number) => void;
}) {
  const copy = useVenueCopy();
  const offset = (local: string) => (local.slice(0, 10) > date ? 1440 : 0) + minutesOf(local) - window.from;
  return (
    <div className="relative border-s border-line" style={{ height: rowCount * ROW_PX }}>
      {Array.from({ length: rowCount }, (_, i) => {
        const m = window.from + i * SLOT;
        const day = m >= 1440 ? addDays(date, 1) : date;
        const time = `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const free = freeStarts.has(`${day} ${time}`);
        return (
          <button
            key={i}
            type="button"
            disabled={!free}
            onClick={() => onBook(m >= 1440 ? `+${time}` : time)}
            className={cn("absolute inset-x-0 border-t text-[10px] transition-colors", m % 60 === 0 ? "border-line" : "border-line/40", free ? "text-transparent hover:bg-turf/10 hover:text-turf" : "cursor-default bg-raised/30 text-transparent")}
            style={{ top: i * ROW_PX, height: ROW_PX }}
            aria-label={`${pitch.name} ${time}`}
          >{free ? "+" : ""}</button>
        );
      })}
      {nowMin !== null && nowMin >= window.from && nowMin <= window.to && (
        <div className="pointer-events-none absolute inset-x-0 z-[5] h-0.5 bg-[#FF5A3C]" style={{ top: ((nowMin - window.from) / SLOT) * ROW_PX }} />
      )}
      {bookings.map((b) => {
        const top = (offset(b.startLocal) / SLOT) * ROW_PX;
        const height = Math.max(ROW_PX, (b.minutes / SLOT) * ROW_PX - 2);
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => onOpen(b.id)}
            className={cn(
              "absolute inset-x-1 z-[6] overflow-hidden rounded-lg border px-2 py-1 text-start text-xs shadow-sm",
              b.paymentStatus === "receipt" ? "border-[#7B5CFF]/60 bg-[#7B5CFF]/20" : b.status === "held" ? "border-amber-300/50 bg-amber-300/15" : b.status === "completed" ? "border-line bg-raised" : b.status === "no_show" ? "border-[#FF5A3C]/50 bg-[#FF5A3C]/10" : "border-turf/50 bg-turf/15",
            )}
            style={{ top: top + 1, height }}
            data-testid={`booking-block-${b.id}`}
          >
            <span className="block truncate font-bold text-text">{b.customerName || b.teamName || b.reference}</span>
            <span className="block truncate text-[10px] text-muted-text">
              {clock(b.startLocal, copy.locale)} · {copy.bookings.minutes(b.minutes)}{b.seriesId ? " · ↻" : ""}
            </span>
            {height > 44 && <span className="mt-0.5 block truncate text-[10px] font-semibold text-muted-text">{b.paymentStatus === "paid" ? "✓ " : ""}{copy.payment[b.paymentStatus]} · {jod(b.amountFils, copy.locale)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function BookingRow({ booking, onOpen }: { booking: Booking; onOpen: (id: number) => void }) {
  const copy = useVenueCopy();
  return (
    <button type="button" onClick={() => onOpen(booking.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-raised/40 p-3 text-start hover:border-muted-text">
      <span className="font-display text-sm font-bold tabular-nums text-text">{dayName(booking.startLocal.slice(0, 10), copy.locale)} · {clock(booking.startLocal, copy.locale)}</span>
      <span className="text-sm text-text">{booking.customerName || booking.teamName || booking.reference}</span>
      <span className="text-xs text-muted-text">{copy.locale === "ar" ? booking.pitchNameAr || booking.pitchName : booking.pitchName}</span>
      <span className="ms-auto flex gap-1.5"><Pill kind={booking.status}>{copy.status[booking.status]}</Pill><Pill kind={booking.paymentStatus}>{copy.payment[booking.paymentStatus]}</Pill></span>
    </button>
  );
}

function WaitingList({ bookings, onOpen }: { bookings: Booking[]; onOpen: (id: number) => void }) {
  const copy = useVenueCopy();
  return (
    <Card>
      <h2 className="font-display text-xl font-bold text-text">{copy.bookings.waitingTitle}</h2>
      {bookings.length === 0 ? <p className="mt-3 text-sm text-muted-text">{copy.bookings.waitingEmpty}</p> : (
        <div className="mt-4 space-y-2">{bookings.map((b) => <BookingRow key={b.id} booking={b} onOpen={onOpen} />)}</div>
      )}
    </Card>
  );
}

const LENGTHS = [60, 90, 120, 150, 180];

function NewBookingDialog({ venueId, pitches, draft, onClose, onCreated }: { venueId: number; pitches: Pitch[]; draft: Draft; onClose: () => void; onCreated: (date: string) => void }) {
  const copy = useVenueCopy();
  const create = useCreateBooking(venueId);
  const crossesMidnight = draft.time.startsWith("+");
  const [pitchId, setPitchId] = useState(draft.pitchId);
  const [date, setDate] = useState(crossesMidnight ? addDays(draft.date, 1) : draft.date);
  const [time, setTime] = useState(draft.time.replace("+", ""));
  const [minutes, setMinutes] = useState(draft.minutes);
  const [name, setName] = useState(draft.name ?? "");
  const [phone, setPhone] = useState(draft.phone ?? "");
  const [team, setTeam] = useState("");
  const [notes, setNotes] = useState("");
  const [price, setPrice] = useState("");
  const [how, setHow] = useState<"field" | "paid" | "cliq" | "none">("field");
  const [weeks, setWeeks] = useState(1);
  const [notify, setNotify] = useState(true);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await create.mutateAsync({
        pitchId,
        startLocal: `${date} ${time}`,
        minutes,
        customerName: name || null,
        customerPhone: phone || null,
        teamName: team || null,
        notes: notes || null,
        payWith: how === "paid" ? "none" : how,
        paid: how === "paid",
        amountFils: how === "none" ? 0 : price ? filsFromJod(price) : null,
        repeatWeeks: weeks,
        notify: notify && Boolean(phone),
      });
      onCreated(draft.date);
    } catch {
      // shown below
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="max-h-[92dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle>{copy.bookings.new}</DialogTitle>
          <DialogDescription className="text-start text-muted-text">{copy.bookings.phoneHint}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>{copy.bookings.pitch}</Label>
              <select value={pitchId} onChange={(e) => setPitchId(Number(e.target.value))} className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text">
                {pitches.map((p) => <option key={p.id} value={p.id}>{copy.locale === "ar" ? p.nameAr || p.name : p.name} ({p.size}×{p.size})</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><Label>{copy.bookings.date}</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-11" required /></div>
            <div className="space-y-1.5"><Label>{copy.bookings.start}</Label><Input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} className="min-h-11" required /></div>
          </div>
          <div className="space-y-1.5">
            <Label>{copy.bookings.length}</Label>
            <div className="flex flex-wrap gap-1.5">
              {LENGTHS.map((m) => <button key={m} type="button" onClick={() => setMinutes(m)} className={cn("min-h-10 rounded-full px-3.5 text-sm font-semibold", minutes === m ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{copy.bookings.minutes(m)}</button>)}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>{copy.bookings.name}</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="min-h-11" dir="auto" /></div>
            <div className="space-y-1.5"><Label>{copy.bookings.phone}</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="07XXXXXXXX" className="min-h-11" dir="ltr" /></div>
            <div className="space-y-1.5"><Label>{copy.bookings.team}</Label><Input value={team} onChange={(e) => setTeam(e.target.value)} maxLength={80} className="min-h-11" dir="auto" /></div>
            <div className="space-y-1.5"><Label>{copy.bookings.price}</Label><Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder={copy.bookings.priceHint} className="min-h-11" /></div>
          </div>
          <div className="space-y-1.5">
            <Label>{copy.bookings.how}</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {(["field", "paid", "cliq", "none"] as const).map((h) => (
                <button key={h} type="button" onClick={() => setHow(h)} className={cn("min-h-10 rounded-xl border px-3 text-sm font-semibold", how === h ? "border-turf bg-turf/10 text-turf" : "border-line bg-raised text-muted-text")}>
                  {h === "field" ? copy.bookings.howField : h === "paid" ? copy.bookings.howPaid : h === "cliq" ? copy.bookings.howCliq : copy.bookings.howNone}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><Repeat className="h-3.5 w-3.5" />{copy.bookings.repeat}</Label>
            <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text">
              {[1, 2, 4, 8, 12, 26].map((n) => <option key={n} value={n}>{copy.bookings.repeatWeeks(n)}</option>)}
            </select>
          </div>
          <div className="space-y-1.5"><Label>{copy.bookings.notes}</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} dir="auto" /></div>
          {phone && <label className="flex items-center justify-between gap-3 text-sm text-text">{copy.bookings.notify}<Switch checked={notify} onCheckedChange={setNotify} /></label>}
          {create.error && <p className="text-sm text-red-400" role="alert">{create.error instanceof ApiError && create.error.code === "taken" ? copy.bookings.taken : create.error.message}</p>}
          <Button type="submit" disabled={create.isPending} className="min-h-12 w-full rounded-xl bg-floodlight font-bold text-void" data-testid="button-create-booking">
            {create.isPending ? copy.bookings.creating : copy.bookings.create}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BookingSheet({ venueId, booking, pitches, onClose, onOpenChat }: { venueId: number; booking: Booking; pitches: Pitch[]; onClose: () => void; onOpenChat: (phone: string) => void }) {
  const copy = useVenueCopy();
  const action = useBookingAction(venueId);
  const edit = useEditBooking(venueId);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [byPlayer, setByPlayer] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pitchId, setPitchId] = useState(booking.pitchId);
  const [start, setStart] = useState(booking.startLocal.replace(" ", "T"));
  const [minutes, setMinutes] = useState(booking.minutes);
  const [notes, setNotes] = useState(booking.notes ?? "");
  const run = (a: BookingAction, extra: { reason?: string; series?: boolean; byPlayer?: boolean } = {}) => action.mutate({ id: booking.id, action: a, ...extra }, { onSuccess: () => setCancelling(false) });
  const ended = booking.status === "cancelled" || booking.status === "no_show";
  const live = booking.status === "held" || booking.status === "confirmed";
  const check = booking.receiptCheck;
  const mark = (ok: boolean | undefined, known: boolean) => !known ? copy.bookings.unknown : ok ? `✓ ${copy.bookings.ok}` : `✗ ${copy.bookings.notOk}`;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side={copy.locale === "ar" ? "left" : "right"} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <SheetHeader className="text-start">
          <SheetTitle className="font-display text-2xl">{booking.customerName || booking.teamName || copy.bookings.detailsTitle}</SheetTitle>
          <SheetDescription className="text-start text-muted-text">
            {dayName(booking.startLocal.slice(0, 10), copy.locale, "long")} · {clock(booking.startLocal, copy.locale)}–{clock(booking.endLocal, copy.locale)} · {copy.locale === "ar" ? booking.pitchNameAr || booking.pitchName : booking.pitchName}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Pill kind={booking.status}>{copy.status[booking.status]}</Pill>
          <Pill kind={booking.paymentStatus}>{copy.payment[booking.paymentStatus]}</Pill>
          <Pill kind="source">{copy.source[booking.source]}</Pill>
          {booking.seriesId && <Pill kind="series">↻</Pill>}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-muted-text">{copy.bookings.reference}</dt><dd className="font-mono font-bold">{booking.reference}</dd></div>
          <div><dt className="text-xs text-muted-text">{copy.bookings.amount}</dt><dd className="font-bold">{jod(booking.amountFils, copy.locale)}</dd></div>
          <div><dt className="text-xs text-muted-text">{copy.bookings.paidSoFar}</dt><dd>{jod(booking.paidFils, copy.locale)} {booking.payWith !== "none" ? `· ${copy.payWith[booking.payWith]}` : ""}</dd></div>
          <div><dt className="text-xs text-muted-text">{copy.bookings.balance}</dt><dd className={booking.balanceFils ? "font-bold text-amber-200" : ""}>{jod(booking.balanceFils, copy.locale)}</dd></div>
          {booking.customerPhone && <div className="col-span-2"><dt className="text-xs text-muted-text">{copy.bookings.phone}</dt><dd dir="ltr" className="text-start">+{booking.customerPhone}</dd></div>}
          {booking.holdExpiresAt && booking.status === "held" && <div className="col-span-2 text-xs text-amber-200">{copy.bookings.holdUntil(new Date(booking.holdExpiresAt).toLocaleTimeString(copy.locale === "ar" ? "ar-JO" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Amman" }))}</div>}
          {(booking.footageRequestId || booking.footageNote) && (
            <div className="col-span-2 flex items-start gap-2 rounded-xl bg-raised p-3 text-xs"><Video className="mt-0.5 h-4 w-4 shrink-0 text-turf" /><span>{booking.footageRequestId ? copy.bookings.cameraBooked : booking.footageNote}</span></div>
          )}
          {booking.notes && <div className="col-span-2 whitespace-pre-wrap text-muted-text" dir="auto">{booking.notes}</div>}
          {booking.feeFils > 0 && (
            <div><dt className="text-xs text-muted-text">{copy.bookings.fees}</dt><dd className="font-bold">{jod(booking.feeFils, copy.locale)}{booking.feeReason ? ` · ${copy.bookings.feeReasons[booking.feeReason] ?? ""}` : ""}</dd></div>
          )}
          {booking.refundDueFils > 0 && (
            <div><dt className="text-xs text-muted-text">{copy.bookings.toRefund}</dt><dd className="font-bold text-[#FF8A73]">{jod(booking.refundDueFils, copy.locale)}</dd></div>
          )}
          {booking.refundedFils > 0 && (
            <div><dt className="text-xs text-muted-text">{copy.bookings.refunded}</dt><dd>{jod(booking.refundedFils, copy.locale)}</dd></div>
          )}
          {(booking.depositReason !== "standard" || booking.changeCount > 0) && (
            <div className="col-span-2 flex flex-wrap gap-1.5 text-xs">
              {booking.depositReason !== "standard" && <Pill kind="rule">{copy.bookings.depositReasons[booking.depositReason]}</Pill>}
              {booking.changeCount > 0 && <Pill kind="rule">{copy.bookings.moved(booking.changeCount)}</Pill>}
            </div>
          )}
          {booking.cancelledBy && <div className="col-span-2 text-xs font-semibold text-muted-text">{copy.bookings.cancelledBy[booking.cancelledBy]}</div>}
          {booking.cancelReason && <div className="col-span-2 text-xs text-muted-text">{booking.cancelReason}</div>}
        </dl>

        {(booking.receiptUrl || check) && (
          <div className="mt-5 rounded-2xl border border-[#7B5CFF]/40 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-[#C9BCFF]">{copy.bookings.receipt}</p>
            {booking.receiptUrl && <a href={booking.receiptUrl} target="_blank" rel="noreferrer"><img src={booking.receiptUrl} alt={copy.bookings.receipt} className="mt-2 max-h-72 w-full rounded-lg object-contain bg-black/30" /></a>}
            {check && (
              <ul className="mt-3 space-y-1 text-xs">
                <li className="font-semibold text-text">{copy.bookings.receiptCheck}</li>
                <li>{copy.bookings.amountOk}: {check.amountFils != null ? jod(check.amountFils, copy.locale) : "?"} — {mark(check.amountOk, check.amountFils != null)}</li>
                <li>{copy.bookings.receiverOk}: {check.receiver ?? "?"} — {mark(check.receiverOk, Boolean(check.receiver))}</li>
                <li>{copy.bookings.referenceOk}: {mark(check.referenceOk, check.referenceFound != null)}</li>
                {check.autoConfirmed && <li className="text-floodlight">{copy.bookings.autoConfirmed}</li>}
              </ul>
            )}
          </div>
        )}

        {booking.moneyTo === "replay" && booking.payWith === "cliq" && booking.paymentStatus !== "paid" && (
          <p className="mt-4 rounded-xl bg-raised p-3 text-xs text-muted-text">{copy.bookings.replayConfirms}</p>
        )}

        <div className="mt-5 grid gap-2">
          {live && booking.paymentStatus !== "paid" && !(booking.moneyTo === "replay" && booking.payWith === "cliq") && booking.dueOnlineFils > 0 && (
            <Button type="button" onClick={() => run("confirm-payment")} disabled={action.isPending} className="min-h-11 bg-floodlight font-bold text-void" data-testid="button-confirm-payment">{copy.bookings.actions.confirmPayment}</Button>
          )}
          {live && booking.balanceFils > 0 && (booking.dueOnlineFils === 0 || booking.paymentStatus === "paid") && (
            <Button type="button" onClick={() => run("collect-balance")} disabled={action.isPending} className="min-h-11 bg-floodlight font-bold text-void">{copy.bookings.actions.collectBalance} · {jod(booking.balanceFils, copy.locale)}</Button>
          )}
          {booking.status === "held" && <Button type="button" variant="outline" onClick={() => run("confirm-hold")} disabled={action.isPending}>{copy.bookings.actions.confirmHold}</Button>}
          {booking.paymentStatus === "receipt" && <Button type="button" variant="outline" onClick={() => run("reject-receipt")} disabled={action.isPending}>{copy.bookings.actions.rejectReceipt}</Button>}
          {booking.status === "confirmed" && (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={() => run("complete")} disabled={action.isPending}>{copy.bookings.actions.complete}</Button>
              <Button type="button" variant="outline" onClick={() => run("no-show")} disabled={action.isPending}>{copy.bookings.actions.noShow}</Button>
            </div>
          )}
          {ended && booking.balanceFils > 0 && (
            <Button type="button" onClick={() => run("fee-collected")} disabled={action.isPending} className="min-h-11 bg-floodlight font-bold text-void" data-testid="button-fee-collected">{copy.bookings.actions.feeCollected} · {jod(booking.balanceFils, copy.locale)}</Button>
          )}
          {booking.refundDueFils > 0 && (
            <Button type="button" onClick={() => run("refund-sent")} disabled={action.isPending} variant="outline" className="min-h-11 border-[#FF8A73]/50 font-bold" data-testid="button-refund-sent">{copy.bookings.actions.refundSent} · {jod(booking.refundDueFils, copy.locale)}</Button>
          )}
          {booking.feeFils > 0 && <Button type="button" variant="ghost" onClick={() => run("waive-fee")} disabled={action.isPending}>{copy.bookings.actions.waiveFee}</Button>}
          {(booking.status === "completed" || booking.status === "no_show") && <Button type="button" variant="ghost" onClick={() => run("reopen")}>{copy.bookings.actions.reopen}</Button>}
          {booking.customerPhone && (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={() => { onClose(); onOpenChat(booking.customerPhone!); }}><MessageCircle className="me-1.5 h-4 w-4" />{copy.bookings.actions.chat}</Button>
              {live && <Button type="button" variant="outline" onClick={() => run("resend")} disabled={action.isPending}>{copy.bookings.actions.resend}</Button>}
            </div>
          )}
          {live && <Button type="button" variant="ghost" onClick={() => setEditing((e) => !e)}>{copy.bookings.actions.edit}</Button>}
          {editing && (
            <div className="space-y-3 rounded-xl border border-line p-3">
              <select value={pitchId} onChange={(e) => setPitchId(Number(e.target.value))} className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm">
                {pitches.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <Input type="datetime-local" step={900} value={start} onChange={(e) => setStart(e.target.value)} />
              <div className="flex flex-wrap gap-1.5">{LENGTHS.map((m) => <button key={m} type="button" onClick={() => setMinutes(m)} className={cn("min-h-9 rounded-full px-3 text-xs font-semibold", minutes === m ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{copy.bookings.minutes(m)}</button>)}</div>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={copy.bookings.notes} dir="auto" />
              <Button type="button" className="w-full" disabled={edit.isPending} onClick={() => edit.mutate({ id: booking.id, pitchId, startLocal: start.replace("T", " ").slice(0, 16), minutes, notes }, { onSuccess: () => setEditing(false) })}>{copy.bookings.save}</Button>
              <ErrorText error={edit.error} />
            </div>
          )}
          {live && !cancelling && <Button type="button" variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => setCancelling(true)}>{copy.bookings.actions.cancel}</Button>}
          {cancelling && (
            <div className="space-y-2 rounded-xl border border-red-400/40 p-3">
              <p className="text-sm">{copy.bookings.cancelConfirm}</p>
              {booking.customerPhone && (
                <div className="space-y-1.5" role="radiogroup" aria-label={copy.bookings.whoCancels}>
                  <p className="text-xs font-semibold text-muted-text">{copy.bookings.whoCancels}</p>
                  {([false, true] as const).map((p) => (
                    <button key={String(p)} type="button" role="radio" aria-checked={byPlayer === p} onClick={() => setByPlayer(p)}
                      className={cn("block w-full rounded-xl border px-3 py-2 text-start", byPlayer === p ? "border-turf bg-turf/10" : "border-line bg-raised")}>
                      <span className="block text-sm font-semibold text-text">{p ? copy.bookings.byPlayer : copy.bookings.byField}</span>
                      <span className="block text-xs text-muted-text">{p ? copy.bookings.byPlayerHint : copy.bookings.byFieldHint}</span>
                    </button>
                  ))}
                </div>
              )}
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={copy.bookings.cancelReason} dir="auto" />
              <div className="flex flex-wrap gap-2">
                <Button type="button" className="bg-red-500 text-white hover:bg-red-500/90" onClick={() => run("cancel", { reason, byPlayer })}>{copy.bookings.actions.cancel}</Button>
                {booking.seriesId && <Button type="button" variant="outline" onClick={() => run("cancel", { reason, series: true })}>{copy.bookings.actions.cancelSeries}</Button>}
                <Button type="button" variant="ghost" onClick={() => setCancelling(false)}>{copy.bookings.keep}</Button>
              </div>
            </div>
          )}
          <ErrorText error={action.error} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
