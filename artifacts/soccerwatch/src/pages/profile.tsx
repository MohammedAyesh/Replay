import { useRoute, useLocation, Link } from "wouter";
import { Crown as CrownIcon } from "lucide-react";
import { useReplayProfile } from "@/lib/match-api";
import { useMatchCopy } from "@/i18n/match-strings";
import {
  useGetUserProfile,
  useGetPublicPlayerStats,
  getGetPublicPlayerStatsQueryKey,
  useFollowUser,
  useUnfollowUser,
  PublicProfile,
  PublicPlayerHeatmap,
  PublicPlayerMatchStats,
  PublicPlayerStats,
  PublicPlayerMeasured,
  PublicPlayerMeasuredMatch,
  PlayerDribbleStats,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Users, UserCheck, Video, UserPlus, UserMinus, MapPinned, BellPlus, Crown, Bookmark, Target, Heart, ChevronDown } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { FriendButton } from "@/components/friends/FriendButton";
import {
  aggregatePitchHeatmaps,
  attachMeasured,
  formatDistance,
  measuredTiles,
  shouldShowEmptyStatsCta,
  shouldShowPerMatchHeatmaps,
} from "@/lib/player-stats";
import { CLAIM_YOUR_MATCH_ENABLED } from "@/lib/feature-flags";
import { SafetyMenu } from "@/components/safety/SafetyMenu";
import { StatsBetaNote } from "@/components/match/StatsBeta";
import { useMyBlocks, useUnblockUser, type BlockedPlayer } from "@/lib/safety-api";
import { useSafetyCopy } from "@/i18n/safety-strings";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function getProfileQueryKey(id: number) {
  return ["getUserProfile", id];
}

function apiErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = (error as { data?: { reason?: unknown } }).data;
  return typeof data?.reason === "string" ? data.reason : undefined;
}

export default function Profile() {
  const [, params] = useRoute("/players/:id");
  const userId = parseInt(params?.id || "0", 10);
  const { t } = useTranslation();
  const { user, isGuest } = useAuth();
  const blocks = useMyBlocks(Boolean(user) && !isGuest);

  const { data: profile, isLoading, isError, error } = useGetUserProfile(userId, {
    query: {
      enabled: !!userId,
      queryKey: getProfileQueryKey(userId),
    },
  });

  if (isLoading) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">{t.profile.loading}</div>
      </div>
    );
  }

  if (isError || !profile) {
    if (apiErrorReason(error) === "blocked") {
      return (
        <BlockedProfileNotice
          userId={userId}
          isMyBlock={(blocks.data ?? []).some((row) => row.userId === userId)}
        />
      );
    }
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">{t.profile.notFound}</div>
      </div>
    );
  }

  return <ProfileScreen profile={profile} myBlocks={blocks.data ?? []} />;
}

function BlockedProfileNotice({ userId, isMyBlock }: { userId: number; isMyBlock: boolean }) {
  const copy = useSafetyCopy();
  const unblock = useUnblockUser();
  const { toast } = useToast();

  const restoreProfile = async () => {
    try {
      await unblock.mutateAsync(userId);
      toast({ title: copy.unblocked });
    } catch {
      toast({ title: copy.unblockFailed, variant: "destructive" });
    }
  };

  return (
    <main
      dir={copy.locale === "ar" ? "rtl" : "ltr"}
      className="flex flex-1 items-center justify-center bg-void px-5 py-10 text-text"
    >
      <section data-testid="card-profile-not-available" className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-center">
        <h1 className="font-display text-xl font-bold">{copy.notAvailable}</h1>
        {isMyBlock && (
          <>
            <p className="mt-2 text-sm text-muted-text">{copy.youBlocked}</p>
            <button
              type="button"
              disabled={unblock.isPending}
              data-testid="button-profile-unblock"
              onClick={() => void restoreProfile()}
              className="mt-5 min-h-11 rounded-full bg-floodlight px-5 text-sm font-bold text-void disabled:opacity-50"
            >
              {copy.unblock}
            </button>
          </>
        )}
      </section>
    </main>
  );
}

