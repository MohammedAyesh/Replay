import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ArrowUpRight, Camera, Gift, Globe2, Volume2, VolumeX } from "lucide-react";
import { getGetHomeWeeklyHighlightQueryKey, getListUserClipsQueryKey, useGetHomeWeeklyHighlight, useListUserClips, type WeeklyHighlight } from "@workspace/api-client-react";
import { FreeMatchRulesSheet } from "@/components/free-match/FreeMatch";
import { StatTileCard } from "@/components/home/StatTile";
import { HomeAvatar } from "@/components/match/HomeHub";
import { BetaPill } from "@/components/match/StatsBeta";
import { MatchApiError, formatJod, shareOrCopy, whatsappLink, useBookingFields, useCreateBooking, useMyMatches, useReplayProfile, type BookingResult, type FreeMatchStatus, type MyMatchItem } from "@/lib/match-api";
import { FieldPaymentPanel, PaymentPanel } from "@/components/match/PaymentPanel";
import { PlayerAvatar } from "@/components/match/bits";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/i18n/context";
import { useExplainerCopy } from "@/i18n/explainer-strings";
import { useMatchCopy } from "@/i18n/match-strings";
import { cn } from "@/lib/utils";

const words = {
  en: {
    live: "Your match is live now", next: "Your next match", startsIn: "starts in", watch: "Watch", yourWeek: "YOUR WEEK",
    weekTitle: (n: number) => `Your week in ${n} sec`, clips: (n: number, date: string) => `${n} clips · ${date}`,
    goal: "GOAL OF THE WEEK", goalTitle: (field: string) => `Best goal at ${field}`, goalSub: "This week · next week's could be yours",
    free: "Free games", ready: (n: number) => `${n} ready to use`, useBy: (date: string) => `Use by ${date}`,
    invite: "INVITE TEAMMATES", left: (n: number) => `${n} more teammate${n === 1 ? "" : "s"} and your next game is free`,
    bring: (n: number) => `Bring ${n} teammates and your next game is free`,
    accurate: "A teammate counts when they find themselves in a game you booked and paid with CliQ.",
    inviteWhatsApp: "Invite on WhatsApp", how: "How it works", every: (n: number) => `EVERY ${n}TH GAME FREE`,
    toGo: (n: number) => `${n} paid games to go`, waiting: "Waiting on you", answer: "Answer", vote: "Vote",
    numbers: "Your numbers", beta: "BETA", noTime: "That time is already being recorded. Pick another time.",
    field: "Field", date: "Date", start: "Start time", hours: "Hours", record: "Record", openMatch: "Open match", deduction: (n: string) => `Free match deduction: −${n} JOD`, pay: (n: string) => `Pay ${n} JOD with CliQ`,
    confirmFree: "Confirm, it's free", choose: "Choose a time", booked: "Booking confirmed",
    mute: "Mute highlight", unmute: "Unmute highlight", language: "Switch language to Arabic",
  },
  ar: {
    live: "مباراتك شغّالة هسا", next: "مباراتك الجاية", startsIn: "بتبلّش بعد", watch: "احضر", yourWeek: "أسبوعك",
    weekTitle: (n: number) => `أسبوعك بـ ${n} ${n === 1 ? "ثانية" : "ثواني"}`, clips: (n: number, date: string) => `${n} لقطات · ${date}`,
    goal: "أحلى هدف بالأسبوع", goalTitle: (field: string) => `أحلى هدف بـ ${field}`, goalSub: "هالأسبوع · الجاي دورك",
    free: "مباريات مجانية", ready: (n: number) => `${n} جاهزة`, useBy: (date: string) => `استخدمها قبل ${date}`,
    invite: "اعزم صحابك", left: (n: number) => `باقي ${n} من صحابك، ومباراتك الجاية علينا`,
    bring: (n: number) => `جيب ${n} من صحابك ومباراتك الجاية علينا`,
    accurate: "صاحبك بينحسب لما يلاقي حاله بمباراة إنت حاجزها ودافعها كليك.",
    inviteWhatsApp: "اعزمهم عالواتساب", how: "كيف بتشتغل؟", every: (n: number) => `كل ${n} مباريات، وحدة ببلاش`,
    toGo: (n: number) => `باقي ${n} مباريات مدفوعة`, waiting: "مستنيين ردّك", answer: "ردّ", vote: "صوّت",
    numbers: "أرقامك", beta: "تجريبي", noTime: "هالوقت محجوز للتسجيل. اختار وقت ثاني.",
    field: "الملعب", date: "اليوم", start: "وقت البداية", hours: "الساعات", record: "سجّل", openMatch: "افتح المباراة", deduction: (n: string) => `خصم المباراة المجانية: −${n} د.أ`, pay: (n: string) => `ادفع ${n} د.أ بكليك`,
    confirmFree: "أكد، الحجز مجاني", choose: "اختار وقت", booked: "تم تأكيد الحجز",
    mute: "اكتم الصوت", unmute: "شغّل الصوت", language: "بدّل اللغة للإنجليزي",
  },
} as const;
type HomeCopy = { [K in keyof typeof words.en]: (typeof words.en)[K] extends (...args: infer A) => infer R ? (...args: A) => R : string };

