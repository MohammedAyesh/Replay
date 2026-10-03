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
import { ChevronLeft, ChevronRight, Users, UserCheck, Video, UserPlus, UserMinus, MapPinned } from "lucide-react";
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

  if (apiErrorReason(replayProfile.error) === "blocked") {
    return <BlockedProfileNotice userId={profile.id} isMyBlock={blockedByViewer} />;
  }

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

      <div className="px-5 py-8">
        {/* Avatar */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="flex flex-col items-center gap-4 mb-8"
        >
          <ProfileFace userId={profile.id} name={profile.name} />
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
            <div className="flex gap-3">
              <button
                onClick={handleFollow}
                disabled={isMutating}
                className={cn(
                  "min-h-11 flex-1 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-95",
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
              <div className="min-w-0 flex-1">
                <FriendButton userId={profile.id} name={profile.name} />
              </div>
            </div>
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

        <MatchRecord userId={profile.id} />

        <PlayerStatsSection
          stats={playerStats}
          loading={statsLoading}
          error={statsError}
          locale={locale}
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
  canClaim,
}: {
  stats: PublicPlayerStats | undefined;
  loading: boolean;
  error: boolean;
  locale: "en" | "ar";
  canClaim: boolean;
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
          {canClaim ? (
            <>
              <MapPinned className="w-6 h-6 text-muted-foreground" />
              <h3>{t.profile.noConfirmedTitle}</h3>
              <p>{t.profile.noConfirmedDesc}</p>
              <Link href="/claim/demo" className="player-stats-cta">{t.profile.viewClaimFlow}</Link>
            </>
          ) : (
            <p className="player-stats-neutral-empty">{t.profile.noConfirmedOther}</p>
          )}
        </div>
        <MeasuredTotalTiles measured={stats.measured ?? null} />
        <OtherMeasuredMatches matches={stats.measured?.matches ?? []} locale={locale} titled={false} />
      </section>
    );
  }

  const showPerMatch = shouldShowPerMatchHeatmaps(stats.matches);
  const aggregateHeatmap = aggregatePitchHeatmaps(stats.matches);
  // Each measured match sits beside the claimed recording it was measured on.
  const measured = attachMeasured(stats.matches, stats.measured?.matches ?? []);

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
      <StatsBetaNote />

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

      <MeasuredTotalTiles measured={stats.measured ?? null} fallbackDribbles={stats.totals.dribbles ?? null} />

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
            measured={measured.byRecording.get(match.recordingId) ?? null}
            locale={locale}
            showHeatmap={showPerMatch}
          />
        ))}
      </div>

      <OtherMeasuredMatches matches={measured.unattached} locale={locale} titled />
    </section>
  );
}

function PlayerMatchStatsRow({
  match,
  measured,
  locale,
  showHeatmap,
}: {
  match: PublicPlayerMatchStats;
  /** the match report's figures for this game, when Replay measured them */
  measured: PublicPlayerMeasuredMatch | null;
  locale: "en" | "ar";
  showHeatmap: boolean;
}) {
  const { t } = useTranslation();
  // Dribbles from the match report when it has them, so the two never disagree.
  const reportFigures = measuredTiles(measured);
  const showClaimDribbles = Boolean(match.dribbles) && !reportFigures.some((tile) => tile.key === "dribbles");
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
        {showClaimDribbles && match.dribbles && (
          <div>
            <span>{t.profile.dribbles}</span>
            <b>{match.dribbles.total}</b>
            <small>{t.profile.dribblesSplit(match.dribbles.succeeded, match.dribbles.failed)}</small>
          </div>
        )}
        {reportFigures.map((tile) => <MeasuredCell key={tile.key} tile={tile} />)}
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
    <div className="player-stats-match-list">
      {titled && <p className="player-stats-coordinate-note">{t.profile.otherMatches}</p>}
      {matches.map((match) => {
        const figures = measuredTiles(match, { distance: true });
        return (
          <article className="player-stats-match" key={match.matchId}>
            <div className="player-stats-match-heading">
              <div>
                <h3>{match.fieldName ?? t.profile.measuredTitle}</h3>
                <span>{t.profile.matchDate(format.format(new Date(`${match.date}T12:00:00`)))}</span>
              </div>
              {match.minutes !== null && <strong>{t.profile.onCameraMin(formatMinutes(match.minutes))}</strong>}
            </div>
            {figures.length > 0 && (
              <div className="player-stats-match-metrics">
                {figures.map((tile) => <MeasuredCell key={tile.key} tile={tile} />)}
              </div>
            )}
          </article>
        );
      })}
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


function ProfileFace({ userId, name }: { userId: number; name: string }) {
  const { data } = useReplayProfile(userId);
  return (
    <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-turf/50 bg-raised shadow-lg">
      {data?.avatarUrl ? (
        <img src={data.avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="font-display text-3xl font-bold text-text">{getInitials(name)}</span>
      )}
    </div>
  );
}

/** Matches played on Replay: record, man-of-the-match crowns, recent results. */
function MatchRecord({ userId }: { userId: number }) {
  const copy = useMatchCopy();
  const { data } = useReplayProfile(userId);
  if (!data || data.matchesPlayed === 0) return null;
  return (
    <section className="mt-8 rounded-2xl border border-line bg-surface p-4">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div><p className="font-mono text-3xl font-bold">{data.matchesPlayed}</p><p className="text-[11px] font-semibold uppercase text-muted-text">{copy.played}</p></div>
        <div><p className="font-mono text-3xl font-bold text-turf">{data.wins}</p><p className="text-[11px] font-semibold uppercase text-muted-text">{copy.wins}</p></div>
        <div><p className="flex items-center justify-center gap-1 font-mono text-3xl font-bold text-floodlight"><CrownIcon className="h-5 w-5" />{data.motmCount}</p><p className="text-[11px] font-semibold uppercase text-muted-text">{copy.motmShort}</p></div>
      </div>
      <ul className="mt-4 flex flex-col gap-2">
        {data.recent.slice(0, 6).map((m) => (
          <li key={m.code}>
            <Link href={`/m/${m.code}`} className="flex items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{m.field.name}</span>
                <span className="text-[11px] text-muted-text">{m.startLocal.slice(0, 10)}</span>
              </span>
              {m.motm && <CrownIcon className="h-4 w-4 text-floodlight" aria-label={copy.motm} />}
              {m.score && <span className="font-mono text-base font-bold" dir="ltr">{m.score.a}–{m.score.b}</span>}
              {m.score && m.team && <span className={m.won ? "text-[10px] font-bold text-turf" : "text-[10px] font-bold text-muted-text"}>{m.won ? copy.won : copy.lost}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
