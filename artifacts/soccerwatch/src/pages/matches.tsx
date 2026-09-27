import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { CalendarDays, Crown, Loader2, Sparkles, Trophy, Users } from "lucide-react";
import { useForm } from "react-hook-form";
import { MatchCard } from "@/components/match/MatchCard";
import { RecentFormPanel } from "@/components/match/MatchStats";
import { PlayerAvatar } from "@/components/match/bits";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useMatchCopy } from "@/i18n/match-strings";
import { useFriendsCopy } from "@/i18n/friends-strings";
import { useAuth } from "@/lib/auth";
import { useJoinMatch, useMyMatches, useReplayProfile, type MyMatchItem } from "@/lib/match-api";

type MatchCodeFormValues = { code: string };

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
  const friendsCopy = useFriendsCopy();
  const { user, isGuest, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const signedIn = Boolean(user) && !isGuest;
  const matches = useMyMatches(signedIn);
  const profile = useReplayProfile(signedIn ? user?.id : null);
  const now = useNow();
  const codeForm = useForm<MatchCodeFormValues>({ defaultValues: { code: "" } });
  const codeValue = codeForm.watch("code");
  const joinByCode = useJoinMatch(codeValue.trim().toUpperCase());

  useEffect(() => {
    if (!isLoading && !user) setLocation(`/sign-in?redirect_url=${encodeURIComponent("/matches")}`);
  }, [isLoading, setLocation, user]);

  const onJoinByCode = codeForm.handleSubmit(async ({ code }) => {
    const matchCode = code.trim().toUpperCase();
    codeForm.clearErrors("code");

    // Guests can open the room first; its existing RSVP flow will sign them
    // in and resume the join. Signed-in players join immediately.
    if (!signedIn) {
      setLocation(`/m/${matchCode}`);
      return;
    }

    try {
      await joinByCode.mutateAsync({ rsvp: "in" });
      setLocation(`/m/${matchCode}`);
    } catch (error) {
      codeForm.setError("code", {
        type: "server",
        message: error instanceof Error ? error.message : copy.error,
      });
    }
  });

  const data = matches.data;
  const empty = data && !data.live.length && !data.upcoming.length && !data.recent.length && !data.invites.length;

  return (
    <div dir={copy.locale === "ar" ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto no-scrollbar px-4 pb-28 pt-2">
      <div className="flex min-h-full flex-col">
      <section
        aria-labelledby="join-match-by-code-title"
        className="mb-4 rounded-2xl border border-line bg-surface p-4"
      >
        <h2 id="join-match-by-code-title" className="font-display text-lg font-bold">
          {copy.joinByCodeTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-text">{copy.joinByCodeDesc}</p>
        <Form {...codeForm}>
          <form onSubmit={onJoinByCode} className="mt-3 flex items-start gap-2">
            <FormField
              control={codeForm.control}
              name="code"
              rules={{
                required: copy.matchCodeRequired,
                validate: (value) =>
                  /^[A-Z0-9]{6}$/.test(value.trim().toUpperCase()) || copy.matchCodeInvalid,
              }}
              render={({ field }) => (
                <FormItem className="min-w-0 flex-1">
                  <FormLabel>{copy.matchCode}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      data-testid="input-match-code"
                      dir="ltr"
                      autoComplete="off"
                      autoCapitalize="characters"
                      maxLength={6}
                      placeholder={copy.matchCodePlaceholder}
                      onChange={(event) => {
                        codeForm.clearErrors("code");
                        field.onChange(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase());
                      }}
                    />
                  </FormControl>
                  <FormMessage data-testid="status-match-code-error" />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="mt-8 shrink-0"
              disabled={isLoading || joinByCode.isPending || codeForm.formState.isSubmitting}
              data-testid="button-join-match-by-code"
            >
              {joinByCode.isPending || codeForm.formState.isSubmitting
                ? copy.joiningByCode
                : copy.joinByCodeButton}
            </Button>
          </form>
        </Form>
      </section>

      {profile.data && (
        <div className="mb-4 flex items-center gap-2">
          <Link href={`/players/${profile.data.id}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-line bg-surface p-3">
            <PlayerAvatar name={profile.data.name} avatarUrl={profile.data.avatarUrl} size={44} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-base font-bold">{profile.data.name}</p>
              <p className="text-[11px] text-muted-text">{copy.playerCard}</p>
            </div>
            <Stat value={profile.data.matchesPlayed} label={copy.played} />
            <Stat value={profile.data.wins} label={copy.wins} />
            <Stat value={profile.data.motmCount} label={copy.motmShort} icon={<Crown className="h-3 w-3 text-floodlight" />} />
          </Link>
          <Link href="/friends" aria-label={friendsCopy.title} className="flex min-h-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl border border-line bg-surface px-2 text-[10px] font-bold text-turf">
            <Users className="h-4 w-4" aria-hidden="true" />
            {friendsCopy.title}
          </Link>
        </div>
      )}

      {data && (data.personalForm || data.personalFormPending) && (
        <section className="mb-5 rounded-2xl border border-floodlight/25 bg-surface p-4" data-testid="section-personal-form">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="font-display text-lg font-bold">{copy.competitionForm}</p>
              <p className="mt-1 text-xs leading-5 text-muted-text">
                {data.personalForm
                  ? copy.competitionRecentFormHint(data.personalForm.previousMatchesUsed ?? Math.max(0, data.personalForm.matchesUsed - 1))
                  : copy.competitionFormPending}
              </p>
            </div>
            {data.personalForm && (
              <span className="shrink-0 rounded-full bg-floodlight/10 px-2 py-1 font-mono text-xs font-bold text-floodlight">
                {data.personalForm.matchesUsed} {copy.competitionMatches}
              </span>
            )}
          </div>
          {data.personalForm
            ? <RecentFormPanel form={data.personalForm} copy={copy} />
            : <div className="h-20 animate-pulse rounded-xl bg-raised/60" aria-hidden="true" />}
        </section>
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
        {items.map((m) => (
          <div key={`${m.code}-${m.inviteToken ?? ""}`} className="flex flex-col gap-1.5">
            <MatchCard item={m} copy={copy} now={now} />
            {m.findRecordingId ? (
              <Link
                href={`/find/${m.findRecordingId}`}
                className="ms-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-turf/40 bg-turf/10 px-3 py-1.5 text-xs font-bold text-turf"
              >
                <Sparkles className="h-3.5 w-3.5" />{copy.findTitle}
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
