import { Link } from "wouter";
import { Play, Sparkles } from "lucide-react";
import { Countdown, PlayerAvatar, formatClock, formatDay } from "@/components/match/bits";
import type { MatchStrings } from "@/i18n/match-strings";
import { useSetScore, type MatchReplay, type MatchRoom, type TeamSide } from "@/lib/match-api";
import { cn } from "@/lib/utils";

/**
 * The scoreboard: always there, from the invite to the memory. Before the
 * game it is the matchup (two shirts, who's in, the clock ticking down to
 * kick-off, 0-0 waiting); during it, LIVE and the minute; after it, the
 * result, or -- until the captain puts it in -- the goals Replay spotted in
 * the footage, offered as the count to use.
 */
export function Scoreboard({ room, copy, now, colors, names, replay }: {
  room: MatchRoom;
  copy: MatchStrings & { locale: "en" | "ar" };
  now: number;
  colors: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  replay: MatchReplay | undefined;
}) {
  const setScore = useSetScore(room.code);
  const pre = room.phase === "pre";
  const live = room.phase === "live";
  const post = ["processing", "ready", "expired"].includes(room.phase);
  const score = room.score;
  const minute = live ? Math.max(1, Math.floor((now - room.startMs) / 60000) + 1) : null;
  const goals = replay?.goals ?? [];
  const suggested = replay?.suggested ?? null;
  const perSide = room.playersPerSide;
  const sideIn = (side: TeamSide) => room.players.filter((p) => p.team === side && p.rsvp === "in");
  const need = Math.max(0, room.counts.needed - room.counts.in);
  const hype = pre
    ? need === 0 ? copy.sbHypeFull : room.startMs - now < 60 * 60 * 1000 ? copy.sbHypeSoon : copy.sbHypeNeed(need)
    : live ? copy.sbHypeLive : post ? copy.sbHypePost : null;
  const shown = score ?? (pre || live ? { a: 0, b: 0 } : null);
  const duration = Math.max(1, (room.endMs - room.startMs) / 1000);
  const watch = (atSeconds: number) =>
    room.footage.shareToken ? `/w/${room.footage.shareToken}?m=${room.code}&t=${Math.max(0, Math.round(atSeconds - 8))}` : null;

  const Crest = ({ side }: { side: TeamSide }) => {
    const players = sideIn(side);
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
        <span
          className="flex h-14 w-14 items-center justify-center rounded-2xl font-display text-2xl font-black text-void shadow-[0_8px_30px_rgba(0,0,0,.35)] ring-2 ring-white/15"
          style={{ background: colors[side] }}
        >
          {(names[side] || side).trim().charAt(0).toUpperCase()}
        </span>
        <span className="line-clamp-2 text-sm font-bold leading-tight">{names[side]}</span>
        {pre && (
          <>
            <span className="flex -space-x-2 rtl:space-x-reverse">
              {players.slice(0, 5).map((p) => (
                <PlayerAvatar key={p.id} name={p.name} initials={p.initials} avatarUrl={p.avatarUrl} size={22} ring={colors[side]} />
              ))}
            </span>
            <span className="font-mono text-[11px] font-semibold text-muted-text">
              {players.length ? copy.sbReady(players.length, perSide) : copy.sbTbd}
            </span>
          </>
        )}
      </div>
    );
  };

  return (
    <div
      className={cn("relative mt-5 overflow-hidden rounded-3xl border p-4 backdrop-blur", live ? "border-live/50" : "border-line")}
      style={{
        background: `radial-gradient(90% 120% at 0% 0%, ${colors.A}33, transparent 55%), radial-gradient(90% 120% at 100% 0%, ${colors.B}33, transparent 55%), rgba(20,27,44,.85)`,
      }}
    >
      <div className="flex items-center justify-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em]">
        {live ? (
          <span className="flex items-center gap-1.5 text-live"><span className="h-2 w-2 animate-pulse rounded-full bg-live" />{copy.sbLive} · {copy.sbMinute(minute!)}</span>
        ) : post ? (
          <span className="text-turf">{copy.sbFullTime}</span>
        ) : (
          <span className="text-muted-text">{copy.sbKickoff} · {formatDay(room.startMs, copy.locale, now, copy)} {formatClock(room.startMs, copy.locale)}</span>
        )}
      </div>

      <div className="mt-3 flex items-start gap-2" dir="ltr">
        <Crest side="A" />
        <div className="flex shrink-0 flex-col items-center pt-2">
          <span
            className={cn(
              "font-mono text-5xl font-black tabular-nums leading-none tracking-tight",
              pre ? "text-text/35" : "text-text",
            )}
          >
            {shown ? `${shown.a}–${shown.b}` : "–"}
          </span>
          {post && !score && <span className="mt-2 text-[11px] font-semibold text-muted-text">{copy.sbAwaitingScore}</span>}
        </div>
        <Crest side="B" />
      </div>

      {pre && room.startMs - now < 7 * 86400000 && (
        <div className="mt-4 flex justify-center">
          <Countdown targetMs={room.startMs} now={now} labels={copy} />
        </div>
      )}

      {hype && <p className="mt-3 text-center text-sm font-semibold text-text/90">{hype}</p>}

      {post && !score && suggested && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-turf/15 px-3 py-1 text-xs font-bold text-turf">
            <Sparkles className="h-3.5 w-3.5" />{copy.sbReplayCounted(suggested.a, suggested.b)}
          </span>
          {room.canManage && room.teamCount < 3 && (
            <button
              type="button"
              disabled={setScore.isPending}
              onClick={() => void setScore.mutateAsync({ scoreA: suggested.a, scoreB: suggested.b })}
              className="rounded-full bg-floodlight px-3 py-1 text-xs font-bold text-void"
            >
              {copy.sbUseReplay}
            </button>
          )}
        </div>
      )}
      {post && !score && room.canManage && !suggested && (
        <p className="mt-2 text-center text-xs font-semibold text-floodlight">{copy.sbCaptainEnter}</p>
      )}

      {post && goals.length > 0 && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-text">
            <Sparkles className="h-3.5 w-3.5 text-turf" />{copy.sbGoalsTitle}
          </p>
          <div className="relative mt-3 h-2 rounded-full bg-white/10" dir="ltr">
            {goals.map((g, i) => (
              <span
                key={i}
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-void"
                style={{ left: `${Math.min(100, (100 * g.atSeconds) / duration)}%`, background: g.side ? colors[g.side] : "#8A94A6" }}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {goals.map((g, i) => {
              const href = watch(g.atSeconds);
              return (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span dir="ltr" className="w-10 shrink-0 font-mono text-xs font-bold text-muted-text">{copy.sbMinute(Math.floor(g.atSeconds / 60) + 1)}</span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g.side ? colors[g.side] : "#8A94A6" }} />
                  <span className="min-w-0 flex-1 truncate">{g.scorer?.name ?? (g.side ? names[g.side] : copy.sbUnknownScorer)}</span>
                  {href && (
                    <Link href={href} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs font-semibold">
                      <Play className="h-3 w-3 fill-current" />{copy.sbWatch}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          {replay?.shots && <p className="mt-2 text-xs text-muted-text">{copy.sbShots(replay.shots[0], replay.shots[1])}</p>}
          <p className="mt-2 text-[11px] leading-4 text-muted-text">{copy.sbGoalsNote}</p>
        </div>
      )}
    </div>
  );
}

/** After the whistle: the way into /find, where a player claims themselves and earns their numbers and moments. */
export function FindYourselfCard({ recordingId, copy }: { recordingId: number; copy: MatchStrings }) {
  return (
    <Link
      href={`/find/${recordingId}`}
      className="relative block overflow-hidden rounded-3xl border border-turf/40 p-5"
      style={{ background: "radial-gradient(120% 120% at 100% 0%, rgba(47,216,196,.28), transparent 60%), radial-gradient(90% 90% at 0% 100%, rgba(212,255,79,.16), transparent 60%), #141B2C" }}
    >
      <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-turf"><Sparkles className="h-3.5 w-3.5" />{copy.findBadge}</p>
      <p className="mt-2 font-display text-2xl font-bold leading-tight">{copy.findTitle}</p>
      <p className="mt-1.5 text-sm leading-5 text-muted-text">{copy.findDesc}</p>
      <span className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full bg-floodlight px-5 text-sm font-bold text-void">{copy.findCta}</span>
    </Link>
  );
}
