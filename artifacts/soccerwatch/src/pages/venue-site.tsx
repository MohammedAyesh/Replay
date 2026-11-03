import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { CalendarCheck2, Check, Clock, Copy, CreditCard, Instagram, Loader2, MapPin, MessageCircle, Video, Wallet } from "lucide-react";

/**
 * A field's public booking website: replayjo.com/v/<slug>, or the field's own domain
 * (main.tsx renders VenueSiteStandalone there, without the app around it). No sign-in:
 * players pick a time, leave a name and a WhatsApp number, and pay by CliQ, card or at the
 * field. Self-contained (its own copy and language switch) so it works on a foreign domain.
 */

type Locale = "ar" | "en";
type PriceRule = { days: number[]; from: string; to: string; pricePerHourFils: number };
type Site = {
  id: number; slug: string; name: string; nameAr: string | null; logoUrl: string | null;
  tagline: string | null; taglineAr: string | null; about: string | null; aboutAr: string | null;
  heroImageUrl: string | null; accentColor: string | null; address: string | null; latitude: number | null; longitude: number | null;
  instagramUrl: string | null; facebookUrl: string | null; whatsappPhone: string | null; fieldId: number;
  bookingEnabled: boolean; openingHours: Record<string, { open: string; close: string } | null>; durations: number[]; maxDaysAhead: number;
  pitches: Array<{ id: number; name: string; nameAr: string | null; size: string; surface: string | null; indoor: boolean; pricePerHourFils: number; priceRules: PriceRule[]; imageUrl: string | null; hasCamera: boolean }>;
  payment: { cliq: boolean; card: boolean; field: boolean; depositMode: string; depositFils: number; depositPercent?: number; cancelHours: number; perPlayer?: boolean; allowChanges?: boolean };
  rules?: { en: string[]; ar: string[] };
  today: string;
};
type Slot = { startLocal: string; options: Array<{ minutes: number; priceFils: number; available: boolean }> };
type Availability = { date: string; pitches: Array<{ pitchId: number; slots: Slot[] }> };
type BookingResult = {
  reference: string; status: string; paymentStatus: string; pitchName: string; pitchNameAr?: string | null; startLocal: string; endLocal: string;
  amountFils: number; dueOnlineFils: number; balanceFils: number; feeFils?: number; refundFils?: number; payWith: string; cliqAlias: string | null; cliqName: string | null; cardUrl: string | null; holdExpiresAt: string | null;
};

type Quote = { amountFils: number; onlineDueFils: number; minimumOnlineFils: number; reason: "standard" | "rule"; methods: { cliq: boolean; card: boolean; field: boolean }; blocked: boolean };
type Manage = {
  booking: BookingResult; minutes: number; pitchId: number;
  cancel: { allowed: boolean; late: boolean; feeFils: number; refundFils: number; owedFils: number; hours: number };
  change: { allowed: boolean; reason: "ok" | "off" | "too_late" | "too_many" | "not_active"; feeFils: number; changesLeft: number; hours: number };
};

const apiBase = `${(import.meta.env.BASE_URL ?? "/").replace(/\/$/, "")}/api`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${apiBase}${path}`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `Error ${r.status}`);
  return data as T;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${apiBase}${path}`, { credentials: "omit" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `Error ${r.status}`);
  return data as T;
}

