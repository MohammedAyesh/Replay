import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useMatchStatsData, type PlayerStats } from "@/components/match/MatchStats";
import { visibleColour } from "@/components/match/report/ReportParts";
import type { ClipSeekRequest, ClipTimelineMarker } from "@/components/clip-player/ClipPlayer";
import { useAuth } from "@/lib/auth";
import { useMatchReplay, useMatchRoom, type MatchRoom } from "@/lib/match-api";
import { clock } from "@/lib/match-report";
import {
  buildMoments,
  countByKind,
  momentAt,
  nextMoment,
  previousMoment,
  reel,
  reelJump,
  startOf,
  type FlagInput,
  type Moment,
  type MomentKind,
} from "@/lib/player-moments";
import { cn } from "@/lib/utils";

/**
 * The full-match player's moments: the match's goals and one claimed
 * player's goals, shots, dribbles, passes and touches, drawn on the seek bar,
 * listed beside the video and playable back to back.
 *
 * Lime is the chosen player's goal (the one thing to find first); team
 * colours are the match's goals; the rest each have one quiet colour. No red:
 * red means live.
 */

export const MOMENT_COLOURS: Record<Exclude<MomentKind, "matchGoal">, string> = {
  goal: "#D4FF4F",
  shot: "#2FD8C4",
  dribble: "#FFB547",
  pass: "#6EA8FE",
  touch: "#8A93A6",
  flag: "#F2F4F8",
};

const ORDER: MomentKind[] = ["matchGoal", "goal", "shot", "dribble", "pass", "touch", "flag"];

type Copy = ReturnType<typeof momentsCopy>;

export function momentsCopy(arabic: boolean) {
  return arabic
    ? {
        eyebrow: "لحظات الماتش",
        you: "أنت",
        kinds: { matchGoal: "أهداف الماتش", goal: "أهداف", shot: "تسديدات", dribble: "مراوغات", pass: "تمريرات", touch: "لمسات", flag: "لحظات مميزة" } as Record<MomentKind, string>,
        goalMine: "هدفك",
        goalOf: (name: string) => `هدف ${name}`,
        matchGoal: (name: string | null) => (name ? `هدف · ${name}` : "هدف"),
        shot: "تسديدة",
        dribble: { won: "مراوغة ناجحة", lost: "مراوغة خسرها", none: "مراوغة" },
        pass: { completed: "تمريرة صحيحة", missed: "تمريرة مقطوعة", none: "تمريرة" },
        touches: (n: number) => (n === 1 ? "لمسة" : `${n} لمسات`),
        flag: "لحظة مميزة",
        previous: "السابق",
        next: "التالي",
        play: "شغّل اللقطات",
        stop: "أوقف اللقطات",
        playing: "اللقطات شغّالة",
        rail: "الماتش كامل: اضغط لتروح لأي لحظة",
        noClaim: "حدّد نفسك بالماتش لتظهر هنا لمساتك وتمريراتك وتسديداتك ومراوغاتك.",
        locked: "افتح إحصائيات الماتش لتشوف لحظات كل لاعب.",
        noBall: "تتبّع الكرة مش جاهز لهالماتش بعد، فبنعرض الأهداف بس.",
        loading: "جاري تحميل اللحظات…",
        goMatch: "روح للماتش",
        none: "ما في لحظات بهالفلتر.",
      }
    : {
        eyebrow: "Match moments",
        you: "You",
        kinds: { matchGoal: "Match goals", goal: "Goals", shot: "Shots", dribble: "Dribbles", pass: "Passes", touch: "Touches", flag: "Flagged" } as Record<MomentKind, string>,
        goalMine: "Your goal",
        goalOf: (name: string) => `${name} scores`,
        matchGoal: (name: string | null) => (name ? `Goal · ${name}` : "Goal"),
        shot: "Shot",
        dribble: { won: "Dribble won", lost: "Dribble lost", none: "Dribble" },
        pass: { completed: "Pass completed", missed: "Pass lost", none: "Pass" },
        touches: (n: number) => (n === 1 ? "Touch" : `${n} touches`),
        flag: "Flagged moment",
        previous: "Previous",
        next: "Next",
        play: "Play highlights",
        stop: "Stop highlights",
        playing: "Highlights playing",
        rail: "Whole match: tap to jump anywhere",
        noClaim: "Claim yourself in the match to see your touches, passes, shots and dribbles here.",
        locked: "Unlock match stats to see each player's moments.",
        noBall: "Ball tracking isn't ready for this match yet, so only goals are shown.",
        loading: "Loading moments…",
        goMatch: "Go to match",
        none: "No moments with these filters.",
      };
}