function ProfileScreen({ profile, myBlocks }: { profile: PublicProfile; myBlocks: BlockedPlayer[] }) {
  const [, setLocation] = useLocation();
  const { user, isGuest } = useAuth();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();
  const replayProfile = useReplayProfile(profile.id);
  const { data: playerStats, isLoading: statsLoading, isError: statsError } = useGetPublicPlayerStats(profile.id, {
    query: {
      enabled: Boolean(profile.id),
      queryKey: getGetPublicPlayerStatsQueryKey(profile.id),
    },
  });

  const followMutation = useFollowUser();
  const unfollowMutation = useUnfollowUser();

  const isOwnProfile = !isGuest && user?.id === profile.id;
  const blockedByViewer = myBlocks.some((row) => row.userId === profile.id);

  const handleFollow = () => {
    if (isGuest) {
      toast({
        title: t.profile.signInToFollow,
        description: t.profile.signInToFollowDesc,
      });
      return;
    }

    if (profile.isFollowing) {
      unfollowMutation.mutate(
        { id: profile.id },
        {
          onSuccess: (data) => {
            queryClient.setQueryData(getProfileQueryKey(profile.id), (old: PublicProfile | undefined) =>
              old ? { ...old, isFollowing: false, followerCount: data.followerCount } : old
            );
          },
          onError: () => {
            toast({ title: t.profile.followFailed, variant: "destructive" });
          },
        }
      );
    } else {
      followMutation.mutate(
        { id: profile.id },
        {
          onSuccess: (data) => {
            queryClient.setQueryData(getProfileQueryKey(profile.id), (old: PublicProfile | undefined) =>
              old ? { ...old, isFollowing: true, followerCount: data.followerCount } : old
            );
          },
          onError: () => {
            toast({ title: t.profile.followFailed, variant: "destructive" });
          },
        }
      );
    }
  };

  const isMutating = followMutation.isPending || unfollowMutation.isPending;
  const playerPosition = profile.position
    ? t.profile.positions[profile.position] ?? profile.position
    : null;
  const statsAvailable = !statsLoading && !statsError && Boolean(playerStats);
  const measuredTotals = playerStats?.measured?.totals;
  const totalDistanceKm = playerStats?.totals.totalDistanceMetres == null ? 0 : playerStats.totals.totalDistanceMetres / 1000;

  if (apiErrorReason(replayProfile.error) === "blocked") {
    return <BlockedProfileNotice userId={profile.id} isMyBlock={blockedByViewer} />;
  }

  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="relative flex h-full flex-1 flex-col overflow-y-auto bg-void px-4 pb-28 pt-2 text-text no-scrollbar">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-void/95 pb-2 pt-safe backdrop-blur-md">
        <button
          type="button"
          onClick={() => history.back()}
          aria-label={locale === "ar" ? "رجوع" : "Back"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-text transition-transform active:scale-95"
        >
          <ChevronLeft className="w-5 h-5 rtl:hidden" />
          <ChevronRight className="w-5 h-5 ltr:hidden" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-muted-text" dir="auto">{profile.name}</span>
        {!isGuest && user && !isOwnProfile && (
          <SafetyMenu
            target={{ type: "user", id: profile.id, name: profile.name }}
            onBlocked={() => {
              if (window.history.length > 1) window.history.back();
              else setLocation("/matches");
            }}
          />
        )}
      </div>

      <div className="pb-safe">
        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative mt-1 overflow-hidden rounded-3xl border border-turf/35 bg-gradient-to-br from-[#173B3E] via-[#13283A] to-surface px-4 pb-3.5 pt-4">
          <PitchBackdrop />
          <div className="relative flex items-center gap-3.5">
            <ProfileFace userId={profile.id} name={profile.name} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-display text-[22px] font-extrabold leading-tight" dir="auto">{profile.name}</h1>
              {(playerPosition || profile.age != null) && (
                <div className="mt-1.5 flex min-h-6 items-center gap-2 text-sm font-bold text-text/80">
                  {playerPosition && <span className="rounded-full bg-floodlight px-2.5 py-1 text-xs font-extrabold text-void">{playerPosition}</span>}
                  {profile.age != null && <span><bdi className="font-display font-bold" dir="ltr">{profile.age}</bdi> {t.profile.years}</span>}
                </div>
              )}
            </div>
          </div>
          <div className="relative mt-3 grid grid-cols-2">
            {[
              { label: t.profile.speed, value: statsAvailable ? (measuredTotals?.topSpeedKmh ?? 0).toFixed(1) : "–" },
              { label: t.profile.distance, value: statsAvailable ? totalDistanceKm.toFixed(2) : "–" },
              { label: t.profile.goals, value: statsAvailable ? String(measuredTotals?.goals ?? 0) : "–" },
              { label: t.profile.passes, value: statsAvailable ? String(measuredTotals?.passesCompleted ?? 0) : "–" },
              { label: t.profile.touches, value: statsAvailable ? String(measuredTotals?.touches ?? 0) : "–" },
              { label: t.profile.dribbles, value: statsAvailable ? String(measuredTotals?.dribbles ?? playerStats?.totals.dribbles?.total ?? 0) : "–" },
            ].map((stat, index) => (
              <div key={stat.label} className={`flex min-w-0 items-baseline gap-2 py-1.5 ${index >= 2 ? "border-t border-white/10" : ""} ${index % 2 === 0 ? "pe-2" : "border-s border-white/10 ps-3"}`}>
                <bdi dir="ltr" className="min-w-[52px] font-display text-[26px] font-bold leading-none tabular-nums">{stat.value}</bdi>
                <span className="truncate text-xs font-semibold text-[#9FB3B5]">{stat.label}</span>
              </div>
            ))}
          </div>
          <div className="relative mt-2.5 flex items-center justify-between gap-2 border-t border-white/10 pt-2.5">
            <ProfileCount icon={<Video />} value={profile.clipCount} label={t.profile.clips} />
            <ProfileCount icon={<Users />} value={profile.followerCount} label={t.profile.followers} />
            <ProfileCount icon={<UserCheck />} value={profile.followingCount} label={t.profile.following} />
          </div>
        </motion.section>

        {!isOwnProfile ? (
          <div className="mt-3 flex gap-2.5">
            <div className="min-w-0 flex-1"><FriendButton userId={profile.id} name={profile.name} /></div>
            <button type="button" onClick={handleFollow} disabled={isMutating} className={cn(
              "inline-flex min-h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-[14px] border px-3 text-sm font-bold transition-opacity disabled:opacity-50",
              profile.isFollowing ? "border-line bg-raised text-text" : "border-[#7B5CFF]/50 bg-[#7B5CFF]/[0.16] text-text"
            )}>
              {profile.isFollowing ? <UserMinus className="h-4 w-4 text-[#B9A8FF]" /> : <BellPlus className="h-4 w-4 text-[#B9A8FF]" />}
              {profile.isFollowing ? t.profile.unfollow : t.profile.follow}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex min-h-11 items-center justify-center rounded-xl border border-dashed border-line px-3 text-center text-sm font-semibold text-muted-text">{t.profile.ownProfile}</div>
        )}
        <StatsBetaNote className="mt-2.5" />

        <MatchRecord userId={profile.id} />

        <PlayerStatsSection
          stats={playerStats}
          loading={statsLoading}
          error={statsError}
          locale={locale}
          ownProfile={isOwnProfile}
          canClaim={CLAIM_YOUR_MATCH_ENABLED && shouldShowEmptyStatsCta(profile.id, user?.id, isGuest)}
        />
      </div>
    </div>
  );
}

function PlayerStatsSection({
  stats,
  loading,
  error,
  locale,
  ownProfile,
  canClaim,
}: {
  stats: PublicPlayerStats | undefined;
  loading: boolean;
  error: boolean;
  locale: "en" | "ar";
  ownProfile: boolean;
  canClaim: boolean;
}) {
  const { t } = useTranslation();
  const hasStats = Boolean(stats) && !loading && !error;
  const matches = hasStats ? stats!.matches : [];
  const showPerMatch = shouldShowPerMatchHeatmaps(matches);
  const aggregateHeatmap = !showPerMatch ? aggregatePitchHeatmaps(matches) : null;
  const measured = attachMeasured(matches, hasStats ? stats!.measured?.matches ?? [] : []);
  const emptyMatches = hasStats && matches.length === 0;
  const totals = hasStats ? stats!.totals : null;
  const humanMinutes = totals ? totals.totalHumanVouchedSeconds / 60 : 0;
  const inferredMinutes = totals ? totals.totalInferredSeconds / 60 : 0;
  const trustedTotal = humanMinutes + inferredMinutes;
  const humanPercent = trustedTotal > 0 ? humanMinutes / trustedTotal * 100 : 0;

  return (
    <section className="mt-7 grid gap-3.5 pb-8" aria-labelledby="player-stats-title">
      <div className="flex items-end justify-between gap-3 px-0.5">
        <div>
          <h2 id="player-stats-title" className="font-display text-xl font-extrabold">{t.profile.matchesHeading}</h2>
          <p className="mt-0.5 text-[13px] text-muted-text">{ownProfile ? t.profile.ownMatchesSubtitle : t.profile.otherMatchesSubtitle}</p>
        </div>
        {hasStats && stats!.excludedClaimCount > 0 && <span className="shrink-0 rounded-full border border-[#7B5CFF]/40 bg-[#7B5CFF]/[0.16] px-2.5 py-1 text-xs font-bold text-[#B9A8FF]">{t.profile.awaitingReview(stats!.excludedClaimCount)}</span>}
      </div>
      {hasStats && stats!.excludedClaimCount > 0 && <div className="rounded-lg border-s-[3px] border-[#7B5CFF] bg-[#7B5CFF]/10 px-3 py-2 text-xs text-muted-text"><span>{t.profile.awaitingReviewDesc}</span></div>}
      {error && <p role="status" className="text-center text-xs text-muted-text">{t.profile.statsLoadFailed}</p>}

      {emptyMatches && <div className="grid justify-items-center gap-2 rounded-2xl border border-line bg-surface p-5 text-center">
        {canClaim ? <>
          <Target className="h-6 w-6 text-turf" aria-hidden="true" />
          <h3 className="font-bold">{t.profile.noConfirmedTitle}</h3>
          <p className="max-w-sm text-sm leading-5 text-muted-text">{t.profile.noConfirmedDesc}</p>
          <Link href="/claim/demo" className="mt-1 inline-flex min-h-11 items-center justify-center rounded-full bg-floodlight px-4 text-sm font-extrabold text-void">{t.profile.viewClaimFlow}</Link>
        </> : <p className="text-sm text-muted-text">{t.profile.noConfirmedOther}</p>}
      </div>}

      <div className="grid grid-cols-3 gap-2">
        <TotalValue value={totals ? String(totals.totalMatchesClaimed) : "–"} label={t.profile.matchesClaimed} />
        <TotalValue value={totals ? String(Math.round(totals.totalMinutesPlayed)) : "–"} label={t.profile.totalMinutes} />
        <TotalValue value={totals ? (totals.totalDistanceMetres == null ? 0 : totals.totalDistanceMetres / 1000).toFixed(1) : "–"} label={t.profile.totalDistance} />
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <section className="min-w-0 rounded-2xl border border-line bg-surface p-2.5">
          <h3 className="mb-2 text-[13px] font-bold text-muted-text">{t.profile.heatmap}</h3>
          <PlayerStatsHeatmap heatmap={aggregateHeatmap} label={t.profile.heatmap} />
          {showPerMatch && <p className="mt-1.5 text-[10px] leading-4 text-muted-text">{t.profile.perMatchMapsNote}</p>}
        </section>
        <section className="flex min-w-0 flex-col justify-center gap-2 rounded-2xl border border-line bg-surface p-2.5">
          <TotalLine label={t.profile.matchesClaimed} value={totals ? String(totals.totalMatchesClaimed) : "–"} />
          <TotalLine label={t.profile.totalMinutes} value={totals ? String(Math.round(totals.totalMinutesPlayed)) : "–"} />
          <TotalLine label={t.profile.totalDistance} value={totals ? (totals.totalDistanceMetres == null ? 0 : totals.totalDistanceMetres / 1000).toFixed(1) : "–"} />
        </section>
      </div>

      <section className="rounded-2xl border border-line bg-surface p-3.5">
        <h3 className="mb-2.5 text-[13px] font-bold text-text">{t.profile.confirmedMinutesTitle}</h3>
        <div className="flex h-2 overflow-hidden rounded-full bg-line">
          {humanPercent > 0 && <span className="bg-turf" style={{ width: `${humanPercent}%` }} />}
          {trustedTotal > humanMinutes && <span className="flex-1 bg-[#7B5CFF]/65" />}
        </div>
        <div className="mt-2 flex justify-between gap-3 text-[11px] text-muted-text">
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-turf" />{t.profile.humanVouched}<bdi dir="ltr" className="font-display text-sm font-bold text-text">{totals ? formatMinutes(humanMinutes) : "–"}</bdi></span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[#7B5CFF]" />{t.profile.inferred}<bdi dir="ltr" className="font-display text-sm font-bold text-text">{totals ? formatMinutes(inferredMinutes) : "–"}</bdi></span>
        </div>
      </section>

      {emptyMatches && stats!.excludedClaimCount > 0 && <p className="text-xs text-muted-text">{t.profile.awaitingReviewDesc}</p>}
      {loading && <p className="py-2 text-center text-xs text-muted-text">{t.profile.loading}</p>}
      <div className="grid gap-2">
        {matches.map((match, index) => (
          <PlayerMatchStatsRow key={match.recordingId} match={match} measured={measured.byRecording.get(match.recordingId) ?? null} locale={locale} showHeatmap={showPerMatch} defaultOpen={index === 0} />
        ))}
      </div>
      {hasStats && <OtherMeasuredMatches matches={measured.unattached} locale={locale} titled />}
    </section>
  );
}

function PlayerMatchStatsRow({
  match,
  measured,
  locale,
  showHeatmap,
  defaultOpen,
}: {
  match: PublicPlayerMatchStats;
  measured: PublicPlayerMeasuredMatch | null;
  locale: "en" | "ar";
  showHeatmap: boolean;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const figures = measuredTiles(measured, { distance: true });
  const figure = (key: MeasuredTileValue["key"]) => figures.find((item) => item.key === key);
  const dribbles = figure("dribbles")?.value ?? match.dribbles?.total ?? 0;
  const passes = figure("passes");
  const distanceKm = figure("distance")?.value ?? (match.distanceMetres ?? 0) / 1000;
  const statCells = [
    [t.profile.distance, `${distanceKm.toFixed(2)} km`],
    [t.profile.topSpeed, `${(figure("topSpeed")?.value ?? 0).toFixed(1)} ${t.profile.kmh}`],
    [t.profile.goals, String(figure("goals")?.value ?? 0)],
    [t.profile.shots, String(figure("shots")?.value ?? 0)],
    [t.profile.passes, passes ? (passes.tried === null ? String(passes.value) : t.profile.passesOf(passes.tried)) : "0"],
    [t.profile.touches, String(figure("touches")?.value ?? 0)],
    [t.profile.dribbles, String(dribbles)],
    [t.profile.humanVouched, `${formatMinutes(match.humanVouchedSeconds / 60)} min`],
    [t.profile.inferred, `${formatMinutes(match.inferredSeconds / 60)} min`],
  ] as const;
  const date = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium" })
    .format(new Date(`${match.date}T12:00:00`));

  return (
    <details open={defaultOpen} className="group overflow-hidden rounded-2xl border border-line bg-surface">
      <summary className="flex min-h-[60px] cursor-pointer list-none items-center gap-2.5 px-3.5 py-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span dir="ltr" className="block truncate text-start font-display text-base font-bold">{match.title}</span>
          <span className="mt-0.5 block text-xs text-muted-text">{t.profile.matchDate(date)}</span>
        </span>
        <bdi dir="ltr" className="font-display text-lg font-bold tabular-nums">{formatMinutes(match.minutesPlayed)}</bdi>
        <span className="text-xs text-muted-text">{t.profile.minuteShort}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-text transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="grid grid-cols-3 gap-1.5 px-3.5 pb-3.5">
        {statCells.map(([label, value]) => <MetricCell key={label} label={label} value={value} />)}
        {match.offPitchSeconds > 0 && <p className="col-span-3 mt-0.5 text-xs font-semibold text-muted-text">{t.profile.offPitch(match.offPitchSeconds / 60)}</p>}
        {showHeatmap && <div className="col-span-3 mt-1 rounded-xl border border-line bg-raised p-2.5">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-bold text-muted-text"><span>{t.profile.heatmap}</span><span className="text-[10px] font-medium">{match.heatmap.coordinateSpace === "pitch" ? t.profile.pitchCoordinates : t.profile.cameraCoordinates}</span></div>
          <PlayerStatsHeatmap heatmap={match.heatmap} label={t.profile.heatmap} />
        </div>}
      </div>
    </details>
  );
}

function PlayerStatsHeatmap({ heatmap, label }: { heatmap: PublicPlayerHeatmap | null; label: string }) {
  return (
    <svg viewBox="0 0 200 120" className="block w-full overflow-hidden rounded-lg bg-[#0F2427]" role="img" aria-label={`${label} (${heatmap?.coordinateSpace ?? "pitch"})`}>
      <defs>
        <radialGradient id="player-heat-glow"><stop offset="0" stopColor="#D4FF4F" stopOpacity=".92" /><stop offset=".44" stopColor="#2FD8C4" stopOpacity=".48" /><stop offset="1" stopColor="#2FD8C4" stopOpacity="0" /></radialGradient>
      </defs>
      {(heatmap?.cells ?? []).map((cell, index) => {
        const weight = Math.max(0, Math.min(1, cell.weight));
        return <circle key={`${cell.x}:${cell.y}:${index}`} cx={cell.x * 200} cy={cell.y * 120} r={8 + weight * 11} fill="url(#player-heat-glow)" opacity={Math.max(.12, weight)} />;
      })}
      <g fill="none" stroke="#F2F4F8" strokeOpacity=".35" strokeWidth="1.2">
        <rect x="8" y="8" width="184" height="104" rx="6" /><line x1="100" y1="8" x2="100" y2="112" /><circle cx="100" cy="60" r="16" /><rect x="8" y="34" width="26" height="52" /><rect x="166" y="34" width="26" height="52" />
      </g>
    </svg>
  );
}

type MeasuredTileValue = ReturnType<typeof measuredTiles>[number];

/** A tile's label, headline and small line, in the reader's language. */
function useMeasuredText() {
  const { t } = useTranslation();
  return (tile: MeasuredTileValue, count: number | null): { label: string; value: string; note: string | null } => {
    const inMatches = count !== null ? t.profile.inMatches(count) : null;
    switch (tile.key) {
      case "topSpeed":
        return { label: t.profile.topSpeed, value: `${tile.value.toFixed(1)} ${t.profile.kmh}`, note: count !== null ? t.profile.topSpeedBest(count) : null };
      case "distance":
        return { label: t.profile.distance, value: `${tile.value.toFixed(2)} km`, note: inMatches };
      case "goals":
        return { label: t.profile.goals, value: String(tile.value), note: inMatches };
      case "shots":
        return { label: t.profile.shots, value: String(tile.value), note: inMatches };
      case "passes":
        return { label: t.profile.passes, value: String(tile.value), note: tile.tried !== null ? t.profile.passesOf(tile.tried) : inMatches };
      case "touches":
        return { label: t.profile.touches, value: String(tile.value), note: inMatches };
      case "dribbles":
        return {
          label: t.profile.dribbles,
          value: String(tile.value),
          note: tile.won !== null && tile.lost !== null ? t.profile.dribblesWonLost(tile.won, tile.lost) : inMatches,
        };
    }
  };
}

const MEASURED_KEY_FIELD: Record<MeasuredTileValue["key"], keyof PublicPlayerMeasuredMatch> = {
  topSpeed: "topSpeedKmh",
  distance: "distanceKm",
  goals: "goals",
  shots: "shots",
  passes: "passesCompleted",
  touches: "touches",
  dribbles: "dribbles",
};

/**
 * What Replay measured across the player's matches -- the match reports' own
 * figures. A figure no match measured is simply not shown; nothing is labelled
 * "Unavailable". Dribbles fall back to the claimed games' count when no match
 * report has them.
 */
function MeasuredTotalTiles({ measured, fallbackDribbles = null }: { measured: PublicPlayerMeasured | null; fallbackDribbles?: PlayerDribbleStats | null }) {
  const { t } = useTranslation();
  const text = useMeasuredText();
  const matches = measured?.matches ?? [];
  const tiles = matches.length ? measuredTiles(measured!.totals) : [];
  const showFallbackDribbles = Boolean(fallbackDribbles) && !tiles.some((tile) => tile.key === "dribbles");
  if (!tiles.length && !showFallbackDribbles) return null;
  return (
    <div className="flex flex-col gap-2">
      {tiles.length > 0 && (
        <div className="player-stats-card-heading">
          <span>{t.profile.measuredTitle}</span>
          <small>{t.profile.measuredDesc}</small>
        </div>
      )}
      <div className="player-stats-unavailable-grid">
        {tiles.map((tile) => {
          const count = matches.filter((match) => match[MEASURED_KEY_FIELD[tile.key]] !== null).length;
          const shown = text(tile, count);
          return (
            <div className="player-stats-unavailable-tile is-measured" key={tile.key} title={tile.key === "dribbles" ? t.profile.dribblesDesc : undefined}>
              <span>{shown.label}</span>
              <b dir="ltr" className="text-start">{shown.value}</b>
              {shown.note && <small>{shown.note}</small>}
            </div>
          );
        })}
        {showFallbackDribbles && fallbackDribbles && (
          <div className="player-stats-unavailable-tile is-measured" title={t.profile.dribblesDesc}>
            <span>{t.profile.dribbles}</span>
            <b>{fallbackDribbles.total}</b>
            <small>{t.profile.dribblesSplit(fallbackDribbles.succeeded, fallbackDribbles.failed)}</small>
          </div>
        )}
      </div>
    </div>
  );
}

/** One measured figure inside a match row, styled like the row's other metrics. */
function MeasuredCell({ tile }: { tile: MeasuredTileValue }) {
  const text = useMeasuredText();
  const shown = text(tile, null);
  return (
    <div>
      <span>{shown.label}</span>
      <b dir="ltr" className="text-start">{shown.value}</b>
      {shown.note && <small>{shown.note}</small>}
    </div>
  );
}

/** Measured matches with no claimed recording on the page: their figures, one row each. */
function OtherMeasuredMatches({ matches, locale, titled }: { matches: PublicPlayerMeasuredMatch[]; locale: "en" | "ar"; titled: boolean }) {
  const { t } = useTranslation();
  if (!matches.length) return null;
  const format = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium" });
  return (
    <div className="grid gap-2">
      {titled && <p className="player-stats-coordinate-note">{t.profile.otherMatches}</p>}
      {matches.map((match) => {
        const figures = measuredTiles(match, { distance: true });
        return (
          <details className="group overflow-hidden rounded-2xl border border-line bg-surface" key={match.matchId}>
            <summary className="flex min-h-[60px] cursor-pointer list-none items-center gap-2.5 px-3.5 py-2 [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1"><span className="block truncate font-display text-base font-bold">{match.fieldName ?? t.profile.measuredTitle}</span><span className="mt-0.5 block text-xs text-muted-text">{t.profile.matchDate(format.format(new Date(`${match.date}T12:00:00`)))}</span></span>
              <bdi dir="ltr" className="font-display text-sm font-bold">{match.minutes == null ? "0.0" : formatMinutes(match.minutes)}</bdi>
              <span className="text-xs text-muted-text">{t.profile.minuteShort}</span>
              <ChevronDown className="h-4 w-4 text-muted-text transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="grid grid-cols-3 gap-1.5 px-3.5 pb-3.5">{figures.map((tile) => {
              const shown = useMeasuredText()(tile, null);
              return <MetricCell key={tile.key} label={shown.label} value={shown.value} />;
            })}</div>
          </details>
        );
      })}
    </div>
  );
}

