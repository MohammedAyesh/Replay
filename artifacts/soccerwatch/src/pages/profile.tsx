import { useRoute, useLocation, Link } from "wouter";
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
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Users, UserCheck, Video, UserPlus, UserMinus, MapPinned } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { aggregatePitchHeatmaps, formatDistance, shouldShowPerMatchHeatmaps } from "@/lib/player-stats";

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

export default function Profile() {
  const [, params] = useRoute("/players/:id");
  const userId = parseInt(params?.id || "0", 10);
  const { t } = useTranslation();

  const { data: profile, isLoading, isError } = useGetUserProfile(userId, {
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
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">{t.profile.notFound}</div>
      </div>
    );
  }

  return <ProfileScreen profile={profile} />;
}

function ProfileScreen({ profile }: { profile: PublicProfile }) {
  const [, setLocation] = useLocation();
  const { user, isGuest } = useAuth();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();
  const { data: playerStats, isLoading: statsLoading, isError: statsError } = useGetPublicPlayerStats(profile.id, {
    query: {
      enabled: Boolean(profile.id),
      queryKey: getGetPublicPlayerStatsQueryKey(profile.id),
    },
  });

  const followMutation = useFollowUser();
  const unfollowMutation = useUnfollowUser();

  const isOwnProfile = !isGuest && user?.id === profile.id;

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

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-y-auto no-scrollbar">
      {/* Top bar */}
      <div className="pt-safe px-4 pt-4 flex items-center gap-2 sticky top-0 z-10 bg-background/95 backdrop-blur-md pb-3">
        <button
          onClick={() => history.back()}
          className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-foreground active:scale-95 transition-transform"
        >
          <ChevronLeft className="w-5 h-5 rtl:hidden" />
          <ChevronRight className="w-5 h-5 ltr:hidden" />
        </button>
        <span className="text-sm font-semibold text-muted-foreground flex-1 truncate">{profile.name}</span>
      </div>

      <div className="px-5 py-8">
        {/* Avatar */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="flex flex-col items-center gap-4 mb-8"
        >
          <div className="w-24 h-24 rounded-full bg-primary flex items-center justify-center shadow-lg">
            <span className="text-3xl font-bold text-white">{getInitials(profile.name)}</span>
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold">{profile.name}</h1>
            {profile.position && (
              <p className="text-muted-foreground text-sm capitalize mt-0.5">{profile.position}</p>
            )}
            {profile.age && (
              <p className="text-muted-foreground text-xs mt-0.5">{t.profile.age(profile.age)}</p>
            )}
          </div>
        </motion.div>

        {/* Stats row */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-3 gap-3 mb-8"
        >
          <StatCard value={profile.clipCount} label={t.profile.clips} icon={<Video className="w-4 h-4" />} />
          <StatCard value={profile.followerCount} label={t.profile.followers} icon={<Users className="w-4 h-4" />} />
          <StatCard value={profile.followingCount} label={t.profile.following} icon={<UserCheck className="w-4 h-4" />} />
        </motion.div>

        {/* Follow / Unfollow button */}
        {!isOwnProfile && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <button
              onClick={handleFollow}
              disabled={isMutating}
              className={cn(
                "w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-95",
                profile.isFollowing
                  ? "bg-muted text-foreground"
                  : "bg-primary text-white"
              )}
            >
              {profile.isFollowing ? (
                <>
                  <UserMinus className="w-4 h-4" />
                  {t.profile.unfollow}
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  {t.profile.follow}
                </>
              )}
            </button>
          </motion.div>
        )}

        {isOwnProfile && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="text-center text-sm text-muted-foreground py-2"
          >
            {t.profile.ownProfile}
          </motion.div>
        )}

        <PlayerStatsSection
          stats={playerStats}
          loading={statsLoading}
          error={statsError}
          locale={locale}
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
}: {
  stats: PublicPlayerStats | undefined;
  loading: boolean;
  error: boolean;
  locale: "en" | "ar";
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <section className="player-stats-section" aria-labelledby="player-stats-title">
        <div className="player-stats-heading">
          <div>
            <h2 id="player-stats-title">{t.profile.statsTitle}</h2>
            <p>{t.profile.statsSubtitle}</p>
          </div>
        </div>
        <div className="player-stats-loading">{t.profile.loading}</div>
      </section>
    );
  }

  if (error || !stats) {
    return (
      <section className="player-stats-section" aria-labelledby="player-stats-title">
        <div className="player-stats-heading">
          <div>
            <h2 id="player-stats-title">{t.profile.statsTitle}</h2>
            <p>{t.profile.statsSubtitle}</p>
          </div>
        </div>
        <div className="player-stats-error">{t.profile.statsLoadFailed}</div>
      </section>
    );
  }

  if (stats.matches.length === 0) {
    return (
      <section className="player-stats-section" aria-labelledby="player-stats-title">
        <div className="player-stats-heading">
          <div>
            <h2 id="player-stats-title">{t.profile.statsTitle}</h2>
            <p>{t.profile.statsSubtitle}</p>
          </div>
        </div>
        {stats.excludedClaimCount > 0 && (
          <div className="player-stats-review-note" role="status">
            <b>{t.profile.awaitingReview(stats.excludedClaimCount)}</b>
            <span>{t.profile.awaitingReviewDesc}</span>
          </div>
        )}
        <div className="player-stats-empty">
          <MapPinned className="w-6 h-6 text-muted-foreground" />
          <h3>{t.profile.noConfirmedTitle}</h3>
          <p>{t.profile.noConfirmedDesc}</p>
          <Link href="/claim-match/demo" className="player-stats-cta">{t.profile.viewClaimFlow}</Link>
        </div>
        <UnavailableMetricTiles />
      </section>
    );
  }

  const showPerMatch = shouldShowPerMatchHeatmaps(stats.matches);
  const aggregateHeatmap = aggregatePitchHeatmaps(stats.matches);

  return (
    <section className="player-stats-section" aria-labelledby="player-stats-title">
      <div className="player-stats-heading">
        <div>
          <h2 id="player-stats-title">{t.profile.statsTitle}</h2>
          <p>{t.profile.statsSubtitle}</p>
        </div>
        {stats.excludedClaimCount > 0 && (
          <span className="player-stats-review-pill">{t.profile.awaitingReview(stats.excludedClaimCount)}</span>
        )}
      </div>

      {stats.excludedClaimCount > 0 && (
        <div className="player-stats-review-note" role="status">
          <b>{t.profile.awaitingReview(stats.excludedClaimCount)}</b>
          <span>{t.profile.awaitingReviewDesc}</span>
        </div>
      )}

      <div className="player-stats-total-grid">
        <StatCard value={stats.totals.totalMatchesClaimed} label={t.profile.matchesClaimed} />
        <StatCard value={stats.totals.totalMinutesPlayed} label={t.profile.totalMinutes} suffix=" min" />
        <div className="player-stats-total-card">
          <span>{t.profile.totalDistance}</span>
          <b>{formatDistance(stats.totals.totalDistanceMetres, t.profile.distanceUnavailable)}</b>
        </div>
      </div>

      <div className="player-stats-trust-grid">
        <div>
          <span>{t.profile.humanVouched}</span>
          <b>{formatMinutes(stats.totals.totalHumanVouchedSeconds / 60)} min</b>
        </div>
        <div>
          <span>{t.profile.inferred}</span>
          <b>{formatMinutes(stats.totals.totalInferredSeconds / 60)} min</b>
        </div>
      </div>

      {!showPerMatch && aggregateHeatmap && (
        <div className="player-stats-heatmap-card">
          <div className="player-stats-card-heading">
            <span><MapPinned className="w-4 h-4" />{t.profile.aggregateHeatmap}</span>
            <small>{t.profile.pitchCoordinates}</small>
          </div>
          <p>{t.profile.aggregateHeatmapDesc}</p>
          <PlayerStatsHeatmap heatmap={aggregateHeatmap} label={t.profile.heatmap} />
        </div>
      )}

      {showPerMatch && (
        <p className="player-stats-coordinate-note">{t.profile.perMatchHeatmapDesc}</p>
      )}

      <div className="player-stats-match-list">
        {stats.matches.map((match) => (
          <PlayerMatchStatsRow
            key={match.recordingId}
            match={match}
            locale={locale}
            showHeatmap={showPerMatch}
          />
        ))}
      </div>

      <UnavailableMetricTiles />
    </section>
  );
}

