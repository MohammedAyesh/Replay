import { Link } from "wouter";
import { ChevronRight, Crown } from "lucide-react";
import { Countdown, PhaseChip, formatClock, formatDay } from "@/components/match/bits";
import type { MatchStrings } from "@/i18n/match-strings";
import type { MyMatchItem } from "@/lib/match-api";
import { cn } from "@/lib/utils";

/** One match in a list: Home's "next match", My matches, invites. */
export function MatchCard({ item, copy, now, variant = "row" }: {
  item: MyMatchItem;
  copy: MatchStrings & { locale: "en" | "ar" };
  now: number;
  variant?: "row" | "hero";
}) {
  const href = item.inviteToken ? `/m/${item.code}?i=${item.inviteToken}` : `/m/${item.code}`;
  const day = formatDay(item.startMs, copy.locale, now, copy);
  const time = formatClock(item.startMs, copy.locale);
  const title = item.title || item.field.name;
  const needed = item.needed ?? 0;
  const countIn = item.countIn ?? 0;

  if (variant === "hero") {
    const live = item.phase === "live";
    return (
      <Link
        href={href}
        className={cn(
          "relative block overflow-hidden rounded-3xl border p-5",
          live ? "border-live/50" : "border-turf/30",
        )}
        style={{
          background: live
            ? "radial-gradient(120% 100% at 100% 0%, rgba(255,90,60,.22), transparent 60%), #141B2C"
            : "radial-gradient(120% 100% at 100% 0%, rgba(47,216,196,.20), transparent 60%), radial-gradient(90% 90% at 0% 100%, rgba(123,92,255,.18), transparent 60%), #141B2C",
        }}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-turf">{live ? copy.liveNow : copy.nextMatch}</span>
          <PhaseChip phase={item.phase} label={copy.phase[item.phase] ?? item.phase} />
        </div>
        <p className="mt-3 font-display text-2xl font-bold leading-tight">{title}</p>
        <p className="mt-1 text-sm text-muted-text">{item.title ? `${item.field.name} · ` : ""}{day} · {time}{item.isOwner ? ` · ${copy.ownerTag}` : ""}</p>
        {item.phase === "pre" && item.startMs - now < 7 * 86400000 && (
          <div className="mt-4">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-text">{copy.kickoffIn}</p>
            <Countdown targetMs={item.startMs} now={now} labels={copy} />
          </div>
        )}
        {needed > 0 && (
          <div className="mt-4">
            <div className="flex h-2 overflow-hidden rounded-full bg-raised">
              <span className="bg-turf" style={{ width: `${Math.min(100, (countIn / needed) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-xs font-semibold">{copy.countIn(countIn, needed)}</p>
          </div>
        )}
        <span className="mt-4 inline-flex min-h-11 items-center gap-1 rounded-full bg-floodlight px-5 text-sm font-bold text-void">
          {live ? copy.varTitle : copy.open}
          <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </span>
      </Link>
    );
  }

  const result = item.score && item.myTeam
    ? (item.myTeam === "A" ? item.score.a - item.score.b : item.score.b - item.score.a)
    : null;
  return (
    <Link href={href} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
      <div className="flex w-12 shrink-0 flex-col items-center rounded-xl bg-raised py-1.5">
        <span className="font-mono text-lg font-bold leading-none">{time}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-bold">
          {title}
          {item.isCaptain && <Crown className="h-3.5 w-3.5 shrink-0 text-floodlight" aria-label={copy.captainTag} />}
        </p>
        <p className="truncate text-xs text-muted-text">{day}{item.title ? ` · ${item.field.name}` : ""}{item.isOwner && !item.myRsvp ? ` · ${copy.ownerTag}` : ""}</p>
      </div>
      {item.score ? (
        <span className="flex flex-col items-end">
          <span className="font-mono text-lg font-bold tabular-nums" dir="ltr">{item.score.a}–{item.score.b}</span>
          {result !== null && (
            <span className={cn("text-[10px] font-bold", result > 0 ? "text-turf" : result < 0 ? "text-muted-text" : "text-violet")}>
              {result > 0 ? copy.won : result < 0 ? copy.lost : copy.draw}
            </span>
          )}
        </span>
      ) : item.voteOpen ? (
        <span className="rounded-full bg-violet/15 px-2.5 py-1 text-[11px] font-bold text-violet">{copy.voteNow}</span>
      ) : item.inviteToken ? (
        <span className="rounded-full bg-floodlight px-2.5 py-1 text-[11px] font-bold text-void">{copy.open}</span>
      ) : needed > 0 ? (
        <span className="font-mono text-xs font-semibold text-muted-text">{countIn}/{needed}</span>
      ) : (
        <PhaseChip phase={item.phase} label={copy.phase[item.phase] ?? item.phase} />
      )}
    </Link>
  );
}
