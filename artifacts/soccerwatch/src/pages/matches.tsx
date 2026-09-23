import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { CalendarDays, Crown, Loader2, Trophy } from "lucide-react";
import { MatchCard } from "@/components/match/MatchCard";
import { PlayerAvatar } from "@/components/match/bits";
import { useMatchCopy } from "@/i18n/match-strings";
import { useAuth } from "@/lib/auth";
import { useMyMatches, useReplayProfile, type MyMatchItem } from "@/lib/match-api";

function useNow(tick = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), tick);
    return () => window.clearInterval(t);
  }, [tick]);
  return now;
}

export default function Matches() {
  const copy = useMatchCopy();
  const { user, isGuest, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const signedIn = Boolean(user) && !isGuest;
  const matches = useMyMatches(signedIn);
  const profile = useReplayProfile(signedIn ? user?.id : null);
  const now = useNow();

  useEffect(() => {
    if (!isLoading && !user) setLocation(`/sign-in?redirect_url=${encodeURIComponent("/matches")}`);
  }, [isLoading, setLocation, user]);

  const data = matches.data;
  const empty = data && !data.live.length && !data.upcoming.length && !data.recent.length && !data.invites.length;

  return (
    <div dir={copy.locale === "ar" ? "rtl" : "ltr"} className="flex min-h-0 flex-1 flex-col overflow-y-auto no-scrollbar px-4 pb-28 pt-2">
      {profile.data && (
        <Link href={`/players/${profile.data.id}`} className="mb-4 flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
          <PlayerAvatar name={profile.data.name} avatarUrl={profile.data.avatarUrl} size={48} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-lg font-bold">{profile.data.name}</p>
            <p className="text-[11px] text-muted-text">{copy.playerCard}</p>
          </div>
          <Stat value={profile.data.matchesPlayed} label={copy.played} />
          <Stat value={profile.data.wins} label={copy.wins} />
          <Stat value={profile.data.motmCount} label={copy.motmShort} icon={<Crown className="h-3 w-3 text-floodlight" />} />
        </Link>
      )}

      {matches.isLoading || isLoading ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-text" /></div>
      ) : empty || !data ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <CalendarDays className="h-10 w-10 text-turf" />
          <p className="mt-3 font-display text-xl font-bold">{copy.noMatches}</p>
          <p className="mt-1 text-sm text-muted-text">{copy.noMatchesDesc}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {data.live.map((m) => <MatchCard key={m.code} item={m} copy={copy} now={now} variant="hero" />)}
          <Section title={copy.invites} items={data.invites} copy={copy} now={now} />
          <Section title={copy.upcoming} items={data.upcoming} copy={copy} now={now} />
          <Section title={copy.recent} items={data.recent} copy={copy} now={now} icon={<Trophy className="h-4 w-4 text-turf" />} />
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, icon }: { value: number; label: string; icon?: React.ReactNode }) {
  return (
    <div className="flex w-12 flex-col items-center">
      <span className="flex items-center gap-0.5 font-mono text-xl font-bold leading-none">{icon}{value}</span>
      <span className="mt-0.5 text-[9px] font-semibold uppercase text-muted-text">{label}</span>
    </div>
  );
}

function Section({ title, items, copy, now, icon }: {
  title: string; items: MyMatchItem[]; copy: ReturnType<typeof useMatchCopy>; now: number; icon?: React.ReactNode;
}) {
  if (!items.length) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold">{icon}{title}</h2>
      <div className="flex flex-col gap-2">
        {items.map((m) => <MatchCard key={`${m.code}-${m.inviteToken ?? ""}`} item={m} copy={copy} now={now} />)}
      </div>
    </section>
  );
}