const T = {
  en: {
    book: "Book a pitch",
    bookNow: "Book now",
    pickDay: "Day",
    pickPitch: "Pitch",
    pickLength: "How long",
    pickTime: "Kick-off",
    noTimes: "Nothing free that day. Try another day.",
    closed: "Bookings are closed online right now. Message us on WhatsApp.",
    details: "Your details",
    name: "Name",
    phone: "WhatsApp number",
    phoneHint: "Your confirmation comes on WhatsApp.",
    team: "Team name (optional)",
    pay: "How do you want to pay?",
    payCliq: "CliQ transfer",
    payCard: "Card / Apple Pay",
    payField: "Pay at the field",
    deposit: (v: string) => `Deposit online: ${v}, the rest at the field`,
    confirm: "Book",
    booking: "Booking…",
    change: "Change",
    total: "Total",
    held: "Your slot is held",
    confirmed: "You're booked! ✅",
    paidTitle: "Paid and confirmed ✅",
    code: "Booking code",
    sendTo: "Send by CliQ to",
    amount: "Amount",
    note: "Write this in the transfer note",
    receipt: "Then send the receipt on WhatsApp",
    sendReceipt: "Send receipt on WhatsApp",
    payCardNow: "Pay now",
    holdUntil: (t: string) => `We hold it until ${t}.`,
    atField: (v: string) => `Pay ${v} at the field.`,
    whatsapp: "WhatsApp us",
    directions: "Directions",
    pitches: "Pitches & prices",
    hours: "Opening hours",
    perHour: "/ hour",
    from: "from",
    closedDay: "Closed",
    about: "About",
    camera: "Filmed by Replay",
    cameraHint: "Games on camera pitches are filmed. Your match video comes on WhatsApp after the game.",
    cancelPolicy: (h: number) => `Free cancellation up to ${h} hours before kick-off.`,
    powered: "Bookings by Replay",
    copied: "Copied",
    error: "Something went wrong. Try again or message us on WhatsApp.",
    notFound: "This page doesn't exist.",
    days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    minutes: (m: number) => m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`,
    today: "Today",
    tomorrow: "Tomorrow",
    rulesTitle: "Good to know",
    firstPay: (v: string) => `To confirm this booking, ${v} is paid online.`,
    blocked: "Please message us on WhatsApp to book.",
    manage: "Manage my booking",
    manageHint: "Change or cancel with your booking code and WhatsApp number.",
    find: "Find my booking",
    codePlaceholder: "Booking code",
    cancelBooking: "Cancel booking",
    cancelFree: "Cancelling now is free.",
    cancelFee: (v: string) => `Cancelling now costs ${v}.`,
    refundNote: (v: string) => `We'll refund ${v}.`,
    owedNote: (v: string) => `${v} is still to pay.`,
    cancelTooLate: (h: number) => `It's less than ${h} hours to kick-off. Message us on WhatsApp to cancel.`,
    confirmCancel: "Yes, cancel it",
    keep: "Keep it",
    changeTime: "Change time",
    changeFree: "Changing is free.",
    changeFee: (v: string) => `Changing costs ${v}.`,
    cantChange: { off: "Changes aren't taken online. Message us on WhatsApp.", too_late: "It's too close to kick-off to change online. Message us on WhatsApp.", too_many: "This booking can't be changed again online. Message us on WhatsApp.", not_active: "This booking can't be changed." } as Record<string, string>,
    pickNewTime: "Pick a new time",
    moved: "Moved ✅ The new time is on WhatsApp.",
    cancelledTitle: "Cancelled. The details are on WhatsApp.",
    fee: "Fee",
    refund: "Refund",
    statusLabel: { held: "Waiting for payment", confirmed: "Confirmed", cancelled: "Cancelled", completed: "Played", no_show: "Missed" } as Record<string, string>,
  },
  ar: {
    book: "احجز ملعب",
    bookNow: "احجز هلأ",
    pickDay: "اليوم",
    pickPitch: "الملعب",
    pickLength: "المدة",
    pickTime: "الساعة",
    noTimes: "ما في مواعيد فاضية بهاليوم. جرّب يوم ثاني.",
    closed: "الحجز الأونلاين مسكّر هلأ. احكينا عالواتساب.",
    details: "معلوماتك",
    name: "الاسم",
    phone: "رقم الواتساب",
    phoneHint: "تأكيد الحجز بيوصلك عالواتساب.",
    team: "اسم الفريق (اختياري)",
    pay: "كيف بدك تدفع؟",
    payCliq: "تحويل كليك",
    payCard: "بطاقة / Apple Pay",
    payField: "بالملعب",
    deposit: (v: string) => `عربون أونلاين: ${v}، والباقي بالملعب`,
    confirm: "احجز",
    booking: "عم نحجز…",
    change: "غيّر",
    total: "المجموع",
    held: "الموعد محجوزلك",
    confirmed: "تم الحجز! ✅",
    paidTitle: "انْدفع وتأكد ✅",
    code: "رقم الحجز",
    sendTo: "حوّل على كليك",
    amount: "المبلغ",
    note: "اكتب هاد بملاحظة التحويل",
    receipt: "وبعدها ابعت الإيصال عالواتساب",
    sendReceipt: "ابعت الإيصال عالواتساب",
    payCardNow: "ادفع هلأ",
    holdUntil: (t: string) => `محجوزلك لحد ${t}.`,
    atField: (v: string) => `بتدفع ${v} بالملعب.`,
    whatsapp: "واتساب",
    directions: "الموقع",
    pitches: "الملاعب والأسعار",
    hours: "ساعات الدوام",
    perHour: "/ ساعة",
    from: "من",
    closedDay: "مسكّر",
    about: "عنّا",
    camera: "مصوّر مع ريبلاي",
    cameraHint: "المباريات على ملاعب الكاميرا بتتصوّر، وفيديو مباراتك بيوصلك عالواتساب بعد اللعب.",
    cancelPolicy: (h: number) => `بتقدر تلغي ببلاش لحد ${h} ساعات قبل الموعد.`,
    powered: "الحجوزات من ريبلاي",
    copied: "انتسخ",
    error: "صار خطأ. جرّب كمان مرة أو احكينا عالواتساب.",
    notFound: "هالصفحة مش موجودة.",
    days: ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
    minutes: (m: number) => m === 60 ? "ساعة" : m === 90 ? "ساعة ونص" : m === 120 ? "ساعتين" : m % 60 === 0 ? `${m / 60} ساعات` : `${m} دقيقة`,
    today: "اليوم",
    tomorrow: "بكرا",
    rulesTitle: "قبل ما تحجز",
    firstPay: (v: string) => `عشان نثبّت الحجز، بتدفع ${v} أونلاين.`,
    blocked: "احكينا عالواتساب عشان تحجز.",
    manage: "إدارة حجزي",
    manageHint: "غيّر أو ألغِ حجزك برقم الحجز ورقم الواتساب.",
    find: "دوّر على حجزي",
    codePlaceholder: "رقم الحجز",
    cancelBooking: "ألغِ الحجز",
    cancelFree: "الإلغاء هلأ مجاني.",
    cancelFee: (v: string) => `الإلغاء هلأ عليه رسوم ${v}.`,
    refundNote: (v: string) => `رح نرجعلك ${v}.`,
    owedNote: (v: string) => `ضايل عليك ${v}.`,
    cancelTooLate: (h: number) => `ضايل أقل من ${h} ساعات عالموعد. احكينا عالواتساب عشان تلغي.`,
    confirmCancel: "أيوه، ألغيه",
    keep: "خليه",
    changeTime: "غيّر الموعد",
    changeFree: "التغيير مجاني.",
    changeFee: (v: string) => `التغيير عليه رسوم ${v}.`,
    cantChange: { off: "ما بنغيّر المواعيد أونلاين. احكينا عالواتساب.", too_late: "صار قريب كثير من الموعد. احكينا عالواتساب.", too_many: "ما بتقدر تغيّر هالحجز مرة ثانية أونلاين. احكينا عالواتساب.", not_active: "ما بينفع نغيّر هالحجز." } as Record<string, string>,
    pickNewTime: "اختار موعد جديد",
    moved: "انغيّر الموعد ✅ التفاصيل عالواتساب.",
    cancelledTitle: "انلغى الحجز. التفاصيل عالواتساب.",
    fee: "رسوم",
    refund: "مبلغ مسترجع",
    statusLabel: { held: "بانتظار الدفع", confirmed: "مأكّد", cancelled: "ملغي", completed: "انلعب", no_show: "ما إجيت" } as Record<string, string>,
  },
};