function formatMinutes(value: number): string {
  return value.toFixed(1);
}

function ProfileFace({ userId, name }: { userId: number; name: string }) {
  const { data } = useReplayProfile(userId);
  return (
    <div className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-turf to-[#7B5CFF] p-[3px]">
      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-raised font-display text-[30px] font-bold text-text">
      {data?.avatarUrl ? (
        <img src={data.avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        getInitials(name)
      )}
      </span>
    </div>
  );
}

/** Matches played on Replay: record, man-of-the-match crowns, recent results. */
function MatchRecord({ userId, ownProfile }: { userId: number; ownProfile: boolean }) {
  const copy = useMatchCopy();
  const { t, locale } = useTranslation();
  const { data, isLoading } = useReplayProfile(userId);
  const dateParts = (local: string) => {
    const [date, time = "00:00"] = local.split(" ");
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    const dateValue = new Date(year, month - 1, day, hour, minute);
    return {
      day: new Intl.NumberFormat("en").format(day),
      month: new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { month: "short" }).format(dateValue),
      weekday: new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { weekday: "long" }).format(dateValue),
    };
  };
  return (
    <section className="mt-7" aria-labelledby="replay-matches-heading">
      <div className="mb-3">
        <h2 id="replay-matches-heading" className="font-display text-xl font-extrabold">{t.profile.replayMatches}</h2>
        <p className="mt-0.5 text-[13px] text-muted-text">{ownProfile ? t.profile.ownMatchesRecord : t.profile.otherMatchesRecord}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MatchStat value={data ? data.matchesPlayed : isLoading ? "–" : 0} label={copy.played} />
        <MatchStat value={data ? data.wins : isLoading ? "–" : 0} label={copy.wins} turf />
        <MatchStat value={data ? data.motmCount : isLoading ? "–" : 0} label={copy.motmShort} crown />
      </div>
      {data?.matchesPlayed === 0 || (data && data.recent.length === 0) ? (
        <p className="mt-3 rounded-2xl border border-dashed border-line bg-surface px-4 py-3 text-center text-sm leading-5 text-muted-text">{ownProfile ? t.profile.noReplayMatchesOwn : t.profile.noReplayMatchesOther}</p>
      ) : data?.recent.length ? (
        <div className="mt-3 grid">
          {data.recent.slice(0, 6).map((match, index) => {
            const date = dateParts(match.startLocal);
            return <div key={match.code} className="flex gap-2.5">
              <div className="flex w-11 shrink-0 flex-col items-center pt-2">
                <span className="font-display text-[22px] font-bold leading-none">{date.day}</span><span className="text-[11px] font-semibold text-muted-text">{date.month}</span>
              </div>
              <div className="flex w-3 shrink-0 flex-col items-center">
                <span className={`h-3.5 w-0.5 ${index ? "bg-line" : "bg-transparent"}`} />
                <span className={`h-3 w-3 shrink-0 rounded-full border-[2.5px] bg-void ${match.motm ? "border-floodlight" : "border-turf"}`} />
                <span className={`min-h-3 flex-1 w-0.5 ${index < Math.min(data.recent.length, 6) - 1 ? "bg-line" : "bg-transparent"}`} />
              </div>
              <Link href={`/m/${match.code}`} className="mb-2.5 flex min-h-[62px] min-w-0 flex-1 flex-col justify-center gap-1 rounded-2xl border border-line bg-surface px-3 py-2.5 text-text">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5"><span dir="ltr" className="truncate font-display text-base font-bold">{match.field.name}</span>{match.motm && <CrownIcon className="h-3.5 w-3.5 shrink-0 text-floodlight" aria-label={copy.motm} />}</span>
                  {match.score && <span className="flex shrink-0 items-center gap-1.5"><bdi dir="ltr" className="font-display text-lg font-bold">{match.score.a}–{match.score.b}</bdi>{match.team && <span className={`text-xs font-extrabold ${match.won ? "text-turf" : "text-muted-text"}`}>{match.won ? copy.won : copy.lost}</span>}</span>}
                  {!match.score && <span className="shrink-0 text-xs text-muted-text">{t.profile.noScore}</span>}
                </span>
                <span className="text-[11px] text-muted-text">{date.weekday}</span>
              </Link>
            </div>;
          })}
        </div>
      ) : isLoading ? <p className="mt-3 text-center text-xs text-muted-text">{t.profile.loading}</p> : null}
    </section>
  );
}
