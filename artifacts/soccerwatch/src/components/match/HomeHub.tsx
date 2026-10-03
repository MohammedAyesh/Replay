import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Camera, CalendarPlus, ChevronRight, CirclePlus, Film, Loader2, Play, Smartphone } from "lucide-react";
import { useListUserClips, getListUserClipsQueryKey } from "@workspace/api-client-react";
import { StatCarousel } from "@/components/home/StatCarousel";
import { MatchCard } from "@/components/match/MatchCard";
import { PlayerAvatar } from "@/components/match/bits";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useLocale } from "@/i18n/context";
import { useMatchCopy } from "@/i18n/match-strings";
import { useAuth } from "@/lib/auth";
import { formatJod, useAvatarRemove, useAvatarUpload, useBookingFields, useMyMatches, useReplayProfile } from "@/lib/match-api";

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
  const myClips = (clips.data ?? []).slice(0, 6);
  // The most impressive things Replay can tell this player right now, best first, chosen by the server.
  const tiles = data?.statTiles ?? (data?.statTile ? [data.statTile] : []);
  const statTile = tiles.length ? <StatCarousel tiles={tiles} /> : null;

  return (
    <div className="mb-8 flex flex-col gap-6">
      <div className="flex items-center gap-3 px-1">
        <HomeAvatar name={user?.name ?? ""} avatarUrl={profile.data?.avatarUrl ?? null} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-2xl font-bold leading-tight">{firstName ? copy.hello(firstName) : copy.helloGuest}</p>
          {profile.data && profile.data.matchesPlayed > 0 && (
            <p className="text-xs text-muted-text">
              {profile.data.matchesPlayed} {copy.played} · {profile.data.wins} {copy.wins} · {profile.data.motmCount} {copy.motmShort}
            </p>
          )}
        </div>
      </div>

      {matches.isLoading ? (
        <div className="h-48 animate-pulse rounded-3xl bg-surface" />
      ) : hero ? (
        <>
          <MatchCard item={hero} copy={copy} now={now} variant="hero" />
          {statTile}
          {bookRow}
        </>
      ) : (
        <section className="rounded-3xl border border-line bg-surface p-4" data-testid="home-no-match">
          <p className="font-display text-lg font-bold leading-tight">{copy.homeNoMatch}</p>
          <ol className="mt-3 grid grid-cols-[1fr_20px_1fr_20px_1fr] items-center text-center">
            {[CalendarPlus, BallIcon, Smartphone].map((Icon, index) => (
              <Step key={index} index={index} label={copy.homeSteps[index]}>
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </Step>
            ))}
          </ol>
          {canBook && (
            <Link href="/book" className="mt-4 flex min-h-11 items-center justify-center rounded-full bg-floodlight px-5 text-sm font-bold text-void" data-testid="link-home-book">
              {bookLabel}
            </Link>
          )}
        </section>
      )}
      {!matches.isLoading && !hero && statTile}

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
        <Section title={copy.upcoming}>
          {moreUpcoming.map((m) => <MatchCard key={`u-${m.code}`} item={m} copy={copy} now={now} />)}
        </Section>
      )}

      {recent.length > 0 && (
        <Section title={copy.recentMatches} href="/matches" more={copy.allMatches}>
          {recent.map((m) => <MatchCard key={`r-${m.code}`} item={m} copy={copy} now={now} />)}
        </Section>
      )}

      {myClips.length > 0 && (
        <section>
          <SectionHead title={copy.recentClips} href="/my-clips" more={copy.allClips} />
          <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4">
            {myClips.map((clip) => (
              <Link key={clip.id} href="/my-clips" className="w-40 shrink-0 overflow-hidden rounded-2xl border border-line bg-surface">
                <div className="relative aspect-video bg-raised">
                  <ClipThumb src={clip.thumbnailUrl ?? null} />
                  <span className="absolute bottom-1.5 end-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-void/70"><Play className="h-3 w-3 fill-current" /></span>
                </div>
                <p className="truncate px-2.5 py-2 text-xs font-semibold">{clip.title}</p>
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
      {index > 0 && <span aria-hidden className="h-0 border-t-[1.5px] border-dashed border-[#2C3650]" />}
      <li className="flex min-w-0 flex-col items-center gap-1.5">
        <span className={index === 0 ? "flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-floodlight" : "flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-turf"}>{children}</span>
        <span className="text-[11px] font-semibold leading-tight">{label}</span>
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
      <PlayerAvatar name={name} avatarUrl={avatarUrl} size={52} className={busy ? "opacity-50" : undefined} />
      <button
        type="button"
        disabled={busy}
        onClick={() => (avatarUrl ? setSheet(true) : pick())}
        aria-label={avatarUrl ? copy.photo.change : copy.photo.add}
        data-testid="button-home-photo"
        className={avatarUrl
          ? "absolute -bottom-1 -end-1 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-void bg-raised text-text before:absolute before:-inset-2.5 before:content-['']"
          : "absolute -bottom-1 -end-1 flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 border-void bg-floodlight text-void before:absolute before:-inset-2 before:content-['']"}
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

function SectionHead({ title, href, more }: { title: string; href?: string; more?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between px-1">
      <h2 className="text-sm font-bold">{title}</h2>
      {href && more && <Link href={href} className="text-xs font-semibold text-turf">{more}</Link>}
    </div>
  );
}

function Section({ title, href, more, children }: { title: string; href?: string; more?: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionHead title={title} href={href} more={more} />
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

/** A clip's poster, or a quiet placeholder when there isn't one (or it fails to load). */
function ClipThumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="flex h-full w-full items-center justify-center" style={{ background: "repeating-linear-gradient(180deg,#0F2A2A 0 25%,#0D2525 25% 50%)" }}>
        <Film className="h-5 w-5 text-turf/70" />
      </div>
    );
  }
  return <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" onError={() => setBroken(true)} />;
}
