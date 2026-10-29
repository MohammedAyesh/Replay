import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Camera, CalendarPlus, ChevronRight, ChevronLeft, CirclePlus, Loader2, Play, Smartphone, Target } from "lucide-react";
import { useListUserClips, getListUserClipsQueryKey } from "@workspace/api-client-react";
import { FreeMatchHomeCard, LoyaltyCard } from "@/components/free-match/FreeMatch";
import { FirstClipChecklist } from "@/components/home/FirstClipChecklist";
import { StatCarousel } from "@/components/home/StatCarousel";
import { MatchCard } from "@/components/match/MatchCard";
import { PlayerAvatar } from "@/components/match/bits";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useLocale } from "@/i18n/context";
import { useMatchCopy } from "@/i18n/match-strings";
import { formatDay } from "@/components/match/bits";
import { formatClipTitle } from "@/lib/clip-title";
import { useAuth } from "@/lib/auth";
import { formatJod, useAvatarRemove, useAvatarUpload, useBookingFields, useMyMatches, useReplayProfile, type MyMatchItem } from "@/lib/match-api";
import { cn } from "@/lib/utils";

function useTicker(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * The top of Home: who you are, the game that matters right now (live, or the
 * next one with a countdown), invites waiting for an answer, votes still open,
 * your recent matches and your clips. News moves below all of this.
 */
export function HomeHub() {
  const copy = useMatchCopy();
  const { user, isGuest } = useAuth();
  const signedIn = Boolean(user) && !isGuest;
  const matches = useMyMatches(signedIn);
  const profile = useReplayProfile(signedIn ? user?.id : null);
  const clips = useListUserClips({ query: { enabled: signedIn, queryKey: getListUserClipsQueryKey(), staleTime: 60_000 } });
  const now = useTicker(1000);
  // Booking lives here and only here: Home is the one way into /book.
  const booking = useBookingFields();
  const canBook = booking.data ? booking.data.enabled && booking.data.fields.length > 0 : false;
  const bookLabel = copy.bookFootage(formatJod(booking.data?.pricePerHourFils ?? 2000));
  const bookRow = canBook ? (
    <Link href="/book" className="flex items-center gap-3 rounded-2xl border border-floodlight/30 bg-surface p-3" data-testid="link-home-book">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-floodlight text-void"><CirclePlus className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{bookLabel}</span>
        <span className="block truncate text-xs text-muted-text">{copy.book.why[0].title}</span>
      </span>
      <ChevronRight className="h-4 w-4 text-muted-text rtl:rotate-180" />
    </Link>
  ) : null;

  if (!signedIn) return bookRow ? <div className="mb-6">{bookRow}</div> : null;
  const data = matches.data;
  const isOwner = (user?.ownedFieldIds?.length ?? 0) > 0;
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] ?? "";

  const hero = data ? data.live[0] ?? data.upcoming[0] ?? null : null;
  const moreUpcoming = data ? [...data.live.slice(1), ...data.upcoming.slice(data.live.length ? 0 : 1)].slice(0, 3) : [];
  const invites = data?.invites.slice(0, 3) ?? [];
  const voting = data?.recent.filter((m) => m.voteOpen) ?? [];
  const recent = (data?.recent ?? []).filter((m) => !m.voteOpen).slice(0, 3);
  // Moments Replay cut for him live under My Clips → Moments, not here.
  const createdClips = (clips.data ?? []).filter((clip) => !clip.isMatchMoment);
  const myClips = createdClips.slice(0, 4);
  // The most impressive things Replay can tell this player right now, best first, chosen by the server.
  const tiles = data?.statTiles ?? (data?.statTile ? [data.statTile] : []);
  const statTile = tiles.length ? <StatCarousel tiles={tiles} /> : null;

  return (
    <div className="mb-8 flex flex-col gap-6">
      <div className="flex flex-col items-start gap-3 px-1">
        <HomeAvatar name={user?.name ?? ""} avatarUrl={profile.data?.avatarUrl ?? null} />
        <div className="min-w-0">
          <p className="font-display text-[34px] font-extrabold leading-tight">{firstName ? copy.hello(firstName) : copy.helloGuest}</p>
          {profile.data && profile.data.matchesPlayed > 0 && (
            <p className="text-xs text-muted-text">
              {profile.data.matchesPlayed} {copy.played} · {profile.data.wins} {copy.wins} · {profile.data.motmCount} {copy.motmShort}
            </p>
          )}
        </div>
      </div>

      {data && clips.data && <FirstClipChecklist matches={data} clips={createdClips} now={now} />}

      {matches.isLoading ? (
        <div className="h-48 animate-pulse rounded-3xl bg-surface" />
      ) : hero ? (
        <>
          <MatchCard item={hero} copy={copy} now={now} variant="hero" />
          {statTile}
          {bookRow}
        </>
      ) : (
        <section
          className={cn(
            "flex flex-col gap-[22px] rounded-2xl border bg-surface px-[22px] py-6",
            data?.freeMatch?.attempt || data?.freeMatch?.reward ? "border-floodlight/40" : "border-line",
          )}
          style={data?.freeMatch?.attempt || data?.freeMatch?.reward
            ? { background: "radial-gradient(120% 90% at 100% 0%, rgba(212,255,79,.12), transparent 60%), #141B2C" }
            : undefined}
          data-testid="home-no-match"
        >
          <style>{`@keyframes floodOn{0%{opacity:.3}8%{opacity:1}13%{opacity:.45}22%{opacity:1}100%{opacity:1}}.flood-on{animation:floodOn 1.1s ease-out .3s both}@media(prefers-reduced-motion:reduce){.flood-on{animation:none}}`}</style>
          <p className="font-display text-[26px] font-extrabold leading-tight">{copy.homeNoMatch}</p>
          <ol className="m-0 flex list-none flex-col p-0">
            {[CalendarPlus, Target, Smartphone].map((Icon, index) => (
              <Step key={index} index={index} label={copy.homeSteps[index]}>
                <Icon className="h-[22px] w-[22px]" aria-hidden />
              </Step>
            ))}
          </ol>
          {canBook && !data?.freeMatch?.reward && (
            <Link href="/book" className="flood-on flex min-h-[58px] items-center justify-center rounded-full bg-floodlight px-5 text-center font-display text-[17px] font-extrabold text-void shadow-[0_0_0_6px_rgba(212,255,79,0.08)]" data-testid="link-home-book">
              {bookLabel}
            </Link>
          )}
          {data?.freeMatch && (
            <>
              <div className="border-t border-line pt-4">
                <FreeMatchHomeCard status={data.freeMatch} canBook={canBook} embedded />
              </div>
              <div className="border-t border-line pt-4">
                <LoyaltyCard status={data.freeMatch} canBook={canBook} embedded />
              </div>
            </>
          )}
        </section>
      )}
      {!matches.isLoading && !hero && statTile}
      {hero && data?.freeMatch && (
        <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-5 py-5" data-testid="home-booking-rewards">
          <FreeMatchHomeCard status={data.freeMatch} canBook={canBook} embedded />
          <div className="border-t border-line pt-4">
            <LoyaltyCard status={data.freeMatch} canBook={canBook} embedded />
          </div>
        </section>
      )}

      {invites.length > 0 && (
        <Section title={copy.invites}>
          {invites.map((m) => <MatchCard key={`i-${m.code}-${m.inviteToken}`} item={m} copy={copy} now={now} />)}
        </Section>
      )}

      {voting.length > 0 && (
        <Section title={copy.vote}>
          {voting.slice(0, 2).map((m) => <MatchCard key={`v-${m.code}`} item={m} copy={copy} now={now} />)}
        </Section>
      )}

      {moreUpcoming.length > 0 && (
        <Section title={copy.upcoming} horizontal>
          {moreUpcoming.map((m) => <HomeMatchCard key={`u-${m.code}`} item={m} copy={copy} now={now} />)}
        </Section>
      )}

      {recent.length > 0 && (
        <Section title={copy.recentMatches} href="/matches" more={copy.allMatches} horizontal>
          {recent.map((m) => <HomeMatchCard key={`r-${m.code}`} item={m} copy={copy} now={now} />)}
        </Section>
      )}

      {myClips.length > 0 && (
        <section>
          <SectionHead title={copy.recentClips} href="/my-clips?tab=created" more={copy.allClips} />
          <div className="grid grid-cols-2 gap-3 px-1">
            {myClips.map((clip) => (
              <Link key={clip.id} href="/my-clips?tab=created" className="relative h-[220px] min-w-0 overflow-hidden rounded-2xl border border-line bg-surface">
                <div className="relative h-[168px] bg-raised">
                  <ClipThumb src={clip.thumbnailUrl ?? null} />
                  <span className="absolute inset-0 z-10 flex items-center justify-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-violet text-text"><Play className="h-[17px] w-[17px] fill-current" /></span>
                  </span>
                </div>
                <ClipFooter title={clip.title} locale={copy.locale} now={now} labels={copy} />
              </Link>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}

/** A football, in lucide's stroke style (lucide has no football). */
function BallIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m12 7 4 3-1.5 4.5h-5L8 10z" />
    </svg>
  );
}

/** One step of "Book → Play → Watch in 20 min", with the dashed link to the next one. */
function Step({ index, label, children }: { index: number; label: string; children: React.ReactNode }) {
  return (
    <>
      {index > 0 && <li aria-hidden className="h-[22px] w-0 ms-[23px] border-s border-dotted border-muted-text/50" />}
      <li className="flex min-w-0 items-center gap-[14px]">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-turf">{children}</span>
        <span className="text-[17px] font-bold leading-tight">{label}</span>
      </li>
    </>
  );
}

/**
 * The player's face with a camera badge. No photo yet: the badge opens the
 * phone's picker straight away. With a photo: a sheet to change or remove it.
 */
function HomeAvatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const copy = useMatchCopy();
  const { locale } = useLocale();
  const { toast } = useToast();
  const upload = useAvatarUpload();
  const remove = useAvatarRemove();
  const input = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState(false);
  const busy = upload.isPending || remove.isPending;
  const pick = () => input.current?.click();
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      toast({ title: copy.photo.tooBig, variant: "destructive" });
      return;
    }
    try {
      await upload.mutateAsync(file);
      toast({ title: copy.photo.updated });
    } catch {
      toast({ title: copy.photo.failed, variant: "destructive" });
    }
  };
  const onRemove = async () => {
    setSheet(false);
    try {
      await remove.mutateAsync();
      toast({ title: copy.photo.removed });
    } catch {
      toast({ title: copy.photo.failed, variant: "destructive" });
    }
  };
  return (
    <div className="relative shrink-0">
      <PlayerAvatar name={name} avatarUrl={avatarUrl} size={76} className={cn("border-2 border-turf", busy ? "opacity-50" : undefined)} />
      <button
        type="button"
        disabled={busy}
        onClick={() => (avatarUrl ? setSheet(true) : pick())}
        aria-label={avatarUrl ? copy.photo.change : copy.photo.add}
        data-testid="button-home-photo"
        className={avatarUrl
          ? "absolute -bottom-1 -end-1 flex h-[30px] w-[30px] items-center justify-center rounded-full border-[3px] border-void bg-raised text-text before:absolute before:-inset-2.5 before:content-['']"
          : "absolute -bottom-1 -end-1 flex h-[30px] w-[30px] items-center justify-center rounded-full border-[3px] border-void bg-raised text-text before:absolute before:-inset-2 before:content-['']"}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className={avatarUrl ? "h-[11px] w-[11px]" : "h-[13px] w-[13px]"} strokeWidth={2.4} />}
      </button>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" dir={locale === "ar" ? "rtl" : "ltr"} className="mx-auto w-full max-w-lg rounded-t-3xl border-line bg-surface p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <SheetHeader className="text-start">
            <SheetTitle className="font-display text-xl">{copy.photo.title}</SheetTitle>
          </SheetHeader>
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" onClick={() => { setSheet(false); pick(); }} className="min-h-[52px] rounded-2xl border border-line bg-raised px-4 text-start text-[15px] font-semibold">{copy.photo.changeAction}</button>
            <button type="button" onClick={() => void onRemove()} className="min-h-[52px] rounded-2xl border border-line bg-raised px-4 text-start text-[15px] font-semibold text-[#FF8A7A]">{copy.photo.remove}</button>
            <button type="button" onClick={() => setSheet(false)} className="min-h-12 rounded-2xl text-sm font-semibold text-muted-text">{copy.photo.cancel}</button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SectionHead({ title, href, more, styled = true }: { title: string; href?: string; more?: string; styled?: boolean }) {
  return (
    <div className="mb-2 flex items-center justify-between px-1">
      <h2 className={styled ? "font-display text-[22px] font-extrabold" : "text-sm font-bold"}>{title}</h2>
      {href && more && (styled
        ? <Link href={href} className="flex min-h-11 items-center gap-0.5 text-sm font-bold text-turf">{more}<ChevronLeft className="h-[18px] w-[18px] ltr:rotate-180" aria-hidden /></Link>
        : <Link href={href} className="text-xs font-semibold text-turf">{more}</Link>)}
    </div>
  );
}

function Section({ title, href, more, horizontal = false, children }: { title: string; href?: string; more?: string; horizontal?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <SectionHead title={title} href={href} more={more} styled={horizontal} />
      <div className={horizontal ? "no-scrollbar -mx-4 flex snap-x snap-mandatory gap-[10px] overflow-x-auto px-4" : "flex flex-col gap-2"}>{children}</div>
    </section>
  );
}

/** A clip's poster, or a quiet placeholder when there isn't one (or it fails to load). */
function ClipThumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-raised">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-violet/25" />
        <span aria-hidden className="relative z-[1] h-[84px] w-[84px] shrink-0 rounded-full border-2 border-violet/55 bg-raised" />
      </div>
    );
  }
  return <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" onError={() => setBroken(true)} />;
}

