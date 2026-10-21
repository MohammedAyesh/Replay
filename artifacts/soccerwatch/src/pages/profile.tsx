import { useRoute, useLocation, Link } from "wouter";
import { useMemo, useRef, useState } from "react";
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
  PublicPlayerMeasuredMatch,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Users, UserCheck, Video, UserMinus, BellPlus, Crown, Target, ChevronDown, Flame, Share2, Play, Edit3, Sparkles, Gauge, Footprints, Crosshair, CircleDot, RotateCw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { FriendButton } from "@/components/friends/FriendButton";
import {
  aggregatePitchHeatmaps,
  attachMeasured,
  measuredTiles,
  shouldShowEmptyStatsCta,
  shouldShowPerMatchHeatmaps,
} from "@/lib/player-stats";
import { CLAIM_YOUR_MATCH_ENABLED } from "@/lib/feature-flags";
import { SafetyMenu } from "@/components/safety/SafetyMenu";
import { StatsBetaNote } from "@/components/match/StatsBeta";
import { useMyBlocks, useUnblockUser, type BlockedPlayer } from "@/lib/safety-api";
import { useSafetyCopy } from "@/i18n/safety-strings";
import { getGetUserPortfolioQueryKey, useGetUserPortfolio, useUpdateUserPortfolio, type PortfolioView, type PortfolioClip } from "@workspace/api-client-react";
import { portfolioFromApi, portfolioToUpdateInput, positionLabelKey, type PortfolioState } from "@/features/portfolio/model";
import { PortfolioEditor, PortfolioClipViewer, PortfolioFeatureStyles, useStoryLinkCopy } from "@/features/portfolio/page";
import { AnimatePresence } from "framer-motion";

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
  const [, playerParams] = useRoute("/players/:id");
  const [, portfolioParams] = useRoute("/portfolio/:id");
  const userId = parseInt(playerParams?.id ?? portfolioParams?.id ?? "0", 10);
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
    query: { enabled: Boolean(profile.id), queryKey: getGetPublicPlayerStatsQueryKey(profile.id) },
  });
  const polling = useRef({ dataUpdatedAt: 0, intervalMs: 3_000 });
  const portfolioQuery = useGetUserPortfolio(profile.id, { query: {
    enabled: Boolean(profile.id),
    queryKey: getGetUserPortfolioQueryKey(profile.id),
    retry: false,
    refetchInterval: (query) => {
      const processing = query.state.data?.clips.some((clip) => clip.playbackStatus === "processing") ?? false;
      if (!processing) { polling.current = { dataUpdatedAt: 0, intervalMs: 3_000 }; return false; }
      const updatedAt = query.state.dataUpdatedAt;
      if (updatedAt > 0 && updatedAt !== polling.current.dataUpdatedAt) {
        if (polling.current.dataUpdatedAt > 0) polling.current.intervalMs = Math.min(polling.current.intervalMs * 2, 30_000);
        polling.current.dataUpdatedAt = updatedAt;
      }
      return polling.current.intervalMs;
    },
  } });
  const portfolio = useMemo(() => portfolioQuery.data ? portfolioFromApi(portfolioQuery.data) : null, [portfolioQuery.data]);
  const updatePortfolio = useUpdateUserPortfolio();
  const [editorOpen, setEditorOpen] = useState(false);
  const [activeClip, setActiveClip] = useState<PortfolioClip | null>(null);
  const [allClips, setAllClips] = useState(false);
  const { copyState, copyStoryLink } = useStoryLinkCopy();
  const followMutation = useFollowUser();
  const unfollowMutation = useUnfollowUser();
  const isOwnProfile = !isGuest && user?.id === profile.id;
  const blockedByViewer = myBlocks.some((row) => row.userId === profile.id);
  const handleFollow = () => {
    if (isGuest) { toast({ title: t.profile.signInToFollow, description: t.profile.signInToFollowDesc }); return; }
    const following = !profile.isFollowing;
    const mutation = following ? followMutation : unfollowMutation;
    mutation.mutate({ id: profile.id }, {
      onSuccess: (data) => queryClient.setQueryData(getProfileQueryKey(profile.id), (old: PublicProfile | undefined) =>
        old ? { ...old, isFollowing: following, followerCount: data.followerCount } : old),
      onError: () => toast({ title: t.profile.followFailed, variant: "destructive" }),
    });
  };
  const blockedByReplay = apiErrorReason(replayProfile.error) === "blocked";
  if (blockedByReplay) return <BlockedProfileNotice userId={profile.id} isMyBlock={blockedByViewer} />;
  const name = portfolio?.name || profile.name;
  const position = portfolio?.position || profile.position || "";
  const positionKey = positionLabelKey(position);
  const translatedPosition = t.profile.positions[positionKey];
  const statsReady = Boolean(playerStats) && !statsLoading && !statsError;
  const totals = playerStats?.totals;
  const measured = playerStats?.measured?.totals;
  const totalDistance = totals?.totalDistanceMetres == null ? 0 : totals.totalDistanceMetres / 1000;
  const heatmap = playerStats && statsReady ? aggregatePitchHeatmaps(playerStats.matches) : null;
  const canEdit = Boolean(portfolio?.canEdit);
  const clips = portfolio?.clips ?? [];
  const share = () => void copyStoryLink();
  const fallbackValues = {
    speed: statsReady ? (measured?.topSpeedKmh ?? 0).toFixed(1) : "–",
    distance: statsReady ? totalDistance.toFixed(2) : "–",
    goals: statsReady ? String(measured?.goals ?? 0) : "–",
    passes: statsReady ? String(measured?.passesCompleted ?? 0) : "–",
    touches: statsReady ? String(measured?.touches ?? 0) : "–",
    dribbles: statsReady ? String(measured?.dribbles ?? totals?.dribbles?.total ?? 0) : "–",
  };
  const highlightCards = [
    { label: t.profile.topSpeed, value: fallbackValues.speed, unit: t.profile.kmh, note: statsReady ? t.profile.topSpeedBest(playerStats?.measured?.matches.length ?? 0) : "", color: "floodlight", icon: <Gauge /> },
    { label: t.profile.distance, value: fallbackValues.distance, unit: "km", note: "", color: "turf", icon: <Footprints /> },
    { label: t.profile.goals, value: fallbackValues.goals, unit: "", note: "", color: "violet", icon: <CircleDot /> },
    { label: t.profile.passes, value: fallbackValues.passes, unit: "", note: statsReady && measured?.passesTried != null ? t.profile.passesOf(measured.passesTried) : "", color: "turf", icon: <Crosshair /> },
    { label: t.profile.touches, value: fallbackValues.touches, unit: "", note: "", color: "violet", icon: <Target /> },
    { label: t.profile.dribbles, value: fallbackValues.dribbles, unit: "", note: statsReady && measured?.dribblesWon != null && measured.dribblesLost != null ? t.profile.dribblesWonLost(measured.dribblesWon, measured.dribblesLost) : "", color: "floodlight", icon: <RotateCw /> },
  ];
  const getClipDate = (title: string) => {
    const parsed = title.match(/^(?:cam\d+_)?(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2})$/i);
    if (!parsed) return null;
    const date = new Date(`${parsed[1]}T12:00:00`);
    return {
      day: new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { weekday: "long", day: "numeric", month: "short" }).format(date),
      time: parsed[2],
      camera: title.match(/^(cam\\d+)/i)?.[1] ?? "",
    };
  };

  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="player-page relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-void px-4 pb-28 pt-2 text-text no-scrollbar">
      <PortfolioFeatureStyles />
      <div className="sticky top-0 z-20 flex items-center gap-2 bg-void/95 pb-2 pt-safe backdrop-blur-md">
        <button data-testid="button-profile-back" type="button" onClick={() => history.back()} aria-label={locale === "ar" ? "رجوع" : "Back"} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-text active:scale-95">
          <ChevronLeft className="h-5 w-5 rtl:hidden" /><ChevronRight className="h-5 w-5 ltr:hidden" />
        </button>
        <span data-testid="text-profile-name" className="min-w-0 flex-1 truncate text-sm font-semibold text-muted-text" dir="auto">{name}</span>
        {!isGuest && user && !isOwnProfile && <SafetyMenu target={{ type: "user", id: profile.id, name }} onBlocked={() => window.history.length > 1 ? history.back() : setLocation("/matches")} />}
      </div>
      <main className="mx-auto w-full max-w-xl pb-safe">
        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="player-cover relative mt-1 h-[210px] overflow-hidden rounded-[22px] border border-line" aria-label={t.profile.wherePlays}>
          {heatmap ? <PlayerStatsHeatmap heatmap={heatmap} label={t.profile.heatmap} /> : <FallbackPitch position={positionKey} />}
          <div className="absolute inset-0 bg-gradient-to-t from-void via-void/10 to-transparent" />
          <span className="absolute inset-inline-start-3 top-3 inline-flex min-h-8 items-center gap-1.5 rounded-full border border-white/10 bg-void/75 px-2.5 text-xs font-bold backdrop-blur">
            <Flame className="h-3.5 w-3.5 text-floodlight" />{t.profile.wherePlays}
          </span>
        </motion.section>
        <section className="relative z-[1] -mt-[58px] flex flex-col items-center text-center">
          <ProfileFace userId={profile.id} name={name} photo={portfolio?.profilePhoto || replayProfile.data?.avatarUrl || null} size={112} />
          <h1 dir="auto" className="mt-2 max-w-full truncate font-display text-2xl font-extrabold">{name}</h1>
        </section>
        <section className="mt-3 grid grid-cols-3 overflow-hidden rounded-2xl border border-line bg-surface">
          <Fact label={t.portfolio.age} value={portfolio?.age ?? profile.age ?? "—"} numeric />
          <Fact label={t.profile.nation} value={portfolio?.nation || "—"} />
          <Fact label={t.profile.position} value={position ? translatedPosition : "—"} />
        </section>
        <div className="mt-3 flex items-center justify-center gap-5">
          <ProfileCount icon={<Video />} value={profile.clipCount} label={t.profile.clips} />
          <ProfileCount icon={<Users />} value={profile.followerCount} label={t.profile.followers} />
          <ProfileCount icon={<UserCheck />} value={profile.followingCount} label={t.profile.following} />
        </div>
        <div className="mt-3 flex gap-2">
          {isOwnProfile ? canEdit && <button data-testid="button-edit-profile" type="button" onClick={() => setEditorOpen(true)} className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-floodlight px-3 text-sm font-extrabold text-void"><Edit3 className="h-4 w-4" />{t.profile.editPage}</button> : <>
            <div className="min-w-0 flex-1"><FriendButton userId={profile.id} name={name} /></div>
            <button data-testid="button-profile-follow" type="button" onClick={handleFollow} disabled={followMutation.isPending || unfollowMutation.isPending} className={cn("inline-flex min-h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl border px-2 text-sm font-bold disabled:opacity-50", profile.isFollowing ? "border-line bg-raised" : "border-violet/50 bg-violet/15")}>
              {profile.isFollowing ? <UserMinus className="h-4 w-4 text-[#B9A8FF]" /> : <BellPlus className="h-4 w-4 text-[#B9A8FF]" />}{profile.isFollowing ? t.profile.unfollow : t.profile.follow}
            </button>
          </>}
          <button data-testid="button-share-profile" type="button" onClick={share} aria-label={t.profile.sharePage} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-violet"><Share2 className="h-5 w-5" /></button>
        </div>
        <p className="min-h-5 pt-1 text-center text-xs text-turf" role="status" aria-live="polite">{copyState === "copied" ? t.profile.linkCopied : copyState === "failed" ? t.profile.linkCopyFailed : ""}</p>
        <section className="mt-4" aria-labelledby="profile-highlights">
          <h2 id="profile-highlights" className="mb-2 flex items-center gap-2 font-display text-xl font-extrabold">{t.profile.highlights}<span className="ms-auto"><StatsBetaPill /></span></h2>
          {statsError && <p role="status" className="mb-2 text-xs text-muted-text">{t.profile.statsLoadFailed}</p>}
          <div className="flex snap-x gap-2.5 overflow-x-auto pb-2 no-scrollbar">
            {highlightCards.map((card) => <article key={card.label} data-testid={`card-highlight-${card.label}`} className={`player-highlight is-${card.color} min-h-[128px] w-[132px] shrink-0 snap-start rounded-xl border border-line bg-surface p-3`}>
              <div className="flex items-center justify-between text-muted-text">{card.icon}<span className="text-[10px]">{card.unit}</span></div>
              <bdi dir="ltr" className="mt-2 block font-display text-[27px] font-bold leading-none tabular-nums">{card.value}</bdi>
              <strong className="mt-1 block truncate text-xs">{card.label}</strong>
              <small className="mt-1 block min-h-4 truncate text-[9px] text-muted-text">{card.note}</small>
            </article>)}
          </div>
          <StatsBetaNote className="mt-1" />
        </section>
        <section className="mt-6" aria-labelledby="profile-clips">
          <div className="mb-2 flex items-center justify-between"><h2 id="profile-clips" className="font-display text-xl font-extrabold">{t.profile.clipsHeading}</h2>
            {clips.length > 4 && <button data-testid="button-all-clips" type="button" onClick={() => setAllClips((value) => !value)} aria-expanded={allClips} className="min-h-11 px-3 text-sm font-bold text-violet">{allClips ? t.profile.showFewer : t.profile.all}</button>}
          </div>
          {portfolioQuery.isLoading ? <div className="grid grid-cols-2 gap-2">{[1, 2].map((n) => <div key={n} className="aspect-video animate-pulse rounded-xl bg-raised" />)}</div> : clips.length ? <div className="grid grid-cols-2 gap-2.5">
            {(allClips ? clips : clips.slice(0, 4)).map((clip, index) => {
              const caption = getClipDate(clip.title);
              const available = clip.playbackStatus === "ready" && Boolean(clip.playbackUrl);
              return <button data-testid={`button-open-clip-${clip.id}`} key={clip.id} type="button" onClick={() => setActiveClip(clip)} className="group min-w-0 overflow-hidden rounded-xl border border-line bg-surface text-start">
                <span className="relative block aspect-video overflow-hidden bg-raised">
                  {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center bg-gradient-to-br from-[#173B3E] to-raised font-display text-3xl font-bold text-turf">R</div>}
                  <span className="absolute inset-0 bg-void/15" /><span className="absolute inset-0 m-auto flex h-10 w-10 items-center justify-center rounded-full bg-violet/90 text-white"><Play className="h-4 w-4 fill-current" /></span>
                  <bdi dir="ltr" className="absolute inset-inline-start-2 top-2 rounded bg-void/80 px-1.5 py-0.5 font-display text-xs font-bold">{String(index + 1).padStart(2, "0")}</bdi>
                </span>
                <span className="block min-h-[48px] p-2">
                  {caption ? <><span className="block truncate text-[11px] font-bold">{caption.day}</span><span dir="ltr" className="block truncate text-[10px] text-muted-text">{caption.time}{caption.camera ? ` · ${caption.camera}` : ""}</span></>
                    : <span dir="auto" className="block truncate text-[11px] font-bold">{clip.title}</span>}
                  {!available && <span className="mt-0.5 block truncate text-[9px] text-muted-text">{clip.playbackStatus === "expired" ? t.portfolio.clipExpired : clip.playbackStatus === "processing" ? t.portfolio.clipProcessing : t.portfolio.videoUnavailable}</span>}
                </span>
              </button>;
            })}
          </div> : <EmptyPortfolio text={isOwnProfile ? t.profile.noClipsOwn : t.profile.noClipsOther} button={isOwnProfile ? t.profile.goToClips : undefined} onClick={() => setLocation("/my-clips")} />}
        </section>
        <section className="mt-6" aria-labelledby="profile-career">
          <div className="mb-2 flex items-center justify-between"><h2 id="profile-career" className="font-display text-xl font-extrabold">{t.profile.career}</h2></div>
          {portfolioQuery.isLoading ? <div className="h-20 animate-pulse rounded-xl bg-raised" /> : portfolio?.history.length ? <div className="grid gap-2">
            {portfolio.history.map((item) => <article key={item.editorId} className={`flex min-h-[72px] items-center gap-3 rounded-xl border border-line border-s-[3px] ${item.current ? "border-s-floodlight" : "border-s-turf"} bg-surface px-3 py-2`}>
              <div className="min-w-0 flex-1"><h3 dir="auto" className="truncate font-display text-lg font-bold">{item.academy}</h3><p dir="auto" className="truncate text-xs text-muted-text">{item.role === "firstTeam" ? t.portfolio.roles.firstTeam : item.role === "developmentSquad" ? t.portfolio.roles.developmentSquad : item.role === "academyPlayer" ? t.portfolio.roles.academyPlayer : item.role}</p></div>
              <span className="shrink-0 text-end">{item.current ? <b className="rounded-full bg-turf/15 px-2.5 py-1 text-xs font-bold text-turf">{t.profile.currentTeam}</b> : <bdi dir="ltr" className="font-display text-sm font-bold">{item.startYear} – {item.endYear ?? "—"}</bdi>}</span>
            </article>)}
          </div> : <EmptyPortfolio text={isOwnProfile ? t.profile.noCareerOwn : t.profile.noCareerOther} button={isOwnProfile && canEdit ? t.profile.editPage : undefined} onClick={() => setEditorOpen(true)} />}
        </section>
        <MatchRecord userId={profile.id} ownProfile={isOwnProfile} />
        <PlayerStatsSection stats={playerStats} loading={statsLoading} error={statsError} locale={locale} ownProfile={isOwnProfile} canClaim={CLAIM_YOUR_MATCH_ENABLED && shouldShowEmptyStatsCta(profile.id, user?.id, isGuest)} />
        <section className="my-6 rounded-2xl border border-turf/40 bg-surface px-5 py-6 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-floodlight" />
          <h2 className="mt-2 font-display text-2xl font-extrabold">{t.portfolio.verifiedOnFilm}</h2>
          <p className="mt-2 text-sm text-muted-text">{t.profile.closingLine}</p>
          <button data-testid="button-copy-profile-link" type="button" onClick={share} className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-turf px-4 text-sm font-bold text-turf"><Share2 className="h-4 w-4" />{t.profile.copyPageLink}</button>
          <p className="mt-2 min-h-5 text-xs text-turf" role="status" aria-live="polite">{copyState === "copied" ? t.profile.linkCopied : copyState === "failed" ? t.profile.linkCopyFailed : ""}</p>
        </section>
      </main>
      <AnimatePresence>{activeClip && <PortfolioClipViewer clip={activeClip} onClose={() => setActiveClip(null)} />}</AnimatePresence>
      <AnimatePresence>{editorOpen && portfolio && <PortfolioEditor value={portfolio} clips={clips} onClose={() => setEditorOpen(false)}
        onClipRemoved={(clipId) => {
          queryClient.setQueryData<PortfolioView | undefined>(getGetUserPortfolioQueryKey(profile.id), (current) => current ? { ...current, clips: current.clips.filter((clip) => clip.id !== clipId) } : current);
          void queryClient.invalidateQueries({ queryKey: getGetUserPortfolioQueryKey(profile.id) });
        }}
        onSave={async (next: PortfolioState) => {
          const saved = await updatePortfolio.mutateAsync({ id: profile.id, data: portfolioToUpdateInput(next) });
          queryClient.setQueryData(getGetUserPortfolioQueryKey(profile.id), saved);
          setEditorOpen(false);
        }} />}</AnimatePresence>
    </div>
  );
}

