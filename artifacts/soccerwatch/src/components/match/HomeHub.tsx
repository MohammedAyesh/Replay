import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CalendarDays, ChevronRight, Film, Play } from "lucide-react";
import { useListUserClips, getListUserClipsQueryKey } from "@workspace/api-client-react";
import { MatchCard } from "@/components/match/MatchCard";
import { PlayerAvatar } from "@/components/match/bits";
import { useMatchCopy } from "@/i18n/match-strings";
import { useAuth } from "@/lib/auth";
import { useMyMatches, useReplayProfile } from "@/lib/match-api";

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

  if (!signedIn) return null;
  const data = matches.data;
  const isOwner = (user?.ownedFieldIds?.length ?? 0) > 0;
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] ?? "";

  const hero = data ? data.live[0] ?? data.upcoming[0] ?? null : null;
  const moreUpcoming = data ? [...data.live.slice(1), ...data.upcoming.slice(data.live.length ? 0 : 1)].slice(0, 3) : [];
  const invites = data?.invites.slice(0, 3) ?? [];
  const voting = data?.recent.filter((m) => m.voteOpen) ?? [];
  const recent = (data?.recent ?? []).filter((m) => !m.voteOpen).slice(0, 3);
  const myClips = (clips.data ?? []).slice(0, 6);

  return (
    <div className="mb-8 flex flex-col gap-6">
      <div className="flex items-center gap-3 px-1">
        <PlayerAvatar name={user?.name ?? ""} avatarUrl={profile.data?.avatarUrl} size={44} />
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
        <MatchCard item={hero} copy={copy} now={now} variant="hero" />
      ) : (
        <section className="rounded-3xl border border-line bg-surface p-5">
          <CalendarDays className="h-6 w-6 text-turf" />
          <p className="mt-3 font-display text-xl font-bold">{copy.homeEmptyTitle}</p>
          <p className="mt-1 text-sm text-muted-text">{isOwner ? copy.homeEmptyOwner : copy.homeEmptyPlayer}</p>
          {isOwner ? (
            <Link href="/owner" className="mt-4 inline-flex min-h-11 items-center gap-1 rounded-full bg-floodlight px-5 text-sm font-bold text-void">
              {copy.bookFootage("1")}
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </Link>
          ) : (
            <Link href="/view" className="mt-4 inline-flex min-h-11 items-center gap-1 rounded-full border border-violet/60 px-5 text-sm font-bold text-violet">
              {copy.browseFields}
            </Link>
          )}
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
                  {clip.thumbnailUrl ? (
                    <img src={clip.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center"><Film className="h-5 w-5 text-muted-text" /></div>
                  )}
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