function jod(fils: number, locale: Locale) {
  const n = new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", { maximumFractionDigits: 3 }).format(fils / 1000);
  return locale === "ar" ? `${n} د.أ` : `${n} JOD`;
}
function clock(hhmm: string, locale: Locale) {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h >= 12 ? (locale === "ar" ? "م" : "pm") : (locale === "ar" ? "ص" : "am")}`;
}
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function VenueSitePage() {
  const params = useParams<{ slug: string }>();
  return <VenueSite source={{ slug: params.slug ?? "" }} />;
}

export function VenueSiteStandalone({ host }: { host: string }) {
  return <VenueSite source={{ host }} />;
}

function VenueSite({ source }: { source: { slug?: string; host?: string } }) {
  const [locale, setLocale] = useState<Locale>(() => {
    try { const saved = localStorage.getItem("venue_site_locale"); if (saved === "en" || saved === "ar") return saved; } catch { /* storage may be off */ }
    return typeof navigator !== "undefined" && navigator.language?.startsWith("en") ? "en" : "ar";
  });
  const t = T[locale];
  const [site, setSite] = useState<Site | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const path = source.host ? `/venue-site/by-host?host=${encodeURIComponent(source.host)}` : `/venue-site/${encodeURIComponent(source.slug ?? "")}`;
    get<Site>(path).then(setSite).catch(() => setFailed(true));
  }, [source.host, source.slug]);

  useEffect(() => {
    if (!site) return;
    document.title = locale === "ar" ? site.nameAr || site.name : site.name;
    try { localStorage.setItem("venue_site_locale", locale); } catch { /* optional */ }
  }, [site, locale]);

  const accent = site?.accentColor ?? "#D4FF4F";
  const dir = locale === "ar" ? "rtl" : "ltr";

  if (failed) return <div className="grid min-h-[100dvh] place-items-center bg-[#0B0F1A] p-6 text-center text-white/70" dir={dir}>{t.notFound}</div>;
  if (!site) return <div className="grid min-h-[100dvh] place-items-center bg-[#0B0F1A]"><Loader2 className="h-8 w-8 animate-spin text-white/50" /></div>;

  const name = locale === "ar" ? site.nameAr || site.name : site.name;
  const tagline = locale === "ar" ? site.taglineAr || site.tagline : site.tagline || site.taglineAr;
  const about = locale === "ar" ? site.aboutAr || site.about : site.about || site.aboutAr;
  const wa = site.whatsappPhone ? `https://wa.me/${site.whatsappPhone}` : null;
  const map = site.latitude && site.longitude ? `https://maps.google.com/?q=${site.latitude},${site.longitude}` : site.address ? `https://maps.google.com/?q=${encodeURIComponent(site.address)}` : null;
  const anyCamera = site.pitches.some((p) => p.hasCamera);

  return (
    <div className="min-h-[100dvh] bg-[#0B0F1A] text-white" dir={dir} style={{ ["--accent" as string]: accent }} data-testid="venue-site">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0B0F1A]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          {site.logoUrl ? <img src={site.logoUrl} alt="" className="h-9 w-9 rounded-xl object-cover" /> : <span className="grid h-9 w-9 place-items-center rounded-xl font-bold text-[#0B0F1A]" style={{ background: accent }}>{name.slice(0, 1)}</span>}
          <span className="min-w-0 flex-1 truncate font-display text-lg font-bold">{name}</span>
          <button type="button" onClick={() => setLocale(locale === "ar" ? "en" : "ar")} className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-bold">{locale === "ar" ? "EN" : "عربي"}</button>
          {wa && <a href={wa} className="flex items-center gap-1.5 rounded-full bg-[#25D366] px-3 py-1.5 text-xs font-bold text-[#0B0F1A]"><MessageCircle className="h-3.5 w-3.5" />{t.whatsapp}</a>}
        </div>
      </header>

      <section className="relative overflow-hidden">
        {site.heroImageUrl && <img src={site.heroImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-45" />}
        <div className="absolute inset-0 bg-gradient-to-b from-[#0B0F1A]/30 via-[#0B0F1A]/70 to-[#0B0F1A]" />
        <div className="relative mx-auto max-w-5xl px-4 pb-10 pt-16 sm:pt-24">
          <h1 className="font-display text-4xl font-bold leading-tight sm:text-6xl">{name}</h1>
          {tagline && <p className="mt-3 max-w-xl text-lg text-white/80">{tagline}</p>}
          <div className="mt-6 flex flex-wrap gap-2">
            <a href="#book" className="rounded-2xl px-5 py-3 font-bold text-[#0B0F1A]" style={{ background: accent }}>{t.bookNow}</a>
            {map && <a href={map} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-2xl border border-white/20 px-4 py-3 text-sm font-semibold"><MapPin className="h-4 w-4" />{t.directions}</a>}
            {site.instagramUrl && <a href={site.instagramUrl} target="_blank" rel="noreferrer" className="grid place-items-center rounded-2xl border border-white/20 px-3 py-3"><Instagram className="h-4 w-4" /></a>}
          </div>
          {site.address && <p className="mt-4 text-sm text-white/60">{site.address}</p>}
        </div>
      </section>

      <main className="mx-auto max-w-5xl space-y-8 px-4 pb-16">
        <BookingCard site={site} locale={locale} slug={site.slug} accent={accent} wa={site.whatsappPhone} />
        <ManageCard site={site} locale={locale} slug={site.slug} accent={accent} />

        {anyCamera && (
          <section className="flex items-start gap-3 rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <Video className="mt-0.5 h-5 w-5 shrink-0" style={{ color: accent }} />
            <div><p className="font-bold">{t.camera}</p><p className="mt-1 text-sm text-white/65">{t.cameraHint}</p></div>
          </section>
        )}

        <section>
          <h2 className="font-display text-2xl font-bold">{t.pitches}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {site.pitches.map((p) => (
              <article key={p.id} className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03]">
                {p.imageUrl && <img src={p.imageUrl} alt="" className="h-40 w-full object-cover" loading="lazy" />}
                <div className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-display text-xl font-bold">{locale === "ar" ? p.nameAr || p.name : p.name}</h3>
                    {p.hasCamera && <Video className="h-4 w-4" style={{ color: accent }} />}
                  </div>
                  <p className="mt-1 text-sm text-white/60">{p.size}×{p.size}{p.surface ? ` · ${p.surface}` : ""}</p>
                  <p className="mt-3 font-display text-2xl font-bold" style={{ color: accent }}>{jod(p.pricePerHourFils, locale)} <span className="text-sm font-normal text-white/50">{t.perHour}</span></p>
                  {p.priceRules.map((r, i) => <p key={i} className="mt-1 text-xs text-white/55">{r.days.map((d) => t.days[d]).join("، ")} {r.from}–{r.to}: {jod(r.pricePerHourFils, locale)}</p>)}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="flex items-center gap-2 font-display text-xl font-bold"><Clock className="h-5 w-5" style={{ color: accent }} />{t.hours}</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              {[0, 1, 2, 3, 4, 5, 6].map((d) => {
                const h = site.openingHours[String(d)];
                return <li key={d} className="flex justify-between"><span className="text-white/65">{t.days[d]}</span><span dir="ltr">{h ? `${h.open} – ${h.close}` : t.closedDay}</span></li>;
              })}
            </ul>
          </div>
          {about && <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-display text-xl font-bold">{t.about}</h2><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/75">{about}</p></div>}
        </section>
      </main>
      <footer className="border-t border-white/10 py-6 text-center text-xs text-white/40"><a href="https://replayjo.com" className="hover:text-white/70">{t.powered}</a></footer>
    </div>
  );
}

function BookingCard({ site, locale, slug, accent, wa }: { site: Site; locale: Locale; slug: string; accent: string; wa: string | null }) {
  const t = T[locale];
  const days = useMemo(() => Array.from({ length: Math.min(14, site.maxDaysAhead + 1) }, (_, i) => addDays(site.today, i)).filter((d) => site.openingHours[String(new Date(`${d}T00:00:00Z`).getUTCDay())]), [site]);
  const [date, setDate] = useState(days[0] ?? site.today);
  const [pitchId, setPitchId] = useState(site.pitches[0]?.id ?? 0);
  const [minutes, setMinutes] = useState(site.durations.includes(60) ? 60 : site.durations[0] ?? 60);
  const [slots, setSlots] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<{ startLocal: string; priceFils: number } | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);
  const initialRef = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("booking") : null;

  useEffect(() => {
    setLoading(true);
    get<Availability>(`/venue-site/${slug}/availability?date=${date}`).then(setSlots).catch(() => setSlots(null)).finally(() => setLoading(false));
  }, [slug, date, result]);

  useEffect(() => {
    if (initialRef) get<BookingResult>(`/venue-site/${slug}/bookings/${initialRef}`).then(setResult).catch(() => undefined);
  }, [initialRef, slug]);

  if (result) return <Confirmation result={result} locale={locale} slug={slug} accent={accent} wa={wa} onNew={() => { setResult(null); setChosen(null); }} />;

  const times = (slots?.pitches.find((p) => p.pitchId === pitchId)?.slots ?? [])
    .flatMap((s) => s.options.filter((o) => o.minutes === minutes && o.available).map((o) => ({ startLocal: s.startLocal, priceFils: o.priceFils })));
  const dayLabel = (d: string) => d === site.today ? t.today : d === addDays(site.today, 1) ? t.tomorrow : `${t.days[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${Number(d.slice(8))}`;

  return (
    <section id="book" className="scroll-mt-20 rounded-3xl border border-white/10 bg-white/[0.04] p-5 sm:p-7" data-testid="venue-booking">
      <h2 className="flex items-center gap-2 font-display text-2xl font-bold"><CalendarCheck2 className="h-6 w-6" style={{ color: accent }} />{t.book}</h2>
      {!site.bookingEnabled ? <p className="mt-4 text-white/70">{t.closed}</p> : chosen ? (
        <DetailsForm site={site} locale={locale} slug={slug} accent={accent} pitchId={pitchId} minutes={minutes} chosen={chosen} onBack={() => setChosen(null)} onDone={setResult} />
      ) : (
        <div className="mt-5 space-y-5">
          <Chooser label={t.pickDay}>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {days.map((d) => <Chip key={d} active={d === date} accent={accent} onClick={() => setDate(d)}>{dayLabel(d)}</Chip>)}
            </div>
          </Chooser>
          {site.pitches.length > 1 && (
            <Chooser label={t.pickPitch}>
              <div className="flex flex-wrap gap-2">{site.pitches.map((p) => <Chip key={p.id} active={p.id === pitchId} accent={accent} onClick={() => setPitchId(p.id)}>{locale === "ar" ? p.nameAr || p.name : p.name} · {p.size}×{p.size}</Chip>)}</div>
            </Chooser>
          )}
          {site.durations.length > 1 && (
            <Chooser label={t.pickLength}>
              <div className="flex flex-wrap gap-2">{site.durations.map((m) => <Chip key={m} active={m === minutes} accent={accent} onClick={() => setMinutes(m)}>{t.minutes(m)}</Chip>)}</div>
            </Chooser>
          )}
          <Chooser label={t.pickTime}>
            {loading ? <Loader2 className="h-5 w-5 animate-spin text-white/50" /> : times.length === 0 ? <p className="text-sm text-white/60">{t.noTimes}</p> : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {times.map((s) => (
                  <button key={s.startLocal} type="button" onClick={() => setChosen(s)} className="rounded-2xl border border-white/15 bg-white/[0.03] p-2.5 text-center hover:border-[var(--accent)]" data-testid="venue-time">
                    <span className="block font-display text-base font-bold" dir="ltr">{clock(s.startLocal.slice(11), locale)}</span>
                    <span className="block text-[11px] text-white/55">{jod(s.priceFils, locale)}</span>
                  </button>
                ))}
              </div>
            )}
          </Chooser>
          {site.rules?.[locale]?.length ? (
            <div className="rounded-2xl border border-white/10 p-3" data-testid="venue-rules">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/45">{t.rulesTitle}</p>
              <ul className="mt-1.5 space-y-1 text-xs text-white/65">{site.rules[locale].map((line) => <li key={line}>• {line}</li>)}</ul>
            </div>
          ) : <p className="text-xs text-white/45">{t.cancelPolicy(site.payment.cancelHours)}</p>}
        </div>
      )}
    </section>
  );
}

function Chooser({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-white/45">{label}</p>{children}</div>;
}

function Chip({ active, accent, onClick, children }: { active: boolean; accent: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition-colors"
      style={active ? { background: accent, borderColor: accent, color: "#0B0F1A" } : { borderColor: "rgba(255,255,255,0.15)" }}>{children}</button>
  );
}

function DetailsForm({ site, locale, slug, accent, pitchId, minutes, chosen, onBack, onDone }: {
  site: Site; locale: Locale; slug: string; accent: string; pitchId: number; minutes: number; chosen: { startLocal: string; priceFils: number };
  onBack: () => void; onDone: (r: BookingResult) => void;
}) {
  const t = T[locale];
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  // Once the number is in, ask what this player pays: a first booking may need money online.
  useEffect(() => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 9) { setQuote(null); return; }
    const id = setTimeout(() => {
      post<Quote>(`/venue-site/${slug}/quote`, { pitchId, startLocal: chosen.startLocal, minutes, phone }).then(setQuote).catch(() => setQuote(null));
    }, 400);
    return () => clearTimeout(id);
  }, [phone, slug, pitchId, chosen.startLocal, minutes]);
  const allowed = quote?.methods ?? { cliq: site.payment.cliq, card: site.payment.card, field: site.payment.field };
  const methods = ([allowed.cliq && "cliq", allowed.card && "card", allowed.field && "field"].filter(Boolean)) as Array<"cliq" | "card" | "field">;
  const [team, setTeam] = useState("");
  const [trap, setTrap] = useState("");
  const [payWith, setPayWith] = useState<"cliq" | "card" | "field">(methods[0] ?? "field");
  useEffect(() => { if (methods.length && !methods.includes(payWith)) setPayWith(methods[0]); }, [methods.join(","), payWith]); // eslint-disable-line react-hooks/exhaustive-deps
  const depositFils = quote ? quote.onlineDueFils : site.payment.depositPercent ? Math.round((chosen.priceFils * site.payment.depositPercent) / 100) : Math.min(chosen.priceFils, site.payment.depositFils);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pitch = site.pitches.find((p) => p.id === pitchId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${apiBase}/venue-site/${slug}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pitchId, startLocal: chosen.startLocal, minutes, name, phone, teamName: team || undefined, payWith, ...(trap ? { website: trap } : {}) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as { error?: string }).error ?? t.error);
      const booking = data as BookingResult;
      if (booking.payWith === "card" && booking.cardUrl) { window.location.href = booking.cardUrl; return; }
      onDone(booking);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
    } finally {
      setBusy(false);
    }
  };

  const label = { cliq: t.payCliq, card: t.payCard, field: t.payField };
  const icon = { cliq: Wallet, card: CreditCard, field: MapPin };
  return (
    <form onSubmit={submit} className="mt-5 space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div>
          <p className="font-bold">{locale === "ar" ? pitch?.nameAr || pitch?.name : pitch?.name} · <span dir="ltr">{clock(chosen.startLocal.slice(11), locale)}</span></p>
          <p className="text-sm text-white/60">{chosen.startLocal.slice(0, 10)} · {t.minutes(minutes)} · {t.total} {jod(chosen.priceFils, locale)}</p>
        </div>
        <button type="button" onClick={onBack} className="text-sm font-semibold underline">{t.change}</button>
      </div>
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-white/45">{t.details}</p>
      <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder={t.name} className="w-full rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 outline-none focus:border-[var(--accent)]" />
      <div>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" placeholder="07XXXXXXXX" dir="ltr" className="w-full rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 text-start outline-none focus:border-[var(--accent)]" aria-label={t.phone} />
        <p className="mt-1 text-xs text-white/50">{t.phoneHint}</p>
      </div>
      <input value={team} onChange={(e) => setTeam(e.target.value)} maxLength={80} placeholder={t.team} className="w-full rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 outline-none focus:border-[var(--accent)]" />
      <input value={trap} onChange={(e) => setTrap(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" name="website" />
      {methods.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-white/45">{t.pay}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {methods.map((m) => {
              const Icon = icon[m];
              return (
                <button key={m} type="button" onClick={() => setPayWith(m)} className="flex items-center gap-2 rounded-2xl border p-3 text-start text-sm font-semibold"
                  style={payWith === m ? { borderColor: accent, background: "rgba(255,255,255,0.06)" } : { borderColor: "rgba(255,255,255,0.15)" }}>
                  <Icon className="h-4 w-4" style={{ color: accent }} />{label[m]}
                </button>
              );
            })}
          </div>
          {payWith !== "field" && depositFils > 0 && depositFils < chosen.priceFils && <p className="mt-2 text-xs text-white/60">{t.deposit(jod(depositFils, locale))}</p>}
          {quote?.reason === "rule" && quote.minimumOnlineFils > 0 && <p className="mt-2 text-xs font-semibold" style={{ color: accent }} data-testid="venue-first-pay">{t.firstPay(jod(quote.minimumOnlineFils, locale))}</p>}
        </div>
      )}
      {quote?.blocked && <p className="text-sm text-[#FF8A73]" role="alert">{t.blocked}</p>}
      {error && <p className="text-sm text-[#FF8A73]" role="alert">{error}</p>}
      <button type="submit" disabled={busy || Boolean(quote?.blocked)} className="w-full rounded-2xl py-3.5 font-bold text-[#0B0F1A] disabled:opacity-60" style={{ background: accent }} data-testid="venue-submit">{busy ? t.booking : t.confirm}</button>
    </form>
  );
}

