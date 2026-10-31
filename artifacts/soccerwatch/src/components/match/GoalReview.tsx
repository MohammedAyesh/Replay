import { Link } from "wouter";
import { useState } from "react";
import { Check, Play, Undo2, X } from "lucide-react";
import type { MatchStrings } from "@/i18n/match-strings";
import { useGoalVote, type MatchReplay, type MatchRoom, type TeamSide } from "@/lib/match-api";
import { cn } from "@/lib/utils";
import { GoalReelButton } from "@/components/match/GoalReel";

/**
 * "Was it a goal?" (2026-10-25): every chance Replay found, and the players'
 * answers. Only a confirmed chance counts as a goal anywhere; one "Goal" from
 * anyone in the match confirms it. Used by the scoreboard (before and during
 * the game) and by the match report (after it), so a finished match can be
 * answered from its own page, not only from the "Is this you?" deck.
 */

export type ReplayGoalRow = MatchReplay["goals"][number];
type Copy = MatchStrings & { locale: "en" | "ar" };

/** An older server sends no status, and then every listed goal counted. */
export const goalStatusOf = (g: ReplayGoalRow) => g.status ?? "confirmed";

/** Every chance with its status: `review` when the server sends it, else `goals`. */
export const reviewOf = (replay: MatchReplay | undefined): ReplayGoalRow[] => replay?.review ?? replay?.goals ?? [];

export function GoalRow({ g, room, copy, colors, names, canVote, vote, pending }: {
  g: ReplayGoalRow;
  room: MatchRoom;
  copy: Copy;
  colors: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  canVote: boolean;
  vote: (g: ReplayGoalRow, verdict: "goal" | "not_goal" | null) => void;
  pending: boolean;
}) {
  const href = room.footage.shareToken
    ? `/w/${room.footage.shareToken}?m=${room.code}&t=${Math.max(0, Math.round(g.atSeconds - 8))}`
    : null;
  const status = goalStatusOf(g);
  const who = g.ownGoal
    ? `${copy.gvOwnGoal}${g.side ? ` · ${names[g.side]}` : ""}`
    : g.scorer?.name ?? (g.side ? names[g.side] : copy.sbUnknownScorer);
  const chip = "inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-xs font-bold disabled:opacity-50";
  return (
    <li className="flex flex-col gap-1.5 text-sm" data-testid={`goal-${status}`}>
      <div className="flex items-center gap-2">
        <span dir="ltr" className="w-10 shrink-0 font-mono text-xs font-bold text-muted-text">{copy.sbMinute(Math.floor(g.atSeconds / 60) + 1)}</span>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g.side ? colors[g.side] : "#8A94A6" }} />
        <span className="min-w-0 flex-1 truncate">
          {who}
          {status === "open" && g.source === "goal" && (
            <span className="ms-2 rounded-full bg-turf/15 px-2 py-0.5 text-[10px] font-bold text-turf">{copy.gvLikely}</span>
          )}
        </span>
        {href && (
          <Link href={href} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs font-semibold">
            <Play className="h-3 w-3 fill-current" />{copy.sbWatch}
          </Link>
        )}
      </div>
      {canVote && g.key !== undefined && (
        <div className="flex flex-wrap items-center gap-2 ps-12">
          {status !== "confirmed" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => vote(g, "goal")}
              className={cn(chip, g.myVote === "goal" ? "bg-turf text-void" : "border border-turf/50 text-turf")}
              data-testid="button-goal-yes"
            >
              <Check className="h-3.5 w-3.5" />{copy.gvYes}
            </button>
          )}
          {status === "open" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => vote(g, "not_goal")}
              className={cn(chip, "border border-line text-muted-text")}
              data-testid="button-goal-no"
            >
              <X className="h-3.5 w-3.5" />{copy.gvNo}
            </button>
          )}
          {g.myVote && status !== "open" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => vote(g, null)}
              className={cn(chip, "border border-line text-muted-text")}
              data-testid="button-goal-undo"
            >
              <Undo2 className="h-3.5 w-3.5" />{copy.gvUndo}
            </button>
          )}
        </div>
      )}
      {status === "confirmed" && g.confirmedBy && g.confirmedBy.length > 0 && (
        <p className="ps-12 text-[11px] text-muted-text">{copy.gvConfirmedBy(g.confirmedBy.join(", "))}</p>
      )}
      {status === "rejected" && g.rejectedBy && g.rejectedBy.length > 0 && (
        <p className="ps-12 text-[11px] text-muted-text">{copy.gvNotGoalBy(g.rejectedBy.join(", "))}</p>
      )}
    </li>
  );
}

/** One vote at a time for the whole page; rows share it. */
export function useGoalVoting(code: string) {
  const goalVote = useGoalVote(code);
  const vote = (g: ReplayGoalRow, verdict: "goal" | "not_goal" | null) => {
    if (g.key === undefined) return;
    goalVote.mutate({ recordingId: g.recordingId, key: g.key, verdict });
  };
  return { vote, pending: goalVote.isPending, error: goalVote.isError };
}

/**
 * The open chances ("Was it a goal?") and the ones set aside. The confirmed
 * goals are listed by whoever shows the goals; this box is only for answering.
 */
export function GoalReviewBox({ room, copy, colors, names, replay, className }: {
  room: MatchRoom;
  copy: Copy;
  colors: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  replay: MatchReplay | undefined;
  className?: string;
}) {
  const { vote, pending, error } = useGoalVoting(room.code);
  const [showAll, setShowAll] = useState(false);
  const [showAside, setShowAside] = useState(false);
  const all = reviewOf(replay);
  const open = all.filter((g) => goalStatusOf(g) === "open");
  const aside = all.filter((g) => goalStatusOf(g) === "rejected");
  const likely = open.filter((g) => g.source === "goal");
  const openShown = showAll ? open : likely.length ? likely : open.slice(0, 3);
  const canVote = Boolean(replay?.canVoteGoals);
  if (!open.length && !aside.length) return null;
  const row = (g: ReplayGoalRow) => (
    <GoalRow key={`${g.recordingId}-${g.key ?? g.t}`} g={g} room={room} copy={copy} colors={colors} names={names} canVote={canVote} vote={vote} pending={pending} />
  );
  return (
    <div className={className}>
      {open.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[.03] p-3" data-testid="goal-review">
          <p className="text-sm font-bold">{copy.gvAskTitle}</p>
          <p className="mt-1 text-[11px] leading-4 text-muted-text">{copy.gvAskNote}</p>
          {/* the quick way: every open chance played one after another */}
          {canVote && <GoalReelButton room={room} names={names} colors={colors} openCount={open.length} className="mt-3" />}
          <ul className="mt-3 flex flex-col gap-2">{openShown.map(row)}</ul>
          {open.length > openShown.length || showAll ? (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-xs font-semibold text-turf">
              {showAll ? copy.gvLess : copy.gvMore(open.length - openShown.length)}
            </button>
          ) : null}
        </div>
      )}
      {aside.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowAside((v) => !v)} className="text-[11px] font-semibold text-muted-text underline-offset-2 hover:underline">
            {copy.gvSetAside(aside.length)}
          </button>
          {showAside && <ul className="mt-2 flex flex-col gap-2 opacity-80">{aside.map(row)}</ul>}
        </div>
      )}
      {error && <p className="mt-2 text-xs font-semibold text-live">{copy.gvVoteError}</p>}
    </div>
  );
}