function PlayerMatchStatsRow({
  match,
  locale,
  showHeatmap,
}: {
  match: PublicPlayerMatchStats;
  locale: "en" | "ar";
  showHeatmap: boolean;
}) {
  const { t } = useTranslation();
  const date = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    dateStyle: "medium",
  }).format(new Date(`${match.date}T12:00:00`));

  return (
    <article className="player-stats-match">
      <div className="player-stats-match-heading">
        <div>
          <h3>{match.title}</h3>
          <span>{t.profile.matchDate(date)}</span>
        </div>
        <strong>{formatMinutes(match.minutesPlayed)} min</strong>
      </div>
      <div className="player-stats-match-metrics">
        <div>
          <span>{t.profile.minutes}</span>
          <b>{formatMinutes(match.minutesPlayed)} min</b>
        </div>
        <div>
          <span>{t.profile.distance}</span>
          <b>{formatDistance(match.distanceMetres, t.profile.distanceUnavailable)}</b>
          {match.distanceMetres === null && <small>{t.profile.matchUnavailableDistance}</small>}
        </div>
        <div>
          <span>{t.profile.humanVouched}</span>
          <b>{formatMinutes(match.humanVouchedSeconds / 60)} min</b>
        </div>
        <div>
          <span>{t.profile.inferred}</span>
          <b>{formatMinutes(match.inferredSeconds / 60)} min</b>
        </div>
      </div>
      {match.offPitchSeconds > 0 && (
        <p className="player-stats-off-pitch">
          {t.profile.offPitch(match.offPitchSeconds / 60)}
        </p>
      )}
      {showHeatmap && (
        <div className="player-stats-match-heatmap">
          <div className="player-stats-card-heading">
            <span><MapPinned className="w-4 h-4" />{t.profile.heatmap}</span>
            <small>{match.heatmap.coordinateSpace === "pitch" ? t.profile.pitchCoordinates : t.profile.cameraCoordinates}</small>
          </div>
          <PlayerStatsHeatmap heatmap={match.heatmap} label={t.profile.heatmap} />
        </div>
      )}
    </article>
  );
}