function HomeMatchCard({ item, copy, now }: { item: MyMatchItem; copy: ReturnType<typeof useMatchCopy>; now: number }) {
  const href = item.inviteToken ? `/m/${item.code}?i=${item.inviteToken}` : `/m/${item.code}`;
  const day = formatDay(item.startMs, copy.locale, now, copy);
  const title = item.title || item.field.name;
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(item.startMs));
  return (
    <Link href={href} className="flex min-h-[164px] w-[150px] shrink-0 snap-start flex-col justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
      <span className="text-[13px] font-medium text-muted-text">{day}</span>
      {item.score
        ? <span dir="ltr" className="self-start font-display text-5xl font-bold leading-none tracking-wide text-text">{item.score.a}-{item.score.b}</span>
        : <span dir="ltr" className="self-start font-display text-[42px] font-bold leading-none text-turf">{clock}</span>}
      <span className="line-clamp-2 font-display text-base font-bold leading-tight">{title}</span>
    </Link>
  );
}

function ClipFooter({ title, locale, now, labels }: { title: string; locale: "en" | "ar"; now: number; labels: { today: string; tomorrow: string } }) {
  const { dayLabel, time } = formatClipTitle(title, locale, now, labels);
  return (
    <span className="absolute inset-x-0 bottom-0 flex h-[52px] items-center justify-between gap-2 bg-void px-3.5">
      <span className="min-w-0 truncate text-sm font-bold">{dayLabel}</span>
      {time && <span dir="ltr" className="shrink-0 font-display text-[15px] font-semibold text-muted-text">{time}</span>}
    </span>
  );
}