function dateLabel(ms: number, locale: "en" | "ar") {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(new Date(ms));
}
function dayLabel(ms: number, locale: "en" | "ar") {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(new Date(ms));
}
function clock(ms: number, locale: "en" | "ar") {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Amman" }).format(new Date(ms));
}

export function HomeHubRedesigned() {
  const { user, isGuest } = useAuth();
  const signedIn = Boolean(user) && !isGuest;
  const { locale, setLocale } = useLocale();
  const ar = locale === "ar";
  const s = words[locale];
  const copy = useMatchCopy();
  const { toast } = useToast();
  const matches = useMyMatches(signedIn);
  const profile = useReplayProfile(signedIn ? user?.id : null);
  const booking = useBookingFields();
  const weekly = useGetHomeWeeklyHighlight({ query: { enabled: signedIn, queryKey: getGetHomeWeeklyHighlightQueryKey(), retry: false } });
  const clips = useListUserClips({ query: { enabled: signedIn, queryKey: getListUserClipsQueryKey(), staleTime: 60_000 } });
  const search = useSearch();
  const [, setLocation] = useLocation();
  const [recordOpen, setRecordOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(search).get("record") === "1") {
      setRecordOpen(true);
      const params = new URLSearchParams(search);
      params.delete("record");
      setLocation(`/home${params.size ? `?${params}` : ""}`, { replace: true });
    }
  }, [search, setLocation]);

  if (!signedIn) {
    return booking.data?.enabled && booking.data.fields.length > 0 ? (
      <div className="px-4 pb-28 pt-3"><Link href="/book" className="flex min-h-12 items-center justify-center rounded-full bg-floodlight font-display font-bold text-void">{copy.bookFootage(formatJod(booking.data.pricePerHourFils))}</Link></div>
    ) : null;
  }
  const data = matches.data;
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] ?? "";
  const hero = data?.live[0] ?? data?.upcoming[0] ?? null;
  const waiting = [...(data?.invites ?? []), ...(data?.recent ?? []).filter((m) => m.voteOpen)];
  const statTiles = data?.statTiles?.length ? data.statTiles : data?.statTile ? [data.statTile] : [];
  const mockClip = (clips.data ?? []).find((clip) => !clip.isMatchMoment);
  const requestedMockKind = new URLSearchParams(search).get("homeHighlight") === "field" ? "field" : "personal";
  const mockWeekStart = (() => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const mockHighlight: WeeklyHighlight | null = import.meta.env.DEV && weekly.isError && mockClip ? {
    id: 0, userId: requestedMockKind === "personal" ? (user?.id ?? null) : null,
    fieldId: booking.data?.fields[0]?.id ?? 1, weekStart: mockWeekStart,
    weekEnd: (() => { const d = new Date(`${mockWeekStart}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })(),
    title: requestedMockKind === "personal" ? "Your week" : `Best goal at ${booking.data?.fields[0]?.name ?? "the field"}`,
    clipCount: 1, durationSec: Math.max(1, Math.round(mockClip.endTime - mockClip.startTime)),
    status: "published", publishedAt: null, fieldName: booking.data?.fields[0]?.name ?? "Field",
    kind: requestedMockKind, clips: [{
      position: 0, clipId: mockClip.id, eventType: "goal", title: mockClip.title ?? "Weekly highlight",
      startTime: String(mockClip.startTime), endTime: String(mockClip.endTime), videoUrl: `/api/user-clips/${mockClip.id}/playback`,
      previewUrl: `/api/user-clips/${mockClip.id}/playback`,
    }],
  } : null;
  const highlight = weekly.data ?? mockHighlight;
  const poster = highlight?.clips[0] ? (clips.data ?? []).find((c) => c.id === highlight.clips[0].clipId)?.thumbnailUrl : null;
  const date = highlight ? dateLabel(Date.parse(`${highlight.weekStart}T12:00:00Z`), locale) : "";
  const canBook = Boolean(booking.data?.enabled && booking.data.fields.length);

  return (
    <div dir={ar ? "rtl" : "ltr"} className="mx-auto flex min-w-0 max-w-lg flex-col gap-3 px-4 pb-[calc(6.5rem+env(safe-area-inset-bottom))] pt-2">
      <header className="flex h-12 min-w-0 items-center gap-2">
        <HomeAvatar name={user?.name ?? ""} avatarUrl={profile.data?.avatarUrl ?? null} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-extrabold leading-5" data-testid="text-home-greeting">{copy.hello(firstName)}</p>
          {!!profile.data?.matchesPlayed && <p className="truncate text-[11px] leading-4 text-muted-text" data-testid="text-home-stats">{profile.data.matchesPlayed} {copy.played} · {profile.data.wins} {profile.data.wins === 1 ? (ar ? "فوز" : "win") : copy.wins} · {profile.data.motmCount} {copy.motmShort}</p>}
        </div>
        <button type="button" aria-label={ar ? "بدّل اللغة للإنجليزي" : s.language} data-testid="button-home-language" onClick={() => setLocale(ar ? "en" : "ar")} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted-text"><Globe2 className="h-4 w-4" /></button>
        <button type="button" onClick={() => setRecordOpen(true)} data-testid="button-home-record" disabled={!canBook} className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-floodlight px-3 font-display text-sm font-extrabold text-void disabled:opacity-50"><Camera className="h-4 w-4" />{s.record}</button>
      </header>

      {hero && <MatchStrip item={hero} live={data?.live[0]?.code === hero.code} s={s} locale={locale} now={Date.now()} />}
      {highlight && <WeeklyCard highlight={highlight} poster={poster || null} s={s} locale={locale} />}

      {data?.freeMatch && <FreeGames status={data.freeMatch} s={s} locale={locale} onRules={() => setRulesOpen(true)} />}
      {data?.freeMatch && <FreeMatchRulesSheet open={rulesOpen} onOpenChange={setRulesOpen} status={data.freeMatch} canBook={canBook} />}

      {waiting.length > 0 && <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-2 font-display text-base font-extrabold">{s.waiting}</h2>
        <div className="flex flex-col divide-y divide-line">
          {waiting.map((m) => {
            const vote = Boolean(m.voteOpen);
            return <div key={`${vote ? "vote" : "invite"}-${m.code}`} className="flex min-h-14 items-center gap-2 py-2">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{vote ? `${m.field.name} · ${s.vote}` : `${m.invitedBy?.name || m.title || m.field.name} · ${m.field.name}`}</p><p className="text-[11px] text-muted-text">{dateLabel(m.startMs, locale)}</p></div>
              <Link href={vote ? `/m/${m.code}` : m.inviteToken ? `/m/${m.code}?i=${m.inviteToken}` : `/m/${m.code}`} className="min-h-9 rounded-full border border-line px-3 py-2 text-xs font-bold">{vote ? s.vote : s.answer}</Link>
            </div>;
          })}
        </div>
      </section>}
      {user?.id && <section data-testid="home-your-numbers">
        <div className="mb-2 flex min-h-12 items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display font-bold">{s.numbers}<BetaPill /></h2>
          <Link href={`/players/${user.id}`} aria-label={s.numbers} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted-text" data-testid="link-home-numbers"><ArrowUpRight className="h-4 w-4" /></Link>
        </div>
        {statTiles.length > 0 && <>
          <p className="mb-3 px-1 text-[11px] leading-4 text-muted-text">{copy.statsBeta.note}</p>
          <div className="flex flex-col gap-3" data-testid="home-stat-tiles">
            {statTiles.map((tile, index) => <StatTileCard key={`${tile.kind}-${index}`} tile={tile} />)}
          </div>
        </>}
      </section>}
      <RecordSheet open={recordOpen} onOpenChange={setRecordOpen} recent={[...(data?.recent ?? []), ...(data?.upcoming ?? []), ...(data?.live ?? [])]} s={s} locale={locale} />
    </div>
  );
}

function MatchStrip({ item, live, s, locale, now }: { item: MyMatchItem; live: boolean; s: HomeCopy; locale: "en" | "ar"; now: number }) {
  const href = `/m/${item.code}`;
  return <Link href={href} className="flex h-16 min-w-0 items-center gap-2 rounded-2xl border border-line bg-surface px-3" data-testid="link-home-hero-match">
    {live ? <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-destructive" /> : <span className="flex shrink-0 flex-col text-center"><b className="font-display text-sm">{dayLabel(item.startMs, locale).split(" ")[0]}</b><small className="text-[9px] text-muted-text">{dateLabel(item.startMs, locale)}</small></span>}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-bold">{live ? s.live : `${s.next} · ${clock(item.startMs, locale)}`}</span>
      <span className="block truncate text-[11px] text-muted-text">{item.field.name}{!live && ` · ${s.startsIn} ${Math.max(0, Math.ceil((item.startMs - now) / 60000))} min`}</span>
    </span>
    <span className="rounded-full border border-line px-3 py-1.5 text-xs font-bold">{s.watch}</span>
  </Link>;
}

function WeeklyCard({ highlight, poster, s, locale }: { highlight: WeeklyHighlight; poster: string | null; s: HomeCopy; locale: "en" | "ar" }) {
  const video = useRef<HTMLVideoElement>(null);
  const card = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const { toast } = useToast();
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(mq.matches);
    change(); mq.addEventListener("change", change); return () => mq.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 });
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.muted = muted;
    if (!reduced && visible) void el.play().catch(() => undefined); else el.pause();
  }, [visible, reduced, muted]);
  const item = highlight.clips[0];
  if (!item) return null;
  const title = highlight.kind === "personal" ? s.weekTitle(highlight.durationSec) : s.goalTitle(highlight.fieldName);
  const subtitle = highlight.kind === "personal" ? s.clips(highlight.clipCount, dateLabel(Date.parse(`${highlight.weekStart}T12:00:00Z`), locale)) : s.goalSub;
  return <section ref={card} className="relative h-[210px] overflow-hidden rounded-[22px] border border-line bg-surface" data-testid="card-home-weekly-highlight">
    {reduced ? (poster ? <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <div className="absolute inset-0 bg-raised" />) : <video ref={video} data-testid="video-home-highlight" data-playback-state={visible ? "visible" : "offscreen"} src={item.previewUrl} poster={poster || undefined} autoPlay muted loop playsInline preload="metadata" onTimeUpdate={(e) => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)} onPlay={() => { if (import.meta.env.DEV) console.info("[home-highlight] play"); }} onPause={() => { if (import.meta.env.DEV) console.info("[home-highlight] pause"); }} className="absolute inset-0 h-full w-full object-cover" />}
    <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-b from-black/30 via-transparent to-black/80" />
    <span className="pointer-events-none absolute start-3 top-3 z-30 rounded-full bg-floodlight px-2.5 py-1 font-mono text-[10px] font-bold text-void">{highlight.kind === "personal" ? s.yourWeek : s.goal}</span>
    <div className="pointer-events-none absolute inset-x-3 bottom-4 z-30">
      <h2 className="truncate font-display text-xl font-extrabold text-white">{title}</h2><p className="truncate text-xs text-white/80">{subtitle}</p>
    </div>
    <button type="button" aria-label={muted ? s.unmute : s.mute} data-testid="button-highlight-mute" className="absolute bottom-3 end-3 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-white/30 bg-black/45 text-white" onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}>{muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}</button>
    <div className="absolute inset-x-0 bottom-0 z-40 h-[3px] bg-white/20"><div className="h-full bg-floodlight" style={{ width: `${progress * 100}%` }} /></div>
    <Link href={`/week/${highlight.id}`} className="absolute inset-0 z-10" aria-label={title} data-testid="link-home-weekly-highlight" />
  </section>;
}

function FreeGames({ status, s, locale, onRules }: { status: FreeMatchStatus; s: HomeCopy; locale: "en" | "ar"; onRules: () => void }) {
  const free = useExplainerCopy().free;
  const { toast } = useToast();
  const reward = status.reward?.status === "available" ? status.reward : null;
  const attempt = status.attempt;
  const hidden = !status.enabled || !status.canEarn || Boolean(attempt?.capped);
  const friends = attempt?.friends.filter((f) => f.found) ?? [];
  const left = Math.max(0, status.friendsRequired - (attempt?.friendsFound ?? 0));
  const invite = async () => {
    if (!attempt) return onRules();
    const url = `${window.location.origin}/m/${attempt.code}`;
    const text = free.shareText(url);
    const result = await shareOrCopy({ text: text.replace(url, "").trim(), url });
    if (result === "copied") toast({ title: "Copied" });
    if (result === "failed") window.open(whatsappLink(text), "_blank", "noopener");
  };
  return <section className="rounded-[22px] border border-line bg-surface p-4" data-testid="card-home-free-games">
    <div className="flex items-center justify-between gap-2"><h2 className="font-display text-lg font-extrabold">{s.free}</h2>{reward && <span className="rounded-full border border-floodlight px-2.5 py-1 text-[10px] font-bold text-floodlight">{s.ready(1)}</span>}</div>
    {reward && <p className="mt-1 text-xs text-muted-text">{s.useBy(dateLabel(Date.parse(reward.expiresAt), locale))}</p>}
    {!hidden && <div className="mt-4">
      <p className="font-mono text-[10px] font-bold tracking-wide text-muted-text">{s.invite}</p>
      <div className="mt-2 flex gap-2">{Array.from({ length: status.friendsRequired }, (_, i) => {
        const friend = friends[i];
        return friend ? <PlayerAvatar key={friend.userId} name={friend.name} avatarUrl={friend.avatarUrl} size={44} ring="var(--turf)" /> : <span key={i} className="grid h-11 w-11 place-items-center rounded-full border border-dashed border-muted-text text-muted-text">+</span>;
      })}</div>
      <p className="mt-2 text-sm font-bold">{attempt ? s.left(left) : s.bring(status.friendsRequired)}</p><p className="mt-1 text-[11px] leading-4 text-muted-text">{s.accurate}</p>
      <button type="button" onClick={() => void invite()} className="mt-3 min-h-10 rounded-full border border-line px-4 text-xs font-bold">{attempt ? s.inviteWhatsApp : s.how}</button>
    </div>}
      {status.loyalty.enabled && <div className="mt-4 border-t border-line pt-4"><p className="font-mono text-[10px] font-bold tracking-wide text-muted-text">{s.every(status.loyalty.every)}</p><div className="mt-2 flex items-center gap-1.5"><span className="me-1 text-turf"><Gift className="h-5 w-5" /></span>{Array.from({ length: status.loyalty.every }, (_, i) => <span key={i} className={cn("h-7 w-7 rounded-full border border-line", i < status.loyalty.count ? "border-turf bg-turf" : "bg-transparent")} />)}</div><p className="mt-2 text-xs text-muted-text">{s.toGo(Math.max(0, status.loyalty.every - status.loyalty.count))}</p></div>}
  </section>;
}

function RecordSheet({ open, onOpenChange, recent, s, locale }: { open: boolean; onOpenChange: (v: boolean) => void; recent: MyMatchItem[]; s: HomeCopy; locale: "en" | "ar" }) {
  const { user, isGuest } = useAuth();
  const copy = useMatchCopy();
  const { toast } = useToast();
  const fields = useBookingFields();
  const create = useCreateBooking();
  const [, setLocation] = useLocation();
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); }), [today]);
  const prior = recent[0];
  const fieldList = fields.data?.fields ?? [];
  const [fieldId, setFieldId] = useState<number | null>(null);
  const [date, setDate] = useState(days[0]);
  const [start, setStart] = useState<number | null>(null);
  const [hours, setHours] = useState(1);
  const [result, setResult] = useState<BookingResult | null>(null);
  const price = fields.data?.pricePerHourFils ?? 0;
  const maxHours = Math.max(1, Math.min(3, Math.floor((fields.data?.maxMinutes ?? 180) / 60)));
  useEffect(() => {
    if (!open) return;
    const match = prior;
    const priorDate = match?.startLocal.slice(0, 10);
    const priorWeekday = priorDate ? new Date(`${priorDate}T12:00:00Z`).getUTCDay() : -1;
    const suggestedDate = days.find((day) => new Date(`${day}T12:00:00Z`).getUTCDay() === priorWeekday) ?? days[0];
    const time = match ? Number(match.startLocal.slice(11, 13)) * 60 + Number(match.startLocal.slice(14, 16)) : null;
    const nowText = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const passed = Boolean(match && suggestedDate === days[0] && time != null && time <= Number(nowText.slice(0, 2)) * 60 + Number(nowText.slice(3, 5)));
    const [sh, sm] = (match?.startLocal.slice(11, 16) ?? "00:00").split(":").map(Number);
    const [eh, em] = (match?.endLocal.slice(11, 16) ?? "00:00").split(":").map(Number);
    const minutes = (eh * 60 + em - sh * 60 - sm + 1440) % 1440;
    setFieldId(match?.field.id ?? fieldList[0]?.id ?? null);
    setDate(passed ? days[0] : suggestedDate);
    setStart(match && !passed ? time : null);
    setHours(match ? Math.min(maxHours, Math.max(1, Math.ceil(minutes / 60))) : 1);
    setResult(null);
  }, [open, prior, fieldList, days, maxHours]);
  const free = fields.data?.freeMatch;
  const useFree = Boolean(free?.reward);
  const total = Math.max(0, hours - (useFree ? free!.reward!.freeHours : 0)) * price;
  const times = Array.from({ length: 34 }, (_, i) => 7 * 60 + i * 30);
  const submit = async () => {
    if (!fieldId || start == null) return;
    if (!user || isGuest) return setLocation(`/sign-up?redirect_url=${encodeURIComponent("/home?record=1")}`);
    const endMinute = start + hours * 60;
    const endDate = endMinute >= 1440 ? (() => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })() : date;
    try { setResult(await create.mutateAsync({ fieldId, startLocal: `${date} ${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`, endLocal: `${endDate} ${String(Math.floor((endMinute % 1440) / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`, title: null, payWith: "cliq", useFreeMatch: useFree || undefined })); }
    catch (e) { const msg = e instanceof MatchApiError && /record|taken|already/i.test(e.message) ? s.noTime : copy.error; toast({ title: msg, variant: "destructive" }); }
  };
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="bottom" dir={locale === "ar" ? "rtl" : "ltr"} className="mx-auto max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
    <SheetHeader className="text-start"><SheetTitle className="font-display text-xl font-extrabold">{result ? s.booked : s.choose}</SheetTitle></SheetHeader>
    {result ? <><div className="mt-4 rounded-2xl border border-line bg-raised p-4">{result.method === "free" ? <p>{s.confirmFree}</p> : result.method === "field" ? <FieldPaymentPanel amountFils={result.amountFils} reference={result.reference} /> : <PaymentPanel amountFils={result.amountFils} cliqAlias={result.cliqAlias} reference={result.reference} />}</div><Link href={`/m/${result.code}`} className="mt-3 flex min-h-11 items-center justify-center rounded-full border border-line text-sm font-bold">{s.openMatch}</Link></> : <>
      <label className="mt-4 block text-xs text-muted-text">{s.field}<select value={fieldId ?? ""} onChange={(e) => setFieldId(Number(e.target.value))} className="mt-1 h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-text">{fieldList.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
      <p className="mt-4 text-xs text-muted-text">{s.date}</p><div className="mt-2 grid grid-cols-7 gap-1">{days.map((d, i) => <button key={d} onClick={() => { setDate(d); setStart(null); }} className={cn("min-h-11 rounded-lg border text-[10px]", date === d ? "border-turf bg-turf text-void" : "border-line bg-surface")}>{i === 0 ? (locale === "ar" ? "اليوم" : "Today") : dayLabel(Date.parse(`${d}T12:00:00Z`), locale)}</button>)}</div>
      <p className="mt-4 text-xs text-muted-text">{s.hours}</p><div className="mt-2 grid grid-cols-3 gap-2">{[1,2,3].filter((h) => h <= maxHours).map((h) => <button key={h} onClick={() => setHours(h)} className={cn("min-h-10 rounded-xl border text-sm", hours === h ? "border-turf bg-turf/10 text-turf" : "border-line bg-surface")}>{h}</button>)}</div>
      <p className="mt-4 text-xs text-muted-text">{s.start}</p><div className="mt-2 grid grid-cols-4 gap-2" dir="ltr">{times.filter((m) => { if (date > today) return true; const nowText = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()); return m >= Number(nowText.slice(0, 2)) * 60 + Number(nowText.slice(3, 5)); }).map((m) => <button key={m} onClick={() => setStart(m)} className={cn("min-h-10 rounded-lg border font-mono text-xs", start === m ? "border-floodlight bg-floodlight text-void" : "border-line bg-surface")}>{String(Math.floor(m / 60)).padStart(2,"0")}:{String(m%60).padStart(2,"0")}</button>)}</div>
      <div className="mt-4 flex items-center justify-between rounded-2xl border border-line bg-raised p-3"><div className="min-w-0"><span className="block text-xs text-muted-text">{s.hours} × {formatJod(price)} JOD</span>{useFree && <span className="block text-xs text-muted-text">{s.deduction(formatJod(Math.min(hours, free!.reward!.freeHours) * price))}</span>}</div><b dir="ltr" className="font-mono">{formatJod(total)} JOD</b></div>
      <button disabled={start == null || create.isPending || fields.isLoading || !fields.data?.enabled || !fieldList.length} onClick={() => void submit()} className="mt-3 min-h-12 w-full rounded-full bg-floodlight font-display font-extrabold text-void disabled:opacity-40">{total === 0 ? s.confirmFree : s.pay(formatJod(total))}</button>
    </>}
  </SheetContent></Sheet>;
}