function colourOf(m: Moment): string {
  return m.kind === "matchGoal" ? (m.colour ?? "#F2F4F8") : MOMENT_COLOURS[m.kind];
}

export function momentLabel(m: Moment, copy: Copy, playerName: string | null, isMe: boolean): string {
  switch (m.kind) {
    case "goal":
      return isMe || !playerName ? copy.goalMine : copy.goalOf(playerName);
    case "matchGoal":
      return copy.matchGoal(m.label);
    case "shot":
      return copy.shot;
    case "dribble":
      return m.outcome === "won" ? copy.dribble.won : m.outcome === "lost" ? copy.dribble.lost : copy.dribble.none;
    case "pass":
      return m.outcome === "completed" ? copy.pass.completed : m.outcome === "missed" ? copy.pass.missed : copy.pass.none;
    case "touch":
      return copy.touches(m.count);
    case "flag":
      return m.label && m.label.length > 0 ? m.label : copy.flag;
  }
}

/**
 * Everything the page needs: the moments for the chosen player, the markers
 * for the seek bar, the badge for the picture, and the seek requests that
 * Previous, Next, the list and the highlight reel make.
 */
export function useMatchMoments(code: string | null, flags: FlagInput[], arabic: boolean) {
  const { user } = useAuth();
  const copy = useMemo(() => momentsCopy(arabic), [arabic]);
  const roomQuery = useMatchRoom(code ?? "");
  const room = roomQuery.data ?? null;
  const statsOn = Boolean(room && room.stats.enabled && room.stats.unlocked);
  const statsQuery = useMatchStatsData(room ?? ({ code: code ?? "", stats: { unlocked: false } } as MatchRoom), user?.id ?? null, null, statsOn);
  const replayQuery = useMatchReplay(code ?? "", Boolean(room) && ["processing", "ready", "expired"].includes(room?.phase ?? ""));
  const stats = statsQuery.data ?? null;
  const meId = stats?.competition?.viewerPlayerId ?? room?.me?.id ?? null;

  const claimed = useMemo<PlayerStats[]>(
    () => (stats?.players ?? []).filter((p) => p.claimed && p.report).sort((a, b) => (a.playerId === meId ? -1 : b.playerId === meId ? 1 : a.name.localeCompare(b.name))),
    [stats, meId],
  );
  const [chosenId, setChosenId] = useState<number | null>(null);
  const chosen = claimed.find((p) => p.playerId === chosenId) ?? claimed.find((p) => p.playerId === meId) ?? claimed[0] ?? null;

  const matchGoals = useMemo(() => (replayQuery.data?.goals ?? []).map((goal) => ({
    at: goal.atSeconds,
    scorerName: goal.scorer?.name ?? (goal.side && room ? room.teams[goal.side]?.name ?? null : null),
    colour: goal.side && room?.teams[goal.side] ? visibleColour(room.teams[goal.side]!.color, "#F2F4F8") : null,
    byPlayer: Boolean(chosen && goal.scorer?.playerId === chosen.playerId),
  })), [replayQuery.data, room, chosen]);

  const all = useMemo(() => buildMoments({ report: chosen?.report ?? null, matchGoals, flags }), [chosen, matchGoals, flags]);
  const counts = useMemo(() => countByKind(all), [all]);
  const [hidden, setHidden] = useState<Set<MomentKind>>(() => new Set());
  const moments = useMemo(() => all.filter((m) => !hidden.has(m.kind)), [all, hidden]);
  const toggle = useCallback((kind: MomentKind) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const durationSeconds = room ? Math.max(60, (room.endMs - room.startMs) / 1000) : Math.max(60, ...all.map((m) => m.endAt + 30));
  const stops = useMemo(() => reel(moments, durationSeconds), [moments, durationSeconds]);

  const [position, setPosition] = useState(0);
  const [seekRequest, setSeekRequest] = useState<ClipSeekRequest | null>(null);
  const [reelOn, setReelOn] = useState(false);
  const seekIdRef = useRef(0);
  const pendingRef = useRef<{ target: number; until: number } | null>(null);

  const seek = useCallback((seconds: number, play = true) => {
    seekIdRef.current += 1;
    pendingRef.current = { target: seconds, until: Date.now() + 2000 };
    setSeekRequest({ seconds, id: seekIdRef.current, play });
    setPosition(seconds);
  }, []);

  const onPositionChange = useCallback((seconds: number) => {
    const pending = pendingRef.current;
    if (pending) {
      // Ignore the old position the video reports for a moment after a seek.
      if (Math.abs(seconds - pending.target) > 2 && Date.now() < pending.until) return;
      pendingRef.current = null;
    }
    setPosition(seconds);
  }, []);

  useEffect(() => {
    if (!reelOn || pendingRef.current) return;
    const jump = reelJump(stops, position);
    if (jump === "end") setReelOn(false);
    else if (jump !== null) seek(jump);
  }, [position, reelOn, seek, stops]);

  const startReel = useCallback(() => {
    if (!stops.length) return;
    setReelOn(true);
    const inside = stops.some((stop) => position >= stop.start - 0.5 && position <= stop.end);
    if (!inside) {
      const next = stops.find((stop) => stop.start > position) ?? stops[0];
      seek(next.start);
    }
  }, [position, seek, stops]);

  const current = momentAt(moments, position);
  const chosenIsMe = Boolean(chosen && chosen.playerId === meId);
  const label = (m: Moment) => momentLabel(m, copy, chosen?.name ?? null, chosenIsMe);

  const markers = useMemo<ClipTimelineMarker[]>(() => [...moments]
    .sort((a, b) => ORDER.indexOf(b.kind) - ORDER.indexOf(a.kind))
    .map((m) => ({ at: m.at, color: colourOf(m), label: momentLabel(m, copy, chosen?.name ?? null, chosenIsMe), emphasis: m.kind === "goal" || m.kind === "matchGoal" })),
  [moments, copy, chosen, chosenIsMe]);

  const badge = current ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colourOf(current) }} />
      <span className="truncate">{label(current)}</span>
      <span dir="ltr" className="font-mono tabular-nums text-white/70">{clock(current.at)}</span>
    </span>
  ) : null;

  return {
    enabled: Boolean(code),
    room,
    loading: roomQuery.isLoading || (statsOn && statsQuery.isLoading),
    statsOn,
    hasBall: stats?.hasBall ?? false,
    meId,
    claimed,
    chosen,
    setChosenId,
    all,
    counts,
    hidden,
    toggle,
    moments,
    stops,
    durationSeconds,
    position,
    current,
    label,
    copy,
    seek,
    seekRequest,
    onPositionChange,
    reelOn,
    startReel,
    stopReel: () => setReelOn(false),
    markers,
    badge,
  };
}

