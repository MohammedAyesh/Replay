import { useMatchCopy } from "@/i18n/match-strings";
import { cn } from "@/lib/utils";

/**
 * "Statistics are in beta", wherever a player sees their numbers.
 *
 * Tracking can still swap two players at a crossing, and every distance,
 * speed, touch and pass is read from that tracking. The pill marks a stat
 * heading as beta; the note says why in one line. Both follow the page's
 * direction, so in Arabic the pill sits on the right and the line reads on
 * from it.
 */
export function BetaPill({ className }: { className?: string }) {
  const copy = useMatchCopy();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-floodlight/40 bg-floodlight/10 px-1.5 py-0.5 text-[9px] font-black uppercase leading-none tracking-[0.12em] text-floodlight rtl:text-[10px] rtl:tracking-normal",
        className,
      )}
      data-testid="stats-beta-pill"
    >
      {copy.statsBeta.pill}
    </span>
  );
}

export function StatsBetaNote({ className }: { className?: string }) {
  const copy = useMatchCopy();
  return (
    <p className={cn("flex items-start gap-2 text-start text-[11px] leading-4 text-muted-text", className)} data-testid="stats-beta-note">
      <BetaPill className="mt-px" />
      <span>{copy.statsBeta.note}</span>
    </p>
  );
}