function Confirmation({ result, locale, slug, accent, wa, onNew }: { result: BookingResult; locale: Locale; slug: string; accent: string; wa: string | null; onNew: () => void }) {
  const t = T[locale];
  const [r, setR] = useState(result);
  const [copied, setCopied] = useState<string | null>(null);
  const poll = useCallback(() => get<BookingResult>(`/venue-site/${slug}/bookings/${r.reference}`).then(setR).catch(() => undefined), [slug, r.reference]);
  useEffect(() => {
    if (r.paymentStatus === "paid" || r.status === "cancelled") return;
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [poll, r.paymentStatus, r.status]);
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); setCopied(text); setTimeout(() => setCopied(null), 1500); };
  const hold = r.holdExpiresAt ? new Date(r.holdExpiresAt).toLocaleTimeString(locale === "ar" ? "ar-JO" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Amman" }) : null;
  const receiptText = encodeURIComponent(locale === "ar" ? `إيصال الحجز ${r.reference}` : `Receipt for booking ${r.reference}`);
  const title = r.paymentStatus === "paid" ? t.paidTitle : r.status === "held" ? t.held : t.confirmed;
  return (
    <section id="book" className="rounded-3xl border p-5 sm:p-7" style={{ borderColor: accent }} data-testid="venue-confirmation">
      <h2 className="flex items-center gap-2 font-display text-2xl font-bold"><Check className="h-6 w-6" style={{ color: accent }} />{title}</h2>
      <p className="mt-2 text-white/70">{locale === "ar" ? r.pitchNameAr || r.pitchName : r.pitchName} · {t.days[new Date(`${r.startLocal.slice(0, 10)}T00:00:00Z`).getUTCDay()]} {Number(r.startLocal.slice(8, 10))}/{Number(r.startLocal.slice(5, 7))} · <span dir="ltr">{clock(r.startLocal.slice(11), locale)}</span></p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Field label={t.code} value={r.reference} mono onCopy={() => copy(r.reference)} copied={copied === r.reference} copiedText={t.copied} />
        <Field label={t.total} value={jod(r.amountFils, locale)} />
      </div>
      {r.status === "held" && r.payWith === "cliq" && r.cliqAlias && r.paymentStatus !== "paid" && (
        <div className="mt-5 space-y-3 rounded-2xl bg-white/[0.05] p-4">
          <Field label={t.sendTo} value={`${r.cliqAlias}${r.cliqName ? ` (${r.cliqName})` : ""}`} mono onCopy={() => copy(r.cliqAlias!)} copied={copied === r.cliqAlias} copiedText={t.copied} />
          <Field label={t.amount} value={jod(r.dueOnlineFils, locale)} />
          <Field label={t.note} value={r.reference} mono onCopy={() => copy(r.reference)} copied={copied === r.reference} copiedText={t.copied} />
          <p className="text-sm text-white/70">{t.receipt}</p>
          {wa && <a href={`https://wa.me/${wa}?text=${receiptText}`} className="flex items-center justify-center gap-2 rounded-2xl bg-[#25D366] py-3 font-bold text-[#0B0F1A]"><MessageCircle className="h-4 w-4" />{t.sendReceipt}</a>}
          {hold && <p className="text-xs text-white/50">{t.holdUntil(hold)}</p>}
        </div>
      )}
      {r.status === "held" && r.payWith === "card" && r.cardUrl && r.paymentStatus !== "paid" && (
        <a href={r.cardUrl} className="mt-5 block rounded-2xl py-3 text-center font-bold text-[#0B0F1A]" style={{ background: accent }}>{t.payCardNow}</a>
      )}
      {r.balanceFils > 0 && (r.status === "confirmed" || r.status === "completed") && <p className="mt-4 text-sm text-white/70">{t.atField(jod(r.balanceFils, locale))}</p>}
      <button type="button" onClick={onNew} className="mt-6 text-sm font-semibold underline">{t.book}</button>
    </section>
  );
}

