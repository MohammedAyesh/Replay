import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  Clapperboard,
  Copy,
  Crown,
  Flag,
  Loader2,
  Lock,
  MapPin,
  Minus,
  Play,
  Plus,
  Share2,
  Shuffle,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { ClipPlayer, type ClipDraft } from "@/components/clip-player/ClipPlayer";
import { FieldPaymentPanel, PaymentPanel } from "@/components/match/PaymentPanel";
import {
  Countdown,
  PhaseChip,
  PitchBoard,
  PlayerAvatar,
  ScoreLine,
  SquadBar,
  StandingsTable,
  TEAM_SWATCHES,
  formatClock,
  formatDate,
  formatDay,
  splitDuration,
  useServerNow,
} from "@/components/match/bits";
import { useToast } from "@/hooks/use-toast";
import { useMatchCopy, type MatchStrings } from "@/i18n/match-strings";
import { useAuth } from "@/lib/auth";
import {
  MatchApiError,
  apiBase,
  calendarUrl,
  formatJod,
  shareOrCopy,
  useAutoTeams,
  useFlagMoment,
  useInvitePlayer,
  useJoinMatch,
  useMakeCaptain,
  useMatchClips,
  useMatchRoom,
  useRemovePlayer,
  useSetGames,
  useSetScore,
  useStatsPlan,
  useUnlockStats,
  useUpdatePlayer,
  useUpdateRoom,
  useVote,
  useCancelBooking,
  useCollectCash,
  usePayWith,
  whatsappLink,
  type JoinInput,
  type MatchPlayer,
  type MatchRoom,
  type TeamSide,
} from "@/lib/match-api";
import { cn } from "@/lib/utils";

const PENDING_KEY = "replay_pending_join";
type Tab = "overview" | "teams" | "var" | "clips" | "vote" | "stats";

function readPending(code: string): JoinInput | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code: string; input: JoinInput; at: number };
    if (parsed.code !== code || Date.now() - parsed.at > 60 * 60 * 1000) return null;
    return parsed.input;
  } catch {
    return null;
  }
}
function writePending(code: string, input: JoinInput | null) {
  try {
    if (input) sessionStorage.setItem(PENDING_KEY, JSON.stringify({ code, input, at: Date.now() }));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* private mode */
  }
}