function PlayerStatsHeatmap({ heatmap, label }: { heatmap: PublicPlayerHeatmap; label: string }) {
  return (
    <div
      className="player-stats-heatmap"
      role="img"
      aria-label={`${label} (${heatmap.coordinateSpace})`}
    >
      {heatmap.cells.map((cell) => (
        <span
          className="player-stats-heatmap-cell bg-primary"
          key={`${cell.x}:${cell.y}`}
          style={{
            gridColumn: Math.min(12, Math.max(1, Math.floor(cell.x * 12) + 1)),
            gridRow: Math.min(8, Math.max(1, Math.floor(cell.y * 8) + 1)),
            opacity: Math.max(0.12, Math.min(1, cell.weight)),
          }}
        />
      ))}
      <span className="player-stats-heatmap-midline" />
      <span className="player-stats-heatmap-circle" />
    </div>
  );
}

function UnavailableMetricTiles() {
  const { t } = useTranslation();
  const metrics = [
    t.profile.touches,
    t.profile.passes,
    t.profile.shots,
    t.profile.dribbles,
    t.profile.topSpeed,
  ];
  return (
    <div className="player-stats-unavailable-grid">
      {metrics.map((label) => (
        <div className="player-stats-unavailable-tile" key={label}>
          <span>{label}</span>
          <b>{t.profile.unavailable}</b>
          <small>{t.profile.ballTrackingUnavailable}</small>
        </div>
      ))}
    </div>
  );
}

function formatMinutes(value: number): string {
  return value.toFixed(1);
}

function StatCard({ value, label, icon, suffix = "" }: { value: number; label: string; icon?: React.ReactNode; suffix?: string }) {
  return (
    <div className="p-3 flex flex-col items-center gap-1">
      <div className="text-muted-foreground">{icon}</div>
      <span className="text-xl font-bold">{typeof value === "number" && !Number.isInteger(value) ? value.toFixed(1) : value}{suffix}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