export type MatchMomentsState = ReturnType<typeof useMatchMoments>;

export function MatchMomentsPanel({ state }: { state: MatchMomentsState }) {
  const { copy, room, moments, current, position, durationSeconds, chosen, claimed, meId } = state;
  const listRef = useRef<HTMLOListElement>(null);
  const currentIndex = current ? moments.indexOf(current) : -1;

  useEffect(() => {
    // Keep the moment on screen visible in the list without scrolling the page.
    const list = listRef.current;
    if (!list || currentIndex < 0) return;
    const item = list.children[currentIndex] as HTMLElement | undefined;
    if (!item) return;
    if (item.offsetTop < list.scrollTop || item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, item.offsetTop - list.clientHeight / 3), behavior: "smooth" });
    }
  }, [currentIndex]);

  if (!room) {
    return state.loading ? <p className="mx-3 mb-5 text-xs text-muted-text sm:mx-5">{copy.loading}</p> : null;
  }

  const prev = previousMoment(moments, position);
  const next = nextMoment(moments, position);
  const kinds = (["matchGoal", "goal", "shot", "dribble", "pass", "touch", "flag"] as MomentKind[]).filter((kind) => state.counts[kind] > 0);
  const notice = !state.statsOn
    ? copy.locked
    : state.loading
      ? copy.loading
      : !chosen
        ? copy.noClaim
        : !state.hasBall
          ? copy.noBall
          : null;
  const spans = chosen?.report?.spans ?? [];
  const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / durationSeconds) * 100))}%`;

  return (
    <section className="mx-3 mb-5 flex flex-col gap-3.5 rounded-2xl border border-line bg-surface p-4 sm:mx-5" aria-label={copy.eyebrow}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:text-xs rtl:tracking-normal">{copy.eyebrow}</h2>
        {state.reelOn && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-floodlight" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-floodlight" />
            {copy.playing}
          </span>
        )}
      </div>

      {claimed.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="radiogroup">
          {claimed.map((player) => {
            const on = chosen?.playerId === player.playerId;
            return (
              <button
                key={player.playerId}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => state.setChosenId(player.playerId)}
                className={cn(
                  "min-h-8 shrink-0 rounded-full border px-3 font-display text-[13px] font-semibold",
                  on ? "border-floodlight bg-floodlight/10 text-floodlight" : "border-line text-muted-text",
                )}
              >
                {player.playerId === meId ? copy.you : player.name}
              </button>
            );
          })}
        </div>
      )}

      {kinds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((kind) => {
            const on = !state.hidden.has(kind);
            const colour = kind === "matchGoal" ? "#F2F4F8" : MOMENT_COLOURS[kind];
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={on}
                onClick={() => state.toggle(kind)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors",
                  on ? "border-[#3A4560] bg-raised text-text" : "border-line text-muted-text opacity-60",
                )}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: on ? colour : "transparent", boxShadow: on ? undefined : `inset 0 0 0 1.5px ${colour}` }} />
                {copy.kinds[kind]}
                <span dir="ltr" className="font-mono tabular-nums text-muted-text">{state.counts[kind]}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* The whole match as one bar: on-camera time, every moment, where the video is. */}
      <button
        type="button"
        dir="ltr"
        aria-label={copy.rail}
        title={copy.rail}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
          state.seek(fraction * durationSeconds);
        }}
        className="relative h-11 w-full rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-turf"
      >
        <span className="absolute inset-x-0 top-[26px] h-2 rounded-full bg-[#232C42]" />
        {spans.map(([a, b], index) => (
          <span key={index} className="absolute top-[26px] h-2 bg-turf/35" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />
        ))}
        {moments.map((m, index) => {
          const big = m.kind === "goal" || m.kind === "matchGoal";
          return (
            <span
              key={index}
              className={cn("absolute -translate-x-1/2 rounded-full", big ? "top-1 h-3.5 w-3.5 border-2 border-void" : "top-[22px] h-4 w-[3px]")}
              style={{ left: pct(m.at), background: colourOf(m), zIndex: big ? 2 : 1 }}
            />
          );
        })}
        <span className="absolute top-0 z-[3] h-full w-0.5 -translate-x-1/2 rounded-full bg-floodlight" style={{ left: pct(position) }} />
      </button>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!prev}
          onClick={() => prev && state.seek(startOf(prev))}
          className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-line px-3 text-sm font-semibold text-text disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          {copy.previous}
        </button>
        <button
          type="button"
          disabled={!state.stops.length}
          onClick={() => (state.reelOn ? state.stopReel() : state.startReel())}
          className={cn(
            "inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-bold disabled:opacity-40",
            state.reelOn ? "border border-floodlight text-floodlight" : "bg-floodlight text-void",
          )}
        >
          {state.reelOn ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {state.reelOn ? copy.stop : copy.play}
        </button>
        <button
          type="button"
          disabled={!next}
          onClick={() => next && state.seek(startOf(next))}
          className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-line px-3 text-sm font-semibold text-text disabled:opacity-40"
        >
          {copy.next}
          <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
        </button>
      </div>

      {notice && (
        <p className="text-xs text-muted-text">
          {notice}{" "}
          {(notice === copy.noClaim || notice === copy.locked) && (
            <Link href={`/m/${room.code}`} className="font-semibold text-turf">{copy.goMatch}</Link>
          )}
        </p>
      )}

      {moments.length > 0 ? (
        <ol ref={listRef} className="relative -mx-1 flex max-h-72 flex-col overflow-y-auto px-1">
          {moments.map((m, index) => {
            const on = m === current;
            return (
              <li key={`${m.kind}-${m.at}-${index}`}>
                <button
                  type="button"
                  onClick={() => state.seek(startOf(m))}
                  aria-current={on ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start text-sm",
                    on ? "bg-floodlight/10" : "hover:bg-raised",
                  )}
                >
                  <span dir="ltr" className="w-12 shrink-0 font-mono text-xs tabular-nums text-muted-text">{clock(m.at)}</span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colourOf(m) }} />
                  <span className={cn("min-w-0 flex-1 truncate", on ? "font-semibold text-floodlight" : m.kind === "goal" || m.kind === "matchGoal" ? "font-semibold text-text" : "text-text")}>
                    {state.label(m)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        state.all.length > 0 && <p className="text-xs text-muted-text">{copy.none}</p>
      )}
    </section>
  );
}
