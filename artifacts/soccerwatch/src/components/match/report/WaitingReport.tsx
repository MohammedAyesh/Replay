import { useState } from "react";
import { Check, Crown, UserPlus } from "lucide-react";
import { GoalReviewBox } from "@/components/match/GoalReview";
import { formatDay } from "@/components/match/bits";
import type { MatchStrings } from "@/i18n/match-strings";
import { useReportCopy, type ReportStrings } from "@/i18n/report-strings";
import { whatsappLink, type MatchReplay, type MatchRoom, type TeamSide } from "@/lib/match-api";
import { cn } from "@/lib/utils";
import { ReportHeader } from "./ReportHeader";
import { ReportScoreRows } from "./ReportScoreRows";
import { VoteSheet } from "./ReportVoteSheet";
import { Num, Section } from "./ReportParts";
import { Disclosure } from "./StatsReport";
import { SquadBlock, type MatchReportSlots } from "./MatchReport";
import { waitingSteps } from "./waiting-steps";

type Copy = MatchStrings & { locale: "en" | "ar" };
type R = ReportStrings & { locale: "en" | "ar" };
export const waitingNotifyStorageKey = (code: string) => `replay:match-ready-notify:${code.toUpperCase()}`;

export function WaitingReport({ room, copy, now, colors, names, replay, onShare, inviteText, slots }: {
  room: MatchRoom; copy: Copy; now: number; colors: Record<TeamSide, string>; names: Record<TeamSide, string>;
  replay: MatchReplay | undefined; onShare: () => void; inviteText: string; slots: MatchReportSlots;
}) {
  const r = useReportCopy();
  const steps = waitingSteps(room, now);
  const [notify, setNotify] = useState(() => {
    try { return window.localStorage.getItem(waitingNotifyStorageKey(room.code)) === "1"; }
    catch { return false; }
  });
  const [voteOpen, setVoteOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const votedFor = room.players.find((player) => player.id === room.vote.myVote);
  const voteAction = room.isMember && room.vote.open && room.vote.myVote === null;
  const voteMessage = !room.isMember ? r.onlyPlayers
    : votedFor ? r.youVoted(votedFor.name)
      : !room.vote.open ? r.voteNotOpen : null;
  const missing = Math.max(0, room.counts.needed - room.counts.in);

  const setNotifyEnabled = (checked: boolean) => {
    setNotify(checked);
    try {
      if (checked) window.localStorage.setItem(waitingNotifyStorageKey(room.code), "1");
      else window.localStorage.removeItem(waitingNotifyStorageKey(room.code));
    } catch { /* Storage may be disabled; this page can still keep the in-memory toggle. */ }
    if (checked && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col px-4 pb-16" data-testid="match-report-waiting">
      <ReportHeader copy={copy} r={r} onShare={onShare} />

      <section data-testid="report-top-card" className="relative mt-4 overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-[#1D3B2E] via-[#13283A] to-[#1B1F3D] p-4">
        <p className="text-[13px] text-muted-text">
          {formatDay(room.startMs, copy.locale, now, copy)} · {room.title ? `${room.title} · ` : ""}{room.field.name} · {r.minutesLong(Math.max(1, Math.round((room.endMs - room.startMs) / 60_000)))}
          <bdi className="ms-2 font-mono text-[11px] tracking-[0.2em] text-muted-text/70">#{room.code}</bdi>
        </p>
        <ReportScoreRows room={room} copy={copy} r={r} colors={colors} names={names} replay={replay} meId={room.me?.id ?? null} me={null} players={[]} stats={null}
          onOpenCaptainTools={() => {
            setToolsOpen(true);
            window.setTimeout(() => document.querySelector('[data-testid="report-captain-tools"]')?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
          }} />
      </section>

      <Section eyebrow={r.waitingJourney} className="border-b-0 pb-1">
        <ol className="ms-3 border-s-2 border-line" data-testid="waiting-timeline">
          {steps.map((step) => (
            <li key={step.key} className="relative pb-5 ps-7 last:pb-0">
              <span className={cn(
                "absolute -start-[9px] top-0 flex h-4 w-4 items-center justify-center rounded-full border-2",
                step.state === "done" && "border-turf bg-turf text-void",
                step.state === "current" && "border-[3px] border-turf bg-void",
                step.state === "upcoming" && "border-line bg-void",
              )}>
                {step.state === "done" && <Check className="h-2.5 w-2.5 stroke-[3]" />}
              </span>
              {step.key === "whistle" ? (
                <div className="flex min-h-8 items-center justify-between gap-3 text-sm">
                  <span className="font-semibold">{r.waitingFinalWhistle(step.matchMinutes ?? 0)}</span>
                  <span className="shrink-0 text-xs text-muted-text">
                    {step.clockTime
                      ? new Intl.DateTimeFormat(r.locale, { hour: "numeric", minute: "2-digit" }).format(step.endedAt)
                      : r.waitingMinutesAgo(step.minutesAgo ?? 0)}
                  </span>
                </div>
              ) : step.key === "processing" ? (
                <div className="rounded-2xl border border-turf/35 bg-surface p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-display text-base font-bold">{r.waitingPreparing}</h2>
                    {step.progressPercent !== undefined && <Num className="font-display text-sm font-bold text-turf">{step.progressPercent}%</Num>}
                  </div>
                  {step.progressPercent !== undefined && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"><span className="block h-full bg-turf" style={{ width: `${step.progressPercent}%` }} /></div>}
                  <p className="mt-2 text-xs leading-5 text-muted-text">{r.processingDesc}</p>
                  <div className="mt-3 border-t border-line pt-3">
                    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
                      <input type="checkbox" checked={notify} onChange={(event) => setNotifyEnabled(event.target.checked)} className="h-4 w-4 accent-turf" />
                      <span>{r.waitingNotify}</span>
                    </label>
                    <p className="ms-6 text-[11px] text-muted-text">{r.waitingWhileOpen}</p>
                  </div>
                </div>
              ) : (
                <div className="py-0.5">
                  <p className="text-sm font-semibold text-muted-text">{r.waitingStepTitle[step.key]}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-text/80">{r.waitingStepDescription[step.key]}</p>
                </div>
              )}
            </li>
          ))}
        </ol>
      </Section>

      {slots.freeMatch && <div className="pt-4">{slots.freeMatch}</div>}
      {slots.booking && <div className="pt-4">{slots.booking}</div>}
      {slots.rsvp && <div className="pt-4">{slots.rsvp}</div>}

      <section className="pt-5">
        <h2 className="mb-3 font-display text-lg font-extrabold">{r.waitingDoNow}</h2>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={() => voteAction && setVoteOpen(true)} disabled={!voteAction}
            className="flex min-h-[92px] flex-col items-start justify-center rounded-2xl border border-line bg-surface p-3 text-start disabled:cursor-default">
            <span className="flex items-center gap-2 text-sm font-bold"><Crown className="h-4 w-4 text-floodlight" />{r.motm}</span>
            <span className="mt-1 text-xs text-muted-text">{r.votesCast(room.vote.votesCast, room.vote.eligibleVoters)}</span>
            {voteAction ? <span className="mt-2 text-xs font-bold text-floodlight">{r.voteNow} ›</span> : <span className="mt-2 text-xs text-muted-text">{voteMessage}</span>}
          </button>
          <a href={whatsappLink(inviteText)} target="_blank" rel="noopener noreferrer"
            className="flex min-h-[92px] flex-col items-start justify-center rounded-2xl border border-line bg-surface p-3 text-start">
            <span className="flex items-center gap-2 text-sm font-bold"><UserPlus className="h-4 w-4 text-turf" />{r.squad}</span>
            <span className="mt-1 text-xs text-muted-text">{copy.countIn(room.counts.in, room.counts.needed)}{missing ? ` · ${r.waitingMissing(missing)}` : ""}</span>
            <span className="mt-2 text-xs font-bold text-turf">{r.waitingSendLink} ›</span>
          </a>
        </div>
      </section>
      <VoteSheet room={room} copy={copy} r={r} open={voteOpen} onOpenChange={setVoteOpen} />

      {replay?.canVoteGoals && <GoalReviewBox room={room} copy={copy} colors={colors} names={names} replay={replay} className="pt-4" />}

      <div className="mt-4 flex flex-col">
        <Disclosure title={r.squad} icon={<UserPlus />} tone="turf">
          <SquadBlock room={room} copy={copy} r={r} colors={colors} claimedIds={null} findRecordingId={replay?.recordings[0] ?? null} />
        </Disclosure>
        {slots.teams && <Disclosure title={r.teamsAndSwitches} icon={<UserPlus />} tone="turf" testId="report-teams">{slots.teams}</Disclosure>}
        {slots.invite && <Disclosure title={r.inviteSomeone} icon={<UserPlus />} tone="turf" testId="report-invite">{slots.invite}</Disclosure>}
        {slots.captainTools && <Disclosure title={r.captainTools} icon={<Crown />} tone="turf" open={toolsOpen} onOpenChange={setToolsOpen} testId="report-captain-tools">{slots.captainTools}</Disclosure>}
      </div>
    </div>
  );
}