export default function MatchPage() {
  const [, params] = useRoute("/m/:code");
  const code = (params?.code ?? "").toUpperCase();
  const search = useSearch();
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const inviteToken = query.get("i");
  const byParam = Number.parseInt(query.get("by") ?? "", 10);
  const captainToken = query.get("c");
  const copy = useMatchCopy();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { user, isGuest, isLoading: authLoading } = useAuth();
  const roomQuery = useMatchRoom(code, search);
  const realRoom = roomQuery.data;
  // Owners and captains can see the other phases of their match: ?preview=pre|live.
  const previewParam = query.get("preview");
  const preview: "pre" | "live" | null = realRoom && (realRoom.isOwner || realRoom.canManage)
    && (previewParam === "pre" || previewParam === "live") ? previewParam : null;
  const room = useMemo(() => (realRoom && preview ? previewRoom(realRoom, preview) : realRoom), [realRoom, preview]);
  const now = useServerNow(room?.serverNow);
  const join = useJoinMatch(code);
  const [tab, setTab] = useState<Tab | null>(null);
  const autoJoinDone = useRef(false);

  useEffect(() => {
    if (room) document.title = `${room.title || room.field.name} · Replay`;
  }, [room]);

  const joinInput = useCallback((rsvp: JoinInput["rsvp"]): JoinInput => ({
    rsvp,
    inviteToken: inviteToken || null,
    by: Number.isSafeInteger(byParam) ? byParam : null,
    captainToken: captainToken || null,
  }), [byParam, captainToken, inviteToken]);

  const doJoin = useCallback(async (input: JoinInput) => {
    try {
      await join.mutateAsync(input);
      writePending(code, null);
    } catch (error) {
      toast({ title: error instanceof MatchApiError ? error.message : copy.error, variant: "destructive" });
    }
  }, [code, copy.error, join, toast]);

  const onRsvp = (rsvp: JoinInput["rsvp"]) => {
    if (preview) {
      toast({ title: copy.previewBanner });
      return;
    }
    const input = joinInput(rsvp);
    if (!user || isGuest) {
      writePending(code, input);
      setLocation(`/sign-up?redirect_url=${encodeURIComponent(`/m/${code}${search ? `?${search}` : ""}`)}`);
      return;
    }
    void doJoin(input);
  };

  // Came back from sign-up with a pending RSVP: apply it once.
  useEffect(() => {
    if (autoJoinDone.current || authLoading || !user || isGuest || !room) return;
    const pending = readPending(code);
    autoJoinDone.current = true;
    if (pending && !room.me) void doJoin(pending);
  }, [authLoading, code, doJoin, isGuest, room, user]);

  // The captain link: take the armband as soon as the owner's link is opened by a signed-in player.
  useEffect(() => {
    if (!captainToken || !room || !user || isGuest || room.isCaptain || join.isPending) return;
    if (room.me?.rsvp === "in" && room.captain?.userId === user.id) return;
    void doJoin({ ...joinInput("in"), captainToken });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captainToken, room?.code, user?.id]);

  const tabs = useMemo<Tab[]>(() => {
    if (!room) return ["overview"];
    if (room.phase === "live") return ["var", "overview", "teams"];
    if (room.phase === "pre") return ["overview", "teams"];
    if (room.phase === "cancelled" || room.phase === "failed") return ["overview"];
    return room.stats.enabled ? ["overview", "clips", "vote", "teams", "stats"] : ["overview", "clips", "vote", "teams"];
  }, [room]);
  const activeTab: Tab = tab && tabs.includes(tab) ? tab : tabs[0];

  if (roomQuery.isLoading) {
    return <Shell><div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />{copy.loading}</div></Shell>;
  }
  if (!room) {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <p className="font-display text-2xl font-bold">{copy.notFound}</p>
          <p className="mt-2 text-sm text-muted-text">{copy.notFoundDesc}</p>
          <Link href="/home" className="mt-6 rounded-full bg-floodlight px-5 py-3 text-sm font-bold text-void">Replay</Link>
        </div>
      </Shell>
    );
  }

  const colors: Record<TeamSide, string> = { A: room.teams.A.color, B: room.teams.B.color, C: room.teams.C?.color ?? "#2FD8C4" };
  const names: Record<TeamSide, string> = {
    A: room.teams.A.name || copy.teamA, B: room.teams.B.name || copy.teamB, C: room.teams.C?.name || copy.teamC,
  };
  const shareUrl = room.myInviteUrl ?? room.url;
  const when = `${formatDay(room.startMs, copy.locale, now, copy)} ${formatClock(room.startMs, copy.locale)}`;
  const need = Math.max(0, room.counts.needed - room.counts.in);
  const inviteText = copy.inviteMessage(room.field.name, when, shareUrl, need);

  const onShare = async () => {
    const result = await shareOrCopy({ title: room.title || room.field.name, text: inviteText.replace(shareUrl, "").trim(), url: shareUrl });
    if (result === "copied") toast({ title: copy.copied });
    if (result === "failed") window.open(whatsappLink(inviteText), "_blank", "noopener");
  };

  return (
    <Shell>
      {preview && (
        <div className="sticky top-0 z-30 flex items-center gap-3 bg-violet px-4 py-2.5 text-sm font-semibold text-text">
          <span className="flex-1">{preview === "pre" ? copy.previewBanner : copy.previewLiveBanner}</span>
          <Link href={`/m/${room.code}`} className="shrink-0 rounded-full bg-void/30 px-3 py-1 text-xs font-bold">{copy.exitPreview}</Link>
        </div>
      )}
      <Hero room={room} copy={copy} now={now} colors={colors} names={names} onShare={onShare} />
      <div className="px-4">
        <RsvpCard room={room} copy={copy} onRsvp={onRsvp} busy={join.isPending} signedIn={Boolean(user) && !isGuest} />
      </div>

      {tabs.length > 1 && (
        <div className="sticky top-0 z-20 mt-4 border-b border-line bg-void/95 px-2 backdrop-blur">
          <div className="no-scrollbar flex gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "relative shrink-0 px-3.5 py-3 text-sm font-semibold transition-colors",
                  activeTab === t ? "text-text" : "text-muted-text",
                )}
              >
                {t === "var" && room.phase === "live" && <span className="me-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-live align-middle" />}
                {copy.tabs[t]}
                {activeTab === t && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-turf" />}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4 px-4 pb-16 pt-4">
        {activeTab === "overview" && (
          <Overview room={room} copy={copy} colors={colors} names={names} now={now} inviteText={inviteText} onShare={onShare} />
        )}
        {activeTab === "overview" && !preview && (room.isOwner || room.canManage) && (
          <div className="flex flex-wrap gap-2">
            {room.phase !== "pre" && (
              <Link href={`/m/${room.code}?preview=pre`} className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted-text">{copy.seePreMatch}</Link>
            )}
            {room.phase !== "live" && (
              <Link href={`/m/${room.code}?preview=live`} className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted-text">{copy.seeLive}</Link>
            )}
          </div>
        )}
        {activeTab === "teams" && <TeamsTab room={room} copy={copy} colors={colors} names={names} />}
        {activeTab === "var" && <VarTab room={room} copy={copy} preview={Boolean(preview)} />}
        {activeTab === "clips" && <ClipsTab room={room} copy={copy} />}
        {activeTab === "vote" && <VoteTab room={room} copy={copy} now={now} />}
        {activeTab === "stats" && <StatsTab room={room} copy={copy} />}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const copy = useMatchCopy();
  return (
    <main dir={copy.locale === "ar" ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto bg-void text-text">
      <div className="flex min-h-full flex-col">{children}</div>
    </main>
  );
}

// ---------------------------------------------------------------- hero

function Hero({ room, copy, now, colors, names, onShare }: {
  room: MatchRoom; copy: MatchStrings & { locale: "en" | "ar" }; now: number;
  colors: Record<TeamSide, string>; names: Record<TeamSide, string>; onShare: () => void;
}) {
  const [, setLocation] = useLocation();
  const post = ["processing", "ready", "expired"].includes(room.phase);
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0">
        {room.field.imageUrl ? (
          <img src={room.field.imageUrl} alt="" className="h-full w-full object-cover opacity-40" />
        ) : (
          <div className="h-full w-full" style={{ background: "radial-gradient(120% 90% at 80% 0%, rgba(47,216,196,.25), transparent 60%), radial-gradient(90% 80% at 0% 100%, rgba(123,92,255,.22), transparent 60%)" }} />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-void/40 via-void/70 to-void" />
      </div>
      <div className="relative px-4 pb-5 pt-4">
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => (window.history.length > 1 ? window.history.back() : setLocation("/home"))} aria-label={copy.back} className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface/80 backdrop-blur">
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
          </button>
          <div className="flex items-center gap-2">
            {room.phase === "pre" && (
              <a href={calendarUrl(room.code)} aria-label={copy.calendar} className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface/80 backdrop-blur">
                <CalendarPlus className="h-4 w-4" />
              </a>
            )}
            <button type="button" onClick={onShare} aria-label={copy.share} className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface/80 px-3.5 text-sm font-semibold backdrop-blur">
              <Share2 className="h-4 w-4" />{copy.share}
            </button>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2">
          <PhaseChip phase={room.phase} label={copy.phase[room.phase] ?? room.phase} />
          <span className="font-mono text-xs font-semibold tracking-[0.2em] text-muted-text">#{room.code}</span>
        </div>
        <h1 className="mt-2 font-display text-3xl font-bold leading-tight">{room.title || room.field.name}</h1>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-text">
          <MapPin className="h-3.5 w-3.5" />
          {room.title ? `${room.field.name} · ` : ""}{copy.startsAt(formatDay(room.startMs, copy.locale, now, copy), `${formatClock(room.startMs, copy.locale)}–${formatClock(room.endMs, copy.locale)}`)}
        </p>

        {room.phase === "pre" && (
          <div className="mt-5">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-turf">{copy.kickoffIn}</p>
            <Countdown targetMs={room.startMs} now={now} labels={copy} />
          </div>
        )}
        {post && (
          <div className="mt-6 rounded-2xl border border-line bg-surface/80 p-4 backdrop-blur">
            {room.teamCount === 3 && room.standings
              ? <StandingsTable rows={room.standings} colors={colors} names={names} leader={room.leader} labels={copy} compact />
              : <ScoreLine score={room.score} colors={colors} names={names} />}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- RSVP

function RsvpCard({ room, copy, onRsvp, busy, signedIn }: {
  room: MatchRoom; copy: MatchStrings & { locale: "en" | "ar" }; onRsvp: (r: JoinInput["rsvp"]) => void; busy: boolean; signedIn: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (room.phase === "cancelled" || room.phase === "failed" || room.phase === "expired") return null;
  const post = room.phase === "processing" || room.phase === "ready";
  const me = room.me;
  const inviter = room.invitedBy && !me ? room.invitedBy : null;

  if (me && !editing) {
    if (post) return null;
    const label = me.rsvp === "in" ? copy.youAreIn : me.rsvp === "maybe" ? copy.youAreMaybe : me.rsvp === "out" ? copy.youAreOut : null;
    if (!label) return <RsvpButtons copy={copy} onRsvp={onRsvp} busy={busy} />;
    return (
      <div className={cn("flex items-center gap-3 rounded-2xl border p-3", me.rsvp === "in" ? "border-turf/40 bg-turf/10" : "border-line bg-surface")}>
        {me.rsvp === "in" ? <Check className="h-5 w-5 text-turf" /> : <span className="h-2 w-2 rounded-full bg-violet" />}
        <span className="flex-1 text-sm font-bold">{label}{room.isCaptain ? ` · ${copy.captain}` : ""}</span>
        <button type="button" onClick={() => setEditing(true)} className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted-text">{copy.changeRsvp}</button>
      </div>
    );
  }
  if (post && !me) {
    // The link often arrives after the game: let players claim their place to get the footage, clips and vote.
    return (
      <div className="rounded-2xl border border-line bg-surface p-4">
        {inviter && <p className="mb-3 text-sm font-semibold">{copy.invitedYou(inviter.name)}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => onRsvp("in")}
          className={cn(
            "flex min-h-12 w-full items-center justify-center gap-2 rounded-full text-base font-bold disabled:opacity-60",
            // One primary action per screen: when the footage button is showing, this one steps back.
            room.footage.shareToken ? "border border-violet/60 text-violet" : "bg-floodlight text-void",
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{copy.iPlayed}
        </button>
        <p className="mt-2 text-center text-[11px] text-muted-text">{copy.iPlayedDesc}</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      {inviter && (
        <div className="mb-3 flex items-center gap-3">
          <PlayerAvatar name={inviter.name} avatarUrl={inviter.avatarUrl} size={36} />
          <p className="text-sm font-semibold">{room.personalInvite ? copy.invitedYouFor(inviter.name) : copy.invitedYou(inviter.name)}</p>
        </div>
      )}
      <RsvpButtons copy={copy} onRsvp={(r) => { setEditing(false); onRsvp(r); }} busy={busy} />
      {!signedIn && <p className="mt-2 text-center text-[11px] text-muted-text">{copy.signInToJoinDesc}</p>}
    </div>
  );
}

function RsvpButtons({ copy, onRsvp, busy }: { copy: MatchStrings; onRsvp: (r: JoinInput["rsvp"]) => void; busy: boolean }) {
  return (
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={() => onRsvp("in")} className="flex min-h-12 flex-[2] items-center justify-center gap-2 rounded-full bg-floodlight px-4 text-base font-bold text-void disabled:opacity-60">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{copy.imIn}
      </button>
      <button type="button" disabled={busy} onClick={() => onRsvp("maybe")} className="min-h-12 flex-1 rounded-full border border-violet/60 px-3 text-sm font-semibold text-violet disabled:opacity-60">{copy.maybe}</button>
      <button type="button" disabled={busy} onClick={() => onRsvp("out")} className="min-h-12 flex-1 rounded-full border border-line px-3 text-sm font-semibold text-muted-text disabled:opacity-60">{copy.cantMake}</button>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ room, copy, colors, names, now, inviteText, onShare }: {
  room: MatchRoom; copy: MatchStrings & { locale: "en" | "ar" }; colors: Record<TeamSide, string>; names: Record<TeamSide, string>;
  now: number; inviteText: string; onShare: () => void;
}) {
  const post = ["processing", "ready", "expired"].includes(room.phase);
  return (
    <>
      {room.booking && <BookingPaymentCard room={room} copy={copy} />}
      {room.phase === "cancelled" && <Card><p className="font-bold">{copy.phase.cancelled}</p></Card>}
      {room.phase === "failed" && <Card><p className="font-bold">{copy.phase.failed}</p></Card>}
      {post && <FootageCard room={room} copy={copy} />}
      {post && room.canManage && <ScoreEditor room={room} copy={copy} colors={colors} names={names} />}
      {post && room.vote.winners.length > 0 && <MotmBanner room={room} copy={copy} />}
      {post && room.vote.open && room.isMember && room.vote.myVote === null && (
        <Card className="border-violet/40 bg-violet/10">
          <p className="text-sm font-bold">{copy.vote}</p>
          <p className="mt-1 text-xs text-muted-text">{copy.voteDesc}</p>
        </Card>
      )}
      {room.phase === "live" && room.isMember && (
        <Card className="border-live/40 bg-live/10">
          <p className="flex items-center gap-2 text-sm font-bold"><span className="h-2 w-2 animate-pulse rounded-full bg-live" />{copy.liveNow}</p>
          <p className="mt-1 text-xs text-muted-text">{copy.flagHint}</p>
        </Card>
      )}
      <Roster room={room} copy={copy} colors={colors} />
      {room.phase !== "cancelled" && room.phase !== "expired" && (room.isMember || room.canManage || room.me) && (
        <InviteCard room={room} copy={copy} inviteText={inviteText} onShare={onShare} />
      )}
      {room.captainUrl && !post && <CaptainLinkCard room={room} copy={copy} />}
      {room.canManage && !post && room.phase !== "cancelled" && <RoomEditor room={room} copy={copy} />}
      {room.field.location && (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${room.field.name} ${room.field.location}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-sm"
        >
          <MapPin className="h-4 w-4 text-turf" />
          <span className="flex-1"><span className="block font-semibold">{room.field.name}</span><span className="text-xs text-muted-text">{room.field.location}</span></span>
          <span className="text-xs font-semibold text-turf">{copy.directions}</span>
        </a>
      )}
    </>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-2xl border border-line bg-surface p-4", className)}>{children}</section>;
}

function Roster({ room, copy, colors }: { room: MatchRoom; copy: MatchStrings & { locale: "en" | "ar" }; colors: Record<TeamSide, string> }) {
  const remove = useRemovePlayer(room.code);
  const makeCaptain = useMakeCaptain(room.code);
  // Two taps to hand over the armband, so a stray tap can't do it.
  const [confirmCaptain, setConfirmCaptain] = useState<number | null>(null);
  const { toast } = useToast();
  const order: Record<string, number> = { in: 0, maybe: 1, invited: 2, out: 3 };
  const players = [...room.players].sort((a, b) => order[a.rsvp] - order[b.rsvp]);
  const visible = players.filter((p) => p.rsvp !== "out");
  const open = Math.max(0, room.counts.needed - room.counts.in);
  const captainId = room.captain?.userId ?? null;
  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold"><Users className="h-4 w-4 text-turf" />{copy.roster}</h2>
        <span className="font-mono text-lg font-bold tabular-nums">{copy.countIn(room.counts.in, room.counts.needed)}</span>
      </div>
      <div className="mt-2"><SquadBar inCount={room.counts.in} maybe={room.counts.maybe} needed={room.counts.needed} /></div>
      <p className="mt-1.5 text-xs text-muted-text">
        {open > 0 ? copy.spotsLeft(open) : copy.full}{room.counts.maybe ? ` · ${copy.maybes(room.counts.maybe)}` : ""}
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {visible.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2.5">
            <PlayerAvatar name={p.name} initials={p.initials} avatarUrl={p.avatarUrl} size={40} dashed={!p.signedUp} ring={p.team ? colors[p.team] : undefined} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                {p.name}{p.isMe ? " ·" : ""}
                {p.userId != null && p.userId === captainId && <span className="rounded bg-floodlight px-1 text-[10px] font-black text-void">{copy.captainBadge}</span>}
                {p.shirtNumber != null && <span className="font-mono text-xs text-muted-text">#{p.shirtNumber}</span>}
              </p>
              <p className="truncate text-[11px] text-muted-text">
                {!p.signedUp ? copy.notSignedUp : p.invitedBy ? copy.invitedYou(p.invitedBy.name) : ""}
              </p>
            </div>
            <RsvpDot rsvp={p.rsvp} copy={copy} />
            {room.canManage && p.signedUp && p.userId !== captainId && room.phase !== "cancelled" && (
              confirmCaptain === p.id ? (
                <button
                  type="button"
                  disabled={makeCaptain.isPending}
                  onClick={() => void makeCaptain.mutateAsync(p.id)
                    .then(() => { setConfirmCaptain(null); toast({ title: copy.captainNow(p.name) }); })
                    .catch((e) => toast({ title: e instanceof Error ? e.message : copy.error, variant: "destructive" }))}
                  className="flex h-8 items-center gap-1 rounded-full bg-floodlight px-2.5 text-[11px] font-bold text-void"
                  data-testid={`button-confirm-captain-${p.id}`}
                >
                  {makeCaptain.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Crown className="h-3 w-3" />}{copy.makeCaptain}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={copy.makeCaptain}
                  title={copy.makeCaptain}
                  onClick={() => setConfirmCaptain(p.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted-text hover:bg-raised hover:text-floodlight"
                  data-testid={`button-make-captain-${p.id}`}
                >
                  <Crown className="h-3.5 w-3.5" />
                </button>
              )
            )}
            {room.canManage && !p.isMe && room.phase === "pre" && (
              <button
                type="button"
                aria-label={copy.remove}
                onClick={() => void remove.mutateAsync(p.id).catch((e) => toast({ title: e instanceof Error ? e.message : copy.error, variant: "destructive" }))}
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted-text hover:bg-raised"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
        {Array.from({ length: Math.min(open, 4) }).map((_, i) => (
          <li key={`open-${i}`} className="flex items-center gap-3 py-2.5 opacity-60">
            <PlayerAvatar name="" initials="+" size={40} dashed />
            <span className="text-sm text-muted-text">{copy.openSpot}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RsvpDot({ rsvp, copy }: { rsvp: string; copy: MatchStrings }) {
  if (rsvp === "in") return <span className="rounded-full bg-turf/15 px-2 py-0.5 text-[10px] font-bold text-turf">{copy.imIn}</span>;
  if (rsvp === "maybe") return <span className="rounded-full bg-violet/15 px-2 py-0.5 text-[10px] font-bold text-violet">{copy.maybe}</span>;
  return <span className="rounded-full border border-dashed border-line px-2 py-0.5 text-[10px] font-semibold text-muted-text">…</span>;
}

function InviteCard({ room, copy, inviteText, onShare }: { room: MatchRoom; copy: MatchStrings; inviteText: string; onShare: () => void }) {
  const invite = useInvitePlayer(room.code);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [lastLink, setLastLink] = useState<{ name: string; url: string } | null>(null);
  const canInvite = room.isMember || room.canManage;
  const submit = async () => {
    if (!name.trim()) return;
    try {
      const result = await invite.mutateAsync({ displayName: name.trim(), phone: phone.trim() || null });
      setLastLink({ name: name.trim(), url: result.inviteUrl });
      setName("");
      setPhone("");
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : copy.error, variant: "destructive" });
    }
  };
  return (
    <Card>
      <h2 className="flex items-center gap-2 text-base font-bold"><UserPlus className="h-4 w-4 text-violet" />{copy.inviteFriends}</h2>
      <div className="mt-3 flex gap-2">
        <a href={whatsappLink(inviteText)} target="_blank" rel="noopener noreferrer" className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-violet/60 px-4 text-sm font-bold text-violet">
          {copy.inviteByWhatsapp}
        </a>
        <button type="button" onClick={onShare} aria-label={copy.share} className="flex h-11 w-11 items-center justify-center rounded-full border border-line"><Share2 className="h-4 w-4" /></button>
      </div>
      {canInvite && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} className="mt-3 text-xs font-semibold text-muted-text underline underline-offset-2">{copy.addPlaceholder}</button>
          {open && (
            <div className="mt-2 flex flex-col gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={copy.placeholderName} className="min-h-11 rounded-xl border border-line bg-void px-3 text-sm outline-none focus:border-turf" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={24} placeholder={copy.placeholderPhone} className="min-h-11 rounded-xl border border-line bg-void px-3 text-sm outline-none focus:border-turf" dir="ltr" />
              <button type="button" disabled={!name.trim() || invite.isPending} onClick={() => void submit()} className="min-h-11 rounded-full border border-violet/60 text-sm font-bold text-violet disabled:opacity-50">{copy.add}</button>
            </div>
          )}
          {lastLink && (
            <div className="mt-3 rounded-xl border border-line bg-raised p-3">
              <p className="text-xs font-semibold">{copy.personalLink} · {lastLink.name}</p>
              <a href={whatsappLink(`${copy.invitedYou("")} ${lastLink.url}`.trim())} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex text-xs font-bold text-violet underline">{copy.sendPersonal}</a>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function CaptainLinkCard({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const { toast } = useToast();
  if (!room.captainUrl) return null;
  const text = `${room.title || room.field.name}: ${copy.captainLinkDesc} ${room.captainUrl}`;
  return (
    <Card>
      <h2 className="flex items-center gap-2 text-sm font-bold"><Crown className="h-4 w-4 text-floodlight" />{copy.captainLinkTitle}</h2>
      <p className="mt-1 text-xs text-muted-text">{copy.captainLinkDesc}</p>
      <div className="mt-3 flex gap-2">
        <a href={whatsappLink(text)} target="_blank" rel="noopener noreferrer" className="flex min-h-10 flex-1 items-center justify-center rounded-full border border-violet/60 text-xs font-bold text-violet">{copy.sendToCaptain}</a>
        <button type="button" onClick={() => void navigator.clipboard.writeText(room.captainUrl!).then(() => toast({ title: copy.copied }))} className="flex h-10 w-10 items-center justify-center rounded-full border border-line" aria-label={copy.copyRef}><Copy className="h-4 w-4" /></button>
      </div>
    </Card>
  );
}

function RoomEditor({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const update = useUpdateRoom(room.code);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(room.title ?? "");
  const [a, setA] = useState(room.teams.A.name ?? "");
  const [b, setB] = useState(room.teams.B.name ?? "");
  const [c, setC] = useState(room.teams.C?.name ?? "");
  const [teamCount, setTeamCount] = useState<2 | 3>(room.teamCount);
  const [pps, setPps] = useState(room.playersPerSide);
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="self-start text-xs font-semibold text-muted-text underline underline-offset-2">{copy.editMatch}</button>;
  }
  return (
    <Card>
      <label className="block text-xs text-muted-text">{copy.matchTitle}
        <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-void px-3 text-sm text-text outline-none focus:border-turf" />
      </label>
      <p className="mt-3 text-xs text-muted-text">{copy.teamNames}</p>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <input value={a} maxLength={30} placeholder={copy.teamA} onChange={(e) => setA(e.target.value)} className="min-h-11 rounded-xl border border-line bg-void px-3 text-sm outline-none focus:border-turf" />
        <input value={b} maxLength={30} placeholder={copy.teamB} onChange={(e) => setB(e.target.value)} className="min-h-11 rounded-xl border border-line bg-void px-3 text-sm outline-none focus:border-turf" />
        {teamCount === 3 && (
          <input value={c} maxLength={30} placeholder={copy.teamC} onChange={(e) => setC(e.target.value)} className="col-span-2 min-h-11 rounded-xl border border-line bg-void px-3 text-sm outline-none focus:border-turf" data-testid="input-team-c" />
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-text">{copy.teamCount}</span>
        <div className="flex rounded-full border border-line p-0.5" role="radiogroup" aria-label={copy.teamCount}>
          {([2, 3] as const).map((n) => (
            <button key={n} type="button" role="radio" aria-checked={teamCount === n} onClick={() => setTeamCount(n)}
              className={cn("min-h-9 rounded-full px-4 text-xs font-bold", teamCount === n ? "bg-turf text-void" : "text-muted-text")}
              data-testid={`button-team-count-${n}`}>
              {n === 2 ? copy.twoTeams : copy.threeTeams}
            </button>
          ))}
        </div>
      </div>
      {teamCount === 3 && <p className="mt-1.5 text-[11px] leading-4 text-muted-text">{copy.threeTeamsHint}</p>}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-text">{copy.format}</span>
        <Stepper value={pps} min={3} max={11} onChange={setPps} label={`${pps}v${pps}`} />
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={update.isPending} onClick={() => void update.mutateAsync({
          title: title.trim() || null, teamAName: a.trim() || null, teamBName: b.trim() || null,
          ...(teamCount === 3 ? { teamCName: c.trim() || null } : {}), teamCount, playersPerSide: pps,
        }).then(() => setOpen(false))} className="min-h-11 flex-1 rounded-full bg-floodlight text-sm font-bold text-void">{copy.save}</button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 flex-1 rounded-full border border-line text-sm font-semibold">{copy.cancel}</button>
      </div>
    </Card>
  );
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label?: string }) {
  return (
    <div className="flex items-center gap-2" dir="ltr">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} className="flex h-9 w-9 items-center justify-center rounded-full border border-line" aria-label="-"><Minus className="h-4 w-4" /></button>
      <span className="min-w-10 text-center font-mono text-xl font-bold tabular-nums">{label ?? value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} className="flex h-9 w-9 items-center justify-center rounded-full border border-line" aria-label="+"><Plus className="h-4 w-4" /></button>
    </div>
  );
}

// ---------------------------------------------------------------- after the whistle

function FootageCard({ room, copy }: { room: MatchRoom; copy: MatchStrings & { locale: "en" | "ar" } }) {
  if (room.phase === "expired") return <Card><p className="text-sm text-muted-text">{copy.footageExpired}</p></Card>;
  if (!room.footage.ready) {
    return (
      <Card>
        <p className="flex items-center gap-2 text-sm font-bold"><Loader2 className="h-4 w-4 animate-spin text-turf" />{copy.fullTime}</p>
        <p className="mt-1 text-xs text-muted-text">{copy.processingDesc}</p>
        {room.progress > 0 && room.progress < 100 && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised"><span className="block h-full bg-turf" style={{ width: `${room.progress}%` }} /></div>
        )}
      </Card>
    );
  }
  if (!room.footage.shareToken) return null;
  const href = `/w/${room.footage.shareToken}?m=${room.code}`;
  return (
    <Card className="border-turf/30">
      <p className="text-base font-bold">{copy.footageReady}</p>
      {room.footage.expiresAt && <p className="mt-0.5 text-xs text-muted-text">{copy.footageExpires(formatDate(Date.parse(room.footage.expiresAt), copy.locale))}</p>}
      <Link href={href} className="mt-3 flex min-h-12 items-center justify-center gap-2 rounded-full bg-floodlight text-base font-bold text-void">
        <Play className="h-4 w-4 fill-current" />{copy.watchFootage}
      </Link>
      {room.marks.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-muted-text">{copy.flags}</p>
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {room.marks.map((m) => (
              <Link key={m.id} href={`/w/${room.footage.shareToken}?m=${room.code}&t=${Math.max(0, Math.round((m.offsetSeconds ?? 0) - 8))}`} className="shrink-0 rounded-xl border border-turf/30 bg-turf/10 px-3 py-2 text-start">
                <span className="block text-xs font-bold text-turf">{copy.flagKinds[m.kind] ?? m.kind}</span>
                <span className="font-mono text-[11px] text-muted-text">{copy.atMinute(Math.max(0, Math.floor((m.offsetSeconds ?? 0) / 60)))}{m.byName ? ` · ${m.byName}` : ""}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function ScoreEditor({ room, copy, colors, names }: { room: MatchRoom; copy: MatchStrings; colors: Record<TeamSide, string>; names: Record<TeamSide, string> }) {
  const setScore = useSetScore(room.code);
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(room.score?.a ?? 0);
  const [b, setB] = useState(room.score?.b ?? 0);
  if (room.teamCount === 3) {
    // Three teams: the result is the table, built from the games.
    return (
      <Card>
        <p className="text-sm font-bold">{copy.games}</p>
        <p className="mt-1 text-xs text-muted-text">{copy.threeTeamsHint}</p>
        <GamesEditor room={room} copy={copy} names={names} colors={colors} startOpen />
      </Card>
    );
  }
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="min-h-11 rounded-full border border-line text-sm font-semibold">{room.score ? copy.score : copy.setScore}</button>;
  }
  return (
    <Card>
      <div className="flex items-center justify-around" dir="ltr">
        <div className="flex flex-col items-center gap-2"><span className="h-4 w-4 rounded-full" style={{ background: colors.A }} /><span className="text-xs text-muted-text">{names.A}</span><Stepper value={a} min={0} max={99} onChange={setA} /></div>
        <div className="flex flex-col items-center gap-2"><span className="h-4 w-4 rounded-full" style={{ background: colors.B }} /><span className="text-xs text-muted-text">{names.B}</span><Stepper value={b} min={0} max={99} onChange={setB} /></div>
      </div>
      <GamesEditor room={room} copy={copy} names={names} colors={colors} />
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={setScore.isPending} onClick={() => void setScore.mutateAsync({ scoreA: a, scoreB: b }).then(() => setOpen(false))} className="min-h-11 flex-1 rounded-full bg-floodlight text-sm font-bold text-void">{copy.saveScore}</button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 flex-1 rounded-full border border-line text-sm font-semibold">{copy.cancel}</button>
      </div>
    </Card>
  );
}

type GameDraft = { start: number; end: number; x: TeamSide; y: TeamSide; a: number; b: number };

/** Three teams, winner stays on: the winner plays the team that sat out. On a draw the newer team stays. */
function nextPair(prev: GameDraft | undefined, sides: TeamSide[]): [TeamSide, TeamSide] {
  if (sides.length < 3 || !prev) return ["A", "B"];
  const out = sides.find((t) => t !== prev.x && t !== prev.y) ?? "C";
  const stay = prev.a > prev.b ? prev.x : prev.y;
  return [stay, out];
}

function GamesEditor({ room, copy, names, colors, startOpen = false }: {
  room: MatchRoom; copy: MatchStrings; names: Record<TeamSide, string>; colors: Record<TeamSide, string>; startOpen?: boolean;
}) {
  const setGames = useSetGames(room.code);
  const { toast } = useToast();
  const sides: TeamSide[] = room.teamCount === 3 ? ["A", "B", "C"] : ["A", "B"];
  const total = Math.max(1, Math.round((room.endMs - room.startMs) / 60000));
  const [games, setLocal] = useState<GameDraft[]>(() => room.games.map((g) => ({
    start: Math.round(g.startOffsetSec / 60), end: Math.round(g.endOffsetSec / 60),
    x: g.teamX, y: g.teamY, a: g.scoreA ?? 0, b: g.scoreB ?? 0,
  })));
  const [open, setOpen] = useState(startOpen || room.games.length > 0);
  const edit = (i: number, patch: Partial<GameDraft>) => setLocal(games.map((g, j) => {
    if (j !== i) return g;
    const next = { ...g, ...patch };
    // Picking the team already on the other side swaps them rather than making a team play itself.
    if (patch.x && patch.x === g.y) next.y = g.x;
    if (patch.y && patch.y === g.x) next.x = g.y;
    return next;
  }));
  const addGame = () => {
    const last = games[games.length - 1];
    const start = last ? last.end : 0;
    const [x, y] = nextPair(last, sides);
    setLocal([...games, { start, end: Math.min(total, start + 15), x, y, a: 0, b: 0 }]);
  };
  if (!open) return <button type="button" onClick={() => { setOpen(true); addGame(); }} className="mt-4 text-xs font-semibold text-muted-text underline underline-offset-2">{copy.splitGames}</button>;
  const save = () => void setGames.mutateAsync(games.map((g) => ({
    startOffsetSec: g.start * 60, endOffsetSec: g.end * 60, teamX: g.x, teamY: g.y, scoreA: g.a, scoreB: g.b,
  })))
    .then(() => toast({ title: copy.saveGames }))
    .catch((e) => toast({ title: e instanceof Error ? e.message : copy.error, variant: "destructive" }));
  const teamPicker = (value: TeamSide, onPick: (t: TeamSide) => void, label: string) => sides.length === 2 ? (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-semibold">
      <span className="h-3 w-3 shrink-0 rounded-full border border-line" style={{ background: colors[value] }} />{names[value]}
    </span>
  ) : (
    <label className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="h-3 w-3 shrink-0 rounded-full border border-line" style={{ background: colors[value] }} />
      <select value={value} onChange={(e) => onPick(e.target.value as TeamSide)} aria-label={label}
        className="h-9 min-w-0 flex-1 truncate rounded-lg border border-line bg-void px-1.5 text-xs font-semibold">
        {sides.map((t) => <option key={t} value={t}>{names[t]}</option>)}
      </select>
    </label>
  );
  return (
    <div className={cn(!startOpen && "mt-4 border-t border-line pt-3")}>
      {!startOpen && <p className="text-xs font-semibold text-muted-text">{copy.games}</p>}
      {games.map((g, i) => (
        <div key={i} className="mt-3 rounded-xl border border-line bg-void/40 p-2" data-testid={`game-row-${i}`}>
          <div className="flex items-center gap-2 text-xs" dir="ltr">
            <span className="flex-1 font-semibold">{copy.gameN(i + 1)}</span>
            <input type="number" min={0} max={total} value={g.start} onChange={(e) => edit(i, { start: Number(e.target.value) })} className="h-8 w-14 rounded-lg border border-line bg-void px-2" aria-label="start minute" />
            <span>–</span>
            <input type="number" min={1} max={total + 10} value={g.end} onChange={(e) => edit(i, { end: Number(e.target.value) })} className="h-8 w-14 rounded-lg border border-line bg-void px-2" aria-label="end minute" />
            <span className="text-muted-text">min</span>
            <button type="button" onClick={() => setLocal(games.filter((_, j) => j !== i))} className="flex h-8 w-8 items-center justify-center text-muted-text" aria-label={copy.remove}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
          <div className="mt-2 flex items-center gap-2" dir="ltr">
            {teamPicker(g.x, (t) => edit(i, { x: t }), `${copy.gameN(i + 1)} · 1`)}
            <input type="number" min={0} max={99} value={g.a} onChange={(e) => edit(i, { a: Number(e.target.value) })} className="h-9 w-11 rounded-lg border border-line bg-void px-2 text-center font-mono" aria-label={`${names[g.x]} goals`} />
            <span className="text-xs text-muted-text">{copy.vs}</span>
            <input type="number" min={0} max={99} value={g.b} onChange={(e) => edit(i, { b: Number(e.target.value) })} className="h-9 w-11 rounded-lg border border-line bg-void px-2 text-center font-mono" aria-label={`${names[g.y]} goals`} />
            {teamPicker(g.y, (t) => edit(i, { y: t }), `${copy.gameN(i + 1)} · 2`)}
          </div>
        </div>
      ))}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={addGame} className="min-h-10 flex-1 rounded-full border border-line text-xs font-semibold">{copy.addGame}</button>
        <button type="button" disabled={setGames.isPending || (games.length === 0 && room.games.length === 0)} onClick={save} className="min-h-10 flex-1 rounded-full border border-violet/60 text-xs font-bold text-violet disabled:opacity-40">{copy.saveGames}</button>
      </div>
      {room.teamCount === 3 && room.standings && room.games.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <StandingsTable rows={room.standings} colors={colors} names={names} leader={room.leader} labels={copy} />
        </div>
      )}
    </div>
  );
}

function MotmBanner({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const winners = room.players.filter((p) => room.vote.winners.includes(p.id));
  return (
    <section className="relative overflow-hidden rounded-2xl border border-floodlight/40 p-4" style={{ background: "linear-gradient(135deg, rgba(212,255,79,.14), rgba(123,92,255,.14))" }}>
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-floodlight"><Crown className="h-3.5 w-3.5" />{copy.motm}</p>
      <div className="mt-3 flex flex-wrap gap-4">
        {winners.map((w) => (
          <div key={w.id} className="flex items-center gap-3">
            <PlayerAvatar name={w.name} initials={w.initials} avatarUrl={w.avatarUrl} size={52} ring="#D4FF4F" />
            <span className="font-display text-xl font-bold">{w.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- teams

function TeamsTab({ room, copy, colors, names }: { room: MatchRoom; copy: MatchStrings; colors: Record<TeamSide, string>; names: Record<TeamSide, string> }) {
  const auto = useAutoTeams(room.code);
  const updatePlayer = useUpdatePlayer(room.code);
  const updateRoom = useUpdateRoom(room.code);
  const [selected, setSelected] = useState<number | null>(null);
  const { toast } = useToast();
  const editable = room.canManage;
  const active = room.players.filter((p) => p.rsvp === "in" || p.rsvp === "maybe");
  const three = room.teamCount === 3;
  const waiting = three ? active.filter((p) => p.team === "C") : [];
  const bench = active.filter((p) => !p.team || (p.team !== "C" && p.slotX == null) || (p.team === "C" && !three));
  const moveToC = () => {
    if (selected == null) return;
    void updatePlayer.mutateAsync({ playerId: selected, team: "C", slotX: null, slotY: null })
      .then(() => setSelected(null))
      .catch((e) => toast({ title: e instanceof Error ? e.message : copy.error, variant: "destructive" }));
  };
  const place = (x: number, y: number) => {
    if (selected == null) return;
    const team: TeamSide = y >= 50 ? "A" : "B";
    void updatePlayer.mutateAsync({ playerId: selected, team, slotX: Math.round(x * 10) / 10, slotY: Math.round(y * 10) / 10 })
      .then(() => setSelected(null))
      .catch((e) => toast({ title: e instanceof Error ? e.message : copy.error, variant: "destructive" }));
  };
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <TeamLegend side="B" name={names.B} color={colors.B} editable={editable} onColor={(c) => void updateRoom.mutateAsync({ teamBColor: c })} />
        <TeamLegend side="A" name={names.A} color={colors.A} editable={editable} onColor={(c) => void updateRoom.mutateAsync({ teamAColor: c })} />
      </div>
      {active.some((p) => p.team) ? (
        <PitchBoard players={room.players} colors={colors} editable={editable} selectedId={selected} onSelect={setSelected} onPlace={place} captainUserId={room.captain?.userId ?? null} />
      ) : (
        <Card><p className="text-sm text-muted-text">{editable ? copy.noTeamsYet : copy.teamsLocked}</p></Card>
      )}
      {three && (
        <Card className="border-dashed">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <TeamLegend side="C" name={names.C} color={colors.C} editable={editable} onColor={(c) => void updateRoom.mutateAsync({ teamCColor: c })} />
            </div>
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-text">{copy.waitingTeam}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2" data-testid="team-c-list">
            {waiting.map((p) => (
              <button key={p.id} type="button" disabled={!editable} onClick={() => setSelected(selected === p.id ? null : p.id)} className={cn("flex items-center gap-2 rounded-full border px-2 py-1", selected === p.id ? "border-floodlight" : "border-line")}>
                <PlayerAvatar name={p.name} initials={p.initials} avatarUrl={p.avatarUrl} size={26} dashed={!p.signedUp} ring={colors.C} />
                <span className="text-xs font-semibold">{p.name}</span>
                {p.userId != null && p.userId === room.captain?.userId && <span className="rounded bg-floodlight px-1 text-[9px] font-black text-void">{copy.captainBadge}</span>}
              </button>
            ))}
            {editable && selected != null && !waiting.some((p) => p.id === selected) && (
              <button type="button" onClick={moveToC} className="min-h-9 rounded-full border border-dashed px-3 text-xs font-semibold" style={{ borderColor: colors.C, color: colors.C }}>
                {copy.moveTo(names.C)}
              </button>
            )}
          </div>
        </Card>
      )}
      {editable && (
        <>
          <p className="text-center text-[11px] text-muted-text">{copy.dragHint}</p>
          <div className="flex gap-2">
            <button type="button" disabled={auto.isPending || active.length < 2} onClick={() => void auto.mutateAsync(false)} className="min-h-12 flex-[2] rounded-full bg-floodlight text-sm font-bold text-void disabled:opacity-50">{copy.autoTeams}</button>
            <button type="button" disabled={auto.isPending || active.length < 2} onClick={() => void auto.mutateAsync(true)} className="flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-full border border-violet/60 text-sm font-semibold text-violet disabled:opacity-50"><Shuffle className="h-4 w-4" />{copy.shuffle}</button>
          </div>
        </>
      )}
      {bench.length > 0 && (
        <Card>
          <p className="text-xs font-semibold text-muted-text">{copy.bench}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {bench.map((p) => (
              <button key={p.id} type="button" disabled={!editable} onClick={() => setSelected(selected === p.id ? null : p.id)} className={cn("flex items-center gap-2 rounded-full border px-2 py-1", selected === p.id ? "border-floodlight" : "border-line")}>
                <PlayerAvatar name={p.name} initials={p.initials} avatarUrl={p.avatarUrl} size={26} dashed={!p.signedUp} />
                <span className="text-xs font-semibold">{p.name}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function TeamLegend({ side, name, color, editable, onColor }: { side: TeamSide; name: string; color: string; editable: boolean; onColor: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex-1">
      <button type="button" disabled={!editable} onClick={() => setOpen((v) => !v)} className={cn("flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2", side === "A" && "flex-row-reverse text-end")}>
        <span className="h-4 w-4 shrink-0 rounded-full border border-line" style={{ background: color }} />
        <span className="truncate text-sm font-bold">{name}</span>
      </button>
      {open && editable && (
        <div className="absolute z-10 mt-1 flex flex-wrap gap-1.5 rounded-xl border border-line bg-raised p-2">
          {TEAM_SWATCHES.map((c) => (
            <button key={c} type="button" onClick={() => { onColor(c); setOpen(false); }} className="h-7 w-7 rounded-full border border-line" style={{ background: c }} aria-label={c} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- live VAR

type VarStatus = {
  live: boolean;
  varActive: boolean;
  panAvailable: boolean;
  startUtc: string | null;
  endUtc: string | null;
  error?: string | null;
};

type MatchLiveClipProgress = {
  id: number;
  matchCode: string;
  liveClipStatus: string | null;
  liveClipError: string | null;
  exportStatus: string | null;
};

const PENDING_LIVE_CLIP_PREFIX = "replay_pending_live_clip:";

function VarTab({ room, copy, preview = false }: { room: MatchRoom; copy: MatchStrings & { locale: "en" | "ar" }; preview?: boolean }) {
  const flag = useFlagMoment(room.code);
  const { toast } = useToast();
  const { user, isGuest, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<VarStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [frameMs, setFrameMs] = useState<number | null>(null);
  const [seekUtcMs, setSeekUtcMs] = useState<number | null>(null);
  const [ballFollow, setBallFollow] = useState(false);
  const [processing, setProcessing] = useState<MatchLiveClipProgress | null>(null);
  const [processingId, setProcessingId] = useState<number | null>(null);

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/matches/${encodeURIComponent(room.code)}/live/status`, { credentials: "include" });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error || "Live status unavailable");
        if (!cancelled) {
          setStatus(result as VarStatus);
          setStatusError(null);
        }
      } catch (error) {
        if (!cancelled) setStatusError(error instanceof Error ? error.message : "Live status unavailable");
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [preview, room.code]);

  const saveLiveClip = useCallback(async (draft: ClipDraft, useBallPan: boolean) => {
    const response = await fetch(`${apiBase}/matches/${encodeURIComponent(room.code)}/live-clips`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: draft.startTime,
        end: draft.endTime,
        title: draft.title,
        cropPath: draft.cropPath,
        aspectRatio: draft.aspectRatio,
        useBallPan,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || "Could not save live clip");
    const saved = result as MatchLiveClipProgress;
    setProcessing(saved);
    setProcessingId(saved.id);
  }, [room.code]);

  const requireAuth = useCallback((draft: ClipDraft) => {
    try {
      sessionStorage.setItem(`${PENDING_LIVE_CLIP_PREFIX}${room.code}`, JSON.stringify({
        code: room.code,
        at: Date.now(),
        draft,
        useBallPan: ballFollow,
      }));
    } catch {
      // The clip remains in the editor if session storage is unavailable.
    }
    const redirectPath = `/m/${room.code}`;
    const authPath = isGuest ? "/sign-up" : "/sign-in";
    setLocation(`${authPath}?redirect_url=${encodeURIComponent(redirectPath)}`);
  }, [ballFollow, isGuest, room.code, setLocation]);

  useEffect(() => {
    if (authLoading || !user || isGuest) return;
    const key = `${PENDING_LIVE_CLIP_PREFIX}${room.code}`;
    type PendingLiveClip = { code?: string; at?: number; draft?: ClipDraft; useBallPan?: boolean };
    const saved: PendingLiveClip | null = (() => {
      try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) as PendingLiveClip : null;
      } catch {
        return null;
      }
    })();
    if (!saved) return;
    sessionStorage.removeItem(key);
    if (
      saved.code === room.code
      && typeof saved.at === "number"
      && Date.now() - saved.at <= 60 * 60 * 1000
      && saved.draft
    ) {
      void saveLiveClip(saved.draft, saved.useBallPan === true).catch((error) => {
        toast({ title: error instanceof Error ? error.message : "Could not save live clip", variant: "destructive" });
      });
    }
  }, [authLoading, isGuest, room.code, saveLiveClip, toast, user]);

  useEffect(() => {
    if (!processingId || preview) return;
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    const poll = async () => {
      if (cancelled) return;
      const elapsedMs = Date.now() - startedAt;
      try {
        const response = await fetch(
          `${apiBase}/matches/${encodeURIComponent(room.code)}/live-clips/${processingId}/status`,
          { credentials: "include" },
        );
        if (response.ok) {
          const result = await response.json() as MatchLiveClipProgress;
          if (cancelled) return;
          setProcessing(result);
          const captureFinished = result.liveClipStatus === "ready" || result.liveClipStatus === "failed";
          if (captureFinished && result.exportStatus !== "pending") return;
        }
      } catch {
        // Keep checking through long Bunny encoding queues and transient network errors.
      }
      // Poll at 5 seconds for the first hour, then back off without reporting a
      // false timeout: the worker can complete after an hour-long Bunny queue.
      if (!cancelled) timer = window.setTimeout(poll, elapsedMs < 60 * 60 * 1000 ? 5_000 : 30_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [preview, processingId, room.code]);

  const onFlag = async (kind: "goal" | "foul" | "offside" | "other") => {
    if (preview) {
      toast({ title: `${copy.flagKinds[kind]} · ${copy.flagged}` });
      return;
    }
    try {
      await flag.mutateAsync({ kind, atUtc: new Date(frameMs ?? Date.now() - 20_000).toISOString() });
      if (navigator.vibrate) navigator.vibrate(30);
      toast({ title: copy.flagged });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : copy.error, variant: "destructive" });
    }
  };

  if (preview) {
    return (
      <>
        <div className="-mx-4 relative flex aspect-video items-center justify-center overflow-hidden bg-surface" style={{ background: "repeating-linear-gradient(180deg,#0F2A2A 0 12.5%,#0D2525 12.5% 25%)" }}>
          <span className="absolute start-3 top-3 flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[10px] font-bold uppercase text-text"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text" />Live</span>
          <p className="px-8 text-center text-sm text-text/80">{copy.varBehind}</p>
        </div>
        <Card>
          <p className="flex items-center gap-2 text-sm font-bold"><Flag className="h-4 w-4 text-violet" />{copy.flag}</p>
          <p className="mt-1 text-xs text-muted-text">{copy.flagHint}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => void onFlag("goal")} className="col-span-2 min-h-12 rounded-full bg-floodlight text-base font-bold text-void">{copy.flagKinds.goal}</button>
            {(["foul", "offside", "other"] as const).map((k) => (
              <button key={k} type="button" onClick={() => void onFlag(k)} className={cn("min-h-11 rounded-full border text-sm font-semibold", k === "other" ? "col-span-2 border-violet/60 text-violet" : "border-line text-text")}>{copy.flagKinds[k]}</button>
            ))}
          </div>
        </Card>
      </>
    );
  }

  const canFlag = room.isMember || room.canManage;
  const windowStartUtcMs = status?.startUtc ? Date.parse(status.startUtc) : room.startMs - 3 * 60 * 1000;
  const windowEndUtcMs = status?.endUtc ? Date.parse(status.endUtc) : room.endMs + 5 * 60 * 1000;
  const liveDvr = useMemo(() => (
    status?.live && Number.isFinite(windowStartUtcMs) && Number.isFinite(windowEndUtcMs)
      ? {
        windowStartUtcMs,
        windowEndUtcMs,
        maxDurationSeconds: 600,
        onCurrentTimeUtcChange: setFrameMs,
      }
      : undefined
  ), [status?.live, windowEndUtcMs, windowStartUtcMs]);
  const playerSrc = `${apiBase}/matches/${encodeURIComponent(room.code)}/live/${ballFollow ? "pan" : "hls"}/playlist.m3u8`;
  const clipFinished = processing?.liveClipStatus === "ready" || processing?.liveClipStatus === "failed";
  const processingLabel = processing?.liveClipStatus === "ready"
    ? (processing.exportStatus === "done"
      ? "Clip ready"
      : processing.exportStatus === "error" ? "Capture ready; export failed" : "Capture ready; export processing")
    : processing?.liveClipStatus === "failed" ? "Live clip failed" : "Live clip processing";

  return (
    <>
      {status?.live && liveDvr ? (
        <>
          <div className="-mx-4">
            <ClipPlayer
              src={playerSrc}
              title={room.title || room.field.name}
              source={{ kind: "bunny", videoId: `live:${room.code}` }}
              liveCameraId={room.field.name}
              isLive
              liveDvr={liveDvr}
              layout="inline"
              canSave={Boolean(user) && !isGuest}
              onRequireAuth={requireAuth}
              onSave={(draft) => saveLiveClip(draft, ballFollow)}
              seekToUtcMs={seekUtcMs}
            />
          </div>
          <p className="text-center text-[11px] text-muted-text">{copy.varBehind}</p>
          {status.panAvailable && (
            <button
              type="button"
              aria-pressed={ballFollow}
              onClick={() => setBallFollow((value) => !value)}
              className={cn("min-h-11 rounded-full border px-4 text-sm font-semibold", ballFollow ? "border-turf bg-turf/10 text-turf" : "border-line text-text")}
            >
              {ballFollow ? "Ball-follow view on" : "Enable ball-follow view"}
            </button>
          )}
        </>
      ) : (
        <Card>
          <p className="text-sm">{statusError || status?.error || (
            room.varOpensAt
              ? copy.varOpensAt(formatClock(Date.parse(room.varOpensAt), copy.locale))
              : copy.phase[room.phase]
          )}</p>
          {status && !status.live && !statusError && (
            <p className="mt-1 text-xs text-muted-text">Live match footage is not available right now.</p>
          )}
        </Card>
      )}

      {canFlag && (
        <Card>
          <p className="flex items-center gap-2 text-sm font-bold"><Flag className="h-4 w-4 text-violet" />{copy.flag}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={flag.isPending} onClick={() => void onFlag("goal")} className="col-span-2 min-h-12 rounded-full bg-floodlight text-base font-bold text-void disabled:opacity-60">{copy.flagKinds.goal}</button>
            {(["foul", "offside", "other"] as const).map((k) => (
              <button key={k} type="button" disabled={flag.isPending} onClick={() => void onFlag(k)} className={cn("min-h-11 rounded-full border text-sm font-semibold disabled:opacity-60", k === "other" ? "col-span-2 border-violet/60 text-violet" : "border-line text-text")}>{copy.flagKinds[k]}</button>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <p className="text-xs font-semibold text-muted-text">{copy.flags}</p>
        {room.marks.length === 0 ? <p className="mt-2 text-xs text-muted-text">{copy.noFlags}</p> : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {[...room.marks].reverse().map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => setSeekUtcMs(Date.parse(m.atUtc))} className="flex w-full items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2 text-start">
                  <span className="font-mono text-sm font-bold text-turf">{copy.atMinute(Math.max(0, Math.floor((m.offsetSeconds ?? 0) / 60)))}</span>
                  <span className="flex-1 text-sm font-semibold">{copy.flagKinds[m.kind] ?? m.kind}</span>
                  {m.byName && <span className="truncate text-[11px] text-muted-text">{copy.byName(m.byName)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {processing && (
        <Card>
          <p className="text-sm font-semibold">{processingLabel}</p>
          {processing.liveClipError && <p className="mt-1 text-xs text-live">{processing.liveClipError}</p>}
          {clipFinished && processing.exportStatus === "error" && (
            <p className="mt-1 text-xs text-muted-text">The source clip is saved. Its downloadable export could not be generated.</p>
          )}
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- clips

function ClipsTab({ room, copy }: { room: MatchRoom; copy: MatchStrings & { locale: "en" | "ar" } }) {
  const clips = useMatchClips(room.code);
  const make = room.footage.shareToken ? `/w/${room.footage.shareToken}?m=${room.code}` : null;
  return (
    <>
      {make && (
        <Link href={make} className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-floodlight text-base font-bold text-void">
          <Clapperboard className="h-4 w-4" />{copy.makeClip}
        </Link>
      )}
      {clips.isLoading ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-text" /> : (clips.data ?? []).length === 0 ? (
        <Card><p className="text-sm text-muted-text">{copy.noClips}</p></Card>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {(clips.data ?? []).map((clip) => (
            <Link key={clip.id} href={clip.mine ? "/my-clips" : `/players/${clip.by.userId}`} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="relative aspect-video bg-raised">
                <div className="absolute inset-0 flex items-center justify-center"><Play className="h-6 w-6 text-muted-text" /></div>
                <span className="absolute bottom-1.5 end-1.5 rounded bg-void/80 px-1.5 font-mono text-[11px]">{Math.round(clip.duration)}s</span>
                {clip.mine && <span className="absolute start-1.5 top-1.5 rounded-full bg-violet px-2 py-0.5 text-[10px] font-bold">{copy.yourClip}</span>}
              </div>
              <div className="flex items-center gap-2 p-2">
                <PlayerAvatar name={clip.by.name} avatarUrl={clip.by.avatarUrl} size={22} />
                <span className="truncate text-xs font-semibold">{clip.title || clip.by.name}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- vote

function VoteTab({ room, copy, now }: { room: MatchRoom; copy: MatchStrings; now: number }) {
  const vote = useVote(room.code);
  const { toast } = useToast();
  const candidates = room.players.filter((p) => p.rsvp === "in");
  const tally = new Map(room.vote.tallies.map((t) => [t.playerId, t.count]));
  const closesIn = room.vote.closesAt ? splitDuration(Date.parse(room.vote.closesAt) - now) : null;
  const closesLabel = closesIn ? (closesIn.days ? `${closesIn.days}${copy.days} ` : "") + `${closesIn.hours}${copy.hours} ${closesIn.minutes}${copy.minutes}` : "";
  const canVote = room.vote.open && room.isMember;
  return (
    <>
      <Card>
        <p className="flex items-center gap-2 text-base font-bold"><Crown className="h-4 w-4 text-floodlight" />{copy.vote}</p>
        <p className="mt-1 text-xs text-muted-text">
          {room.vote.closed ? copy.voteClosed : room.vote.open ? `${copy.voteDesc} ${copy.voteClosesIn(closesLabel)}` : copy.voteNotOpen}
        </p>
        <p className="mt-1 text-[11px] text-muted-text">{copy.votesCast(room.vote.votesCast, room.vote.eligibleVoters)}</p>
        {!room.isMember && room.vote.open && <p className="mt-2 text-xs text-muted-text">{copy.onlyPlayersVote}</p>}
      </Card>
      <div className="grid grid-cols-3 gap-3">
        {candidates.map((p) => {
          const mine = room.vote.myVote === p.id;
          const winner = room.vote.winners.includes(p.id);
          const count = tally.get(p.id);
          return (
            <button
              key={p.id}
              type="button"
              disabled={!canVote || p.isMe || vote.isPending}
              onClick={() => void vote.mutateAsync(p.id).catch((e) => toast({ title: e instanceof Error ? e.message : copy.error, variant: "destructive" }))}
              className={cn(
                "flex flex-col items-center gap-2 rounded-2xl border p-3 transition-colors disabled:cursor-default",
                mine ? "border-floodlight bg-floodlight/10" : winner ? "border-floodlight/60" : "border-line bg-surface",
                p.isMe && "opacity-50",
              )}
            >
              <span className="relative">
                <PlayerAvatar name={p.name} initials={p.initials} avatarUrl={p.avatarUrl} size={56} ring={winner ? "#D4FF4F" : undefined} />
                {winner && <Crown className="absolute -top-3 start-1/2 h-5 w-5 -translate-x-1/2 text-floodlight rtl:translate-x-1/2" />}
              </span>
              <span className="w-full truncate text-center text-xs font-semibold">{p.name}</span>
              {count != null && <span className="font-mono text-xs text-muted-text">{copy.votes(count)}</span>}
              {mine && <span className="text-[10px] font-bold text-floodlight">{copy.yourVote}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- stats

function StatsTab({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const unlock = useUnlockStats(room.code);
  const plan = useStatsPlan();
  const { toast } = useToast();
  const [ref, setRef] = useState<{ reference: string; amountFils: number; cliqAlias: string } | null>(
    room.stats.pending ? { reference: room.stats.pending.reference, amountFils: room.stats.pending.amountFils, cliqAlias: room.stats.cliqAlias } : null,
  );
  if (room.stats.unlocked) {
    return (
      <Card className="border-turf/30">
        <p className="flex items-center gap-2 text-base font-bold"><Check className="h-4 w-4 text-turf" />{copy.statsUnlocked}</p>
        <p className="mt-1 text-xs text-muted-text">{copy.statsLockedDesc}</p>
        {room.me?.userId && <Link href={`/players/${room.me.userId}`} className="mt-3 flex min-h-11 items-center justify-center rounded-full bg-floodlight text-sm font-bold text-void">{copy.openStats}</Link>}
      </Card>
    );
  }
  const start = async (kind: "match" | "team" | "monthly") => {
    try {
      const result = kind === "monthly" ? await plan.mutateAsync() : await unlock.mutateAsync(kind);
      setRef(result);
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : copy.error, variant: "destructive" });
    }
  };
  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-4">
        <div className="pointer-events-none absolute inset-0 opacity-40 blur-[6px]" aria-hidden="true">
          <div className="grid h-full grid-cols-3 gap-2 p-4">
            {["4.2 km", "17", "63"].map((v) => <div key={v} className="rounded-xl bg-raised p-3 font-mono text-2xl font-bold text-turf">{v}</div>)}
            <div className="col-span-3 h-24 rounded-xl" style={{ background: "radial-gradient(40% 50% at 30% 60%, rgba(212,255,79,.6), transparent), radial-gradient(30% 40% at 70% 30%, rgba(47,216,196,.5), transparent)" }} />
          </div>
        </div>
        <div className="relative">
          <p className="flex items-center gap-2 text-base font-bold"><Lock className="h-4 w-4 text-floodlight" />{copy.statsLocked}</p>
          <p className="mt-1 text-xs text-muted-text">{copy.statsLockedDesc}</p>
          {room.isMember ? (
            <div className="mt-4 flex flex-col gap-2">
              <button type="button" disabled={unlock.isPending} onClick={() => void start("match")} className="min-h-12 rounded-full bg-floodlight text-sm font-bold text-void">{copy.unlockMatch(formatJod(room.stats.prices.matchFils))}</button>
              {room.canManage && room.stats.teamPack && <button type="button" disabled={unlock.isPending} onClick={() => void start("team")} className="min-h-11 rounded-full border border-violet/60 text-sm font-semibold text-violet">{copy.unlockTeam(formatJod(room.stats.prices.teamFils))}</button>}
              {room.stats.monthly && <button type="button" disabled={plan.isPending} onClick={() => void start("monthly")} className="min-h-11 rounded-full border border-line text-sm font-semibold">{copy.unlockMonthly(formatJod(room.stats.prices.monthlyFils))}</button>}
            </div>
          ) : <p className="mt-3 text-xs text-muted-text">{copy.onlyPlayersVote}</p>}
        </div>
      </section>
      {ref && (
        <Card className="border-violet/40">
          <p className="text-sm font-bold">{copy.payWithCliq} · {copy.pendingPayment}</p>
          <p className="mt-2 text-sm leading-6">{copy.cliqSteps(ref.cliqAlias, formatJod(ref.amountFils), ref.reference)}</p>
          <button type="button" onClick={() => void navigator.clipboard.writeText(ref.reference).then(() => toast({ title: copy.copied }))} className="mt-3 flex min-h-10 items-center gap-2 rounded-full border border-line px-4 font-mono text-sm font-bold">
            <Copy className="h-4 w-4" />{ref.reference}
          </button>
        </Card>
      )}
    </>
  );
}


/** A copy of the room as it would look in another phase, for the owner's preview. */
function previewRoom(room: MatchRoom, mode: "pre" | "live"): MatchRoom {
  const now = Date.now();
  const duration = Number.isFinite(room.endMs - room.startMs) && room.endMs > room.startMs ? room.endMs - room.startMs : 60 * 60 * 1000;
  const five = 5 * 60 * 1000;
  const startMs = mode === "pre"
    ? Math.ceil((now + 2 * 60 * 60 * 1000 + 15 * 60 * 1000) / five) * five
    : Math.floor((now - 20 * 60 * 1000) / five) * five;
  const endMs = startMs + duration;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    ...room,
    phase: mode,
    status: mode === "pre" ? "scheduled" : "recording",
    startMs,
    endMs,
    startsAt: iso(startMs),
    endsAt: iso(endMs),
    varOpensAt: iso(startMs - 3 * 60 * 1000),
    varClosesAt: iso(endMs + 5 * 60 * 1000),
    voteClosesAt: iso(endMs + 24 * 60 * 60 * 1000),
    serverNow: iso(now),
    score: null,
    games: [],
    marks: [],
    var: { ...room.var, active: mode === "live" },
    footage: { ready: false, readyAt: null, shareUrl: null, shareToken: null, expiresAt: null },
    vote: { ...room.vote, open: false, closed: false, myVote: null, votesCast: 0, tallies: [], winners: [] },
  };
}


/** A player booking: pay by CliQ, or see that it's paid. */
function BookingPaymentCard({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const booking = room.booking!;
  const b = copy.book;
  const cancel = useCancelBooking(room.code);
  const payWith = usePayWith(room.code);
  const collect = useCollectCash(room.code);
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const fail = (e: unknown) => toast({ title: e instanceof Error ? e.message : copy.error, variant: "destructive" });
  const field = booking.method === "field";
  const jod = formatJod(booking.amountFils);

  if (booking.status === "paid") {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-turf/40 bg-turf/10 px-4 py-3 text-sm font-semibold text-turf">
        <Check className="h-4 w-4" />{field ? b.cashReceived : b.paid}
      </div>
    );
  }
  if (booking.status === "rejected") {
    return <Card><p className="text-sm text-muted-text">{field ? b.cashNotPaid : b.rejected}</p></Card>;
  }
  if (!booking.reference) {
    return (
      <div className="rounded-2xl border border-violet/40 bg-violet/10 px-4 py-3 text-sm font-semibold text-violet">{field ? b.fieldPending(jod) : b.pending}</div>
    );
  }
  // Whoever is at the field (the owner or an admin) ticks the cash off here.
  const canCollect = field && room.isOwner;
  const canCancel = Boolean(booking.requestId) && (field ? room.phase === "pre" : true);
  return (
    <section className={cn("rounded-2xl border bg-surface p-4", field ? "border-turf/40" : "border-floodlight/40")} data-testid="booking-payment-card">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start justify-between gap-3 text-start">
        <span>
          <span className="flex items-center gap-2 text-base font-bold">
            <span className={cn("h-2 w-2 rounded-full", field ? "bg-turf" : "bg-floodlight")} />{field ? b.fieldPending(jod) : b.pending}
          </span>
          <span className="mt-0.5 block text-xs text-muted-text">{field ? b.fieldPendingDesc : b.pendingDesc}</span>
        </span>
        <span className="font-mono text-xl font-bold" dir="ltr">{jod} JOD</span>
      </button>
      {open && (
        <div className="mt-4">
          {field
            ? <FieldPaymentPanel amountFils={booking.amountFils} reference={booking.reference} />
            : <PaymentPanel amountFils={booking.amountFils} cliqAlias={booking.cliqAlias} reference={booking.reference} />}
          {canCollect && (
            <div className="mt-4 flex gap-2">
              <button type="button" disabled={collect.isPending} data-testid="button-cash-received"
                onClick={() => void collect.mutateAsync(true).then(() => toast({ title: b.cashReceived })).catch(fail)}
                className="flex min-h-11 flex-[2] items-center justify-center gap-1.5 rounded-full bg-floodlight text-sm font-bold text-void">
                <Check className="h-4 w-4" />{b.markCashReceived}
              </button>
              <button type="button" disabled={collect.isPending}
                onClick={() => void collect.mutateAsync(false).then(() => toast({ title: b.cashNotPaid })).catch(fail)}
                className="min-h-11 flex-1 rounded-full border border-line text-sm font-semibold text-muted-text">
                {b.markNotPaid}
              </button>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {booking.mine && booking.requestId && (field || booking.payAtFieldAllowed) && (
              <button
                type="button"
                disabled={payWith.isPending}
                data-testid="button-switch-pay"
                onClick={() => void payWith.mutateAsync({ requestId: booking.requestId!, method: field ? "cliq" : "field" })
                  .then(() => toast({ title: field ? b.payCliqLabel : b.fieldTitle })).catch(fail)}
                className="text-xs font-semibold text-turf underline underline-offset-2"
              >
                {field ? b.switchToCliq : b.switchToField}
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                disabled={cancel.isPending}
                onClick={() => void cancel.mutateAsync(booking.requestId!).then(() => toast({ title: b.cancelled })).catch(fail)}
                className="text-xs font-semibold text-muted-text underline underline-offset-2"
              >
                {b.cancelBooking}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
