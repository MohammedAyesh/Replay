import { PlayerAvatar } from "@/components/match/bits";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import type { MatchStrings } from "@/i18n/match-strings";
import type { ReportStrings } from "@/i18n/report-strings";
import { useVote, type MatchRoom } from "@/lib/match-api";
import { cn } from "@/lib/utils";
import { Num } from "./ReportParts";

type Copy = MatchStrings & { locale: "en" | "ar" };
type R = ReportStrings & { locale: "en" | "ar" };

export function VoteSheet({ room, copy, r, open, onOpenChange }: {
  room: MatchRoom; copy: Copy; r: R; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const vote = useVote(room.code);
  const { toast } = useToast();
  const candidates = room.players.filter((player) => player.rsvp === "in");
  const tally = new Map(room.vote.tallies.map((entry) => [entry.playerId, entry.count]));
  const canVote = room.vote.open && room.isMember;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" dir={r.locale === "ar" ? "rtl" : "ltr"} closeLabel={r.close} className="flex max-h-[88dvh] flex-col overflow-y-auto rounded-t-3xl border-line bg-void px-5 pb-8 pt-5 text-text">
        <SheetHeader className="pe-8 text-start">
          <SheetTitle className="font-display text-2xl font-bold">{r.motm}</SheetTitle>
          <SheetDescription className="text-xs text-muted-text">{r.pickOne}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {candidates.map((player) => {
            const chosen = room.vote.myVote === player.id;
            const count = tally.get(player.id);
            return (
              <button
                key={player.id}
                type="button"
                disabled={!canVote || player.isMe || vote.isPending}
                onClick={() => void vote.mutateAsync(player.id)
                  .then(() => onOpenChange(false))
                  .catch((error) => toast({ title: error instanceof Error ? error.message : copy.error, variant: "destructive" }))}
                className={cn("flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border p-3 disabled:cursor-default",
                  chosen ? "border-floodlight bg-floodlight/10" : "border-line", player.isMe && "opacity-40")}
                data-testid={`button-vote-${player.id}`}
              >
                <span className="relative">
                  <PlayerAvatar name={player.name} initials={player.initials} avatarUrl={player.avatarUrl} size={52} ring={chosen ? "#D4FF4F" : undefined} />
                </span>
                <span className="w-full truncate text-center text-xs font-semibold">{player.name}</span>
                {count != null && <Num className="text-[11px] text-muted-text">{r.votes(count)}</Num>}
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