function ManageCard({ site, locale, slug, accent }: { site: Site; locale: Locale; slug: string; accent: string }) {
  const t = T[locale];
  const initial = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("manage") : null;
  const [open, setOpen] = useState(Boolean(initial));
  const [code, setCode] = useState(initial ?? "");
  const [phone, setPhone] = useState("");
  const [m, setM] = useState<Manage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "cancel" | "change">("view");
  const [done, setDone] = useState<string | null>(null);
  const [date, setDate] = useState(site.today);
  const [slots, setSlots] = useState<Availability | null>(null);

  const call = async (path: string, extra: Record<string, unknown> = {}, after?: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await post<Manage>(`/venue-site/${slug}/manage${path}`, { reference: code.trim(), phone, ...extra });
      setM(next);
      setMode("view");
      setDone(after ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (mode !== "change" || !m) return;
    get<Availability>(`/venue-site/${slug}/availability?date=${date}`).then(setSlots).catch(() => setSlots(null));
  }, [mode, date, slug, m]);

  const days = Array.from({ length: Math.min(14, site.maxDaysAhead + 1) }, (_, i) => addDays(site.today, i)).filter((d) => site.openingHours[String(new Date(`${d}T00:00:00Z`).getUTCDay())]);
  const times = m ? (slots?.pitches.find((p) => p.pitchId === m.pitchId)?.slots ?? []).flatMap((s) => s.options.filter((o) => o.minutes === m.minutes && o.available).map(() => s.startLocal)) : [];
  const b = m?.booking;

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:p-7" data-testid="venue-manage">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-start" aria-expanded={open}>
        <span><span className="block font-display text-xl font-bold">{t.manage}</span><span className="mt-1 block text-sm text-white/60">{t.manageHint}</span></span>
        <span className="text-2xl text-white/50">{open ? "−" : "+"}</span>
      </button>
      {open && !m && (
        <form className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void call(""); }}>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required placeholder={t.codePlaceholder} dir="ltr" className="rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 font-mono outline-none focus:border-[var(--accent)]" aria-label={t.codePlaceholder} />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" placeholder="07XXXXXXXX" dir="ltr" className="rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 outline-none focus:border-[var(--accent)]" aria-label={t.phone} />
          <button type="submit" disabled={busy} className="rounded-2xl px-5 py-3 font-bold text-[#0B0F1A] disabled:opacity-60" style={{ background: accent }}>{t.find}</button>
        </form>
      )}
      {open && m && b && (
        <div className="mt-4 space-y-4">
          <div className="rounded-2xl border border-white/10 p-4">
            <p className="font-bold">{locale === "ar" ? b.pitchNameAr || b.pitchName : b.pitchName} · {t.days[new Date(`${b.startLocal.slice(0, 10)}T00:00:00Z`).getUTCDay()]} {Number(b.startLocal.slice(8, 10))}/{Number(b.startLocal.slice(5, 7))} · <span dir="ltr">{clock(b.startLocal.slice(11), locale)}</span></p>
            <p className="mt-1 text-sm text-white/60"><span className="font-mono">{b.reference}</span> · {t.statusLabel[b.status] ?? b.status} · {t.total} {jod(b.amountFils, locale)}</p>
            {Boolean(b.feeFils) && <p className="mt-1 text-sm text-white/70">{t.fee}: {jod(b.feeFils ?? 0, locale)}{b.balanceFils ? ` · ${t.owedNote(jod(b.balanceFils, locale))}` : ""}</p>}
            {Boolean(b.refundFils) && <p className="mt-1 text-sm text-white/70">{t.refund}: {jod(b.refundFils ?? 0, locale)}</p>}
          </div>
          {done && <p className="text-sm font-semibold" style={{ color: accent }} role="status">{done}</p>}
          {(b.status === "held" || b.status === "confirmed") && mode === "view" && (
            <div className="space-y-2">
              {m.change.allowed ? (
                <button type="button" onClick={() => { setMode("change"); setDate(b.startLocal.slice(0, 10) < site.today ? site.today : b.startLocal.slice(0, 10)); }} className="w-full rounded-2xl border border-white/20 py-3 font-semibold" data-testid="venue-manage-change">
                  {t.changeTime} <span className="text-xs text-white/55">· {m.change.feeFils ? t.changeFee(jod(m.change.feeFils, locale)) : t.changeFree}</span>
                </button>
              ) : <p className="text-sm text-white/60">{t.cantChange[m.change.reason] ?? t.cantChange.not_active}</p>}
              {m.cancel.allowed ? (
                <button type="button" onClick={() => setMode("cancel")} className="w-full rounded-2xl border border-[#FF8A73]/50 py-3 font-semibold text-[#FF8A73]" data-testid="venue-manage-cancel">{t.cancelBooking}</button>
              ) : <p className="text-sm text-white/60">{t.cancelTooLate(m.cancel.hours)}</p>}
            </div>
          )}
          {mode === "cancel" && (
            <div className="space-y-3 rounded-2xl border border-[#FF8A73]/40 p-4">
              <p className="font-semibold">{m.cancel.feeFils ? t.cancelFee(jod(m.cancel.feeFils, locale)) : t.cancelFree}</p>
              {m.cancel.refundFils > 0 && <p className="text-sm text-white/70">{t.refundNote(jod(m.cancel.refundFils, locale))}</p>}
              {m.cancel.owedFils > 0 && <p className="text-sm text-white/70">{t.owedNote(jod(m.cancel.owedFils, locale))}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void call("/cancel", {}, t.cancelledTitle)} className="rounded-2xl bg-[#FF5A3C] px-5 py-2.5 font-bold text-white disabled:opacity-60" data-testid="venue-manage-confirm-cancel">{t.confirmCancel}</button>
                <button type="button" onClick={() => setMode("view")} className="rounded-2xl border border-white/20 px-5 py-2.5 font-semibold">{t.keep}</button>
              </div>
            </div>
          )}
          {mode === "change" && (
            <div className="space-y-3 rounded-2xl border border-white/15 p-4">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-white/45">{t.pickNewTime}</p>
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">{days.map((d) => <Chip key={d} active={d === date} accent={accent} onClick={() => setDate(d)}>{t.days[new Date(`${d}T00:00:00Z`).getUTCDay()]} {Number(d.slice(8))}</Chip>)}</div>
              {times.length === 0 ? <p className="text-sm text-white/60">{t.noTimes}</p> : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {times.map((start) => (
                    <button key={start} type="button" disabled={busy} onClick={() => void call("/change", { startLocal: start }, t.moved)} className="rounded-2xl border border-white/15 p-2.5 font-display font-bold hover:border-[var(--accent)]" dir="ltr">{clock(start.slice(11), locale)}</button>
                  ))}
                </div>
              )}
              {m.change.feeFils > 0 && <p className="text-xs text-white/60">{t.changeFee(jod(m.change.feeFils, locale))}</p>}
              <button type="button" onClick={() => setMode("view")} className="text-sm font-semibold underline">{t.keep}</button>
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-[#FF8A73]" role="alert">{error}</p>}
    </section>
  );
}

function Field({ label, value, mono, onCopy, copied, copiedText }: { label: string; value: string; mono?: boolean; onCopy?: () => void; copied?: boolean; copiedText?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 p-3">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/45">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className={mono ? "font-mono text-lg font-bold" : "text-lg font-bold"} dir="ltr">{value}</span>
        {onCopy && <button type="button" onClick={onCopy} className="flex items-center gap-1 text-xs text-white/60">{copied ? copiedText : <Copy className="h-4 w-4" />}</button>}
      </div>
    </div>
  );
}