function StatsBetaPill() {
  const { t } = useTranslation();
  return <span className="inline-flex items-center rounded-full border border-floodlight/40 bg-floodlight/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-floodlight">{t.profile.beta}</span>;
}

function Fact({ label, value, numeric = false }: { label: string; value: string | number; numeric?: boolean }) {
  return <div className="min-w-0 border-s border-line px-2 py-2.5 text-center first:border-s-0"><span className="block truncate text-[10px] text-muted-text">{label}</span><bdi dir={numeric ? "ltr" : "auto"} className={cn("mt-1 block truncate text-xs font-bold", numeric && "font-display tabular-nums")}>{value}</bdi></div>;
}

function EmptyPortfolio({ text, button, onClick }: { text: string; button?: string; onClick: () => void }) {
  return <div className="rounded-2xl border border-dashed border-line bg-surface px-4 py-5 text-center"><p className="text-sm text-muted-text">{text}</p>{button && <button type="button" onClick={onClick} className="mt-3 min-h-11 rounded-full bg-floodlight px-4 text-sm font-extrabold text-void">{button}</button>}</div>;
}

function FallbackPitch({ position }: { position: ReturnType<typeof positionLabelKey> }) {
  const dots: Record<ReturnType<typeof positionLabelKey>, { x: number; y: number }> = { goalkeeper: { x: 8, y: 50 }, defender: { x: 28, y: 50 }, midfielder: { x: 50, y: 50 }, forward: { x: 76, y: 50 } };
  const point = dots[position];
  return <svg viewBox="0 0 400 210" className="h-full w-full bg-[#10292c]" aria-hidden="true">
    <defs><radialGradient id="cover-dot"><stop stopColor="#D4FF4F" stopOpacity=".95" /><stop offset="1" stopColor="#D4FF4F" stopOpacity="0" /></radialGradient></defs>
    <g fill="none" stroke="#d8efdf" strokeOpacity=".3" strokeWidth="1.5"><rect x="16" y="14" width="368" height="182" rx="8" /><line x1="200" y1="14" x2="200" y2="196" /><circle cx="200" cy="105" r="28" /><rect x="16" y="58" width="52" height="94" /><rect x="332" y="58" width="52" height="94" /></g>
    <circle cx={point.x * 4} cy={point.y * 2.1} r="44" fill="url(#cover-dot)" /><circle cx={point.x * 4} cy={point.y * 2.1} r="6" fill="#D4FF4F" />
  </svg>;
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
  const passes = figures.find((item) => item.key === "passes");
  const distanceKm = figure("distance")?.value ?? (match.distanceMetres ?? 0) / 1000;
  const statCells = [
    [t.profile.distance, `${distanceKm.toFixed(2)} km`],
    [t.profile.topSpeed, `${(figure("topSpeed")?.value ?? 0).toFixed(1)} ${t.profile.kmh}`],
    [t.profile.goals, String(figure("goals")?.value ?? 0)],
    [t.profile.shots, String(figure("shots")?.value ?? 0)],
    [t.profile.passes, passes?.key === "passes" ? (passes.tried === null ? String(passes.value) : t.profile.passesOf(passes.tried)) : "0"],
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

/** Measured matches with no claimed recording on the page: their figures, one row each. */
function OtherMeasuredMatches({ matches, locale, titled }: { matches: PublicPlayerMeasuredMatch[]; locale: "en" | "ar"; titled: boolean }) {
  const { t } = useTranslation();
  const text = useMeasuredText();
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
              const shown = text(tile, null);
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

function PitchBackdrop() {
  return (
    <svg aria-hidden="true" viewBox="0 0 360 150" preserveAspectRatio="xMidYMid slice" className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.11]">
      <g fill="none" stroke="white" strokeWidth="1">
        <rect x="8" y="8" width="344" height="134" rx="7" />
        <line x1="180" y1="8" x2="180" y2="142" />
        <circle cx="180" cy="75" r="25" />
        <rect x="8" y="40" width="45" height="70" />
        <rect x="307" y="40" width="45" height="70" />
      </g>
    </svg>
  );
}

function ProfileCount({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-text">
      <span className="shrink-0 text-violet [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <bdi dir="ltr" className="font-display text-sm font-bold text-text">{value}</bdi>
      <span className="truncate">{label}</span>
    </div>
  );
}

function TotalLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line/70 pb-1.5 last:border-0 last:pb-0">
      <span className="min-w-0 text-xs leading-tight text-muted-text">{label}</span>
      <bdi dir="ltr" className="shrink-0 font-display text-sm font-bold tabular-nums">{value}</bdi>
    </div>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-raised px-2 py-2">
      <span className="truncate text-[10px] font-medium leading-tight text-muted-text">{label}</span>
      <bdi dir="ltr" className="truncate text-start font-display text-xs font-bold tabular-nums">{value}</bdi>
    </div>
  );
}

function MatchStat({ value, label, turf = false, crown = false }: { value: number | string; label: string; turf?: boolean; crown?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface px-2 py-2.5 text-center">
      <div className="flex items-center gap-1.5">
        {crown && <Crown className="h-3.5 w-3.5 text-floodlight" aria-hidden="true" />}
        <bdi dir="ltr" className={cn("font-display text-lg font-bold tabular-nums", turf && "text-turf")}>{value}</bdi>
      </div>
      <span className="truncate text-[10px] font-semibold text-muted-text">{label}</span>
    </div>
  );
}

function ProfileFace({ userId, name, photo, size = 84 }: { userId: number; name: string; photo?: string | null; size?: number }) {
  const { data } = useReplayProfile(userId);
  return (
    <div style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-turf to-[#7B5CFF] p-[3px]">
      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-[5px] border-void bg-raised font-display text-[30px] font-bold text-text">
      {photo || data?.avatarUrl ? (
        <img src={photo || data?.avatarUrl || ""} alt="" className="h-full w-full object-cover" />
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
